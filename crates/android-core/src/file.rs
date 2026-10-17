//! 文件管理：浏览目录、上传、下载、删除。
//!
//! 目录浏览走 `sync:`（二进制协议，比 `ls -l` 解析 shell 文本可靠得多）；
//! 增删改走 shell。

use std::path::{Path, PathBuf};

use adb_client::{AdbClient, FileStat};
use tracing::debug;

use crate::device::{map_adb_error, require_success};
use crate::error::{CoreError, Result};
use crate::model::FileEntry;

/// 设备上最常访问的路径。
pub const COMMON_PATHS: &[(&str, &str)] = &[
    ("内部存储", "/sdcard"),
    ("下载", "/sdcard/Download"),
    ("相册", "/sdcard/DCIM"),
    ("文档", "/sdcard/Documents"),
    ("应用数据", "/data/data"),
    ("系统根目录", "/"),
];

/// 规范化设备端 POSIX 路径。
///
/// 规则：
/// - 多个连续 `/` 折叠为一个；
/// - `.` 段丢弃；
/// - `..` 只能向上，不能越过根；
/// - 结尾不留 `/`（根目录除外）。
///
/// 设备端路径**永远**是绝对 POSIX 路径，不能用 `std::path` 的平台规则处理：
/// Windows 上 `Path` 会把 `\` 当分隔符、把 `C:` 当盘符。
pub fn normalize_device_path(path: &str) -> Result<String> {
    let path = path.trim();
    if path.is_empty() {
        return Ok("/".to_owned());
    }

    let mut segments: Vec<&str> = Vec::new();
    for segment in path.split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                segments.pop();
            }
            other => segments.push(other),
        }
    }

    if segments.is_empty() {
        return Ok("/".to_owned());
    }
    Ok(format!("/{}", segments.join("/")))
}

/// 拼接父目录与条目名。
pub fn join_device_path(parent: &str, name: &str) -> Result<String> {
    let base = parent.strip_suffix('/').unwrap_or(parent);
    normalize_device_path(&format!("{base}/{name}"))
}

/// `FileStat` → 传输模型。
fn to_entry(stat: &FileStat, parent: &str) -> FileEntry {
    let path = if stat.name.is_empty() {
        parent.to_owned()
    } else {
        join_device_path(parent, &stat.name).unwrap_or_else(|_| parent.to_owned())
    };

    FileEntry {
        is_directory: stat.is_dir(),
        is_symlink: stat.is_symlink(),
        size_bytes: (!stat.is_dir()).then_some(stat.size),
        permissions: stat.permission_string(),
        modified_at: Some(i64::from(stat.mtime) * 1000),
        owner: None,
        group: None,
        name: stat.name.clone(),
        path,
    }
}

/// 列目录内容。
///
/// 结果按「目录在前 + 名称不区分大小写」排序，保证文件管理器里的顺序稳定。
pub async fn list(client: &AdbClient, serial: &str, path: &str) -> Result<Vec<FileEntry>> {
    let normalized = normalize_device_path(path)?;

    let mut sync = client.open_sync(serial).await.map_err(map_adb_error)?;
    let stats = sync.list(&normalized).await.map_err(map_adb_error)?;
    drop(sync);

    debug!(serial, path = %normalized, count = stats.len(), "目录列举完成");

    let mut entries: Vec<FileEntry> = stats.iter().map(|s| to_entry(s, &normalized)).collect();
    entries.retain(|e| e.name != "." && e.name != "..");
    entries.sort_by(|a, b| {
        b.is_directory
            .cmp(&a.is_directory)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(entries)
}

/// 查询单个路径；不存在时返回 `None`。
pub async fn stat(client: &AdbClient, serial: &str, path: &str) -> Result<Option<FileEntry>> {
    let normalized = normalize_device_path(path)?;

    let mut sync = client.open_sync(serial).await.map_err(map_adb_error)?;
    let found = sync.stat(&normalized).await.map_err(map_adb_error)?;
    drop(sync);

    Ok(found.map(|s| to_entry(&s, &normalized)))
}

/// 删除文件，或删除**空**目录。
///
/// 本函数刻意**不做**递归删除，避免误删整棵目录树；
/// 需要强制删除目录时必须显式调用 [`delete_recursive`]。
pub async fn delete(client: &AdbClient, serial: &str, path: &str) -> Result<()> {
    let normalized = normalize_device_path(path)?;
    if normalized == "/" {
        return Err(CoreError::PermissionDenied("拒绝删除根目录".into()));
    }

    // 目录用 rmdir：只能删空目录，避免误删整棵目录树。
    // 需要强制删除目录时必须显式调用 delete_recursive。
    let is_dir = stat(client, serial, &normalized)
        .await?
        .is_some_and(|e| e.is_directory);
    let command = if is_dir {
        format!("rmdir '{normalized}'")
    } else {
        format!("rm -f '{normalized}'")
    };
    shell(client, serial, &command).await.map(|_| ())
}

/// 删除目录及其全部内容。
pub async fn delete_recursive(client: &AdbClient, serial: &str, path: &str) -> Result<()> {
    let normalized = normalize_device_path(path)?;
    if normalized == "/" {
        return Err(CoreError::PermissionDenied("拒绝删除根目录".into()));
    }

    shell(client, serial, &format!("rm -rf '{normalized}'"))
        .await
        .map(|_| ())
}

/// 新建目录（等价 `mkdir -p`）。
pub async fn create_dir(client: &AdbClient, serial: &str, path: &str) -> Result<()> {
    let normalized = normalize_device_path(path)?;
    shell(client, serial, &format!("mkdir -p '{normalized}'"))
        .await
        .map(|_| ())
}

/// 重命名 / 移动。
pub async fn rename(client: &AdbClient, serial: &str, from: &str, to: &str) -> Result<()> {
    let source = normalize_device_path(from)?;
    let target = normalize_device_path(to)?;

    if stat(client, serial, &target).await?.is_some() {
        return Err(CoreError::AlreadyExists(target));
    }

    shell(client, serial, &format!("mv '{source}' '{target}'"))
        .await
        .map(|_| ())
}

/// 上传本地文件到设备。
pub async fn push(client: &AdbClient, serial: &str, local: &Path, remote: &str) -> Result<u64> {
    let target = normalize_device_path(remote)?;

    let mut sync = client.open_sync(serial).await.map_err(map_adb_error)?;
    let written = sync
        .push(local, &target, 0o644)
        .await
        .map_err(map_adb_error)?;
    Ok(written)
}

/// 下载设备文件到本地。
pub async fn pull(client: &AdbClient, serial: &str, remote: &str, local: &Path) -> Result<u64> {
    let source = normalize_device_path(remote)?;

    if let Some(parent) = local.parent() {
        if !parent.as_os_str().is_empty() && !parent.exists() {
            return Err(CoreError::Io(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                format!("本地目录不存在：{}", parent.display()),
            )));
        }
    }

    let mut sync = client.open_sync(serial).await.map_err(map_adb_error)?;
    let read = sync.pull(&source, local).await.map_err(map_adb_error)?;
    Ok(read)
}

/// 目录递归深度上限。防止异常目录结构（或设备端符号链接环）把递归拖死。
const MAX_DIR_DEPTH: u32 = 32;

/// 把设备目录递归下载到 `dest_dir/<目录名>`。
///
/// - 空目录也会在本地建出来；
/// - 符号链接**不跟随**：既避免环，也避免把链接指向的任意路径拉下来；
/// - 同一台设备只开一条 sync 会话，避免每个文件都重新握手。
///
/// 返回 `(本地目录, 总字节数)`。
pub async fn pull_dir(
    client: &AdbClient,
    serial: &str,
    remote: &str,
    dest_dir: &Path,
) -> Result<(PathBuf, u64)> {
    let source = normalize_device_path(remote)?;
    let name = source
        .rsplit('/')
        .next()
        .filter(|s| !s.is_empty())
        .unwrap_or("download");
    let target = dest_dir.join(sanitize_local_component(name));
    std::fs::create_dir_all(&target)?;

    let mut sync = client.open_sync(serial).await.map_err(map_adb_error)?;
    let mut stack = vec![(source, target.clone(), 0u32)];
    let mut total = 0u64;

    while let Some((remote_dir, local_dir, depth)) = stack.pop() {
        if depth > MAX_DIR_DEPTH {
            return Err(CoreError::Internal(format!(
                "目录层级超过 {MAX_DIR_DEPTH} 层，已停止下载：{remote_dir}"
            )));
        }
        let entries = sync.list(&remote_dir).await.map_err(map_adb_error)?;
        for entry in entries {
            if entry.name.is_empty() || entry.name == "." || entry.name == ".." {
                continue;
            }
            // 不跟随链接：设备上可能指向 / 或外部存储之外
            if entry.is_symlink() {
                continue;
            }
            let child_local = local_dir.join(sanitize_local_component(&entry.name));
            let child_remote = join_device_path(&remote_dir, &entry.name)?;
            if entry.is_dir() {
                std::fs::create_dir_all(&child_local)?;
                stack.push((child_remote, child_local, depth + 1));
            } else if entry.is_file() {
                total += sync
                    .pull(&child_remote, &child_local)
                    .await
                    .map_err(map_adb_error)?;
            }
        }
    }

    Ok((target, total))
}

/// 设备文件名 → 安全的本地文件名。
///
/// 设备端允许 `:`、`?` 等 Windows 非法字符；直接落盘会失败。
/// 只替换非法字符，尽量保留原名，避免用户找不到下载的文件。
pub fn sanitize_local_component(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            c if c.is_control() => '_',
            c => c,
        })
        .collect();
    let trimmed = cleaned.trim_end_matches([' ', '.']);
    if trimmed.is_empty() || trimmed == "." || trimmed == ".." {
        return "_".to_owned();
    }
    // Windows 保留名（CON、NUL、COM1…）不能直接作为文件名
    let stem = trimmed
        .split('.')
        .next()
        .unwrap_or(trimmed)
        .to_ascii_uppercase();
    let reserved = matches!(
        stem.as_str(),
        "CON"
            | "PRN"
            | "AUX"
            | "NUL"
            | "COM1"
            | "COM2"
            | "COM3"
            | "COM4"
            | "COM5"
            | "COM6"
            | "COM7"
            | "COM8"
            | "COM9"
            | "LPT1"
            | "LPT2"
            | "LPT3"
            | "LPT4"
            | "LPT5"
            | "LPT6"
            | "LPT7"
            | "LPT8"
            | "LPT9"
    );
    if reserved {
        format!("_{trimmed}")
    } else {
        trimmed.to_owned()
    }
}

/// 按文件名推荐一个本地下载路径。
pub fn suggest_local_path(dir: &Path, file_name: &str) -> PathBuf {
    let safe: String = file_name
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '.' || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    dir.join(if safe.is_empty() {
        "download.bin".to_owned()
    } else {
        safe
    })
}

/// 执行一条 shell 命令并校验成功。
async fn shell(client: &AdbClient, serial: &str, command: &str) -> Result<adb_client::ShellOutput> {
    let out = client.shell(serial, command).await.map_err(map_adb_error)?;
    require_success(out, command)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 规范化折叠斜杠与当前目录() {
        assert_eq!(
            normalize_device_path("/sdcard//Download/").unwrap(),
            "/sdcard/Download"
        );
        assert_eq!(
            normalize_device_path("/sdcard/./Download").unwrap(),
            "/sdcard/Download"
        );
        assert_eq!(normalize_device_path("/").unwrap(), "/");
        assert_eq!(normalize_device_path("").unwrap(), "/");
        assert_eq!(normalize_device_path("///").unwrap(), "/");
    }

    #[test]
    fn 规范化不能越过根目录() {
        assert_eq!(normalize_device_path("/../../etc").unwrap(), "/etc");
        assert_eq!(normalize_device_path("/sdcard/../..").unwrap(), "/");
    }

    #[test]
    fn 规范化忽略首尾空白() {
        assert_eq!(normalize_device_path("  /sdcard  ").unwrap(), "/sdcard");
    }

    #[test]
    fn 相对路径按绝对路径处理() {
        // 设备端路径一律视为绝对，不能像 Windows 那样解释成盘符
        assert_eq!(
            normalize_device_path("sdcard/Download").unwrap(),
            "/sdcard/Download"
        );
    }

    #[test]
    fn 拼接路径() {
        assert_eq!(
            join_device_path("/sdcard", "Download").unwrap(),
            "/sdcard/Download"
        );
        assert_eq!(
            join_device_path("/sdcard/", "Download").unwrap(),
            "/sdcard/Download"
        );
        assert_eq!(join_device_path("/", "sdcard").unwrap(), "/sdcard");
    }

    #[test]
    fn 目录项没有大小_文件有大小() {
        let dir = FileStat {
            mode: 0o040755,
            size: 4096,
            mtime: 1_700_000_000,
            name: "DCIM".into(),
        };
        let file = FileStat {
            mode: 0o100644,
            size: 2048,
            mtime: 1_700_000_000,
            name: "note.txt".into(),
        };

        let dir_entry = to_entry(&dir, "/sdcard");
        assert!(dir_entry.is_directory);
        assert_eq!(dir_entry.size_bytes, None);
        assert_eq!(dir_entry.path, "/sdcard/DCIM");
        assert_eq!(dir_entry.permissions, "drwxr-xr-x");

        let file_entry = to_entry(&file, "/sdcard");
        assert!(!file_entry.is_directory);
        assert_eq!(file_entry.size_bytes, Some(2048));
    }

    #[test]
    fn 软链接被正确标记() {
        let link = FileStat {
            mode: 0o120777,
            size: 12,
            mtime: 0,
            name: "link".into(),
        };
        let entry = to_entry(&link, "/sdcard");

        assert!(entry.is_symlink);
        assert!(!entry.is_directory);
        assert_eq!(entry.permissions, "lrwxrwxrwx");
    }

    #[test]
    fn 修改时间转为毫秒() {
        let file = FileStat {
            mode: 0o100644,
            size: 1,
            mtime: 1_700_000_000,
            name: "a".into(),
        };
        assert_eq!(to_entry(&file, "/").modified_at, Some(1_700_000_000_000));
    }

    #[test]
    fn 本地文件名净化() {
        let dir = Path::new("/tmp/downloads");

        assert_eq!(
            suggest_local_path(dir, "report.pdf"),
            PathBuf::from("/tmp/downloads/report.pdf")
        );
        assert_eq!(
            suggest_local_path(dir, "a/b:c*d.txt"),
            PathBuf::from("/tmp/downloads/a_b_c_d.txt")
        );
        assert_eq!(
            suggest_local_path(dir, ""),
            PathBuf::from("/tmp/downloads/download.bin")
        );
    }

    #[test]
    fn 目录下载的本地文件名替换_windows_非法字符() {
        assert_eq!(sanitize_local_component("a:b?c*.txt"), "a_b_c_.txt");
        assert_eq!(sanitize_local_component("照片 2026"), "照片 2026");
        assert_eq!(sanitize_local_component(".."), "_");
        assert_eq!(sanitize_local_component(""), "_");
        assert_eq!(sanitize_local_component("CON"), "_CON");
        assert_eq!(sanitize_local_component("com1.txt"), "_com1.txt");
        assert_eq!(sanitize_local_component("name. "), "name");
    }
}
