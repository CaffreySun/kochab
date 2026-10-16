//! 系统级命令：应用自述、工具链自检、shell 执行。

use android_core::{ShellOutput, ToolchainStatus};
use serde::Serialize;
use tauri::AppHandle;

use crate::error::{CommandError, CommandResult};
use crate::state::state;

/// 桌面应用自述，用于「关于」面板与前端能力探测。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSelfInfo {
    pub name: &'static str,
    pub version: &'static str,
    pub tauri_version: &'static str,
}

#[tauri::command]
pub fn app_info() -> CommandResult<AppSelfInfo> {
    Ok(AppSelfInfo {
        name: "Android Controller",
        version: env!("CARGO_PKG_VERSION"),
        tauri_version: tauri::VERSION,
    })
}

/// 工具链自检：adb 是否可用、scrcpy server 是否就位。
#[tauri::command]
pub async fn toolchain_diagnostics(app: AppHandle) -> CommandResult<ToolchainStatus> {
    let st = state(&app);
    Ok(android_core::toolchain::diagnose_with(&st.resource_dirs(), Some(&st.adb)).await)
}

/// 执行一条任意 shell 命令（供高级用户排障使用）。
#[tauri::command]
pub async fn shell_exec(
    app: AppHandle,
    serial: String,
    command: String,
    timeout_ms: Option<u64>,
) -> CommandResult<ShellOutput> {
    if command.trim().is_empty() {
        return Err(CommandError::invalid_argument("命令不能为空"));
    }

    let st = state(&app);
    let timeout = std::time::Duration::from_millis(timeout_ms.unwrap_or(30_000));
    let out = st
        .adb
        .shell_with_timeout(&serial, &command, timeout)
        .await?;

    Ok(ShellOutput {
        command: out.command,
        exit_code: out.exit_code,
        stdout: out.stdout,
        timed_out: out.timed_out,
    })
}
