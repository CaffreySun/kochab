//! 设备属性采集。
//!
//! `devices-l` 只给出 serial 与 state；机型、系统版本、分辨率都要靠 `getprop`
//! 与 `wm size` 补齐。一次性把需要的属性全部读回来，避免逐条 `getprop` 往返。

use adb_client::{AdbClient, AdbError, DeviceState};
use tracing::debug;

use crate::error::{CoreError, Result};
use crate::model::{DeviceConnectionState, DeviceInfo, DeviceTransport};

/// 需要从设备读取的属性。
///
/// 用一次 `getprop` 输出解析全部字段，而不是每个属性一次 `getprop <key>`。
const WANTED_PROPS: &[&str] = &[
    "ro.product.model",
    "ro.product.manufacturer",
    "ro.product.brand",
    "ro.product.device",
    "ro.build.version.release",
    "ro.build.version.sdk",
];

/// 从 `getprop` 的完整输出中提取属性表。
///
/// 输出形如：
/// ```text
/// [ro.product.model]: [MIX 2S]
/// [ro.build.version.sdk]: [33]
/// ```
pub fn parse_getprop(output: &str) -> Vec<(String, String)> {
    let mut props = Vec::new();

    for line in output.lines() {
        let line = line.trim();
        let Some(rest) = line.strip_prefix('[') else {
            continue;
        };
        let Some((key, value)) = rest.split_once("]: [") else {
            continue;
        };

        let value = value.strip_suffix(']').unwrap_or(value).trim();
        props.push((key.trim().to_owned(), value.to_owned()));
    }

    props
}

fn prop<'a>(props: &'a [(String, String)], key: &str) -> Option<&'a str> {
    props
        .iter()
        .find(|(k, _)| k == key)
        .map(|(_, v)| v.as_str())
        .filter(|v| !v.is_empty())
}

/// 由 serial 推断传输方式。
///
/// adb 的 `devices-l` 不直接给出传输类型，只能靠序列号特征判断：
/// 模拟器序列号形如 `emulator-5554`；无线设备形如 `192.168.1.10:5555`。
pub fn detect_transport(serial: &str) -> DeviceTransport {
    if serial.starts_with("emulator-") || serial.starts_with("localhost:") {
        return DeviceTransport::Emulator;
    }
    // 形如 host:port 的网络设备
    let mut parts = serial.rsplitn(2, ':');
    let port = parts.next().unwrap_or_default();
    let host = parts.next();
    if host.is_some_and(|h| !h.is_empty() && h.chars().all(|c| c.is_ascii_digit() || c == '.')) {
        return DeviceTransport::Wifi;
    }
    let _ = port;
    DeviceTransport::Usb
}

/// 由 adb 状态映射为前端契约里的连接状态。
pub fn map_state(state: DeviceState) -> DeviceConnectionState {
    match state {
        DeviceState::Device => DeviceConnectionState::Device,
        DeviceState::Offline => DeviceConnectionState::Offline,
        DeviceState::Unauthorized => DeviceConnectionState::Unauthorized,
        DeviceState::Connecting => DeviceConnectionState::Connecting,
        DeviceState::Authorizing => DeviceConnectionState::Authorizing,
        DeviceState::Special | DeviceState::NoPermissions | DeviceState::Unknown => {
            DeviceConnectionState::Unknown
        }
    }
}

/// 采集一台设备的完整信息。
pub async fn collect(client: &AdbClient, serial: &str, state: DeviceState) -> Result<DeviceInfo> {
    if !state.is_ready() {
        return Ok(DeviceInfo {
            serial: serial.to_owned(),
            state: map_state(state),
            is_emulator: detect_transport(serial) == DeviceTransport::Emulator,
            model: None,
            manufacturer: None,
            brand: None,
            device: None,
            android_version: None,
            sdk_int: None,
            screen_resolution: None,
            transport: detect_transport(serial),
        });
    }

    let getprop = client
        .shell(serial, "getprop")
        .await
        .map_err(map_adb_error)
        .and_then(|out| require_success(out, "读取设备属性"))?;
    let props = parse_getprop(&getprop.stdout);

    let resolution = client
        .shell(serial, "wm size")
        .await
        .map_err(map_adb_error)
        .map(|out| parse_wm_size(&out.stdout))
        .unwrap_or(None);

    let sdk_int = prop(&props, "ro.build.version.sdk").and_then(|v| v.parse().ok());

    debug!(serial, "设备属性采集完成");

    Ok(DeviceInfo {
        serial: serial.to_owned(),
        state: map_state(state),
        is_emulator: detect_transport(serial) == DeviceTransport::Emulator,
        model: prop(&props, "ro.product.model").map(str::to_owned),
        manufacturer: prop(&props, "ro.product.manufacturer").map(str::to_owned),
        brand: prop(&props, "ro.product.brand").map(str::to_owned),
        device: prop(&props, "ro.product.device").map(str::to_owned),
        android_version: prop(&props, "ro.build.version.release").map(str::to_owned),
        sdk_int,
        screen_resolution: resolution,
        transport: detect_transport(serial),
    })
}

/// 解析 `wm size` 的输出。
///
/// ```text
/// Physical size: 1080x2400
/// Override size: 720x1280      （开发者选项里改过分辨率时才存在）
/// ```
pub fn parse_wm_size(output: &str) -> Option<String> {
    let mut physical = None;
    let mut overrode = None;

    for line in output.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("Physical size:") {
            physical = Some(rest.trim().to_owned());
        } else if let Some(rest) = line.strip_prefix("Override size:") {
            overrode = Some(rest.trim().to_owned());
        }
    }

    overrode.or(physical)
}

/// shell 命令成功校验。
pub(crate) fn require_success(
    out: adb_client::ShellOutput,
    what: &str,
) -> Result<adb_client::ShellOutput> {
    if out.timed_out {
        return Err(CoreError::ShellFailed {
            code: -1,
            stderr: format!("{what}超时"),
        });
    }
    if out.exit_code != 0 {
        return Err(CoreError::ShellFailed {
            code: out.exit_code,
            stderr: out.text().to_owned(),
        });
    }
    Ok(out)
}

/// 把协议层错误翻译为领域错误。
pub(crate) fn map_adb_error(err: AdbError) -> CoreError {
    match err {
        AdbError::DeviceNotFound { serial } => CoreError::DeviceNotFound { serial },
        AdbError::ServerUnreachable { endpoint } => CoreError::AdbServerUnreachable { endpoint },
        AdbError::Io(e) => CoreError::Io(e),
        AdbError::ServerRejected { message } => CoreError::ShellFailed {
            code: -1,
            stderr: message,
        },
        AdbError::MalformedResponse { reason } => CoreError::ParseFailed {
            path: "<adb response>".into(),
            reason,
        },
        AdbError::ShellFailed { code, stderr } => CoreError::ShellFailed { code, stderr },
        AdbError::SyncFailed(message) => CoreError::ShellFailed {
            code: -1,
            stderr: message,
        },
        AdbError::UnexpectedLength { expected, actual } => CoreError::ParseFailed {
            path: "<adb response>".into(),
            reason: format!("响应长度异常：期望 {expected}，实际 {actual}"),
        },
        AdbError::TransferFailed { path, reason } => CoreError::ParseFailed { path, reason },
    }
}

/// `WANTED_PROPS` 的派生：只要其中任意一个即可认为设备属性可读。
pub fn has_core_props(props: &[(String, String)]) -> bool {
    WANTED_PROPS.iter().any(|key| prop(props, key).is_some())
}

#[cfg(test)]
mod tests {
    use super::*;

    const GETPROP_ANDROID13: &str = "\
[dalvik.vm.heapsize]: [512m]
[ro.product.model]: [MIX 2S]
[ro.product.manufacturer]: [Xiaomi]
[ro.product.brand]: [Xiaomi]
[ro.product.device]: [polaris]
[ro.build.version.release]: [13]
[ro.build.version.sdk]: [33]
[ro.build.id]: [TQ3A]
";

    const GETPROP_ANDROID9: &str = "\
[ro.product.model]: [Pixel 2]
[ro.product.manufacturer]: [Google]
[ro.product.brand]: [google]
[ro.product.device]: [walleye]
[ro.build.version.release]: [9]
[ro.build.version.sdk]: [28]
";

    #[test]
    fn 解析_getprop_输出() {
        let props = parse_getprop(GETPROP_ANDROID13);

        assert_eq!(prop(&props, "ro.product.model"), Some("MIX 2S"));
        assert_eq!(prop(&props, "ro.build.version.release"), Some("13"));
        assert_eq!(prop(&props, "ro.build.version.sdk"), Some("33"));
        assert_eq!(prop(&props, "ro.not.exist"), None);
    }

    #[test]
    fn 空属性的_getprop_返回_none() {
        let props = parse_getprop("[ro.product.model]: []\n");
        assert_eq!(prop(&props, "ro.product.model"), None);
    }

    #[test]
    fn 畸形行被跳过而不是报错() {
        let props = parse_getprop("garbage line\n[broken\n[ok]: [value]\n");
        assert_eq!(props.len(), 1);
        assert_eq!(prop(&props, "ok"), Some("value"));
    }

    #[test]
    fn 两个不同_android_版本都能解析() {
        for sample in [GETPROP_ANDROID13, GETPROP_ANDROID9] {
            let props = parse_getprop(sample);
            assert!(has_core_props(&props), "核心属性应被识别");
        }
    }

    #[test]
    fn 传输方式识别() {
        assert_eq!(detect_transport("d4535f72"), DeviceTransport::Usb);
        assert_eq!(detect_transport("emulator-5554"), DeviceTransport::Emulator);
        assert_eq!(
            detect_transport("localhost:5555"),
            DeviceTransport::Emulator
        );
        assert_eq!(detect_transport("192.168.1.10:5555"), DeviceTransport::Wifi);
        assert_eq!(detect_transport("10.0.0.5:37099"), DeviceTransport::Wifi);
    }

    #[test]
    fn 状态映射覆盖所有_adb_状态() {
        assert_eq!(
            map_state(DeviceState::Device),
            DeviceConnectionState::Device
        );
        assert_eq!(
            map_state(DeviceState::Offline),
            DeviceConnectionState::Offline
        );
        assert_eq!(
            map_state(DeviceState::Unauthorized),
            DeviceConnectionState::Unauthorized
        );
        assert_eq!(
            map_state(DeviceState::Connecting),
            DeviceConnectionState::Connecting
        );
        assert_eq!(
            map_state(DeviceState::Authorizing),
            DeviceConnectionState::Authorizing
        );
        assert_eq!(
            map_state(DeviceState::Special),
            DeviceConnectionState::Unknown
        );
        assert_eq!(
            map_state(DeviceState::NoPermissions),
            DeviceConnectionState::Unknown
        );
        assert_eq!(
            map_state(DeviceState::Unknown),
            DeviceConnectionState::Unknown
        );
    }

    #[test]
    fn 解析_wm_size() {
        assert_eq!(
            parse_wm_size("Physical size: 1080x2400\n"),
            Some("1080x2400".into())
        );
        assert_eq!(
            parse_wm_size("Physical size: 1080x2400\nOverride size: 720x1280\n"),
            Some("720x1280".into())
        );
        assert_eq!(parse_wm_size(""), None);
        assert_eq!(parse_wm_size("unknown output"), None);
    }

    #[tokio::test]
    async fn 未就绪的设备只返回基础信息() {
        use adb_client::testing::MockTransport;

        // 不应发出任何请求；这里预置一个「读即失败」的传输来验证短路
        let client = AdbClient::with_transport(Box::new(MockTransport::new(Vec::new())));

        let info = collect(&client, "abc123", DeviceState::Unauthorized)
            .await
            .unwrap();

        assert_eq!(info.serial, "abc123");
        assert_eq!(info.state, DeviceConnectionState::Unauthorized);
        assert!(!info.is_ready());
        assert_eq!(info.model, None);
        assert_eq!(info.title(), "abc123");
    }
}
