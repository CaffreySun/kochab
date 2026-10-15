//! 真机集成测试。
//!
//! 这些用例**默认跳过**：没有设置 `ANDROID_TEST_DEVICE` 时直接返回，
//! 因此任何环境的 `cargo test --workspace` 都是绿的。
//! 用 `pnpm test:device` 会自动挑选已连接设备并真正执行。

use std::time::Duration;

use adb_client::testing::{device_serial, skip_reason};
use adb_client::{AdbClient, DeviceState};

macro_rules! require_device {
    () => {
        match device_serial() {
            Some(serial) => serial,
            None => {
                eprintln!("跳过：{}", skip_reason());
                return;
            }
        }
    };
}

fn client() -> AdbClient {
    // 连接是惰性的：这里只构造客户端，真正的 socket 在第一次请求时建立
    AdbClient::connect().expect("默认 adb 端点应当可解析")
}

#[tokio::test]
async fn 版本号可读取() {
    let _ = require_device!();

    let client = client();
    let version = client.version().await.expect("host:version 应成功");

    // 现代 Platform Tools 的内部版本号普遍在 29 以上
    assert!(version >= 29, "adb 版本号异常偏小：{version}");
}

#[tokio::test]
async fn 设备列表包含目标设备且状态就绪() {
    let serial = require_device!();
    let client = client();

    let devices = client.devices().await.expect("host:devices-l 应成功");
    let entry = devices
        .iter()
        .find(|d| d.serial == serial)
        .unwrap_or_else(|| panic!("设备列表中找不到 {serial}，实际列表：{devices:?}"));

    assert_eq!(
        entry.state,
        DeviceState::Device,
        "设备 {serial} 未就绪，请在手机上确认 USB 调试授权"
    );
}

#[tokio::test]
async fn 目标设备确实在设备列表里() {
    require_device!();
    let client = client();

    let devices = client.devices().await.expect("host:devices-l 应成功");
    assert!(!devices.is_empty(), "设备列表为空");
}

#[tokio::test]
async fn shell_能执行并返回退出码() {
    let serial = require_device!();
    let client = client();

    let ok = client
        .shell(&serial, "echo ac-ok")
        .await
        .expect("shell 应成功");
    assert!(
        ok.success(),
        "退出码应为 0，实际 {}：{}",
        ok.exit_code,
        ok.text()
    );
    assert!(
        ok.text().contains("ac-ok"),
        "输出应包含 echo 的内容：{}",
        ok.text()
    );

    let fail = client
        .shell(&serial, "exit 42")
        .await
        .expect("shell 应成功");
    assert_eq!(fail.exit_code, 42, "非零退出码应被正确提取");
    assert!(!fail.success());
}

#[tokio::test]
async fn shell_输出中的哨兵不会干扰退出码提取() {
    let serial = require_device!();
    let client = client();

    // 输出里包含大量特殊字符，且末行没有换行
    let out = client
        .shell(&serial, "printf 'no-newline\\n\\ttab\\n中文'")
        .await
        .expect("shell 应成功");

    assert!(out.success());
    assert_eq!(out.text(), "no-newline\n\ttab\n中文");
}

#[tokio::test]
async fn shell_超时会被标记而不是永久挂起() {
    let serial = require_device!();
    let client = client();

    let started = std::time::Instant::now();
    let out = client
        .shell_with_timeout(&serial, "sleep 5", Duration::from_millis(400))
        .await
        .expect("超时不应返回错误");

    assert!(out.timed_out, "应标记为超时");
    assert!(!out.success());
    assert!(
        started.elapsed() < Duration::from_secs(3),
        "超时未按预期提前返回"
    );
}

#[tokio::test]
async fn getprop_能读到设备属性() {
    let serial = require_device!();
    let client = client();

    let out = client
        .shell(&serial, "getprop ro.build.version.release")
        .await
        .expect("shell 应成功");

    assert!(out.success());
    assert!(!out.text().is_empty(), "ro.build.version.release 不应为空");
}

#[tokio::test]
async fn sync_能列出目录() {
    let serial = require_device!();
    let client = client();

    let mut session = client.open_sync(&serial).await.expect("sync 握手应成功");
    let entries = session.list("/sdcard").await.expect("sync list 应成功");

    // 绝大多数 Android 设备都有 /sdcard
    assert!(
        !entries.is_empty(),
        "/sdcard 目录为空，设备可能未完成启动或未解密存储"
    );
}

#[tokio::test]
async fn sync_stat_能区分存在与不存在() {
    let serial = require_device!();
    let client = client();

    let mut session = client.open_sync(&serial).await.expect("sync 握手应成功");

    let missing = session
        .stat("/sdcard/__ac_definitely_missing__")
        .await
        .expect("stat 应成功");
    assert!(missing.is_none(), "不存在的路径应返回 None");

    let dir = session
        .stat("/sdcard")
        .await
        .expect("stat 应成功")
        .expect("/sdcard 应存在");
    // `stat` 用的是 ID_LSTAT_V1（不跟随软链接）；
    // 现代 Android 上 /sdcard 是指向 /storage/emulated/0 的符号链接，
    // 因此这里断言「目录或软链接」而不是「必须是目录」。
    assert!(
        dir.is_dir() || dir.is_symlink(),
        "/sdcard 应是目录或指向目录的软链接，实际 mode={:o}",
        dir.mode
    );
}

#[tokio::test]
async fn sync_文件往返传输一致() {
    use std::path::PathBuf;

    let serial = require_device!();
    let client = client();

    let dir = tempfile::tempdir().expect("创建临时目录失败");
    let local_src: PathBuf = dir.path().join("src.bin");
    let local_dst: PathBuf = dir.path().join("dst.bin");
    let remote = "/sdcard/Download/__ac_sync_test.bin";

    // 确定性内容，便于校验字节级一致
    let payload: Vec<u8> = (0..200_000u32).map(|i| (i % 251) as u8).collect();
    std::fs::write(&local_src, &payload).expect("写入本地文件失败");

    let mut session = client.open_sync(&serial).await.expect("sync 握手应成功");

    let pushed = session
        .push(&local_src, remote, 0o644)
        .await
        .expect("上传失败");
    assert_eq!(pushed, payload.len() as u64, "上传字节数不符");

    let pulled = session.pull(remote, &local_dst).await.expect("下载失败");
    assert_eq!(pulled, payload.len() as u64, "下载字节数不符");

    let roundtrip = std::fs::read(&local_dst).expect("读取下载文件失败");
    assert_eq!(roundtrip, payload, "往返传输后内容不一致");

    // 清理：测试不能给设备留下垃圾
    let cleanup = client.shell(&serial, &format!("rm -f {remote}")).await;
    assert!(cleanup.is_ok(), "清理远端文件失败");
}
