//! Tauri 命令层。
//!
//! 约定：
//! - 每个命令只做「参数校验 → 调用领域服务 → 序列化返回」；
//! - 不写业务分支，不解析设备输出；
//! - 返回 [`crate::error::CommandResult`]，错误必须是可序列化的。

pub mod app;
pub mod device;
pub mod file;
pub mod media;
pub mod session;
pub mod system;

use std::path::PathBuf;

use tauri::{AppHandle, Manager};

use crate::error::{CommandError, CommandResult};
use crate::state::state;

/// 取系统「下载」目录，不存在就建出来。
///
/// 导出 APK、截屏、录屏都默认落到这里：用户不需要每次挑目录，
/// 文件也不是散落在临时文件夹里。
pub(crate) fn download_dir(app: &AppHandle) -> CommandResult<PathBuf> {
    let dir = app
        .path()
        .download_dir()
        .map_err(|_| CommandError::unavailable("系统「下载」目录不可用"))?;
    if !dir.exists() {
        std::fs::create_dir_all(&dir)?;
    }
    Ok(dir)
}

/// 设备必须处于 `device` 状态才能执行媒体 / 网络操作。
///
/// 以 adb server 的设备列表为准，而不是详情缓存：缓存可能停留在上一次扫描，
/// 设备刚断开时仍然显示 `device`。
pub(crate) async fn ensure_ready(app: &AppHandle, serial: &str) -> CommandResult<()> {
    let st = state(app);
    let entries = st.adb.devices().await?;
    let entry = entries
        .into_iter()
        .find(|e| e.serial == serial)
        .ok_or_else(|| CommandError::not_found(format!("设备 {serial} 不在连接列表中")))?;
    if !entry.state.is_ready() {
        return Err(CommandError::new(
            "device_not_ready",
            format!("设备 {serial} 当前状态为 {}，无法执行该操作", entry.state),
        ));
    }
    Ok(())
}

/// 由 `generate_handler!` 展开的命令清单。
///
/// 新增命令时必须同步登记到 `@kochab/ipc-contract` 的 `COMMANDS`。
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
            $crate::commands::device::device_overview,
            $crate::commands::device::device_wifi_enable,
            $crate::commands::device::device_wifi_disable,
            $crate::commands::device::device_reset_display,
            $crate::commands::device::device_display,
            $crate::commands::media::device_screenshot,
            $crate::commands::media::device_record_start,
            $crate::commands::media::device_record_stop,
            $crate::commands::media::device_record_status,
            $crate::commands::media::device_record_cancel,
            $crate::commands::app::app_list,
            $crate::commands::app::app_details,
            $crate::commands::app::app_install,
            $crate::commands::app::app_uninstall,
            $crate::commands::app::app_clear_data,
            $crate::commands::app::app_launch,
            $crate::commands::app::app_stop,
            $crate::commands::app::app_set_enabled,
            $crate::commands::app::app_export,
            $crate::commands::file::file_list,
            $crate::commands::file::file_stat,
            $crate::commands::file::file_pull,
            $crate::commands::file::file_pull_dir,
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
