//! 面向前端的可序列化错误。
//!
//! 错误码是稳定契约：前端据此做差异化处理与埋点，
//! 而 `message` 的文案可以随时调整而不影响调用方逻辑。

use android_core::CoreError;
use serde::Serialize;

#[derive(Debug, thiserror::Error, Serialize)]
#[error("{message}")]
pub struct CommandError {
    /// 稳定的机器可读错误码，snake_case
    pub code: &'static str,
    /// 面向用户的可读文案
    pub message: String,
}

impl CommandError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub fn invalid_argument(message: impl Into<String>) -> Self {
        Self::new("invalid_argument", message)
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new("not_found", message)
    }

    pub fn unavailable(message: impl Into<String>) -> Self {
        Self::new("unavailable", message)
    }
}

pub type CommandResult<T> = std::result::Result<T, CommandError>;

/// 领域错误 → 前端错误码。
impl From<CoreError> for CommandError {
    fn from(err: CoreError) -> Self {
        Self::new(code_of_core(&err), err.to_string())
    }
}

/// `CoreError` → 稳定错误码。
fn code_of_core(err: &CoreError) -> &'static str {
    match err {
        CoreError::DeviceNotFound { .. } => "device_not_found",
        CoreError::DeviceNotReady { .. } => "device_not_ready",
        CoreError::ShellFailed { .. } => "shell_failed",
        CoreError::PermissionDenied(_) => "permission_denied",
        CoreError::PathNotFound(_) => "path_not_found",
        CoreError::NotADirectory(_) => "not_a_directory",
        CoreError::NotAFile(_) => "not_a_file",
        CoreError::AlreadyExists(_) => "already_exists",
        CoreError::AdbNotFound | CoreError::AdbServerUnreachable { .. } => "adb_unavailable",
        CoreError::MissingToolchain(_) => "toolchain_missing",
        _ => "internal",
    }
}

/// adb 协议层错误 → 前端错误码。
impl From<adb_client::AdbError> for CommandError {
    fn from(err: adb_client::AdbError) -> Self {
        Self::new(code_of_adb(&err), err.to_string())
    }
}

/// `AdbError` → 稳定错误码。
fn code_of_adb(err: &adb_client::AdbError) -> &'static str {
    match err {
        adb_client::AdbError::DeviceNotFound { .. } => "device_not_found",
        adb_client::AdbError::ServerUnreachable { .. } => "adb_unavailable",
        adb_client::AdbError::SyncFailed(_) => "file_transfer_failed",
        adb_client::AdbError::TransferFailed { .. } => "file_transfer_failed",
        _ => "adb_error",
    }
}

/// 投屏会话错误 → 前端错误码。
impl From<scrcpy_session::SessionError> for CommandError {
    fn from(err: scrcpy_session::SessionError) -> Self {
        use scrcpy_session::SessionError as E;

        // 嵌套的 adb / 领域错误沿用它们自己的错误码，前端不必区分来源
        let code = match &err {
            E::DeviceNotConnected { .. } => "device_not_connected",
            E::UnknownSession { .. } => "session_not_found",
            E::SessionAlreadyExists { .. } => "session_exists",
            E::UnsupportedDevice { .. } => "unsupported_device",
            E::ConnectionFailed(_) => "session_connect_failed",
            E::DeviceDisconnected(_) => "device_disconnected",
            E::VideoStreamClosed => "video_stream_closed",
            E::ControlChannelClosed(_) => "control_channel_closed",
            E::PushFailed { .. } => "file_transfer_failed",
            E::ForwardFailed(_) => "tunnel_failed",
            E::ServerStartupTimeout(_) | E::HandshakeTimeout(_) => "session_timeout",
            E::Adb(inner) => return Self::new(code_of_adb(inner), err.to_string()),
            E::Core(inner) => return Self::new(code_of_core(inner), err.to_string()),
            E::Protocol(_) | E::Parse(_) | E::Io(_) => "session_error",
        };
        Self::new(code, err.to_string())
    }
}

/// 命令层的兜底转换：任何未预期的错误都不该把细节泄露给终端用户。
impl From<std::io::Error> for CommandError {
    fn from(err: std::io::Error) -> Self {
        Self::new("io_error", format!("本地文件操作失败：{err}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn code_of(err: CoreError) -> &'static str {
        let cmd: CommandError = err.into();
        cmd.code
    }

    #[test]
    fn 领域错误映射到稳定错误码() {
        use android_core::CoreError;

        assert_eq!(
            code_of(CoreError::DeviceNotFound { serial: "x".into() }),
            "device_not_found"
        );
        assert_eq!(
            code_of(CoreError::DeviceNotReady {
                serial: "x".into(),
                state: "offline".into()
            }),
            "device_not_ready"
        );
        assert_eq!(
            code_of(CoreError::AdbServerUnreachable {
                endpoint: "127.0.0.1:5037".into()
            }),
            "adb_unavailable"
        );
        assert_eq!(
            code_of(CoreError::PathNotFound("/x".into())),
            "path_not_found"
        );
        assert_eq!(
            code_of(CoreError::NotADirectory("/x".into())),
            "not_a_directory"
        );
        assert_eq!(
            code_of(CoreError::AlreadyExists("/x".into())),
            "already_exists"
        );
        assert_eq!(
            code_of(CoreError::MissingToolchain("scrcpy-server")),
            "toolchain_missing"
        );
        assert_eq!(code_of(CoreError::Internal("boom".into())), "internal");
    }

    #[test]
    fn 错误文案原样传递给用户() {
        use android_core::CoreError;

        let err: CommandError = CoreError::PathNotFound("/sdcard/x".into()).into();
        assert_eq!(err.message, "路径不存在：/sdcard/x");
    }

    #[test]
    fn adb_错误映射到独立错误码() {
        let sync: CommandError = adb_client::AdbError::SyncFailed("权限不足".into()).into();
        assert_eq!(sync.code, "file_transfer_failed");

        let server: CommandError = adb_client::AdbError::ServerUnreachable {
            endpoint: "x".into(),
        }
        .into();
        assert_eq!(server.code, "adb_unavailable");

        let not_found: CommandError =
            adb_client::AdbError::DeviceNotFound { serial: "x".into() }.into();
        assert_eq!(not_found.code, "device_not_found");
    }

    #[test]
    fn 构造函数与序列化() {
        let err = CommandError::new("device_not_found", "设备 emulator-5554 不在连接列表中");
        let json = serde_json::to_value(&err).expect("序列化不应失败");

        assert_eq!(json["code"], "device_not_found");
        assert_eq!(json["message"], "设备 emulator-5554 不在连接列表中");
    }

    #[test]
    fn 语义化构造器() {
        assert_eq!(
            CommandError::invalid_argument("serial 不能为空").code,
            "invalid_argument"
        );
        assert_eq!(CommandError::not_found("没有这个会话").code, "not_found");
        assert_eq!(CommandError::unavailable("adb 未连接").code, "unavailable");
    }

    #[test]
    fn io_错误被包装成用户可读文案() {
        let err: CommandError = std::io::Error::new(std::io::ErrorKind::NotFound, "boom").into();
        assert_eq!(err.code, "io_error");
        assert!(err.message.contains("本地文件操作失败"));
    }
}
