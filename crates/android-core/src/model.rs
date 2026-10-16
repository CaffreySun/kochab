//! 传输模型。
//!
//! 这些结构会经 Tauri IPC 发到渲染进程，因此：
//!
//! 1. 全部标注 `#[serde(rename_all = "camelCase")]`，与
//!    `packages/ipc-contract/src/types.ts` 逐字对齐；
//! 2. 字段改动等于契约改动，必须同步前端类型。

use serde::{Deserialize, Serialize};

/// 设备连接状态（与 `ipc-contract` 的 `DeviceConnectionState` 一致）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DeviceConnectionState {
    Offline,
    Unauthorized,
    Connecting,
    Device,
    Authorizing,
    Unknown,
}

impl DeviceConnectionState {
    pub fn is_ready(&self) -> bool {
        matches!(self, Self::Device)
    }
}

impl std::fmt::Display for DeviceConnectionState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let s = match self {
            Self::Offline => "offline",
            Self::Unauthorized => "unauthorized",
            Self::Connecting => "connecting",
            Self::Device => "device",
            Self::Authorizing => "authorizing",
            Self::Unknown => "unknown",
        };
        f.write_str(s)
    }
}

/// 设备传输方式。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DeviceTransport {
    Usb,
    Wifi,
    Emulator,
}

/// 一台设备的完整信息。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceInfo {
    pub serial: String,
    pub state: DeviceConnectionState,
    pub is_emulator: bool,
    pub model: Option<String>,
    pub manufacturer: Option<String>,
    pub brand: Option<String>,
    /// `ro.product.device`
    pub device: Option<String>,
    /// `ro.build.version.release`
    pub android_version: Option<String>,
    /// `ro.build.version.sdk`
    pub sdk_int: Option<u32>,
    /// 形如 `1080x2400`
    pub screen_resolution: Option<String>,
    pub transport: DeviceTransport,
}

impl DeviceInfo {
    /// 是否可以执行命令 / 投屏。
    pub fn is_ready(&self) -> bool {
        self.state.is_ready()
    }

    /// 展示用标题：`厂商 机型`，缺失时退化为序列号。
    pub fn title(&self) -> String {
        match (&self.manufacturer, &self.model) {
            (Some(m), Some(model)) => format!("{m} {model}"),
            (None, Some(model)) => model.clone(),
            _ => self.serial.clone(),
        }
    }
}

/// 已安装应用的信息。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub package_name: String,
    pub apk_path: Option<String>,
    pub version_name: Option<String>,
    pub version_code: Option<u64>,
    /// 应用显示名；无法确定时为 `None`，前端回退到包名
    pub label: Option<String>,
    pub is_system: bool,
    /// 是否为已启用的默认应用
    pub enabled: bool,
    /// Unix 毫秒时间戳
    pub first_install_time: Option<i64>,
    pub last_update_time: Option<i64>,
    pub granted_permissions: Option<u32>,
    pub apk_size_bytes: Option<u64>,
}

impl AppInfo {
    /// 列表中展示的主标题。
    pub fn display_name(&self) -> &str {
        self.label.as_deref().unwrap_or(&self.package_name)
    }
}

/// 设备上的一个文件或目录。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    /// 绝对路径（设备端）
    pub path: String,
    pub is_directory: bool,
    pub is_symlink: bool,
    /// 目录为 `None`
    pub size_bytes: Option<u64>,
    /// 形如 `drwxr-xr-x`
    pub permissions: String,
    /// Unix 毫秒时间戳
    pub modified_at: Option<i64>,
    pub owner: Option<String>,
    pub group: Option<String>,
}

/// shell 执行结果。
///
/// `adb shell` 会把 stdout 与 stderr 合并，因此这里没有 `stderr` 字段。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellOutput {
    pub command: String,
    pub exit_code: i32,
    pub stdout: String,
    pub timed_out: bool,
}

/// 安装结果。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallResult {
    pub package_name: Option<String>,
    /// `pm install` 的原始输出（可能是 `Success`，也可能是失败原因）
    pub raw_output: String,
    pub success: bool,
}

/// 外部工具链自检结果。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolchainStatus {
    pub adb_path: Option<String>,
    /// 形如 `1.0.41`：adb 内部版本号补上 `1.0.` 前缀，与 `adb version` 输出一致。
    pub adb_version: Option<String>,
    pub adb_server_reachable: bool,
    pub scrcpy_server_path: Option<String>,
    /// 面向用户的问题列表，空数组表示一切正常
    pub problems: Vec<String>,
}

impl ToolchainStatus {
    pub fn is_ok(&self) -> bool {
        self.problems.is_empty() && self.adb_server_reachable
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 序列化字段名为_camel_case() {
        let device = DeviceInfo {
            serial: "abc".into(),
            state: DeviceConnectionState::Device,
            is_emulator: false,
            model: Some("MIX 2S".into()),
            manufacturer: Some("Xiaomi".into()),
            brand: Some("Xiaomi".into()),
            device: Some("polaris".into()),
            android_version: Some("13".into()),
            sdk_int: Some(33),
            screen_resolution: Some("1080x2400".into()),
            transport: DeviceTransport::Usb,
        };

        let json = serde_json::to_string(&device).unwrap();
        assert!(json.contains(r#""serial":"abc""#));
        assert!(json.contains(r#""screenResolution":"1080x2400""#));
        assert!(json.contains(r#""isEmulator":false"#));
        assert!(json.contains(r#""transport":"usb""#));
    }

    #[test]
    fn 标题在厂商缺失时优雅降级() {
        let base = DeviceInfo {
            serial: "d4535f72".into(),
            state: DeviceConnectionState::Device,
            is_emulator: false,
            model: Some("MIX 2S".into()),
            manufacturer: None,
            brand: None,
            device: None,
            android_version: None,
            sdk_int: None,
            screen_resolution: None,
            transport: DeviceTransport::Usb,
        };

        assert_eq!(base.title(), "MIX 2S");

        let no_model = DeviceInfo {
            model: None,
            ..base.clone()
        };
        assert_eq!(no_model.title(), "d4535f72");

        let full = DeviceInfo {
            manufacturer: Some("Xiaomi".into()),
            ..base
        };
        assert_eq!(full.title(), "Xiaomi MIX 2S");
    }

    #[test]
    fn 应用显示名回退到包名() {
        let app = AppInfo {
            package_name: "com.example".into(),
            apk_path: None,
            version_name: None,
            version_code: None,
            label: None,
            is_system: false,
            enabled: true,
            first_install_time: None,
            last_update_time: None,
            granted_permissions: None,
            apk_size_bytes: None,
        };
        assert_eq!(app.display_name(), "com.example");

        let labeled = AppInfo {
            label: Some("随手记".into()),
            ..app
        };
        assert_eq!(labeled.display_name(), "随手记");
    }

    #[test]
    fn 工具链正常与否取决于问题列表() {
        let ok = ToolchainStatus {
            adb_path: Some("adb".into()),
            adb_version: Some("1.0.41".into()),
            adb_server_reachable: true,
            scrcpy_server_path: None,
            problems: vec![],
        };
        assert!(ok.is_ok());

        let broken = ToolchainStatus {
            adb_server_reachable: false,
            problems: vec!["未找到 scrcpy server".into()],
            ..ok
        };
        assert!(!broken.is_ok());
    }
}
