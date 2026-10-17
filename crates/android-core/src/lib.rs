//! Android 领域服务层。
//!
//! 把 `adb-client` 的字节级协议提升为面向产品的能力：
//! 设备发现与状态跟踪、应用安装/卸载/清理、文件浏览与传输、工具链定位。
//! 上层（Tauri 命令层）只依赖本 crate，不直接接触 adb 细节。
//!
//! # 分层约束
//!
//! 本 crate **不得**依赖 `tauri`。这样所有业务能力都能脱离 UI 独立测试，
//! 未来更换前端框架也不需要改动。

pub mod app;
pub mod device;
pub mod error;
pub mod file;
pub mod model;
pub mod overview;
pub mod testing;
pub mod toolchain;

pub use error::{CoreError, Result};
pub use model::{
    AppExportResult, AppInfo, BatteryInfo, BatteryStatus, DeviceConnectionState, DeviceInfo,
    DeviceOverview, DeviceTransport, ExportedApk, FileEntry, InstallResult, MemoryInfo,
    NetworkInfo, ShellOutput, StorageInfo, StorageVolume, SystemInfo, ToolchainStatus,
};
