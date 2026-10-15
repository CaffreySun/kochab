//! 应用管理命令。

use std::path::PathBuf;

use android_core::{app, AppInfo, InstallResult};
use tauri::AppHandle;

use crate::error::{CommandError, CommandResult};
use crate::state::state;

#[tauri::command]
pub async fn app_list(
    app: AppHandle,
    serial: String,
    filter: Option<String>,
    show_system_apps: Option<bool>,
) -> CommandResult<Vec<AppInfo>> {
    let st = state(&app);
    let apps = app::list(
        &st.adb,
        &serial,
        filter.as_deref(),
        show_system_apps.unwrap_or(true),
    )
    .await?;
    Ok(apps)
}

/// 单个应用详情（合并 `dumpsys package`）。
#[tauri::command]
pub async fn app_details(
    app: AppHandle,
    serial: String,
    package_name: String,
) -> CommandResult<AppInfo> {
    let st = state(&app);
    app::details(&st.adb, &serial, &package_name)
        .await
        .map_err(Into::into)
}

/// 安装本地 APK。
#[tauri::command]
pub async fn app_install(
    app: AppHandle,
    serial: String,
    apk_path: String,
    allow_downgrade: Option<bool>,
) -> CommandResult<InstallResult> {
    let path = PathBuf::from(&apk_path);
    if !path.is_file() {
        return Err(CommandError::not_found(format!(
            "找不到 APK 文件：{apk_path}"
        )));
    }

    let st = state(&app);
    let result = app::install(&st.adb, &serial, &path, allow_downgrade.unwrap_or(false)).await?;

    if !result.success {
        tracing::warn!(serial, "安装失败：{}", app::install_failure_reason(&result));
    }
    Ok(result)
}

#[tauri::command]
pub async fn app_uninstall(
    app: AppHandle,
    serial: String,
    package_name: String,
    keep_data: Option<bool>,
) -> CommandResult<()> {
    let st = state(&app);
    app::uninstall(&st.adb, &serial, &package_name, keep_data.unwrap_or(false))
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn app_clear_data(
    app: AppHandle,
    serial: String,
    package_name: String,
) -> CommandResult<()> {
    let st = state(&app);
    app::clear_data(&st.adb, &serial, &package_name)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn app_launch(app: AppHandle, serial: String, package_name: String) -> CommandResult<()> {
    let st = state(&app);
    app::launch(&st.adb, &serial, &package_name)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn app_stop(app: AppHandle, serial: String, package_name: String) -> CommandResult<()> {
    let st = state(&app);
    app::stop(&st.adb, &serial, &package_name)
        .await
        .map_err(Into::into)
}

/// 启用 / 停用应用。
#[tauri::command]
pub async fn app_set_enabled(
    app: AppHandle,
    serial: String,
    package_name: String,
    enabled: bool,
) -> CommandResult<()> {
    let st = state(&app);
    app::set_enabled(&st.adb, &serial, &package_name, enabled)
        .await
        .map_err(Into::into)
}
