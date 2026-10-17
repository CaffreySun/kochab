//! 截屏与录屏。
//!
//! 两者都走设备自带的工具，再把结果拉到本机：
//!
//! - 截屏：`screencap -p` 落一个 PNG 到 `/data/local/tmp`，pull 后删除；
//! - 录屏：`screenrecord` 后台运行（输出重定向，避免 adb shell 一直挂在管道上），
//!   停止时发 `SIGINT` —— `screenrecord` 只有收到中断才会写完 MP4 的 moov box，
//!   直接杀进程会留下无法播放的残缺文件。
//!
//! 远端临时文件带时间戳与本机 PID，避免同一台设备上并发操作互相覆盖。

use std::path::Path;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use adb_client::AdbClient;
use serde::Serialize;
use tracing::debug;

use crate::device::{map_adb_error, require_success};
use crate::error::{CoreError, Result};
use crate::file;

/// 设备端临时目录。`shell` 用户可写，且 adb sync 能直接 pull。
const REMOTE_TMP: &str = "/data/local/tmp";

/// `screenrecord` 的单次时长上限（秒）。Android 默认为 180，显式写出以便 UI 展示。
pub const RECORD_MAX_SECONDS: u32 = 180;

/// 录屏码率（bit/s）。设备默认 20 Mbps 对普通演示过大，8 Mbps 足够清晰。
const RECORD_BIT_RATE: u32 = 8_000_000;

/// 落盘结果。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedFile {
    pub path: String,
    pub bytes: u64,
}

/// 一条正在设备端运行的录屏。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Recording {
    pub pid: u32,
    pub remote_path: String,
    /// `screenrecord` 的 stderr；启动失败时用它解释原因
    pub log_path: String,
    /// 开始录制的 Unix 毫秒时间戳；跨窗口显示读秒以它为准
    pub started_at: u64,
}

/// 截屏并保存到 `local_dir`。
///
/// `suggested_name` 是前端生成的本地时间名（如 `截屏_20261017_211530`），
/// 后端只做白名单清洗；为空时退回时间戳。
pub async fn screenshot(
    client: &AdbClient,
    serial: &str,
    local_dir: &Path,
    suggested_name: Option<&str>,
) -> Result<SavedFile> {
    ensure_local_dir(local_dir)?;

    let remote = format!("{REMOTE_TMP}/ac-shot-{}.png", unique_token());
    let command = format!("screencap -p '{remote}'");
    let out = client
        .shell(serial, &command)
        .await
        .map_err(map_adb_error)?;
    require_success(out, "截屏")?;

    let name = sanitized_name(suggested_name, "png", "screenshot");
    let target = local_dir.join(name);
    let bytes = file::pull(client, serial, &remote, &target).await?;

    // 临时文件清理失败不影响结果，下次会话启动时也会清理
    let _ = client.shell(serial, &format!("rm -f '{remote}'")).await;

    Ok(SavedFile {
        path: target.display().to_string(),
        bytes,
    })
}

/// 在设备上启动 `screenrecord`，返回 PID 与远端文件名。
pub async fn start_recording(client: &AdbClient, serial: &str) -> Result<Recording> {
    let token = unique_token();
    let remote_path = format!("{REMOTE_TMP}/ac-rec-{token}.mp4");
    let log_path = format!("{REMOTE_TMP}/ac-rec-{token}.log");

    // 后台进程必须 detach：
    // - 不重定向 stdout/stderr 的话，adb shell 的管道会一直被它占着；
    // - 不套 `nohup` 的话，本次 adb shell 连接一断，`screenrecord` 会收到 HUP 直接退出
    //   （命令本身返回了 PID，看起来成功，实际设备上什么都没录）。
    let command = format!(
        "rm -f '{remote_path}' '{log_path}'; \
         nohup screenrecord --time-limit {RECORD_MAX_SECONDS} --bit-rate {RECORD_BIT_RATE} \
         '{remote_path}' >'{log_path}' 2>&1 </dev/null & echo $!"
    );
    let out = client
        .shell(serial, &command)
        .await
        .map_err(map_adb_error)?;
    let pid = parse_pid(&out.stdout);
    require_success(out, "启动录屏")?;
    let pid = pid.ok_or_else(|| CoreError::Internal("无法解析 screenrecord 进程号".to_owned()))?;

    // screenrecord 会在编码器初始化失败时立刻退出；稍等一下再确认，
    // 避免把「已经死掉的进程」当成正在录屏。
    tokio::time::sleep(Duration::from_millis(500)).await;
    let check = format!(
        "if kill -0 {pid} 2>/dev/null; then echo running; \
         elif test -s '{remote_path}'; then echo stopped; else echo dead; fi"
    );
    let state = client
        .shell(serial, &check)
        .await
        .map_err(map_adb_error)?
        .stdout;
    let state = state.trim();
    if state == "dead" {
        let log = read_log(client, serial, &log_path).await;
        let _ = client
            .shell(serial, &format!("rm -f '{remote_path}' '{log_path}'"))
            .await;
        return Err(CoreError::Internal(format!(
            "设备未能开始录屏{}",
            if log.is_empty() {
                "（screenrecord 无输出）".to_owned()
            } else {
                format!("：{log}")
            }
        )));
    }

    Ok(Recording {
        pid,
        remote_path,
        log_path,
        started_at: now_millis(),
    })
}

/// 停止录屏、等待文件收尾，并拉到 `local_dir`。
pub async fn stop_recording(
    client: &AdbClient,
    serial: &str,
    recording: &Recording,
    local_dir: &Path,
    suggested_name: Option<&str>,
) -> Result<SavedFile> {
    ensure_local_dir(local_dir)?;

    // SIGINT 让 screenrecord 正常写完 MP4；进程已经自己结束（到达时限）时忽略错误。
    let _ = client
        .shell(serial, &format!("kill -2 {}", recording.pid))
        .await;

    // 等待进程退出 + 文件落定。screenrecord 收尾通常在几百毫秒内。
    let mut gone = false;
    for _ in 0..20 {
        tokio::time::sleep(Duration::from_millis(200)).await;
        let out = client
            .shell(
                serial,
                &format!(
                    "if kill -0 {} 2>/dev/null; then echo running; else echo gone; fi",
                    recording.pid
                ),
            )
            .await
            .map_err(map_adb_error)?;
        if out.stdout.trim() == "gone" {
            gone = true;
            break;
        }
    }
    if !gone {
        debug!(
            serial,
            pid = recording.pid,
            "screenrecord 未按时退出，仍尝试拉取"
        );
    }

    // 进程退出后可能还有一点尾部写入，给文件系统一个短暂的稳定窗口。
    tokio::time::sleep(Duration::from_millis(250)).await;

    let exists = client
        .shell(
            serial,
            &format!("test -s '{}' && echo yes || echo no", recording.remote_path),
        )
        .await
        .map_err(map_adb_error)?
        .stdout;
    if exists.trim() != "yes" {
        let log = read_log(client, serial, &recording.log_path).await;
        return Err(CoreError::Internal(format!(
            "录屏文件为空或不存在{}",
            if log.is_empty() {
                String::new()
            } else {
                format!("：{log}")
            }
        )));
    }

    let name = sanitized_name(suggested_name, "mp4", "recording");
    let target = local_dir.join(name);
    let bytes = file::pull(client, serial, &recording.remote_path, &target).await?;

    let _ = client
        .shell(
            serial,
            &format!("rm -f '{}' '{}'", recording.remote_path, recording.log_path),
        )
        .await;

    Ok(SavedFile {
        path: target.display().to_string(),
        bytes,
    })
}

/// 放弃一条录屏：尽力停掉设备端进程并删除临时文件，不拉取结果。
///
/// 用于设备断开、用户明确放弃等场景；所有错误都忽略——调用方此时只想清掉状态。
pub async fn cancel_recording(client: &AdbClient, serial: &str, recording: &Recording) {
    let _ = client
        .shell(serial, &format!("kill -2 {}", recording.pid))
        .await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    let _ = client
        .shell(
            serial,
            &format!("rm -f '{}' '{}'", recording.remote_path, recording.log_path),
        )
        .await;
}

/// 清理设备端遗留的临时文件（崩溃/强退后留下的截图与录屏）。
///
/// 只删 10 分钟前的文件：避免把另一个正在运行的实例刚创建的录制删掉。
pub async fn clean_stale(client: &AdbClient, serial: &str) {
    let _ = client
        .shell(
            serial,
            "find /data/local/tmp -maxdepth 1 -name 'ac-shot-*' -mmin +10 -delete 2>/dev/null; \
             find /data/local/tmp -maxdepth 1 -name 'ac-rec-*' -mmin +10 -delete 2>/dev/null",
        )
        .await;
}

/// 从 `echo $!` 的输出里取 PID。
///
/// 只接受纯数字；设备 shell 可能顺带打印别的内容（例如 `sh: ...`），
/// 取最后一个数字段更稳，但绝不把非数字拼进后续命令。
pub fn parse_pid(output: &str) -> Option<u32> {
    output
        .split_whitespace()
        .rev()
        .find_map(|token| token.parse::<u32>().ok())
}

/// 文件名的白名单清洗。
///
/// 保留字母、数字（含中文）与 `-` `_`；其余字符（空格、斜杠、点等）替换为 `_`。
/// 扩展名以参数为准，避免前端传入 `.exe` 之类的内容。
pub fn sanitized_name(suggested: Option<&str>, ext: &str, fallback: &str) -> String {
    let raw = suggested
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(fallback);

    // 去掉前端可能已经带上的同名扩展名
    let stem = raw.strip_suffix(&format!(".{ext}")).unwrap_or(raw).trim();

    let cleaned: String = stem
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let cleaned = cleaned.trim_matches('_');
    let stem = if cleaned.is_empty() {
        fallback
    } else {
        cleaned
    };
    format!("{stem}.{ext}")
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn unique_token() -> String {
    format!("{}-{}", now_millis(), std::process::id())
}

async fn read_log(client: &AdbClient, serial: &str, log_path: &str) -> String {
    match client
        .shell(serial, &format!("cat '{log_path}' 2>/dev/null"))
        .await
    {
        Ok(out) => out.stdout.trim().to_owned(),
        Err(_) => String::new(),
    }
}

fn ensure_local_dir(dir: &Path) -> Result<()> {
    if dir.is_dir() {
        return Ok(());
    }
    std::fs::create_dir_all(dir).map_err(|e| {
        CoreError::Io(std::io::Error::new(
            e.kind(),
            format!("无法创建本地目录 {}：{e}", dir.display()),
        ))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 从后台任务输出解析_pid() {
        assert_eq!(parse_pid("8954\n"), Some(8954));
        assert_eq!(parse_pid("warning\n12345\n"), Some(12345));
        assert_eq!(parse_pid(""), None);
        assert_eq!(parse_pid("not-a-pid"), None);
    }

    #[test]
    fn 文件名只保留安全字符() {
        assert_eq!(
            sanitized_name(Some("截屏 2026/10/17"), "png", "screenshot"),
            "截屏_2026_10_17.png"
        );
        assert_eq!(
            sanitized_name(Some("../evil"), "png", "screenshot"),
            "evil.png"
        );
        assert_eq!(
            sanitized_name(Some("shot.png"), "png", "screenshot"),
            "shot.png"
        );
        assert_eq!(
            sanitized_name(Some("   "), "png", "screenshot"),
            "screenshot.png"
        );
        assert_eq!(sanitized_name(None, "mp4", "recording"), "recording.mp4");
    }
}
