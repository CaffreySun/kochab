//! 真机集成测试：设备属性、应用管理、文件管理。
//!
//! 默认跳过；`pnpm test:device` 会注入 `ANDROID_TEST_DEVICE` 后真正执行。
//! 所有会修改设备状态的用例都必须自行清理。

use std::fs::File;
use std::io::BufReader;
use std::path::PathBuf;

use adb_client::AdbClient;
use android_core::testing::{skip_reason, temp_name};
use android_core::{app, device, display, file, media, toolchain};
use mp4::{Mp4Reader, TrackType};

macro_rules! require_device {
    () => {
        match android_core::testing::device_serial() {
            Some(serial) => serial,
            None => {
                eprintln!("跳过：{}", skip_reason());
                return;
            }
        }
    };
}

fn client() -> AdbClient {
    AdbClient::connect().expect("默认 adb 端点应当可解析")
}

#[tokio::test]
async fn 工具链自检不返回未知问题() {
    let _serial = require_device!();
    let c = client();
    let status = toolchain::diagnose(Some(&c)).await;

    // adb 一定可达（否则 client() 就失败了）；scrcpy server 可能缺失，但那要有明确文案
    assert!(status.adb_server_reachable);
    for problem in &status.problems {
        assert!(!problem.trim().is_empty(), "问题文案不应为空");
    }
}

#[tokio::test]
async fn 采集设备属性() {
    let serial = require_device!();
    let c = client();

    let devices = c.devices().await.expect("列举设备失败");
    let entry = devices
        .iter()
        .find(|d| d.serial == serial)
        .expect("目标设备不在列表中");
    assert!(entry.state.is_ready(), "设备未就绪：{}", entry.state);

    let info = device::collect(&c, &serial, entry.state)
        .await
        .expect("采集属性失败");

    assert_eq!(info.serial, serial);
    assert!(info.is_ready());
    assert!(info.model.is_some(), "缺少机型");
    assert!(info.android_version.is_some(), "缺少 Android 版本");
    assert!(info.sdk_int.is_some(), "缺少 SDK 版本");
    assert!(!info.title().is_empty());
}

#[tokio::test]
async fn 列出应用包含系统与用户应用() {
    let serial = require_device!();
    let c = client();

    let all = app::list(&c, &serial, None, true)
        .await
        .expect("列出应用失败");
    assert!(all.len() > 10, "应用数量异常：{}", all.len());

    assert!(all.iter().any(|a| a.is_system), "应包含系统应用");
    assert!(all.iter().any(|a| !a.is_system), "应包含用户应用");

    // 列表应已排序：用户应用在前
    let first_system = all.iter().position(|a| a.is_system);
    if let Some(idx) = first_system {
        assert!(
            all[idx..].iter().all(|a| a.is_system),
            "排序错误：系统应用应全部排在末尾"
        );
    }
}

#[tokio::test]
async fn 筛选应用只返回匹配项() {
    let serial = require_device!();
    let c = client();

    let filtered = app::list(&c, &serial, Some("com.android.settings"), true)
        .await
        .expect("筛选失败");

    assert!(!filtered.is_empty());
    for entry in &filtered {
        assert!(
            entry
                .package_name
                .to_lowercase()
                .contains("com.android.settings"),
            "筛选结果包含无关应用：{}",
            entry.package_name
        );
    }
}

#[tokio::test]
async fn 只显示用户应用时不含系统应用() {
    let serial = require_device!();
    let c = client();

    let user_apps = app::list(&c, &serial, None, false)
        .await
        .expect("列出用户应用失败");

    assert!(!user_apps.is_empty(), "用户应用列表为空");
    assert!(user_apps.iter().all(|a| !a.is_system), "不应包含系统应用");
}

#[tokio::test]
async fn 系统应用的_dumpsys_详情可解析() {
    let serial = require_device!();
    let c = client();

    // com.android.settings 在几乎所有 Android 设备上都存在
    let details = app::details(&c, &serial, "com.android.settings")
        .await
        .expect("读取详情失败");

    assert_eq!(details.package_name, "com.android.settings");
    assert!(details.version_name.is_some(), "缺少 versionName");
    assert!(details.is_system);
}

#[tokio::test]
async fn 导出一个应用到本机目录() {
    let serial = require_device!();
    let c = client();

    // com.android.settings 在几乎所有 Android 设备上都存在
    let remote = app::resolve_apks(&c, &serial, "com.android.settings")
        .await
        .expect("pm path 失败");
    assert!(!remote.is_empty(), "应当至少解析出一个安装文件");

    let dir = tempfile::tempdir().expect("创建临时目录失败");
    let stem = app::sanitize_stem("com.android.settings_1.0");
    let result = app::export(&c, &serial, "com.android.settings", dir.path(), &stem)
        .await
        .expect("导出失败");

    assert_eq!(result.package_name, "com.android.settings");
    assert_eq!(
        result.files.len(),
        remote.len(),
        "落盘文件数应与 pm path 一致"
    );

    let into_directory = remote.len() > 1;
    let expected_dir = if into_directory {
        dir.path().join(&stem)
    } else {
        dir.path().to_path_buf()
    };
    assert_eq!(PathBuf::from(&result.directory), expected_dir);

    let mut total = 0u64;
    for (index, file) in result.files.iter().enumerate() {
        let local = PathBuf::from(&file.local_path);
        let name = local.file_name().unwrap().to_string_lossy().to_string();
        let remote = &remote[index];
        if into_directory {
            // 多个安装文件：保留设备上的原始文件名，拆分关系不能丢
            let original = remote.rsplit('/').next().unwrap_or(remote);
            assert_eq!(name, original, "多文件时应保留原始文件名");
        } else {
            // 单个安装文件：平铺成 <stem><设备上的扩展名>
            let ext = remote
                .rsplit_once('.')
                .map(|(_, ext)| format!(".{ext}"))
                .unwrap_or_else(|| ".apk".to_owned());
            assert_eq!(name, format!("{stem}{ext}"), "单文件时应按建议名落盘");
        }
        let meta = std::fs::metadata(&local).expect("落盘文件不存在");
        assert_eq!(meta.len(), file.bytes, "落盘大小与返回值不一致");
        assert!(meta.len() > 0, "导出的文件不应为空");
        total += meta.len();
    }
    assert!(total > 0, "导出总字节数应大于 0");
    eprintln!("导出完成：{} 个文件，{} 字节", result.files.len(), total);
}

#[tokio::test]
async fn 列出外部存储根目录() {
    let serial = require_device!();
    let c = client();

    let entries = file::list(&c, &serial, "/sdcard")
        .await
        .expect("列出 /sdcard 失败");

    assert!(!entries.is_empty(), "/sdcard 为空");
    // 目录在前：第一个文件之前必须全是目录
    if let Some(first_file) = entries.iter().position(|e| !e.is_directory) {
        assert!(
            entries[..first_file].iter().all(|e| e.is_directory),
            "目录应排在文件之前"
        );
    }
}

#[tokio::test]
async fn 列出不存在的目录返回空或报错但不崩溃() {
    let serial = require_device!();
    let c = client();

    // sync 协议对不存在的目录只回 DONE，即空列表
    let result = file::list(&c, &serial, "/__ac_missing_dir__").await;

    match result {
        Ok(entries) => assert!(entries.is_empty(), "不存在的目录应返回空列表"),
        Err(e) => eprintln!("（设备以错误方式报告缺失目录：{e}）"),
    }
}

#[tokio::test]
async fn 文件往返传输并校验内容() {
    let serial = require_device!();
    let c = client();

    let dir = tempfile::tempdir().expect("创建临时目录失败");
    let local_src: PathBuf = dir.path().join("src.bin");
    let local_dst: PathBuf = dir.path().join("dst.bin");
    let name = temp_name("file");
    let remote = format!("/sdcard/Download/{name}.bin");

    let payload: Vec<u8> = (0..300_000u32).map(|i| (i % 253) as u8).collect();
    std::fs::write(&local_src, &payload).expect("写入本地文件失败");

    file::push(&c, &serial, &local_src, &remote)
        .await
        .expect("上传失败");
    file::pull(&c, &serial, &remote, &local_dst)
        .await
        .expect("下载失败");

    assert_eq!(std::fs::read(&local_dst).unwrap(), payload);

    file::delete(&c, &serial, &remote)
        .await
        .expect("清理远端文件失败");
    assert!(
        file::stat(&c, &serial, &remote).await.unwrap().is_none(),
        "删除后应查不到"
    );
}

#[tokio::test]
async fn 新建目录后可见再删除() {
    let serial = require_device!();
    let c = client();

    let name = temp_name("dir");
    let remote = format!("/sdcard/Download/{name}");

    file::create_dir(&c, &serial, &remote)
        .await
        .expect("新建目录失败");
    let found = file::stat(&c, &serial, &remote)
        .await
        .expect("查询目录失败");
    assert!(
        found.is_some_and(|e| e.is_directory),
        "新建的目录应可见且为目录"
    );

    file::delete_recursive(&c, &serial, &remote)
        .await
        .expect("删除目录失败");
    assert!(file::stat(&c, &serial, &remote).await.unwrap().is_none());
}

#[tokio::test]
async fn 重命名文件() {
    let serial = require_device!();
    let c = client();

    let name = temp_name("rename");
    let source = format!("/sdcard/Download/{name}.txt");
    let target = format!("/sdcard/Download/{name}_renamed.txt");

    let dir = tempfile::tempdir().unwrap();
    let local = dir.path().join("src.txt");
    std::fs::write(&local, b"rename test").unwrap();

    file::push(&c, &serial, &local, &source)
        .await
        .expect("上传失败");
    file::rename(&c, &serial, &source, &target)
        .await
        .expect("重命名失败");

    assert!(
        file::stat(&c, &serial, &source).await.unwrap().is_none(),
        "旧名字应消失"
    );
    assert!(
        file::stat(&c, &serial, &target).await.unwrap().is_some(),
        "新名字应存在"
    );

    file::delete(&c, &serial, &target).await.expect("清理失败");
}

#[tokio::test]
async fn 递归下载目录保留结构与内容() {
    let serial = require_device!();
    let c = client();

    let name = temp_name("pulldir");
    let remote = format!("/sdcard/Download/{name}");
    let remote_sub = format!("{remote}/sub");
    file::create_dir(&c, &serial, &remote_sub)
        .await
        .expect("创建远端目录失败");

    let dir = tempfile::tempdir().expect("创建临时目录失败");
    let local_a = dir.path().join("a.txt");
    let local_b = dir.path().join("b.txt");
    std::fs::write(&local_a, b"alpha").unwrap();
    std::fs::write(&local_b, b"beta").unwrap();
    file::push(&c, &serial, &local_a, &format!("{remote}/a.txt"))
        .await
        .expect("上传 a 失败");
    file::push(&c, &serial, &local_b, &format!("{remote_sub}/b.txt"))
        .await
        .expect("上传 b 失败");

    let download = tempfile::tempdir().expect("创建下载目录失败");
    let (target, bytes) = file::pull_dir(&c, &serial, &remote, download.path())
        .await
        .expect("递归下载失败");

    assert_eq!(target.file_name().unwrap(), name.as_str());
    assert_eq!(std::fs::read(target.join("a.txt")).unwrap(), b"alpha");
    assert_eq!(std::fs::read(target.join("sub/b.txt")).unwrap(), b"beta");
    assert_eq!(bytes, 9, "总字节数应为两个文件之和");

    file::delete_recursive(&c, &serial, &remote)
        .await
        .expect("清理远端目录失败");
}

#[tokio::test]
async fn 显示覆盖可读取并恢复() {
    let serial = require_device!();
    let c = client();

    // 先制造一个确定可识别的覆盖，测完必须恢复
    c.shell(&serial, "wm size 720x1440")
        .await
        .expect("设置覆盖尺寸失败");
    c.shell(&serial, "wm density 320")
        .await
        .expect("设置覆盖密度失败");

    let overridden = display::inspect(&c, &serial)
        .await
        .expect("读取显示状态失败");
    assert_eq!(overridden.override_size.as_deref(), Some("720x1440"));
    assert_eq!(overridden.override_density.as_deref(), Some("320"));

    let result = display::reset(&c, &serial).await.expect("恢复显示失败");
    assert!(result.overridden);

    let after = display::inspect(&c, &serial).await.expect("恢复后读取失败");
    assert!(!after.is_overridden(), "恢复后不应再有覆盖值");
}

#[tokio::test]
async fn 录屏开始停止并落盘() {
    let serial = require_device!();
    let c = client();

    let recording = media::start_recording(&c, &serial)
        .await
        .expect("启动录屏失败");
    assert!(recording.started_at > 0, "开始时间应写入状态");

    tokio::time::sleep(std::time::Duration::from_millis(1200)).await;

    let dir = tempfile::tempdir().expect("创建临时目录失败");
    let saved = media::stop_recording(&c, &serial, &recording, dir.path(), Some("ac-rec-e2e"))
        .await
        .expect("停止录屏失败");

    assert!(saved.bytes > 0, "录屏文件不应为空");
    assert!(PathBuf::from(&saved.path).is_file(), "本地文件应存在");

    // screenrecord 在静止画面只输出很少几帧；保存时必须补帧，
    // 否则 Windows 播放器开头会黑屏到第一次画面变化。
    let file = File::open(&saved.path).expect("打开录屏失败");
    let size = file.metadata().expect("读取录屏大小失败").len();
    let mut reader = Mp4Reader::read_header(BufReader::new(file), size).expect("解析录屏失败");
    let (track_id, timescale, sample_count) = {
        let track = reader
            .tracks()
            .values()
            .find(|t| matches!(t.track_type(), Ok(TrackType::Video)))
            .expect("录屏缺少视频轨");
        (track.track_id(), track.timescale(), track.sample_count())
    };
    assert!(sample_count > 1, "静止画面也应补出多帧");
    let mut max_gap = 0u32;
    for id in 1..=sample_count {
        let sample = reader
            .read_sample(track_id, id)
            .expect("读取录屏帧失败")
            .expect("录屏帧不存在");
        max_gap = max_gap.max(sample.duration);
    }
    let max_gap_us = u128::from(max_gap) * 1_000_000 / u128::from(timescale);
    assert!(max_gap_us <= 100_000, "补帧后最大间隔仍为 {max_gap_us}us");
}
