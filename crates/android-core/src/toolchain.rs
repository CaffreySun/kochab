//! 外部工具链定位与自检。
//!
//! 投屏需要设备端的 `scrcpy-server` 文件；文件管理之外的一切功能只需要 adb。
//! 定位失败是**可预期**的常见问题（用户没装 scrcpy），因此这里返回结构化诊断而不是错误。

use std::path::{Path, PathBuf};

use adb_client::AdbClient;

use crate::model::ToolchainStatus;

/// 环境变量：显式指定 scrcpy server 路径（最高优先级）。
pub const ENV_SCRCPY_SERVER: &str = "SCRCPY_SERVER_PATH";

/// 定位 scrcpy server 文件。
///
/// 查找顺序（与 `scripts/doctor.mjs` 保持一致）：
/// 1. 环境变量 `SCRCPY_SERVER_PATH`
/// 2. `extra_dirs`（应用自带的资源目录等）
/// 3. `adb` 可执行文件所在目录（Windows 同目录；macOS 可能在其 `../Resources`）
///
/// 找不到返回 `None`——这是正常的降级路径，不是错误。
pub fn resolve_scrcpy_server(adb_path: Option<&Path>) -> Option<PathBuf> {
    resolve_scrcpy_server_with(&[], adb_path)
}

/// 与 [`resolve_scrcpy_server`] 相同，但额外搜索 `extra_dirs`。
///
/// 打包后的应用把 server 作为资源放在自己的资源目录里，那个目录
/// 与 adb 的安装位置毫无关系，必须由调用方显式传进来。
pub fn resolve_scrcpy_server_with(
    extra_dirs: &[PathBuf],
    adb_path: Option<&Path>,
) -> Option<PathBuf> {
    if let Some(explicit) = std::env::var_os(ENV_SCRCPY_SERVER) {
        let path = PathBuf::from(explicit);
        if path.is_file() {
            return Some(path);
        }
    }

    // 自带资源排在 adb 同目录之前：前者是随应用一起验证过的版本，
    // 后者版本未知，可能触发服务端版本不匹配。
    for dir in extra_dirs {
        if let Some(found) = first_server_file(dir) {
            return Some(found);
        }
    }

    let dir = adb_path?.parent()?;

    // scrcpy 与 adb 通常装在一起，但 scrcpy 可能单独安装，因此两边都找
    let mut search_dirs: Vec<PathBuf> = Vec::new();
    if let Some(sibling) = dir.parent() {
        search_dirs.push(dir.to_path_buf());
        search_dirs.push(sibling.to_path_buf());
        search_dirs.push(sibling.join("Resources"));
    }

    for candidate in search_dirs {
        if let Some(found) = first_server_file(&candidate) {
            return Some(found);
        }
    }

    None
}

/// 在目录里找 `scrcpy-server*`。
fn first_server_file(dir: &Path) -> Option<PathBuf> {
    let entries = std::fs::read_dir(dir).ok()?;
    let mut candidates: Vec<PathBuf> = entries
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| {
            p.is_file()
                && p.file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|n| n.starts_with("scrcpy-server"))
        })
        .collect();

    // 目录里有多个时取字典序，保证结果稳定
    candidates.sort();
    candidates.into_iter().next()
}

/// 组装工具链自检结果。
pub async fn diagnose(client: Option<&AdbClient>) -> ToolchainStatus {
    diagnose_with(&[], client).await
}

/// 与 [`diagnose`] 相同，但把 `extra_dirs` 交给 server 定位。
pub async fn diagnose_with(extra_dirs: &[PathBuf], client: Option<&AdbClient>) -> ToolchainStatus {
    let mut problems: Vec<String> = Vec::new();

    let (adb_version, reachable) = match client {
        Some(client) => match client.version().await {
            Ok(v) => (Some(format!("1.0.{v}")), true),
            Err(_) => {
                problems.push(
                    "无法连接 adb server。请确认已安装 Android Platform Tools 并已启动设备调试。"
                        .into(),
                );
                (None, false)
            }
        },
        None => {
            problems.push("adb 客户端尚未初始化".into());
            (None, false)
        }
    };

    let scrcpy_server_path = resolve_scrcpy_server_with(extra_dirs, None);
    if scrcpy_server_path.is_none() {
        problems.push(
            "未找到 scrcpy server 文件，投屏功能不可用。安装 scrcpy，或设置 SCRCPY_SERVER_PATH 指向该文件。"
                .into(),
        );
    }

    ToolchainStatus {
        adb_path: adb_executable_hint(),
        adb_version,
        adb_server_reachable: reachable,
        scrcpy_server_path: scrcpy_server_path.map(|p| p.display().to_string()),
        problems,
    }
}

/// 尽力给出 adb 可执行文件的提示路径。
///
/// 我们只依赖 adb **server**（TCP），因此定位可执行文件只是为了自检展示，
/// 找不到不算错误。
fn adb_executable_hint() -> Option<String> {
    if let Ok(explicit) = std::env::var("ADB_PATH") {
        let path = PathBuf::from(explicit);
        if path.is_file() {
            return Some(path.display().to_string());
        }
    }

    let candidates: Vec<PathBuf> = if cfg!(windows) {
        let mut v: Vec<PathBuf> = vec![
            PathBuf::from(r"C:\Program Files\Android\android-sdk\platform-tools\adb.exe"),
            PathBuf::from(r"C:\Program Files (x86)\Android\android-sdk\platform-tools\adb.exe"),
        ];
        v.extend(
            std::env::var_os("LOCALAPPDATA")
                .map(|p| PathBuf::from(p).join("Android/Sdk/platform-tools/adb.exe")),
        );
        v
    } else if cfg!(target_os = "macos") {
        vec![
            PathBuf::from("/opt/homebrew/bin/adb"),
            PathBuf::from("/usr/local/bin/adb"),
            PathBuf::from("/opt/android-sdk/platform-tools/adb"),
            PathBuf::from("/usr/local/share/android-sdk/platform-tools/adb"),
        ]
    } else {
        vec![
            PathBuf::from("/usr/bin/adb"),
            PathBuf::from("/usr/local/bin/adb"),
            PathBuf::from("/opt/android-sdk/platform-tools/adb"),
        ]
    };

    if let Some(found) = candidates.into_iter().find(|p| p.is_file()) {
        return Some(found.display().to_string());
    }

    // WinGet / 包管理器 / 手动解压通常只把 adb 加进 PATH，不在上面的固定目录里。
    let name = if cfg!(windows) { "adb.exe" } else { "adb" };
    std::env::var_os("PATH").and_then(|paths| {
        std::env::split_paths(&paths)
            .map(|dir| dir.join(name))
            .find(|p| p.is_file())
            .map(|p| p.display().to_string())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 目录中能找到_server_文件() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("scrcpy-server-v4.1");
        std::fs::write(&file, b"x").unwrap();

        assert_eq!(first_server_file(dir.path()), Some(file));
    }

    #[test]
    fn 忽略非_server_文件() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("readme.txt"), b"x").unwrap();

        assert_eq!(first_server_file(dir.path()), None);
    }

    #[test]
    fn 目录不存在时返回_none() {
        assert_eq!(first_server_file(Path::new("/definitely/not/here")), None);
    }

    #[test]
    fn 多个_server_文件时取字典序最小() {
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("scrcpy-server-4.0");
        let b = dir.path().join("scrcpy-server-4.1");
        std::fs::write(&a, b"x").unwrap();
        std::fs::write(&b, b"x").unwrap();

        assert_eq!(first_server_file(dir.path()), Some(a));
    }

    #[test]
    fn 未设置环境变量且找不到时返回_none() {
        // adb_path 为 None 时直接放弃，不应 panic
        assert_eq!(resolve_scrcpy_server(None), None);
    }
}
