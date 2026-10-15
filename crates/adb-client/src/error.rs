use std::path::PathBuf;

use thiserror::Error;

/// adb server 协议层错误。
#[derive(Debug, Error)]
pub enum AdbError {
    #[error("无法连接到 adb server（{endpoint}）。请确认 Platform Tools 已安装且 adb 服务可用")]
    ServerUnreachable { endpoint: String },

    #[error("adb server 返回了失败响应：{message}")]
    ServerRejected { message: String },

    #[error("响应格式非法：{reason}")]
    MalformedResponse { reason: String },

    #[error("响应体长度不足：期望 {expected} 字节，实际 {actual} 字节")]
    UnexpectedLength { expected: usize, actual: usize },

    #[error("设备 {serial} 未连接")]
    DeviceNotFound { serial: String },

    #[error("shell 命令退出码 {code}：{stderr}")]
    ShellFailed { code: i32, stderr: String },

    #[error("sync 服务返回了 {0}")]
    SyncFailed(String),

    #[error("传输 {path} 失败：{reason}")]
    TransferFailed { path: PathBuf, reason: String },

    #[error(transparent)]
    Io(#[from] std::io::Error),
}

pub type Result<T> = std::result::Result<T, AdbError>;
