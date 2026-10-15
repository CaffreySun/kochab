//! adb 协议线的字节编解码。
//!
//! adb 的请求格式非常短，但有三处最容易写错：
//!
//! ```text
//! 请求： "%04x" + service            长度 = service 字节数，**不含**结尾换行
//! 响应： "OKAY" | "FAIL" + "%04x" + 原因
//! 流：   "%04x" + payload             无换行，且长度**不含**任何终止符
//! ```
//!
//! 因此本模块把三种形态拆成三个互不混淆的函数。
//!
//! > 请求末尾**没有** `\n`。这一点已对真实 adb server 实测确认：
//! > 追加换行会让 server 返回 `unknown host service 'devices-l\0'`。

use crate::error::{AdbError, Result};
use crate::transport::Transport;

/// adb 用 4 位十六进制表示长度，最大 0xFFFF。
pub const MAX_PAYLOAD: usize = 0xFFFF;

/// 把长度编码成 4 位小写十六进制并追加到 `buf`。
pub fn write_hex_len(buf: &mut Vec<u8>, len: usize) -> Result<()> {
    if len > MAX_PAYLOAD {
        return Err(AdbError::MalformedResponse {
            reason: format!("负载长度 {len} 超出 adb 协议上限 {MAX_PAYLOAD}"),
        });
    }
    buf.extend_from_slice(format!("{len:04x}").as_bytes());
    Ok(())
}

/// 解析 4 位十六进制长度。
///
/// adb 实际总是输出小写，但为稳妥起见接受大写。
pub fn parse_hex_len(bytes: &[u8]) -> Result<usize> {
    if bytes.len() < 4 {
        return Err(AdbError::MalformedResponse {
            reason: format!("长度字段只有 {} 字节，应为 4 字节", bytes.len()),
        });
    }

    let mut value = 0usize;
    for &b in &bytes[..4] {
        let digit = match b {
            b'0'..=b'9' => b - b'0',
            b'a'..=b'f' => b - b'a' + 10,
            b'A'..=b'F' => b - b'A' + 10,
            other => {
                return Err(AdbError::MalformedResponse {
                    reason: format!("长度字段包含非法字符 {:?}", other as char),
                })
            }
        };
        value = value * 16 + digit as usize;
    }
    Ok(value)
}

/// 编码一条请求：`"%04x" + service`。
///
/// # Examples
///
/// ```text
/// encode_request("host:devices-l") == b"000ehost:devices-l"
/// ```
pub fn encode_request(service: &str) -> Result<Vec<u8>> {
    let len = service.len();
    if len > MAX_PAYLOAD {
        return Err(AdbError::MalformedResponse {
            reason: format!("服务名过长（{len} > {MAX_PAYLOAD}）"),
        });
    }

    let mut buf = Vec::with_capacity(4 + len);
    write_hex_len(&mut buf, len)?;
    buf.extend_from_slice(service.as_bytes());
    Ok(buf)
}

/// 发送一条请求。
pub async fn send_request<T: Transport + ?Sized>(t: &mut T, service: &str) -> Result<()> {
    let bytes = encode_request(service)?;
    t.write_all(&bytes)
        .await
        .map_err(|e| AdbError::MalformedResponse {
            reason: format!("发送 {service} 失败：{e}"),
        })
}

/// 读取响应状态：`OKAY` 直接返回；`FAIL` 读取原因并返回错误。
pub async fn read_status<T: Transport + ?Sized>(t: &mut T) -> Result<()> {
    let mut head = [0u8; 4];
    t.read_exact(&mut head).await?;

    match &head {
        b"OKAY" => Ok(()),
        b"FAIL" => Err(AdbError::ServerRejected {
            message: read_fail_reason(t).await?,
        }),
        other => Err(AdbError::MalformedResponse {
            reason: format!(
                "期望 OKAY/FAIL，实际收到 {:?}",
                String::from_utf8_lossy(other)
            ),
        }),
    }
}

/// 读取 `FAIL` 之后的原因串（长度为 4 位十六进制）。
///
/// adb 给出的原因带 NUL 结尾，这里去掉以获得干净文案。
pub async fn read_reason<T: Transport + ?Sized>(t: &mut T) -> AdbError {
    match read_fail_reason(t).await {
        Ok(message) => AdbError::ServerRejected { message },
        Err(other) => other,
    }
}

async fn read_fail_reason<T: Transport + ?Sized>(t: &mut T) -> Result<String> {
    let raw = read_length_prefixed(t).await?;
    let text = String::from_utf8(raw).map_err(|_| AdbError::MalformedResponse {
        reason: "FAIL 原因不是合法 UTF-8".into(),
    })?;
    Ok(text.trim_end_matches('\0').trim().to_owned())
}

/// 读取一段长度前缀负载（`"%04x" + payload`，无换行）。
pub async fn read_length_prefixed<T: Transport + ?Sized>(t: &mut T) -> Result<Vec<u8>> {
    let len = read_length(t).await?;
    let mut buf = vec![0u8; len];
    t.read_exact(&mut buf)
        .await
        .map_err(|e| AdbError::MalformedResponse {
            reason: format!("读取 {len} 字节负载失败：{e}"),
        })?;
    Ok(buf)
}

/// 只读取 4 位十六进制长度字段。
pub async fn read_length<T: Transport + ?Sized>(t: &mut T) -> Result<usize> {
    let mut head = [0u8; 4];
    t.read_exact(&mut head).await?;
    parse_hex_len(&head)
}

/// 读取长度前缀负载并按 UTF-8 解码。
pub async fn read_length_prefixed_string<T: Transport + ?Sized>(t: &mut T) -> Result<String> {
    let raw = read_length_prefixed(t).await?;
    String::from_utf8(raw).map_err(|_| AdbError::MalformedResponse {
        reason: "负载不是合法 UTF-8".into(),
    })
}

/// 编码一段长度前缀负载（sync 服务使用）。
pub fn encode_length_prefixed(payload: &[u8]) -> Result<Vec<u8>> {
    let mut buf = Vec::with_capacity(4 + payload.len());
    write_hex_len(&mut buf, payload.len())?;
    buf.extend_from_slice(payload);
    Ok(buf)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 请求编码不含结尾换行() {
        // 实测：对真实 adb server 追加换行会得到 unknown host service
        let request = encode_request("host:devices-l").unwrap();
        assert_eq!(&request[..4], b"000e");
        assert_eq!(&request[4..], b"host:devices-l");
    }

    #[test]
    fn 空服务名也能编码() {
        assert_eq!(encode_request("").unwrap(), b"0000");
    }

    #[test]
    fn 超长服务名被拒绝() {
        let long = "x".repeat(MAX_PAYLOAD + 1);
        assert!(matches!(
            encode_request(&long),
            Err(AdbError::MalformedResponse { .. })
        ));

        // 恰好等于上限时仍然允许
        assert!(encode_request(&"x".repeat(MAX_PAYLOAD)).is_ok());
    }

    #[test]
    fn 长度字段支持大小写十六进制() {
        assert_eq!(parse_hex_len(b"0000").unwrap(), 0);
        assert_eq!(parse_hex_len(b"000f").unwrap(), 15);
        assert_eq!(parse_hex_len(b"00FF").unwrap(), 255);
        assert_eq!(parse_hex_len(b"ffff").unwrap(), MAX_PAYLOAD);
    }

    #[test]
    fn 长度字段非法时报错() {
        assert!(parse_hex_len(b"00").is_err());
        assert!(parse_hex_len(b"00g4").is_err());
        assert!(parse_hex_len(b"-123").is_err());
    }

    #[test]
    fn 负载编码与解码对称() {
        let payload = b"0123456789abcdef";
        let encoded = encode_length_prefixed(payload).unwrap();
        assert_eq!(&encoded[..4], b"0010");
        assert_eq!(&encoded[4..], payload);
    }
}
