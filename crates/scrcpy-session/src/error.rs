//! 投屏会话层错误。

use std::path::PathBuf;

use scrcpy_protocol::ProtocolError;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum SessionError {
    #[error("设备 {serial} 尚未连接")]
    DeviceNotConnected { serial: String },

    #[error("会话 {session_id} 不存在或已结束")]
    UnknownSession { session_id: String },

    #[error("同一台设备已存在进行中的投屏会话")]
    SessionAlreadyExists { serial: String },

    #[error("设备不支持投屏：{reason}")]
    UnsupportedDevice { reason: String },

    #[error("建立连接失败：{0}")]
    ConnectionFailed(String),

    #[error("设备端断开：{0}")]
    DeviceDisconnected(String),

    #[error("视频流已关闭")]
    VideoStreamClosed,

    #[error("控制通道写入失败：{0}")]
    ControlChannelClosed(String),

    #[error("推送到设备失败（{path}）：{reason}")]
    PushFailed { path: PathBuf, reason: String },

    #[error("建立端口转发失败：{0}")]
    ForwardFailed(String),

    #[error("等待设备端 server 就绪超时（{0} ms）")]
    ServerStartupTimeout(u64),

    #[error("等待设备端握手/流元信息超时（{0} ms）")]
    HandshakeTimeout(u64),

    #[error(transparent)]
    Protocol(#[from] ProtocolError),

    #[error("视频包解析失败：{0}")]
    Parse(#[from] scrcpy_protocol::stream::ParseError),

    #[error(transparent)]
    Core(#[from] android_core::CoreError),

    #[error(transparent)]
    Adb(#[from] adb_client::AdbError),

    #[error(transparent)]
    Io(#[from] std::io::Error),
}

pub type Result<T> = std::result::Result<T, SessionError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 错误文案面向用户可读() {
        assert_eq!(SessionError::VideoStreamClosed.to_string(), "视频流已关闭");
        assert_eq!(
            SessionError::ServerStartupTimeout(10_000).to_string(),
            "等待设备端 server 就绪超时（10000 ms）"
        );
        assert!(SessionError::ForwardFailed("端口被占用".into())
            .to_string()
            .contains("端口被占用"));
    }

    #[test]
    fn 协议错误可直接转换() {
        let err: SessionError = ProtocolError::InvalidUtf8.into();
        assert!(matches!(err, SessionError::Protocol(_)));
    }

    #[test]
    fn 推送失败携带路径() {
        let err = SessionError::PushFailed {
            path: PathBuf::from("/tmp/scrcpy-server.jar"),
            reason: "设备拒绝".into(),
        };
        assert!(err.to_string().contains("/tmp/scrcpy-server.jar"));
    }
}
