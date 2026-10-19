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

use std::fs::File;
use std::io::{BufReader, BufWriter, Write};
use std::path::Path;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use adb_client::AdbClient;
use mp4::{
    AvcConfig, MediaConfig, Mp4Config, Mp4Reader, Mp4Sample, Mp4Writer, TrackConfig, TrackType,
};
use serde::Serialize;
use tracing::{debug, warn};

use crate::device::{map_adb_error, require_success};
use crate::error::{CoreError, Result};
use crate::file;

/// 设备端临时目录。`shell` 用户可写，且 adb sync 能直接 pull。
const REMOTE_TMP: &str = "/data/local/tmp";

/// `screenrecord` 的单次时长上限（秒）。Android 默认为 180，显式写出以便 UI 展示。
pub const RECORD_MAX_SECONDS: u32 = 180;

/// 录屏码率（bit/s）。设备默认 20 Mbps 对普通演示过大，8 Mbps 足够清晰。
const RECORD_BIT_RATE: u32 = 8_000_000;

/// 补帧后相邻视频帧的最大时间间隔（微秒）。
///
/// `screenrecord` 是可变帧率：画面静止时编码器不出帧，MP4 里就会出现
/// 1~7 秒的单帧时长。Windows 媒体播放器等会把它当成坏文件，开头一直黑屏，
/// 直到画面第一次变化。保存时把大间隔填成 ≤100ms 的重复帧即可正常起播；
/// 画面变化时仍保留原始帧率。
const MAX_FRAME_GAP_US: u64 = 100_000;

/// 重封装输出的时间基。直接使用微秒，和 `screenrecord` 的 PTS 精度一致。
const OUTPUT_TIMESCALE: u32 = 1_000_000;

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

    // 在等待进程收尾之前取时长：收尾、拉取都可能多花 1 秒，
    // 不能算进用户实际录制的长度。
    let expected_duration_us = now_millis()
        .saturating_sub(recording.started_at)
        .saturating_mul(1000);

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
    let pulled_bytes = file::pull(client, serial, &recording.remote_path, &target).await?;

    // 设备端 screenrecord 是 VFR；保存后补帧，避免 Windows 播放器开头黑屏。
    // 补帧失败不影响用户拿到原始文件。
    if let Err(err) = normalize_recording(&target, Some(expected_duration_us)) {
        warn!(path = %target.display(), %err, "录屏补帧失败，保留原始文件");
    }
    let bytes = std::fs::metadata(&target)
        .map(|m| m.len())
        .unwrap_or(pulled_bytes);

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

/// 把设备录制的 VFR MP4 重封装成“最大帧间隔 100ms”的文件。
///
/// 只复制编码帧、不重新编码，所以速度快且画质不变。画面静止时重复
/// 上一帧的编码数据；这些重复帧与原始帧共享同一个 `frame_num`，
/// 主流解码器会直接复用参考帧，不会产生额外的画质损失。
fn normalize_recording(input: &Path, expected_duration_us: Option<u64>) -> Result<()> {
    let temp = input.with_file_name(format!(".kochab-cfr-{}.mp4", unique_token()));
    match normalize_to_cfr(input, &temp, expected_duration_us) {
        Ok(true) => {
            // 先把完整结果写到临时文件，再覆盖原始文件；中途失败不会留下半截 MP4。
            std::fs::copy(&temp, input)?;
            let _ = std::fs::remove_file(&temp);
            let bytes = std::fs::metadata(input).map(|m| m.len()).unwrap_or(0);
            debug!(path = %input.display(), bytes, "录屏已补帧为 CFR");
            Ok(())
        }
        Ok(false) => {
            let _ = std::fs::remove_file(&temp);
            debug!(path = %input.display(), "录屏格式不支持补帧，保留原文件");
            Ok(())
        }
        Err(err) => {
            let _ = std::fs::remove_file(&temp);
            Err(err)
        }
    }
}

/// 返回 `Ok(false)` 表示输入不是可安全重封装的 AVC 视频（例如带音轨）。
fn normalize_to_cfr(
    input: &Path,
    output: &Path,
    expected_duration_us: Option<u64>,
) -> Result<bool> {
    let file = File::open(input)?;
    let size = file.metadata()?.len();
    let mut reader = Mp4Reader::read_header(BufReader::new(file), size)
        .map_err(|e| CoreError::Internal(format!("无法解析录屏 MP4：{e}")))?;

    // 本项目不录音频；若出现音轨说明不是 screenrecord 的输出，直接跳过，
    // 避免补帧时把音轨丢掉。
    if reader
        .tracks()
        .values()
        .any(|t| matches!(t.track_type(), Ok(TrackType::Audio)))
    {
        return Ok(false);
    }

    let Some(track) = reader
        .tracks()
        .values()
        .find(|t| matches!(t.track_type(), Ok(TrackType::Video)))
    else {
        return Ok(false);
    };

    let track_id = track.track_id();
    let width = track.width();
    let height = track.height();
    let timescale = track.timescale();
    let sample_count = track.sample_count();
    // 只处理 H.264；HEVC 的 SPS/PPS 结构不同，跳过即可。
    let (Ok(sps), Ok(pps)) = (
        track.sequence_parameter_set(),
        track.picture_parameter_set(),
    ) else {
        return Ok(false);
    };
    if sample_count == 0 || timescale == 0 {
        return Ok(false);
    }
    let (sps, pps) = (sps.to_vec(), pps.to_vec());

    let config = Mp4Config {
        major_brand: "isom"
            .parse()
            .map_err(|e| CoreError::Internal(format!("无效 MP4 brand：{e}")))?,
        minor_version: 512,
        compatible_brands: ["isom", "iso2", "avc1", "mp41"]
            .into_iter()
            .map(|brand| {
                brand
                    .parse()
                    .map_err(|e| CoreError::Internal(format!("无效 MP4 brand：{e}")))
            })
            .collect::<Result<_>>()?,
        timescale: OUTPUT_TIMESCALE,
    };
    let mut writer = Mp4Writer::write_start(BufWriter::new(File::create(output)?), &config)
        .map_err(|e| CoreError::Internal(format!("无法写入录屏 MP4：{e}")))?;
    writer
        .add_track(&TrackConfig {
            track_type: TrackType::Video,
            timescale: OUTPUT_TIMESCALE,
            language: "und".to_owned(),
            media_conf: MediaConfig::AvcConfig(AvcConfig {
                width,
                height,
                seq_param_set: sps,
                pic_param_set: pps,
            }),
        })
        .map_err(|e| CoreError::Internal(format!("无法写入录屏轨道：{e}")))?;

    let mut written_us = 0u64;
    let mut current = reader
        .read_sample(track_id, 1)
        .map_err(|e| CoreError::Internal(format!("无法读取录屏帧：{e}")))?
        .ok_or_else(|| CoreError::Internal("录屏没有视频帧".to_owned()))?;

    for index in 1..=sample_count {
        // 有 B 帧时 rendering_offset 非 0，复制帧会破坏显示顺序，交给原文件。
        if current.rendering_offset != 0 {
            return Ok(false);
        }

        let next = if index < sample_count {
            reader
                .read_sample(track_id, index + 1)
                .map_err(|e| CoreError::Internal(format!("无法读取录屏帧：{e}")))?
        } else {
            None
        };

        // 原始 MP4 的 start_time/duration 都以 track timescale 为单位。
        let delta = next
            .as_ref()
            .map(|n| n.start_time.saturating_sub(current.start_time))
            .unwrap_or(u64::from(current.duration));
        let mut delta_us = ((u128::from(delta) * 1_000_000) / u128::from(timescale)) as u64;

        // 最后一个样本的 duration 在 screenrecord 的单帧文件里可能是 0。
        // 用实际录制时长兜底，避免 1 秒的录屏被压成 1 微秒。
        if delta_us == 0 {
            delta_us = if next.is_none() {
                expected_duration_us
                    .unwrap_or(0)
                    .saturating_sub(written_us)
                    .max(1)
            } else {
                1
            };
        }

        let mut remaining = delta_us;
        let mut first = true;

        while remaining > 0 {
            let duration = remaining.min(MAX_FRAME_GAP_US) as u32;
            writer
                .write_sample(
                    1,
                    &Mp4Sample {
                        start_time: 0,
                        duration,
                        rendering_offset: 0,
                        // 重复帧也来自同一个 I 帧，但只需首个样本进入 stss。
                        is_sync: first && current.is_sync,
                        bytes: current.bytes.clone(),
                    },
                )
                .map_err(|e| CoreError::Internal(format!("无法写入录屏帧：{e}")))?;
            remaining -= u64::from(duration);
            written_us += u64::from(duration);
            first = false;
        }

        match next {
            Some(sample) => current = sample,
            None => break,
        }
    }

    writer
        .write_end()
        .map_err(|e| CoreError::Internal(format!("无法收尾录屏 MP4：{e}")))?;
    writer
        .into_writer()
        .flush()
        .map_err(|e| CoreError::Internal(format!("无法写入录屏 MP4：{e}")))?;
    Ok(true)
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

    fn write_test_mp4(path: &Path, frames: &[(u32, bool)]) {
        let config = Mp4Config {
            major_brand: "isom".parse().unwrap(),
            minor_version: 512,
            compatible_brands: vec!["isom".parse().unwrap()],
            timescale: OUTPUT_TIMESCALE,
        };
        let mut writer =
            Mp4Writer::write_start(BufWriter::new(File::create(path).unwrap()), &config).unwrap();
        writer
            .add_track(&TrackConfig {
                track_type: TrackType::Video,
                timescale: OUTPUT_TIMESCALE,
                language: "und".to_owned(),
                media_conf: MediaConfig::AvcConfig(AvcConfig {
                    width: 1080,
                    height: 2160,
                    seq_param_set: vec![0x67, 0x64, 0x00, 0x32, 0xAC, 0x3B, 0x50, 0x22],
                    pic_param_set: vec![0x68, 0xEE, 0x06, 0xE2],
                }),
            })
            .unwrap();
        for (duration, is_sync) in frames {
            writer
                .write_sample(
                    1,
                    &Mp4Sample {
                        start_time: 0,
                        duration: *duration,
                        rendering_offset: 0,
                        is_sync: *is_sync,
                        bytes: bytes::Bytes::from_static(&[0, 0, 0, 1, 0x65]),
                    },
                )
                .unwrap();
        }
        writer.write_end().unwrap();
        writer.into_writer().flush().unwrap();
    }

    fn read_durations(path: &Path) -> (u32, u32, u32) {
        let file = File::open(path).unwrap();
        let size = file.metadata().unwrap().len();
        let mut reader = Mp4Reader::read_header(BufReader::new(file), size).unwrap();
        let (track_id, timescale, sample_count) = {
            let track = reader
                .tracks()
                .values()
                .find(|t| matches!(t.track_type(), Ok(TrackType::Video)))
                .expect("缺少视频轨");
            (track.track_id(), track.timescale(), track.sample_count())
        };
        let mut max_gap = 0u32;
        let mut total = 0u64;
        for id in 1..=sample_count {
            let sample = reader.read_sample(track_id, id).unwrap().unwrap();
            max_gap = max_gap.max(sample.duration);
            total += u64::from(sample.duration);
        }
        (
            sample_count,
            max_gap,
            (total * 1_000_000 / u64::from(timescale)) as u32,
        )
    }

    #[test]
    fn 补帧后最大帧间隔不超过100毫秒且总时长不变() {
        let dir = tempfile::tempdir().expect("创建临时目录失败");
        let path = dir.path().join("sparse.mp4");

        // 3 秒静止 + 50ms 画面变化：模拟 screenrecord 的稀疏 VFR 输出。
        write_test_mp4(
            &path,
            &[
                (3_000_000, true),
                (33_333, false),
                (16_667, false),
                (16_667, false),
            ],
        );
        normalize_recording(&path, None).expect("补帧失败");

        let (sample_count, max_gap, total_us) = read_durations(&path);
        assert!(sample_count > 1);
        assert!(
            u128::from(max_gap) * 1_000_000 / u128::from(OUTPUT_TIMESCALE)
                <= u128::from(MAX_FRAME_GAP_US),
            "最大帧间隔超过上限"
        );
        assert!(
            total_us.abs_diff(3_066_667) < 5_000,
            "总时长 {total_us}us 偏离原始时长"
        );
    }

    #[test]
    fn 单帧录屏按实际时长补帧() {
        let dir = tempfile::tempdir().expect("创建临时目录失败");
        let path = dir.path().join("single.mp4");

        // screenrecord 在完全静止时会写出 1 帧且 duration=0。
        write_test_mp4(&path, &[(0, true)]);
        normalize_recording(&path, Some(2_000_000)).expect("补帧失败");

        let (sample_count, max_gap, total_us) = read_durations(&path);
        assert!(sample_count >= 20, "2 秒静止应补出至少 20 帧");
        assert!(
            u128::from(max_gap) * 1_000_000 / u128::from(OUTPUT_TIMESCALE)
                <= u128::from(MAX_FRAME_GAP_US),
            "最大帧间隔超过上限"
        );
        assert!(
            total_us.abs_diff(2_000_000) < 5_000,
            "单帧录屏时长 {total_us}us 未按实际时长补齐"
        );
    }
}
