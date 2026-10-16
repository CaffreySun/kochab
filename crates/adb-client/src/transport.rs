//! 传输层抽象。
//!
//! # 为什么是「每次操作一条连接」
//!
//! adb server 的行为（已对 adb 1.0.41 实测）：
//!
//! - `host:version` / `host:devices-l` 等**返回数据的 host 服务，响应后立刻关闭连接**；
//! - `host:transport:<serial>` 不会关闭，它把连接切换到「设备模式」；
//! - 随后的 `shell:` / `sync:` 执行完，连接同样关闭。
//!
//! 也就是说：**一条连接只能承载一次 host 服务（或一次 host:transport + 一次设备服务）**。
//! 复用连接的做法会在第二次请求时读到 EOF，这是自研 adb 客户端最容易踩的坑。
//!
//! 因此这里提供的是 [`TransportFactory`]：每次操作向工厂要一条新连接。

use std::fmt::Debug;
use std::io;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

/// 读写超时。adb server 在本机，默认值足够宽松。
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);

/// 一个可读写的字节通道。
///
/// 只暴露协议真正需要的几个操作，避免把 `AsyncRead`/`AsyncWrite` 的复杂度泄漏到上层。
#[async_trait]
pub trait Transport: Send + Sync + Debug {
    /// 写入全部字节（或返回错误）。
    async fn write_all(&mut self, buf: &[u8]) -> io::Result<()>;

    /// 把已写入的数据推给对端。
    ///
    /// sync 服务的上传是「请求 → 等状态 → 发数据」的往返模式，
    /// 不显式 flush 会导致请求头与数据粘在一起，设备端将一直等待。
    async fn flush(&mut self) -> io::Result<()>;

    /// 读满 `buf`，不足则返回 `UnexpectedEof`。
    async fn read_exact(&mut self, buf: &mut [u8]) -> io::Result<()>;

    /// 读取至多 `buf.len()` 字节，返回实际读取的数量（0 表示对端已关闭）。
    ///
    /// `adb shell` 的输出长度事先未知，只能边读边处理，因此需要这个操作。
    async fn read_some(&mut self, buf: &mut [u8]) -> io::Result<usize>;

    /// 关闭写方向。
    async fn shutdown(&mut self) -> io::Result<()>;

    /// 人类可读的端点描述，用于日志与错误信息。
    fn endpoint(&self) -> String;
}

/// 传输层工厂：每次 [`crate::AdbClient`] 操作都会向它索取一条新连接。
#[async_trait]
pub trait TransportFactory: Send + Sync + Debug {
    async fn connect(&self) -> io::Result<Box<dyn Transport>>;

    /// 打开一条**推送**连接：读取不施加超时。
    ///
    /// `host:track-devices` 这类服务在没有事件时本就该一直阻塞；
    /// 给它套上读超时，连接会被自己的超时反复踢断（表现为每 30 秒
    /// 重连一次，期间还漏掉设备变化）。
    ///
    /// 默认实现退化为 [`connect`](Self::connect)，测试替身因此不必实现它。
    async fn connect_push(&self) -> io::Result<Box<dyn Transport>> {
        self.connect().await
    }
}

/// 真实的 TCP 传输。
#[derive(Debug)]
pub struct TcpTransport {
    stream: TcpStream,
    addr: SocketAddr,
    /// 单次读写的超时；`None` 表示不施加超时（推送类连接）。
    timeout: Option<Duration>,
}

impl TcpTransport {
    /// 覆盖单次读写的超时时间。
    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = Some(timeout);
        self
    }

    /// 关掉读超时，用于推送类连接。
    pub fn without_timeout(mut self) -> Self {
        self.timeout = None;
        self
    }
}

/// 生产环境的传输工厂：连本机 adb server。
#[derive(Debug, Clone)]
pub struct TcpFactory {
    addr: SocketAddr,
    timeout: Duration,
}

impl TcpFactory {
    pub fn new(addr: SocketAddr) -> Self {
        Self {
            addr,
            timeout: DEFAULT_TIMEOUT,
        }
    }

    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    async fn open(&self, timeout: Option<Duration>) -> io::Result<Box<dyn Transport>> {
        let stream = tokio::time::timeout(DEFAULT_TIMEOUT, TcpStream::connect(self.addr))
            .await
            .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "连接 adb server 超时"))??;

        // adb 协议是「小请求 + 长响应」模式，禁用 Nagle 可显著降低交互延迟
        stream.set_nodelay(true)?;

        Ok(Box::new(TcpTransport {
            stream,
            addr: self.addr,
            timeout,
        }))
    }
}

#[async_trait]
impl TransportFactory for TcpFactory {
    async fn connect(&self) -> io::Result<Box<dyn Transport>> {
        self.open(Some(self.timeout)).await
    }

    async fn connect_push(&self) -> io::Result<Box<dyn Transport>> {
        self.open(None).await
    }
}

/// 按需给 future 套上超时；`None` 时不施加任何期限。
async fn guarded<T>(
    timeout: Option<Duration>,
    message: &'static str,
    fut: impl std::future::Future<Output = io::Result<T>>,
) -> io::Result<T> {
    match timeout {
        Some(limit) => tokio::time::timeout(limit, fut)
            .await
            .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, message))?,
        None => fut.await,
    }
}

#[async_trait]
impl Transport for TcpTransport {
    async fn write_all(&mut self, buf: &[u8]) -> io::Result<()> {
        let timeout = self.timeout;
        let stream = &mut self.stream;
        guarded(timeout, "写入 adb server 超时", async move {
            AsyncWriteExt::write_all(stream, buf).await
        })
        .await
    }

    async fn flush(&mut self) -> io::Result<()> {
        AsyncWriteExt::flush(&mut self.stream).await
    }

    async fn read_exact(&mut self, buf: &mut [u8]) -> io::Result<()> {
        let timeout = self.timeout;
        let stream = &mut self.stream;
        guarded(timeout, "读取 adb server 超时", async move {
            // tokio 1.53 起 `read_exact` 返回读取字节数，这里丢弃该值
            AsyncReadExt::read_exact(stream, buf).await.map(|_| ())
        })
        .await
    }

    async fn read_some(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let timeout = self.timeout;
        let stream = &mut self.stream;
        guarded(timeout, "读取 adb server 超时", async move {
            AsyncReadExt::read(stream, buf).await
        })
        .await
    }

    async fn shutdown(&mut self) -> io::Result<()> {
        AsyncWriteExt::shutdown(&mut self.stream).await
    }

    fn endpoint(&self) -> String {
        self.addr.to_string()
    }
}

/// 便于把一个现成的工厂包进 `Arc`。
pub type SharedFactory = Arc<dyn TransportFactory>;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::MockTransport;

    #[derive(Debug)]
    struct CountingFactory {
        count: std::sync::Arc<std::sync::atomic::AtomicUsize>,
    }

    #[async_trait]
    impl TransportFactory for CountingFactory {
        async fn connect(&self) -> io::Result<Box<dyn Transport>> {
            self.count
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            Ok(Box::new(MockTransport::new(b"OKAY".to_vec())))
        }
    }

    #[tokio::test]
    async fn 工厂每次返回一条新连接() {
        let count = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let factory = CountingFactory {
            count: std::sync::Arc::clone(&count),
        };

        let first = factory.connect().await.unwrap();
        let second = factory.connect().await.unwrap();

        assert_eq!(count.load(std::sync::atomic::Ordering::Relaxed), 2);
        assert_eq!(first.endpoint(), "mock://adb");
        assert_eq!(second.endpoint(), "mock://adb");
    }
}
