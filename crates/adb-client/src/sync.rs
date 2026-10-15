//! `sync:` 服务：文件列举、查询、上传与下载。
//!
//! # 协议要点（来源：`daemon/file_sync_protocol.h`）
//!
//! ## 命令 id 是 4 字节 ASCII magic，不是小整数
//!
//! ```c
//! #define MKID(a, b, c, d) ((a) | ((b) << 8) | ((c) << 16) | ((d) << 24))
//! #define ID_LSTAT_V1 MKID('S', 'T', 'A', 'T')
//! #define ID_LIST_V1  MKID('L', 'I', 'S', 'T')
//! #define ID_SEND_V1  MKID('S', 'E', 'N', 'D')
//! #define ID_RECV_V1  MKID('R', 'E', 'C', 'V')
//! ```
//!
//! 由于按小端写出，线上字节就是 `"STAT"` / `"LIST"` / `"SEND"` / `"RECV"`。
//!
//! ## 请求是定长头 + 路径
//!
//! ```text
//! struct SyncRequest { uint32 id; uint32 path_length; }  // packed
//! // 后跟 path_length 字节路径（无 NUL 结尾），path_length 上限 1024
//! ```
//!
//! ## 记录布局
//!
//! | 结构 | 字段 |
//! | --- | --- |
//! | `stat_v1` | `id mode size mtime` |
//! | `dent_v1` | `id mode size mtime namelen` + `name[namelen]` |
//! | `data` | `id size` + `size` 字节数据 |
//! | `status` | `id msglen` + `msglen` 字节消息（仅 `FAIL` 时有） |
//!
//! ## 握手节奏（容易想当然的地方）
//!
//! - `STAT` / `LIST`：请求发完即返回记录流。
//! - `SEND`：设备创建文件后**不会**先回 `OKAY`；客户端直接发 `DATA`/`DONE`，
//!   全部发完才收到一个 `OKAY`（或某一步失败时的 `FAIL`）。
//! - `RECV`：**没有** `OKAY` 握手，失败时直接 `FAIL`；成功则直接是 `DATA` 流。

use std::path::Path;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tracing::debug;

use crate::error::{AdbError, Result};
use crate::transport::Transport;

/// 传输分块大小，与设备端 `SYNC_DATA_MAX` 一致。
const CHUNK: usize = 64 * 1024;

/// 设备端对路径长度的硬限制。
const MAX_PATH: usize = 1024;

const fn mkid(a: u8, b: u8, c: u8, d: u8) -> u32 {
    (a as u32) | ((b as u32) << 8) | ((c as u32) << 16) | ((d as u32) << 24)
}

// ---- 命令与状态 id（线上表现为 4 个 ASCII 字节）----
const ID_STAT: u32 = mkid(b'S', b'T', b'A', b'T'); // ID_LSTAT_V1
const ID_LIST: u32 = mkid(b'L', b'I', b'S', b'T'); // ID_LIST_V1
const ID_SEND: u32 = mkid(b'S', b'E', b'N', b'D'); // ID_SEND_V1
const ID_RECV: u32 = mkid(b'R', b'E', b'C', b'V'); // ID_RECV_V1
const ID_DENT: u32 = mkid(b'D', b'E', b'N', b'T'); // 目录项
const ID_DONE: u32 = mkid(b'D', b'O', b'N', b'E'); // 流结束
const ID_DATA: u32 = mkid(b'D', b'A', b'T', b'A'); // 数据块
const ID_OKAY: u32 = mkid(b'O', b'K', b'A', b'Y');
const ID_FAIL: u32 = mkid(b'F', b'A', b'I', b'L');

// ---- st_mode 类型位（避免为几个常量引入 libc）----
const S_IFMT: u32 = 0o170000;
const S_IFREG: u32 = 0o100000;
const S_IFDIR: u32 = 0o040000;
const S_IFLNK: u32 = 0o120000;

/// 设备端单个文件（或目录、软链接）的信息。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileStat {
    /// 完整 st_mode（含 `S_IFDIR` / `S_IFREG` 等类型位）
    pub mode: u32,
    pub size: u64,
    /// Unix 时间戳（秒）
    pub mtime: u32,
    /// 名称；`stat(path)` 返回路径末段，`list()` 返回目录项名
    pub name: String,
}

impl FileStat {
    pub fn is_dir(&self) -> bool {
        self.mode & S_IFMT == S_IFDIR
    }

    pub fn is_file(&self) -> bool {
        self.mode & S_IFMT == S_IFREG
    }

    pub fn is_symlink(&self) -> bool {
        self.mode & S_IFMT == S_IFLNK
    }

    /// 权限位，如 `0o644`。
    pub fn permissions(&self) -> u32 {
        self.mode & 0o777
    }

    /// 形如 `drwxr-xr-x` 的权限串，与 `ls -l` 首列一致。
    pub fn permission_string(&self) -> String {
        let kind = if self.is_dir() {
            'd'
        } else if self.is_symlink() {
            'l'
        } else {
            '-'
        };
        let bits = self.permissions();
        let mut out = String::with_capacity(10);
        out.push(kind);
        for shift in [6, 3, 0] {
            let triple = (bits >> shift) & 0o7;
            out.push(if triple & 0o4 != 0 { 'r' } else { '-' });
            out.push(if triple & 0o2 != 0 { 'w' } else { '-' });
            out.push(if triple & 0o1 != 0 { 'x' } else { '-' });
        }
        out
    }
}

/// 一次 `sync:` 会话。
///
/// sync 是长连接：**独占**一条 adb 连接直到会话结束，
/// 因此会话存续期间不能在同一连接上发起其他 adb 操作
/// （`AdbClient` 每次操作本来就会新开连接，因此互不影响）。
pub struct SyncSession {
    transport: Box<dyn Transport>,
    serial: String,
}

impl SyncSession {
    /// 接管已完成握手的连接。
    pub(crate) fn new(transport: Box<dyn Transport>, serial: &str) -> Self {
        Self {
            transport,
            serial: serial.to_owned(),
        }
    }

    fn transport(&mut self) -> &mut (dyn Transport + '_) {
        self.transport.as_mut()
    }

    /// 当前绑定的设备序列号。
    pub fn serial(&self) -> &str {
        &self.serial
    }

    /// 查询路径信息；路径不存在（mode 为 0）时返回 `Ok(None)`。
    pub async fn stat(&mut self, path: &str) -> Result<Option<FileStat>> {
        let t = self.transport();
        send_request(t, ID_STAT, path).await?;
        t.flush().await?;

        let id = read_u32(t).await?;
        if id == ID_FAIL {
            return Err(read_fail(t).await);
        }
        if id != ID_STAT {
            return Err(unexpected_id(id, "STAT"));
        }

        let mode = read_u32(t).await?;
        let size = read_u32(t).await? as u64;
        let mtime = read_u32(t).await?;

        if mode == 0 {
            // adbd 对 lstat 失败不报错，直接回全零
            return Ok(None);
        }

        debug!(path, size, mtime, "STAT");
        Ok(Some(FileStat {
            mode,
            size,
            mtime,
            name: last_segment(path),
        }))
    }

    /// 列目录内容（不递归）。
    ///
    /// 目录不存在时设备端同样只回 `DONE`，因此返回空列表而不是错误；
    /// 调用方需要区分时请先用 [`Self::stat`]。
    pub async fn list(&mut self, path: &str) -> Result<Vec<FileStat>> {
        let t = self.transport();
        send_request(t, ID_LIST, path).await?;
        t.flush().await?;

        let mut entries = Vec::new();
        loop {
            let id = read_u32(t).await?;
            match id {
                ID_DONE => {
                    // DONE 记录是全零的 dent_v1，剩下 4 个 u32 需要读掉
                    for _ in 0..4 {
                        read_u32(t).await?;
                    }
                    break;
                }
                ID_FAIL => return Err(read_fail(t).await),
                ID_DENT => {}
                other => return Err(unexpected_id(other, "DENT/DONE")),
            }

            let mode = read_u32(t).await?;
            let size = read_u32(t).await? as u64;
            let mtime = read_u32(t).await?;
            let name = read_name(t).await?;
            entries.push(FileStat {
                mode,
                size,
                mtime,
                name,
            });
        }

        Ok(entries)
    }

    /// 上传本地文件到设备，返回实际传输的字节数。
    ///
    /// `perms` 是权限位（如 `0o644`）；最终 mode 会带上 `S_IFREG`。
    pub async fn push(&mut self, local: &Path, remote: &str, perms: u32) -> Result<u64> {
        let mut file =
            tokio::fs::File::open(local)
                .await
                .map_err(|e| AdbError::TransferFailed {
                    path: local.to_path_buf(),
                    reason: e.to_string(),
                })?;

        let mode = S_IFREG | (perms & 0o777);
        let spec = format!("{remote},{mode}");

        let t = self.transport();
        send_request(t, ID_SEND, &spec).await?;
        t.flush().await?;

        let mut total = 0u64;
        let mut buf = vec![0u8; CHUNK];
        loop {
            let n = file
                .read(&mut buf)
                .await
                .map_err(|e| AdbError::TransferFailed {
                    path: local.to_path_buf(),
                    reason: e.to_string(),
                })?;
            if n == 0 {
                break;
            }

            t.write_all(&ID_DATA.to_le_bytes()).await?;
            t.write_all(&(n as u32).to_le_bytes()).await?;
            t.write_all(&buf[..n]).await?;
            t.flush().await?;
            total += n as u64;
        }

        // DONE 的第二个 u32 会被设备端当作时间戳回填，这里传 0
        t.write_all(&ID_DONE.to_le_bytes()).await?;
        t.write_all(&0u32.to_le_bytes()).await?;
        t.flush().await?;

        // 设备端在全部数据收完后才回一个状态
        let id = read_u32(t).await?;
        let message_len = read_u32(t).await?;
        match id {
            ID_OKAY => {}
            ID_FAIL => {
                let message = read_string(t, message_len as usize).await?;
                return Err(AdbError::SyncFailed(message));
            }
            other => return Err(unexpected_id(other, "OKAY/FAIL")),
        }

        Ok(total)
    }

    /// 下载设备文件到本地路径，返回实际传输的字节数。
    pub async fn pull(&mut self, remote: &str, local: &Path) -> Result<u64> {
        let t = self.transport();
        send_request(t, ID_RECV, remote).await?;
        t.flush().await?;

        let mut file =
            tokio::fs::File::create(local)
                .await
                .map_err(|e| AdbError::TransferFailed {
                    path: local.to_path_buf(),
                    reason: e.to_string(),
                })?;

        // RECV 没有 OKAY 握手，直接是 DATA 流
        let mut total = 0u64;
        loop {
            let id = read_u32(t).await?;
            let size = read_u32(t).await?;
            match id {
                ID_DONE => break,
                ID_FAIL => {
                    let message = read_string(t, size as usize).await?;
                    return Err(AdbError::TransferFailed {
                        path: local.to_path_buf(),
                        reason: message,
                    });
                }
                ID_DATA => {
                    let data = read_bytes(t, size as usize).await?;
                    file.write_all(&data)
                        .await
                        .map_err(|e| AdbError::TransferFailed {
                            path: local.to_path_buf(),
                            reason: e.to_string(),
                        })?;
                    total += size as u64;
                }
                other => return Err(unexpected_id(other, "DATA/DONE")),
            }
        }

        file.flush().await.map_err(|e| AdbError::TransferFailed {
            path: local.to_path_buf(),
            reason: e.to_string(),
        })?;
        Ok(total)
    }
}

// ------------------------------------------------------------------ 底层读写助手

/// 发送 `SyncRequest { id, path_length }` + 路径内容。
async fn send_request(t: &mut dyn Transport, id: u32, path: &str) -> Result<()> {
    if path.len() > MAX_PATH {
        return Err(AdbError::SyncFailed(format!(
            "路径过长（{} > {MAX_PATH} 字节）",
            path.len()
        )));
    }

    t.write_all(&id.to_le_bytes()).await?;
    t.write_all(&(path.len() as u32).to_le_bytes()).await?;
    t.write_all(path.as_bytes()).await?;
    Ok(())
}

async fn read_u32(t: &mut dyn Transport) -> Result<u32> {
    let mut buf = [0u8; 4];
    t.read_exact(&mut buf).await?;
    Ok(u32::from_le_bytes(buf))
}

async fn read_bytes(t: &mut dyn Transport, len: usize) -> Result<Vec<u8>> {
    let mut buf = vec![0u8; len];
    t.read_exact(&mut buf).await?;
    Ok(buf)
}

async fn read_string(t: &mut dyn Transport, len: usize) -> Result<String> {
    if len == 0 {
        return Ok(String::new());
    }
    let raw = read_bytes(t, len).await?;
    Ok(String::from_utf8_lossy(&raw).into_owned())
}

async fn read_name(t: &mut dyn Transport) -> Result<String> {
    let len = read_u32(t).await?;
    read_string(t, len as usize).await
}

/// 读取 `FAIL` 状态后的消息体（消息长度已在上一步读出）。
async fn read_fail(t: &mut dyn Transport) -> AdbError {
    let len = read_u32(t).await.unwrap_or(0);
    let message = read_string(t, len as usize).await.unwrap_or_default();
    if message.is_empty() {
        AdbError::SyncFailed("设备端返回 FAIL".into())
    } else {
        AdbError::SyncFailed(message)
    }
}

fn unexpected_id(id: u32, expected: &str) -> AdbError {
    AdbError::MalformedResponse {
        reason: format!(
            "sync 返回了非预期的 id {:?}（期望 {expected}）",
            id_to_string(id)
        ),
    }
}

/// 把 4 字节 magic 还原成可读字符串，便于报错定位。
fn id_to_string(id: u32) -> String {
    let bytes = id.to_le_bytes();
    if bytes.iter().all(|b| b.is_ascii_alphanumeric()) {
        format!("{:?} ({id:#010x})", String::from_utf8_lossy(&bytes))
    } else {
        format!("{id:#010x}")
    }
}

fn last_segment(path: &str) -> String {
    path.trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or(path)
        .to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stat(mode: u32) -> FileStat {
        FileStat {
            mode,
            size: 0,
            mtime: 0,
            name: String::new(),
        }
    }

    #[test]
    fn 命令_id_是四字节_ascii_magic() {
        assert_eq!(ID_STAT.to_le_bytes(), *b"STAT");
        assert_eq!(ID_LIST.to_le_bytes(), *b"LIST");
        assert_eq!(ID_SEND.to_le_bytes(), *b"SEND");
        assert_eq!(ID_RECV.to_le_bytes(), *b"RECV");
        assert_eq!(ID_DENT.to_le_bytes(), *b"DENT");
        assert_eq!(ID_DONE.to_le_bytes(), *b"DONE");
        assert_eq!(ID_DATA.to_le_bytes(), *b"DATA");
        assert_eq!(ID_OKAY.to_le_bytes(), *b"OKAY");
        assert_eq!(ID_FAIL.to_le_bytes(), *b"FAIL");
    }

    #[test]
    fn 识别文件类型() {
        assert!(stat(0o040755).is_dir());
        assert!(stat(0o100644).is_file());
        assert!(stat(0o120777).is_symlink());

        assert!(!stat(0o040755).is_file());
        assert!(!stat(0o100644).is_dir());
        assert!(!stat(0o100644).is_symlink());
        assert!(!stat(0o120777).is_dir());
    }

    #[test]
    fn 权限串形如_ls() {
        assert_eq!(stat(0o040755).permission_string(), "drwxr-xr-x");
        assert_eq!(stat(0o100644).permission_string(), "-rw-r--r--");
        assert_eq!(stat(0o100600).permission_string(), "-rw-------");
        assert_eq!(stat(0o120777).permission_string(), "lrwxrwxrwx");
    }

    #[test]
    fn 权限位提取忽略类型位() {
        assert_eq!(stat(0o100644).permissions(), 0o644);
        assert_eq!(stat(0o040755).permissions(), 0o755);
    }

    #[test]
    fn 取路径末段() {
        assert_eq!(last_segment("/sdcard/Download"), "Download");
        assert_eq!(last_segment("/sdcard/Download/"), "Download");
        assert_eq!(last_segment("/"), "");
    }

    #[test]
    fn 超长路径被拒绝() {
        let path = "x".repeat(MAX_PATH + 1);
        let mut mock = crate::testing::MockTransport::new(Vec::new());
        let result = futures_block_on(send_request(&mut mock, ID_STAT, &path));
        assert!(matches!(result, Err(AdbError::SyncFailed(_))));
    }

    /// 测试用的极简执行器：只在当前线程上跑一次 future。
    fn futures_block_on<F: std::future::Future>(mut fut: F) -> F::Output {
        use std::task::{Context, Poll, RawWaker, RawWakerVTable, Waker};

        fn noop(_: *const ()) {}
        fn clone(p: *const ()) -> RawWaker {
            RawWaker::new(p, &VTABLE)
        }
        static VTABLE: RawWakerVTable = RawWakerVTable::new(clone, noop, noop, noop);

        let waker = unsafe { Waker::from_raw(RawWaker::new(std::ptr::null(), &VTABLE)) };
        let mut cx = Context::from_waker(&waker);
        let mut fut = unsafe { std::pin::Pin::new_unchecked(&mut fut) };
        loop {
            if let Poll::Ready(out) = fut.as_mut().poll(&mut cx) {
                return out;
            }
        }
    }
}
