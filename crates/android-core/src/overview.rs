//! 设备概览：电量 / 存储 / 内存 / 网络 / 系统。
//!
//! 这一层只做「跑命令 + 解析」。每个字段都是**尽力而为**：某条命令读不到就留 `None`，
//! 不让一个可选信息把整页拖垮。解析函数全是纯函数，用真机样本做单测。

use adb_client::AdbClient;
use tracing::debug;

use crate::device::{map_adb_error, parse_getprop, require_success};
use crate::error::Result;
use crate::model::{
    BatteryInfo, BatteryStatus, DeviceOverview, MemoryInfo, NetworkInfo, StorageInfo,
    StorageVolume, SystemInfo,
};

/// 采集设备概览。
///
/// `getprop` 是必需的：它失败基本等于设备不可用，此时应当报错而不是返回一页空白。
/// 其余命令失败只记日志并留空。
pub async fn collect(client: &AdbClient, serial: &str) -> Result<DeviceOverview> {
    let props = client
        .shell(serial, "getprop")
        .await
        .map_err(map_adb_error)
        .and_then(|out| require_success(out, "读取设备属性"))?;
    let props = parse_getprop(&props.stdout);

    let battery = best_effort(client, serial, "dumpsys battery")
        .await
        .and_then(|s| parse_battery(&s));
    let df = best_effort(client, serial, "df -k").await;
    let meminfo = best_effort(client, serial, "cat /proc/meminfo").await;
    let wlan = best_effort(client, serial, "ip -4 addr show wlan0").await;
    let uptime = best_effort(client, serial, "cat /proc/uptime").await;

    debug!(serial, "设备概览采集完成");

    Ok(DeviceOverview {
        serial: serial.to_owned(),
        battery,
        storage: df.as_deref().and_then(parse_storage),
        memory: meminfo.as_deref().and_then(parse_meminfo),
        network: NetworkInfo {
            wlan_ipv4: wlan.as_deref().and_then(parse_wlan_ipv4),
        },
        system: SystemInfo {
            android_version: prop(&props, "ro.build.version.release"),
            sdk_int: prop(&props, "ro.build.version.sdk").and_then(|v| v.parse().ok()),
            abi: prop(&props, "ro.product.cpu.abi"),
            security_patch: prop(&props, "ro.build.version.security_patch"),
            uptime_seconds: uptime.as_deref().and_then(parse_uptime),
        },
    })
}

/// 可选命令：失败只记日志，返回 `None`。
async fn best_effort(client: &AdbClient, serial: &str, command: &str) -> Option<String> {
    match client.shell(serial, command).await {
        Ok(out) if out.exit_code == 0 => Some(out.stdout),
        Ok(out) => {
            debug!(
                serial,
                command,
                code = out.exit_code,
                "概览命令返回非零，跳过"
            );
            None
        }
        Err(e) => {
            debug!(serial, command, error = %e, "概览命令执行失败，跳过");
            None
        }
    }
}

fn prop(props: &[(String, String)], key: &str) -> Option<String> {
    props
        .iter()
        .find(|(k, _)| k == key)
        .map(|(_, v)| v.clone())
        .filter(|v| !v.is_empty())
}

/// 解析 `dumpsys battery`。
///
/// ```text
/// Current Battery Service state:
///   AC powered: false
///   USB powered: true
///   status: 5
///   level: 100
///   scale: 100
///   voltage: 4328
///   temperature: 360
///   technology: Li-poly
/// ```
///
/// `temperature` 的单位是 0.1℃，`scale` 缺省按 100 处理。
/// 完全没有可识别字段时返回 `None`，避免把「命令没输出」伪装成一块空数据。
pub fn parse_battery(output: &str) -> Option<BatteryInfo> {
    let mut level = None;
    let mut scale = None;
    let mut status = None;
    let mut health = None;
    let mut voltage = None;
    let mut temperature = None;
    let mut technology = None;
    let mut powered = [false; 3];
    let mut saw_any = false;

    for line in output.lines() {
        let Some((key, value)) = line.trim().split_once(':') else {
            continue;
        };
        let key = key.trim();
        let value = value.trim();
        match key {
            "level" => level = value.parse::<u32>().ok(),
            "scale" => scale = value.parse::<u32>().ok(),
            "status" => status = value.parse::<u32>().ok(),
            "health" => health = value.parse::<u32>().ok(),
            "voltage" => voltage = value.parse::<u32>().ok(),
            "temperature" => temperature = value.parse::<f32>().ok(),
            "technology" => technology = Some(value.to_owned()),
            "AC powered" => powered[0] = value == "true",
            "USB powered" => powered[1] = value == "true",
            "Wireless powered" => powered[2] = value == "true",
            _ => continue,
        }
        saw_any = true;
    }

    if !saw_any {
        return None;
    }

    // scale 缺省 100；设备偶尔会上报 0，这时不能拿它做除数。
    let scale = scale.filter(|s| *s > 0).unwrap_or(100);
    let level = level.map(|l| ((l * 100) / scale).min(100) as u8);

    Some(BatteryInfo {
        level,
        status: match status {
            Some(1) => BatteryStatus::Unknown,
            Some(2) => BatteryStatus::Charging,
            Some(3) => BatteryStatus::Discharging,
            Some(4) => BatteryStatus::NotCharging,
            Some(5) => BatteryStatus::Full,
            _ => BatteryStatus::Unknown,
        },
        charging: powered.into_iter().any(|p| p),
        temperature_c: temperature.map(|t| t / 10.0),
        voltage_mv: voltage,
        health,
        technology,
    })
}

/// 解析 `df -k` 的一行。
///
/// ```text
/// Filesystem       1K-blocks     Used Available Use% Mounted on
/// /dev/block/sda21  54964260 16513412  38303292  31% /data
/// ```
///
/// 挂载点可能含空格，所以按空白切分后把第 6 段起全部还给挂载点。
pub fn parse_df(output: &str) -> Vec<(String, StorageVolume)> {
    output
        .lines()
        .skip(1)
        .filter_map(|line| {
            let tokens: Vec<&str> = line.split_whitespace().collect();
            if tokens.len() < 6 {
                return None;
            }
            let total_kb = tokens[1].parse::<u64>().ok()?;
            let used_kb = tokens[2].parse::<u64>().ok()?;
            let available_kb = tokens[3].parse::<u64>().ok()?;
            Some((
                tokens[5..].join(" "),
                StorageVolume {
                    total_kb,
                    used_kb,
                    available_kb,
                },
            ))
        })
        .collect()
}

/// 从 `df` 结果里挑出内部存储与外部存储。
///
/// 外部存储的挂载点在不同 Android 版本上不一样
/// （`/storage/emulated`、`/data/media`、`/sdcard`），按优先级取第一个存在的。
/// 两者常常是同一块分区，但那是设备的事实，不在这里合并。
pub fn parse_storage(output: &str) -> Option<StorageInfo> {
    let entries = parse_df(output);
    let find = |names: &[&str]| {
        entries
            .iter()
            .find(|(mount, _)| names.contains(&mount.as_str()))
            .map(|(_, v)| *v)
    };

    let data = find(&["/data"])?;
    Some(StorageInfo {
        data,
        external: find(&["/storage/emulated", "/data/media", "/sdcard"]),
    })
}

/// 解析 `/proc/meminfo` 前几行。
///
/// ```text
/// MemTotal:        5767104 kB
/// MemAvailable:    2751928 kB
/// ```
pub fn parse_meminfo(output: &str) -> Option<MemoryInfo> {
    let value_of = |key: &str| {
        output.lines().find_map(|line| {
            let (name, rest) = line.split_once(':')?;
            if name.trim() != key {
                return None;
            }
            rest.split_whitespace().next()?.parse::<u64>().ok()
        })
    };

    Some(MemoryInfo {
        total_kb: value_of("MemTotal")?,
        available_kb: value_of("MemAvailable")?,
    })
}

/// 解析 `ip -4 addr show wlan0` 里的 IPv4 地址。
///
/// ```text
/// 30: wlan0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 state UP
///     inet 192.168.1.158/24 brd 192.168.1.255 scope global wlan0
/// ```
///
/// 命令本身已经限定了 wlan0，所以第一个 `inet` 就是它。
/// 不用 `ip -4 route show wlan0`：部分设备的 iproute2 不认这种省略 `dev` 的写法。
pub fn parse_wlan_ipv4(output: &str) -> Option<String> {
    for line in output.lines() {
        let line = line.trim();
        let Some(rest) = line.strip_prefix("inet ") else {
            continue;
        };
        let address = rest.split('/').next()?.trim();
        if !address.is_empty() {
            return Some(address.to_owned());
        }
    }
    None
}

/// 解析 `/proc/uptime`（`160491.47 1184464.86`），取第一项秒数。
pub fn parse_uptime(output: &str) -> Option<u64> {
    output
        .split_whitespace()
        .next()?
        .parse::<f64>()
        .ok()
        .map(|s| s.max(0.0) as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    // 以下样本均取自真机：Xiaomi MIX 2S（polaris），Android 10 / API 29，MIUI。

    const BATTERY: &str = "\
Current Battery Service state:
  AC powered: false
  USB powered: true
  Wireless powered: false
  Max charging current: 500000
  Max charging voltage: 5000000
  Charge counter: 2984737
  status: 5
  health: 2
  present: true
  level: 100
  scale: 100
  voltage: 4328
  temperature: 360
  technology: Li-poly
";

    const DF: &str = "\
Filesystem       1K-blocks     Used Available Use% Mounted on
tmpfs              2865120     1080   2864040   1% /dev
tmpfs              2865120        0   2865120   0% /mnt
/dev/block/dm-0    3047900  3008220     23296 100% /
none               2865120        0   2865120   0% /sys/fs/cgroup
/dev/block/sda21  54964260 16513412  38303392  31% /data
/data/media       54964260 16513412  38303392  31% /storage/emulated
";

    const MEMINFO: &str = "\
MemTotal:        5767104 kB
MemFree:          106272 kB
MemAvailable:    2751928 kB
Buffers:           61552 kB
Cached:          2690812 kB
";

    const WLAN: &str = "\
30: wlan0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc mq state UP group default qlen 3000
    inet 192.168.1.158/24 brd 192.168.1.255 scope global wlan0
       valid_lft forever preferred_lft forever
";

    #[test]
    fn 解析真机电池输出() {
        let battery = parse_battery(BATTERY).expect("应有电池信息");
        assert_eq!(battery.level, Some(100));
        assert_eq!(battery.status, BatteryStatus::Full);
        assert!(battery.charging, "USB powered 为 true");
        assert_eq!(battery.temperature_c, Some(36.0));
        assert_eq!(battery.voltage_mv, Some(4328));
        assert_eq!(battery.health, Some(2));
        assert_eq!(battery.technology.as_deref(), Some("Li-poly"));
    }

    #[test]
    fn 电池输出为空时不伪造数据() {
        assert!(parse_battery("Current Battery Service state:\n").is_none());
    }

    #[test]
    fn 电池_scale_为_0_时不除零() {
        let out = "  level: 55\n  scale: 0\n  status: 3\n";
        let battery = parse_battery(out).expect("应有电池信息");
        // scale 非法时按 100 处理
        assert_eq!(battery.level, Some(55));
        assert_eq!(battery.status, BatteryStatus::Discharging);
        assert!(!battery.charging);
    }

    #[test]
    fn 未知的电池状态映射为_unknown() {
        let out = "  level: 10\n  status: 99\n";
        assert_eq!(
            parse_battery(out).map(|b| b.status),
            Some(BatteryStatus::Unknown)
        );
    }

    #[test]
    fn 解析真机存储并区分内外() {
        let storage = parse_storage(DF).expect("应识别 /data");
        assert_eq!(storage.data.total_kb, 54_964_260);
        assert_eq!(storage.data.used_kb, 16_513_412);
        assert_eq!(storage.data.available_kb, 38_303_392);

        let external = storage.external.expect("应识别 /storage/emulated");
        assert_eq!(external.total_kb, 54_964_260);
    }

    #[test]
    fn 没有_data_挂载点时返回_none() {
        let out = "Filesystem 1K-blocks Used Available Use% Mounted on\n/dev/block/dm-0 100 50 50 50% /\n";
        assert!(parse_storage(out).is_none());
    }

    #[test]
    fn df_表头与非数字行被跳过() {
        let entries = parse_df(DF);
        // 表头被 skip，其余 6 行都是有效数据行
        assert_eq!(entries.len(), 6);
        assert!(entries.iter().all(|(mount, _)| !mount.is_empty()));
    }

    #[test]
    fn 解析真机内存() {
        let memory = parse_meminfo(MEMINFO).expect("应有内存信息");
        assert_eq!(memory.total_kb, 5_767_104);
        assert_eq!(memory.available_kb, 2_751_928);
    }

    #[test]
    fn 缺少_memavailable_时返回_none() {
        assert!(parse_meminfo("MemTotal: 100 kB\n").is_none());
    }

    #[test]
    fn 解析真机_wlan_地址() {
        assert_eq!(parse_wlan_ipv4(WLAN).as_deref(), Some("192.168.1.158"));
    }

    #[test]
    fn 没连_wifi_时_wlan_为_none() {
        let out = "30: wlan0: <BROADCAST,MULTICAST> mtu 1500 state DOWN\n";
        assert!(parse_wlan_ipv4(out).is_none());
    }

    #[test]
    fn 解析真机_uptime() {
        assert_eq!(parse_uptime("160491.47 1184464.86"), Some(160_491));
        assert_eq!(parse_uptime(""), None);
        assert_eq!(parse_uptime("garbage"), None);
    }
}
