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

/// 导出后落盘的一个安装文件。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportedApk {
    pub remote_path: String,
    pub local_path: String,
    pub bytes: u64,
}

/// 导出应用的结果。
///
/// 一个包可能有多个安装文件（base + split）；单个时 `directory` 是调用方选的目录，
/// 多个时会多一层以应用命名的子目录。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppExportResult {
    pub package_name: String,
    pub directory: String,
    pub files: Vec<ExportedApk>,
}

/// 电池充电状态，对应 `dumpsys battery` 的 `status`。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum BatteryStatus {
    /// `status: 1`
    Unknown,
    /// `status: 2`
    Charging,
    /// `status: 3`
    Discharging,
    /// `status: 4`
    NotCharging,
    /// `status: 5`
    Full,
}

/// 电池信息（`dumpsys battery`）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatteryInfo {
    /// 0–100；`level`/`scale` 换算后的百分比
    pub level: Option<u8>,
    pub status: BatteryStatus,
    /// AC / USB / 无线任一为 true
    pub charging: bool,
    /// 摄氏度；`temperature` 以 0.1℃ 为单位上报
    pub temperature_c: Option<f32>,
    pub voltage_mv: Option<u32>,
    /// `health` 的原始值；含义随厂商而异，不猜测
    pub health: Option<u32>,
    pub technology: Option<String>,
}

/// 一个挂载点的容量（`df -k`，单位 KB）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageVolume {
    pub total_kb: u64,
    pub used_kb: u64,
    pub available_kb: u64,
}

/// 存储占用。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageInfo {
    /// 内部存储（`/data`）
    pub data: StorageVolume,
    /// 用户可见的外部存储（`/storage/emulated` 或 `/data/media`）。
    /// 与内部存储共用同一块物理分区时数值相同，但这是设备的事实，不合并。
    pub external: Option<StorageVolume>,
}

/// 内存（`/proc/meminfo`，单位 KB）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryInfo {
    pub total_kb: u64,
    pub available_kb: u64,
}

/// 网络。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkInfo {
    /// wlan0 的 IPv4 地址；未连 Wi-Fi 时为 None
    pub wlan_ipv4: Option<String>,
}

/// 系统信息。设备型号等基础字段在 `DeviceInfo` 里，这里只放概览页独有的。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemInfo {
    pub android_version: Option<String>,
    pub sdk_int: Option<u32>,
    pub abi: Option<String>,
    pub security_patch: Option<String>,
    /// `/proc/uptime` 的第一项（秒）
    pub uptime_seconds: Option<u64>,
}

/// 设备概览。
///
/// 每一项都是**尽力而为**：读不到就是 `None`，不让一个命令失败拖垮整页。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceOverview {
    pub serial: String,
    pub battery: Option<BatteryInfo>,
    pub storage: Option<StorageInfo>,
    pub memory: Option<MemoryInfo>,
    pub network: NetworkInfo,
    pub system: SystemInfo,
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
