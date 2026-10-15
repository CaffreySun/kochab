//! Tauri 命令层。
//!
//! 约定：
//! - 每个命令只做「参数校验 → 调用领域服务 → 序列化返回」；
//! - 不写业务分支，不解析设备输出；
//! - 返回 [`crate::error::CommandResult`]，错误必须是可序列化的。

pub mod app;
pub mod device;
pub mod file;
pub mod session;
pub mod system;

/// 由 `generate_handler!` 展开的命令清单。
///
/// 新增命令时必须同步登记到 `@ac/ipc-contract` 的 `COMMANDS`。
/// 路径用 `$crate::` 前缀，宏才能在任意调用点展开。
#[macro_export]
macro_rules! invoke_handler {
    () => {
        tauri::generate_handler![
            $crate::commands::system::app_info,
            $crate::commands::system::toolchain_diagnostics,
            $crate::commands::system::shell_exec,
            $crate::commands::device::device_list,
            $crate::commands::device::device_info,
            $crate::commands::device::device_connect_wireless,
            $crate::commands::device::device_disconnect,
            $crate::commands::app::app_list,
            $crate::commands::app::app_details,
            $crate::commands::app::app_install,
            $crate::commands::app::app_uninstall,
            $crate::commands::app::app_clear_data,
            $crate::commands::app::app_launch,
            $crate::commands::app::app_stop,
            $crate::commands::app::app_set_enabled,
            $crate::commands::file::file_list,
            $crate::commands::file::file_stat,
            $crate::commands::file::file_pull,
            $crate::commands::file::file_push,
            $crate::commands::file::file_delete,
            $crate::commands::file::file_create_dir,
            $crate::commands::file::file_rename,
            $crate::commands::session::session_start,
            $crate::commands::session::session_stop,
            $crate::commands::session::session_list,
            $crate::commands::session::session_stats,
            $crate::commands::session::session_touch,
            $crate::commands::session::session_key,
            $crate::commands::session::session_text,
            $crate::commands::session::session_scroll,
        ]
    };
}
