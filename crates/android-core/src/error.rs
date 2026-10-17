use std::path::PathBuf;

use adb_client::AdbError;
use thiserror::Error;

/// 领域服务层错误。
///
/// 对外（Tauri 命令层）暴露的错误文案面向最终用户，
/// 因此在这一层完成「技术错误 → 用户可读提示」的翻译。
#[derive(Debug, Error)]
pub enum CoreError {
    #[error("未找到可用的 adb 可执行文件")]
    AdbNotFound,

    #[error("adb server 未在响应（尝试连接 {endpoint}）。请确认已安装 Android Platform Tools")]
    AdbServerUnreachable { endpoint: String },

    #[error("设备 {serial} 不在连接列表中")]
    DeviceNotFound { serial: String },

    #[error("设备 {serial} 当前状态为 {state}，无法执行该操作")]
    DeviceNotReady { serial: String, state: String },

    #[error("shell 命令执行失败（退出码 {code}）：{stderr}")]
    ShellFailed { code: i32, stderr: String },

    #[error("操作被设备拒绝：{0}")]
    PermissionDenied(String),

    #[error("{0}")]
    InvalidState(String),

    #[error("路径不存在：{0}")]
    PathNotFound(String),

    #[error("路径不是目录：{0}")]
    NotADirectory(String),

    #[error("路径不是文件：{0}")]
    NotAFile(String),

    #[error("目标已存在：{0}")]
    AlreadyExists(String),

    #[error("无法解析 {path} 的内容：{reason}")]
    ParseFailed { path: PathBuf, reason: String },

    #[error("缺少 {0}")]
    MissingToolchain(&'static str),

    #[error(transparent)]
    Io(#[from] std::io::Error),

    #[error(transparent)]
    Adb(#[from] AdbError),

    #[error(transparent)]
    Json(#[from] serde_json::Error),

    #[error("内部错误：{0}")]
    Internal(String),
}

pub type Result<T> = std::result::Result<T, CoreError>;
