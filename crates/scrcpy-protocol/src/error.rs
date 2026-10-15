use thiserror::Error;

/// 协议层错误。
///
/// 这一层的错误全部是「字节布局 / 版本不兼容」类问题，
/// 不应混入网络或 adb 相关的错误，以保证编解码可以被独立测试。
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum ProtocolError {
    #[error("数据不足：需要 {needed} 字节，实际 {available} 字节")]
    Truncated { needed: usize, available: usize },

    #[error("缓冲区末尾存在多余数据")]
    TrailingBytes,

    #[error("不支持的 scrcpy 协议版本：{0}")]
    UnsupportedVersion(String),

    #[error("设备端拒绝了连接：{0}")]
    ConnectionRefused(String),

    #[error("非法的控制消息类型：{0:#04x}")]
    InvalidClientMessage(u8),

    #[error("非法的设备消息类型：{0:#04x}")]
    InvalidDeviceMessage(u8),

    #[error("字符串字段不是合法 UTF-8")]
    InvalidUtf8,

    #[error("JSON 解析失败：{reason}")]
    MalformedJson { reason: String },

    #[error("字段值超出允许范围：{field} = {value}")]
    FieldOutOfRange { field: &'static str, value: u64 },
}

pub type Result<T> = std::result::Result<T, ProtocolError>;
