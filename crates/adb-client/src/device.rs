//! 设备列表的解析与模型。
//!
//! # `host:devices-l` 的实际格式（已对 adb 37.0.0 实测）
//!
//! 新版本 Platform Tools 返回的是**长格式**，且 serial 与 state 之间用**空格**分隔
//! （老版本用制表符）：
//!
//! ```text
//! d4535f72               device product:polaris model:MIX_2S device:polaris transport_id:5
//! ```
//!
//! 而 `host:track-devices` 推送的仍然是**短格式**，用制表符分隔：
//!
//! ```text
//! d4535f72\tdevice
//! ```
//!
//! 因此解析必须同时容忍「制表符」与「空格」两种分隔符，且不能假定 `state` 之后没有别的字段。

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::error::{AdbError, Result};

/// adb server 报告的设备状态。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DeviceState {
    /// 就绪，可执行命令
    Device,
    /// 已连接但无法通信
    Offline,
    /// 设备上尚未确认 USB 调试授权
    Unauthorized,
    /// 正在建立连接
    Connecting,
    /// 新协议（无线调试）授权中
    Authorizing,
    /// 处于 bootloader / recovery 等特殊模式
    Special,
    /// 无权限（Windows 驱动问题）
    NoPermissions,
    /// adb server 未识别的新状态
    #[serde(other)]
    Unknown,
}

impl DeviceState {
    /// 把 wire 上的原始字符串映射为枚举，未知值归入 `Unknown` 而非报错。
    ///
    /// adb 会随版本新增状态（如 `authorizing`），**不能**因为不认识就失败，
    /// 否则整个设备列表会不可用。
    pub fn parse(raw: &str) -> Self {
        match raw.trim() {
            "device" => Self::Device,
            "offline" => Self::Offline,
            "unauthorized" => Self::Unauthorized,
            "connecting" => Self::Connecting,
            "authorizing" => Self::Authorizing,
            "bootloader" | "recovery" | "rescue" | "sideload" | "host" => Self::Special,
            "no" => Self::NoPermissions,
            _ => Self::Unknown,
        }
    }

    /// 是否可以执行命令 / 建立投屏会话。
    pub fn is_ready(&self) -> bool {
        matches!(self, Self::Device)
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Device => "device",
            Self::Offline => "offline",
            Self::Unauthorized => "unauthorized",
            Self::Connecting => "connecting",
            Self::Authorizing => "authorizing",
            Self::Special => "special",
            Self::NoPermissions => "no_permissions",
            Self::Unknown => "unknown",
        }
    }
}

impl std::fmt::Display for DeviceState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// `host:devices-l` / `host:track-devices` 中的一行。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceListEntry {
    pub serial: String,
    pub state: DeviceState,
    /// 长格式附带的 `key:value` 属性（`model` / `product` / `transport_id` …）。
    /// 短格式下为空。
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub props: BTreeMap<String, String>,
}

impl DeviceListEntry {
    /// 解析一行设备记录。
    ///
    /// 分隔规则：制表符优先；没有制表符时按空白切词，取第二段作为状态，
    /// 其余 `k:v` 归入 [`Self::props`]。
    pub fn parse_line(line: &str) -> Result<Self> {
        let line = line.trim_end_matches(['\r', '\n']);
        if line.trim().is_empty() {
            return Err(AdbError::MalformedResponse {
                reason: "设备行为空".into(),
            });
        }

        if line.contains('\t') {
            let mut parts = line.splitn(2, '\t');
            let serial = parts.next().unwrap_or_default().trim().to_owned();
            let rest = parts.next().unwrap_or_default();
            return Self::build(serial, rest);
        }

        // 空格分隔的长格式
        let mut words = line.split_whitespace();
        let serial = words.next().unwrap_or_default().to_owned();
        let rest: Vec<&str> = words.collect();
        Self::build(serial, &rest.join(" "))
    }

    fn build(serial: String, rest: &str) -> Result<Self> {
        if serial.is_empty() {
            return Err(AdbError::MalformedResponse {
                reason: format!("设备行 serial 为空：{rest:?}"),
            });
        }

        let mut words = rest.split_whitespace();
        let Some(state_raw) = words.next() else {
            return Err(AdbError::MalformedResponse {
                reason: format!("设备行缺少状态字段：{serial:?}"),
            });
        };
        let state = DeviceState::parse(state_raw);

        let mut props = BTreeMap::new();
        for word in words {
            if let Some((key, value)) = word.split_once(':') {
                props.insert(key.to_owned(), value.to_owned());
            }
        }

        Ok(Self {
            serial,
            state,
            props,
        })
    }

    /// 长格式里附带的某个属性。
    pub fn prop(&self, key: &str) -> Option<&str> {
        self.props.get(key).map(String::as_str)
    }
}

/// 解析 `host:devices-l` 的完整响应。
pub fn parse_device_list(payload: &[u8]) -> Result<Vec<DeviceListEntry>> {
    let text = String::from_utf8_lossy(payload);
    let mut devices = Vec::new();

    for line in text.lines() {
        if line.trim().is_empty() {
            continue;
        }
        devices.push(DeviceListEntry::parse_line(line)?);
    }

    Ok(devices)
}

/// `host:track-devices` 推送所代表的变化类型。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeviceChange {
    /// 设备列表中出现了一个新序列号
    Added,
    /// 设备从列表中消失
    Removed,
    /// 设备上线（从非就绪变为就绪）
    Online,
    /// 设备下线（从就绪变为非就绪）
    Offline,
    /// 设备仍在列表中但状态发生了变化
    StateChanged,
}

/// 比较新旧两条记录，得出变化类型。
pub fn diff_state(previous: &DeviceListEntry, current: &DeviceListEntry) -> DeviceChange {
    // track-devices 用空 serial 表示「所有设备都消失了」
    if current.serial.is_empty() {
        return DeviceChange::Removed;
    }
    if previous.serial != current.serial {
        return DeviceChange::Added;
    }
    if previous.state == current.state {
        return DeviceChange::StateChanged;
    }
    match (previous.state.is_ready(), current.state.is_ready()) {
        (false, true) => DeviceChange::Online,
        (true, false) => DeviceChange::Offline,
        _ => DeviceChange::StateChanged,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 解析制表符分隔的短格式() {
        let entry = DeviceListEntry::parse_line("d4535f72\tdevice").unwrap();
        assert_eq!(entry.serial, "d4535f72");
        assert_eq!(entry.state, DeviceState::Device);
        assert!(entry.props.is_empty());
    }

    #[test]
    fn 解析空格分隔的长格式() {
        // 实测 adb 37.0.0 的 host:devices-l 输出
        let line = "d4535f72               device product:polaris model:MIX_2S device:polaris transport_id:5";
        let entry = DeviceListEntry::parse_line(line).unwrap();

        assert_eq!(entry.serial, "d4535f72");
        assert_eq!(entry.state, DeviceState::Device);
        assert_eq!(entry.prop("model"), Some("MIX_2S"));
        assert_eq!(entry.prop("product"), Some("polaris"));
        assert_eq!(entry.prop("transport_id"), Some("5"));
    }

    #[test]
    fn 容忍_crlf_换行() {
        let entry = DeviceListEntry::parse_line("emulator-5554\tdevice\r\n").unwrap();
        assert_eq!(entry.serial, "emulator-5554");
        assert_eq!(entry.state, DeviceState::Device);
    }

    #[test]
    fn 无线设备序列号包含冒号() {
        let entry = DeviceListEntry::parse_line("192.168.1.10:5555\toffline").unwrap();
        assert_eq!(entry.serial, "192.168.1.10:5555");
        assert_eq!(entry.state, DeviceState::Offline);
    }

    #[test]
    fn 未知状态归入_unknown_而不是报错() {
        let entry = DeviceListEntry::parse_line("abc\tbrand-new-state").unwrap();
        assert_eq!(entry.state, DeviceState::Unknown);
        assert!(!entry.state.is_ready());
    }

    #[test]
    fn 缺少状态字段时报错() {
        assert!(DeviceListEntry::parse_line("no-separator-at-all").is_err());
        assert!(DeviceListEntry::parse_line("   ").is_err());
    }

    #[test]
    fn 空_serial_被拒绝() {
        assert!(DeviceListEntry::parse_line("\tdevice").is_err());
    }

    #[test]
    fn 解析多行列表并忽略空行() {
        let payload = b"d4535f72\tdevice\n\nemulator-5554\toffline\n";
        let devices = parse_device_list(payload).unwrap();

        assert_eq!(devices.len(), 2);
        assert_eq!(devices[0].serial, "d4535f72");
        assert_eq!(devices[1].state, DeviceState::Offline);
    }

    #[test]
    fn 空响应得到空列表() {
        assert!(parse_device_list(b"").unwrap().is_empty());
        assert!(parse_device_list(b"\n\n").unwrap().is_empty());
    }

    #[test]
    fn 就绪判定() {
        assert!(DeviceState::Device.is_ready());
        for state in [
            DeviceState::Offline,
            DeviceState::Unauthorized,
            DeviceState::Connecting,
            DeviceState::Special,
            DeviceState::NoPermissions,
            DeviceState::Unknown,
        ] {
            assert!(!state.is_ready(), "{state} 不应被视为就绪");
        }
    }

    #[test]
    fn 状态差异判定() {
        let on = entry("a", DeviceState::Device);
        let off = entry("a", DeviceState::Offline);

        assert_eq!(diff_state(&off, &on), DeviceChange::Online);
        assert_eq!(diff_state(&on, &off), DeviceChange::Offline);
        assert_eq!(
            diff_state(&off, &entry("b", DeviceState::Device)),
            DeviceChange::Added
        );
        assert_eq!(diff_state(&off, &off), DeviceChange::StateChanged);
    }

    #[test]
    fn 空序列号表示设备被移除() {
        let removed = DeviceListEntry {
            serial: String::new(),
            state: DeviceState::Unknown,
            props: BTreeMap::new(),
        };
        assert_eq!(
            diff_state(&entry("a", DeviceState::Device), &removed),
            DeviceChange::Removed
        );
    }

    #[test]
    fn 就绪到非就绪之间不会误判为上下线() {
        let unauthorized = entry("a", DeviceState::Unauthorized);
        let offline = entry("a", DeviceState::Offline);
        assert_eq!(
            diff_state(&unauthorized, &offline),
            DeviceChange::StateChanged
        );
    }

    fn entry(serial: &str, state: DeviceState) -> DeviceListEntry {
        DeviceListEntry {
            serial: serial.into(),
            state,
            props: BTreeMap::new(),
        }
    }
}
