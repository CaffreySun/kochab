//! 无线调试：把 USB 设备切到 TCP，以及切回 USB。
//!
//! adb 的 `tcpip:<port>` / `usb:` 都是**设备侧 host 服务**：adbd 收到后重启，
//! 当前连接可能被立即切断。因此这里把「命令返回连接错误」也视为可能成功，
//! 以随后的设备列表 / 重连结果为准，而不是直接向用户报错。

use adb_client::{AdbClient, AdbError};
use serde::Serialize;
use tracing::debug;

use crate::device::{detect_transport, map_adb_error, require_success};
use crate::error::{CoreError, Result};
use crate::model::DeviceTransport;
use crate::overview::parse_wlan_ipv4;

/// 无线调试默认端口，与 `adb tcpip 5555` 一致。
pub const DEFAULT_PORT: u16 = 5555;

/// 切到 TCP 后的结果。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WirelessEnabled {
    /// 形如 `192.168.1.158:5555`
    pub address: String,
    /// adb 返回的连接结果（`connected to ...` / `already connected to ...`）
    pub message: String,
}

/// 读取 wlan0 的 IPv4。未连 Wi-Fi 时返回 `None`。
pub async fn wlan_ipv4(client: &AdbClient, serial: &str) -> Result<Option<String>> {
    let out = client
        .shell(serial, "ip -4 addr show wlan0")
        .await
        .map_err(map_adb_error)?;
    let out = require_success(out, "读取 Wi-Fi 地址")?;
    Ok(parse_wlan_ipv4(&out.stdout))
}

/// 让 USB 连接切换到 TCP，并立刻连回同一台设备。
///
/// 已经是无线连接时直接拒绝：对无线 serial 再执行 `tcpip` 只会重启 adbd，
/// 把当前连接打断，等不到任何收益。
pub async fn enable(client: &AdbClient, serial: &str) -> Result<WirelessEnabled> {
    if detect_transport(serial) == DeviceTransport::Wifi {
        return Err(CoreError::InvalidState(format!(
            "{serial} 已经是无线连接，无需再开启"
        )));
    }

    let ip = wlan_ipv4(client, serial).await?.ok_or_else(|| {
        CoreError::PermissionDenied(
            "读不到 Wi-Fi 地址：请确认手机已连接 Wi-Fi（不是热点/移动数据）".to_owned(),
        )
    })?;
    let address = format!("{ip}:{DEFAULT_PORT}");

    // tcpip 只回一个 OKAY；adbd 可能在这之后才真正重启。
    match client.tcpip(serial, DEFAULT_PORT).await {
        Ok(()) => {}
        // 连接被 adbd 重启切断是预期行为，继续用 connect 验证结果。
        Err(AdbError::Io(e)) => debug!(serial, error = %e, "tcpip 后连接被切断，继续尝试连接"),
        Err(e) => return Err(map_adb_error(e)),
    }

    let mut last_error = None;
    for attempt in 0..6 {
        if attempt > 0 {
            tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        }
        match client.connect_device(&address).await {
            Ok(message) => {
                // 某些 adb 版本连接失败也返回 0，只能看文案
                if message.to_lowercase().contains("unable to connect")
                    || message.to_lowercase().contains("failed")
                {
                    last_error = Some(message);
                    continue;
                }
                return Ok(WirelessEnabled { address, message });
            }
            Err(e) => last_error = Some(e.to_string()),
        }
    }

    Err(CoreError::Internal(format!(
        "已切换到 TCP 模式，但连接 {address} 失败：{}",
        last_error.unwrap_or_else(|| "未知原因".to_owned())
    )))
}

/// 从无线连接切回 USB 模式，并断开这条 TCP 连接。
///
/// `usb:` 之后 adbd 重启，响应有时能读到、有时连接先断；
/// 两种都按成功处理，因为最终状态由 adb 设备列表决定。
pub async fn disable(client: &AdbClient, serial: &str) -> Result<String> {
    if detect_transport(serial) != DeviceTransport::Wifi {
        return Err(CoreError::InvalidState(format!(
            "{serial} 不是无线连接，无需关闭网络端口"
        )));
    }

    match client.usb(serial).await {
        Ok(()) => {}
        Err(AdbError::Io(e)) => debug!(serial, error = %e, "usb 后连接被切断，继续断开"),
        Err(e) => return Err(map_adb_error(e)),
    }

    // TCP 条目可能已经被 adbd 自己断掉，`disconnect` 报 not found 不算失败。
    let _ = client.disconnect_device(serial).await;
    Ok("已切回 USB 模式并断开无线连接".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 端口与前端约定一致() {
        assert_eq!(DEFAULT_PORT, 5555);
    }
}
