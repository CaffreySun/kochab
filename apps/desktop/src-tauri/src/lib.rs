//! Android Controller 桌面应用入口。
//!
//! 该 crate 只做四件事：初始化日志、装配 Tauri 插件、建立 adb 连接、注册命令。
//! 所有业务能力都下沉到 workspace 的 `android-core` / `scrcpy-session` 中，
//! 以便脱离 UI 独立测试。

mod commands;
mod error;
mod state;
mod watcher;

use adb_client::AdbClient;
use state::AppState;
use tauri::{AppHandle, Manager};

pub use error::{CommandError, CommandResult};

pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,android_controller_lib=debug".into()),
        )
        .init();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let handle = app.handle().clone();

            // adb 连接采用惰性建立：启动时连不上也不应该阻止界面出现，
            // 用户可以在「无设备」状态下看到明确的诊断信息。
            let adb = AdbClient::new(adb_client::DEFAULT_ENDPOINT)
                .unwrap_or_else(|e| panic!("默认 adb 端点无法解析：{e}"));
            tracing::info!(endpoint = adb.endpoint(), "adb 客户端就绪（惰性连接）");

            // scrcpy-server 随应用分发，落在资源目录里。
            // 领域层不依赖 Tauri，所以由这里把路径问出来再传下去。
            let resource_dir = app.path().resource_dir().ok();
            match &resource_dir {
                Some(dir) => tracing::info!(dir = %dir.display(), "资源目录"),
                None => tracing::warn!(
                    "无法解析资源目录，scrcpy-server 只能靠 adb 同目录或 SCRCPY_SERVER_PATH"
                ),
            }

            app.manage(AppState::new(adb, resource_dir));
            watcher::spawn(handle);
            spawn_stale_cleanup(app.handle().clone());

            tracing::info!(
                version = app.package_info().version.to_string(),
                "Android Controller 启动"
            );
            Ok(())
        })
        .invoke_handler(crate::invoke_handler!())
        .run(tauri::generate_context!())
        .expect("Tauri 应用启动失败");
}

/// 启动时清理上次异常退出留下的设备端残留。
///
/// 正常停止会话时 `ScrcpySession::stop` 会自己撤隧道、删 jar，
/// 但进程被杀 / 崩溃时不会——残留会随每次启动越积越多。
/// 这一步只做一次、且**不阻塞**界面启动，失败也只记日志。
fn spawn_stale_cleanup(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let st = app.state::<AppState>();

        let entries = match st.adb.devices().await {
            Ok(entries) => entries,
            Err(e) => {
                tracing::debug!(error = %e, "启动清理：读取设备列表失败");
                return;
            }
        };

        for entry in entries {
            if entry.state != adb_client::DeviceState::Device {
                continue;
            }
            scrcpy_session::clean_stale_resources(&st.adb, &entry.serial).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 契约与命令清单双向一致() {
        let contract = include_str!("../../../../packages/ipc-contract/src/commands.ts");
        let handler = include_str!("commands/mod.rs");

        let contract_names = extract_command_names(contract);
        let handler_names = extract_handler_commands(handler);

        assert!(
            contract_names.len() > 15,
            "契约里没有解析到命令名，实际 {} 个",
            contract_names.len()
        );
        assert!(!handler_names.is_empty(), "命令清单里没有解析到命令");

        for name in &contract_names {
            assert!(
                handler.contains(&format!("::{name},")),
                "命令 {name} 已登记在 @ac/ipc-contract，但没有出现在 generate_handler! 中"
            );
        }
        for name in &handler_names {
            assert!(
                contract.contains(&format!("'{name}'")),
                "命令 {name} 已注册到 Tauri，但没有登记在 @ac/ipc-contract 中"
            );
        }
    }

    /// 从 TS 源文件里抽出所有形如 `snake_case` 的单引号字符串字面量。
    fn extract_command_names(source: &str) -> Vec<String> {
        let mut out = Vec::new();
        let mut chars = source.chars().peekable();

        while chars.next().is_some() {
            // 只处理形如 `key: 'value',` 的映射项，避免把注释里的文字也算进来
            if chars.peek() != Some(&'\'') {
                continue;
            }
            chars.next();

            let mut value = String::new();
            let mut closed = false;
            for c in chars.by_ref() {
                if c == '\'' {
                    closed = true;
                    break;
                }
                value.push(c);
            }
            if !closed || !is_command_name(&value) {
                continue;
            }
            // 映射项后面必须紧跟逗号，才是真正的命令登记
            if chars.peek() == Some(&',') {
                out.push(value);
            }
        }
        out
    }

    fn is_command_name(value: &str) -> bool {
        !value.is_empty()
            && value.contains('_')
            && value
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
    }

    /// 从 `generate_handler!` 里抽出 `$crate::commands::<模块>::<命令>` 的命令名。
    fn extract_handler_commands(source: &str) -> Vec<String> {
        source
            .lines()
            .filter_map(|line| line.trim().strip_prefix("$crate::commands::"))
            .filter_map(|rest| rest.split("::").last())
            .map(|name| name.trim_end_matches(',').to_owned())
            .filter(|name| is_command_name(name))
            .collect()
    }

    #[test]
    fn 应用自述可用() {
        let info = commands::system::app_info().expect("app_info 不应失败");
        assert_eq!(info.name, "Android Controller");
        assert!(!info.version.is_empty());
    }
}
