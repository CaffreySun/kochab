//! 真机投屏集成测试。
//!
//! 与 `adb-client` / `android-core` 的真机测试同构：默认跳过，
//! 由 `pnpm test:device` 注入 `ANDROID_TEST_DEVICE` 后执行。
//!
//! 覆盖真实链路：推送 server → 端口转发 → `app_process` 启动 → 握手 → 收帧。

use std::path::PathBuf;
use std::time::Duration;

use adb_client::testing::{device_serial, skip_reason};
use adb_client::AdbClient;
use scrcpy_session::{SessionFactory, SessionOptions};

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
    AdbClient::connect().expect("默认 adb 守护进程应可连接")
}

/// 本地 scrcpy-server 资源路径。
fn server_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../assets/scrcpy-server-v4.1")
}

#[tokio::test]
async fn 真机_握手并读到视频帧() {
    let serial = require_device!();

    let factory = SessionFactory::new(client(), server_path());
    let options = SessionOptions {
        max_fps: 24,
        max_size: 720,
        ..SessionOptions::default()
    };
    let session = factory
        .start("it-handshake", &serial, &options)
        .await
        .expect("会话应能建立");

    let info = session.info().clone();
    println!("会话信息：{info:?}");

    assert_eq!(info.serial, serial);
    assert!(info.local_port > 0, "应分配了本地转发端口");
    assert!(info.width > 0 && info.height > 0, "应从 SESSION 包读到尺寸");
    assert!(!info.device_name.is_empty(), "设备名不应为空");

    // 必须能连续读到视频包
    let (info, mut rx) = session.pump_video().await.expect("应能启动视频泵");

    let mut frames = 0usize;
    let mut configs = 0usize;
    for _ in 0..16 {
        let Some(packet) = rx.recv().await else {
            eprintln!("视频流在 {frames} 帧 / {configs} 配置包后结束");
            break;
        };
        match &packet {
            scrcpy_protocol::VideoPacket::Config { data } => {
                configs += 1;
                eprintln!(
                    "config 包 {} 字节: {:02x?}",
                    data.len(),
                    &data[..data.len().min(6)]
                );
            }
            scrcpy_protocol::VideoPacket::Frame {
                data,
                pts_us,
                is_key_frame,
            } => {
                // H.264 Annex-B：帧应以 NAL 起始码开头
                let has_start_code = data.starts_with(&[0x00, 0x00, 0x00, 0x01])
                    || data.starts_with(&[0x00, 0x00, 0x01]);
                assert!(
                    has_start_code,
                    "H.264 帧应以起始码开头，实际首字节：{:02x?}",
                    &data[..data.len().min(4)]
                );
                assert!(!data.is_empty(), "视频帧不应为空");
                eprintln!("frame pts={pts_us} key={is_key_frame} {} 字节", data.len());
                frames += 1;
            }
        }
    }

    assert!(frames > 0, "应至少收到一个视频帧");
    assert!(info.width > 0);
}

#[tokio::test]
async fn 真机_注入触摸不报错() {
    let serial = require_device!();

    let factory = SessionFactory::new(client(), server_path());
    let session = factory
        .start("it-touch", &serial, &SessionOptions::default())
        .await
        .expect("会话应能建立");

    let info = session.info().clone();
    let (w, h) = (info.width as u16, info.height as u16);
    assert!(w > 0 && h > 0, "应有有效尺寸");

    // 屏幕中央点按一次
    session
        .touch((w / 2) as i32, (h / 2) as i32, true, (w, h))
        .await
        .expect("按下应成功");
    session
        .touch((w / 2) as i32, (h / 2) as i32, false, (w, h))
        .await
        .expect("抬起应成功");

    tokio::time::sleep(Duration::from_millis(200)).await;
}

#[tokio::test]
async fn 真机_停止会话后端口被回收() {
    let serial = require_device!();

    let factory = SessionFactory::new(client(), server_path());
    let session = factory
        .start("it-stop", &serial, &SessionOptions::default())
        .await
        .expect("会话应能建立");

    let port = session.info().local_port;
    session.stop().await;

    tokio::time::sleep(Duration::from_millis(500)).await;

    // 连接应当失败（端口已回收）
    let still_open = tokio::net::TcpStream::connect(("127.0.0.1", port))
        .await
        .is_ok();
    assert!(!still_open, "停止后端口 {port} 不应仍在监听");
}

#[tokio::test]
async fn 真机_同一会话_id_可重复启动() {
    let serial = require_device!();

    let factory = SessionFactory::new(client(), server_path());

    // 第二次启动会复用相同 scid，因此前一个必须先关掉
    let first = factory
        .start("it-reuse", &serial, &SessionOptions::default())
        .await
        .expect("第一次应能建立");
    first.stop().await;

    tokio::time::sleep(Duration::from_millis(500)).await;

    let second = factory
        .start("it-reuse", &serial, &SessionOptions::default())
        .await
        .expect("同一 scid 应能重新启动");
    second.stop().await;
}
