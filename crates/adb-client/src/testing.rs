//! 测试辅助设施。
//!
//! 本模块会被集成测试（`tests/`）使用，因此**不能**只在 `#[cfg(test)]` 下编译。
//! 它只依赖 `tokio`，不会给生产构建带来额外负担。

use std::io;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;

use crate::transport::{Transport, TransportFactory};

/// 记录客户端写出的全部字节，便于断言请求格式。
#[derive(Debug, Clone, Default)]
pub struct WrittenLog(Arc<Mutex<Vec<u8>>>);

impl WrittenLog {
    pub fn bytes(&self) -> Vec<u8> {
        self.0.lock().expect("写入日志锁被毒化").clone()
    }

    /// 按空白切分成若干「请求」，便于断言 `host:xxx` 这类不含空格的文本请求。
    pub fn requests(&self) -> Vec<String> {
        String::from_utf8_lossy(&self.bytes())
            .split_whitespace()
            .map(str::to_owned)
            .collect()
    }
}

/// 内存传输层：预先灌入服务端响应，并记录客户端请求。
#[derive(Debug)]
pub struct MockTransport {
    incoming: Vec<u8>,
    cursor: usize,
    written: WrittenLog,
    shutdown_called: Arc<Mutex<bool>>,
}

impl MockTransport {
    /// 用一段固定的响应序列构造。
    pub fn new(incoming: impl Into<Vec<u8>>) -> Self {
        Self {
            incoming: incoming.into(),
            cursor: 0,
            written: WrittenLog::default(),
            shutdown_called: Arc::new(Mutex::new(false)),
        }
    }

    /// 便捷构造：`OKAY` + 负载。
    pub fn okay_with(payload: &[u8]) -> Self {
        let mut buf = b"OKAY".to_vec();
        buf.extend_from_slice(format!("{:04x}", payload.len()).as_bytes());
        buf.extend_from_slice(payload);
        Self::new(buf)
    }

    /// 便捷构造：`FAIL` + 原因。
    pub fn fail(reason: &str) -> Self {
        let mut buf = b"FAIL".to_vec();
        buf.extend_from_slice(format!("{:04x}", reason.len()).as_bytes());
        buf.extend_from_slice(reason.as_bytes());
        Self::new(buf)
    }

    pub fn written(&self) -> WrittenLog {
        self.written.clone()
    }

    pub fn was_shutdown(&self) -> bool {
        *self.shutdown_called.lock().expect("关闭标记锁被毒化")
    }

    fn fill(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let remaining = self.incoming.len() - self.cursor;
        let n = remaining.min(buf.len());
        buf[..n].copy_from_slice(&self.incoming[self.cursor..self.cursor + n]);
        self.cursor += n;
        Ok(n)
    }
}

#[async_trait]
impl Transport for MockTransport {
    async fn write_all(&mut self, buf: &[u8]) -> io::Result<()> {
        self.written
            .0
            .lock()
            .expect("写入日志锁被毒化")
            .extend_from_slice(buf);
        Ok(())
    }

    async fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }

    async fn read_exact(&mut self, buf: &mut [u8]) -> io::Result<()> {
        let mut filled = 0;
        while filled < buf.len() {
            match self.fill(&mut buf[filled..])? {
                0 => {
                    return Err(io::Error::new(
                        io::ErrorKind::UnexpectedEof,
                        format!("Mock 响应已耗尽，还差 {} 字节", buf.len() - filled),
                    ))
                }
                n => filled += n,
            }
        }
        Ok(())
    }

    async fn read_some(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        self.fill(buf)
    }

    async fn shutdown(&mut self) -> io::Result<()> {
        *self.shutdown_called.lock().expect("关闭标记锁被毒化") = true;
        Ok(())
    }

    fn endpoint(&self) -> String {
        "mock://adb".into()
    }
}

/// 只提供有限条连接的工厂，用来在单测里**验证「每次操作一条连接」**这条不变量。
#[derive(Debug)]
pub struct MockFactory {
    transport: Mutex<Option<Box<dyn Transport>>>,
    connects: AtomicUsize,
    push_connects: AtomicUsize,
}

impl MockFactory {
    pub fn new(transport: Box<dyn Transport>) -> Self {
        Self {
            transport: Mutex::new(Some(transport)),
            connects: AtomicUsize::new(0),
            push_connects: AtomicUsize::new(0),
        }
    }

    /// 已经建立过多少条连接。
    pub fn connects(&self) -> usize {
        self.connects.load(Ordering::Relaxed)
    }

    /// 其中有几条是**推送**连接（读取不应有超时）。
    pub fn push_connects(&self) -> usize {
        self.push_connects.load(Ordering::Relaxed)
    }
}

#[async_trait]
impl TransportFactory for MockFactory {
    async fn connect(&self) -> io::Result<Box<dyn Transport>> {
        self.connects.fetch_add(1, Ordering::Relaxed);
        self.transport
            .lock()
            .expect("传输锁被毒化")
            .take()
            .ok_or_else(|| io::Error::other("Mock 传输已用尽；每次操作都必须新建连接"))
    }

    async fn connect_push(&self) -> io::Result<Box<dyn Transport>> {
        self.connects.fetch_add(1, Ordering::Relaxed);
        self.push_connects.fetch_add(1, Ordering::Relaxed);
        self.transport
            .lock()
            .expect("传输锁被毒化")
            .take()
            .ok_or_else(|| io::Error::other("Mock 传输已用尽；每次操作都必须新建连接"))
    }
}

/// 读取真机集成测试的目标设备。
///
/// 返回 `None` 表示当前环境没有配置设备，**测试应当跳过而不是失败**，
/// 这样任何人的 `cargo test` 都是绿的，而 `pnpm test:device` 会真正执行。
pub fn device_serial() -> Option<String> {
    std::env::var("ANDROID_TEST_DEVICE")
        .ok()
        .filter(|s| !s.trim().is_empty())
}

/// 读取需要被跳过的测试的原因，供 `eprintln!` 输出。
pub fn skip_reason() -> &'static str {
    "未设置 ANDROID_TEST_DEVICE，跳过真机集成测试（用 `pnpm test:device` 运行）"
}
