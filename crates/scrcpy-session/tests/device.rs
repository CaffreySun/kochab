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
            scrcpy_protocol::VideoStreamItem::Session(meta) => {
                eprintln!("尺寸变化：{}x{}", meta.width, meta.height);
            }
            scrcpy_protocol::VideoStreamItem::Packet(scrcpy_protocol::VideoPacket::Config {
                data,
            }) => {
                configs += 1;
                eprintln!(
                    "config 包 {} 字节: {:02x?}",
                    data.len(),
                    &data[..data.len().min(6)]
                );
            }
            scrcpy_protocol::VideoStreamItem::Packet(scrcpy_protocol::VideoPacket::Frame {
                data,
                pts_us,
                is_key_frame,
            }) => {
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
async fn 真机_清理异常退出残留可幂等执行() {
    let serial = require_device!();

    let first = scrcpy_session::clean_stale_resources(&client(), &serial).await;
    // 没有活跃会话时顶多只有历史残留，数量应当很小
    assert!(first.removed_tunnels <= 8, "清理数量异常：{first:?}");

    let second = scrcpy_session::clean_stale_resources(&client(), &serial).await;
    assert_eq!(second.removed_tunnels, 0, "第二次应当没有新残留可清");
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

#[tokio::test]
async fn 真机_旋转后收到新的会话尺寸() {
    let serial = require_device!();
    let c = client();

    // 记住原始旋转设置，结束时必须还原：这个用例会改设备状态
    let original_user = c
        .shell(&serial, "settings get system user_rotation")
        .await
        .ok()
        .and_then(|o| o.stdout.trim().parse::<u32>().ok())
        .unwrap_or(0);
    let original_accel = c
        .shell(&serial, "settings get system accelerometer_rotation")
        .await
        .ok()
        .and_then(|o| o.stdout.trim().parse::<u32>().ok())
        .unwrap_or(1);
    let target = if original_user == 1 { 0 } else { 1 };

    let factory = SessionFactory::new(c.clone(), server_path());
    let options = SessionOptions {
        max_fps: 24,
        max_size: 720,
        ..SessionOptions::default()
    };
    let mut session = factory
        .start("it-rotate", &serial, &options)
        .await
        .expect("会话应能建立");
    let init = session.info().clone();
    // 不用 pump_video：它拿走所有权后就没法主动停止会话，
    // 而设备端只能有一条会话，残留会拖垮后面的用例。
    let mut video = session.take_video().expect("应能取出视频流");

    // 先收几帧，确认流已经跑热；旋转前不应出现会话尺寸包
    for _ in 0..10 {
        match tokio::time::timeout(
            Duration::from_secs(5),
            scrcpy_session::read_video_item(&mut video),
        )
        .await
        {
            Ok(Ok(scrcpy_protocol::VideoStreamItem::Packet(_))) => {}
            Ok(Ok(scrcpy_protocol::VideoStreamItem::Session(_))) => {
                panic!("旋转前不应收到会话尺寸包")
            }
            other => panic!("视频流过早结束：{other:?}"),
        }
    }

    c.shell(&serial, "wm set-fix-to-user-rotation enabled")
        .await
        .expect("开启固定旋转失败");
    c.shell(&serial, &format!("wm set-user-rotation lock {target}"))
        .await
        .expect("旋转设备失败");

    // 旋转会重开编码器并插入一段会话元信息；这里等的就是它
    let mut after = None;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    while tokio::time::Instant::now() < deadline {
        match tokio::time::timeout_at(deadline, scrcpy_session::read_video_item(&mut video)).await {
            Ok(Ok(scrcpy_protocol::VideoStreamItem::Session(meta))) => {
                after = Some((meta.width, meta.height));
                break;
            }
            Ok(Ok(_)) => continue,
            _ => break,
        }
    }

    // 无论断言是否通过，都把设备转回去并结束会话
    let _ = c
        .shell(
            &serial,
            &format!(
                "wm set-user-rotation lock {original_user}; settings put system accelerometer_rotation {original_accel}; wm set-fix-to-user-rotation disabled"
            ),
        )
        .await;
    session.stop().await;
    tokio::time::sleep(Duration::from_millis(300)).await;

    let (width, height) = after.expect("设备旋转后应收到新的会话尺寸");
    assert!(width > 0 && height > 0, "新尺寸不应为 0");
    assert_ne!(
        (width, height),
        (init.width, init.height),
        "旋转后尺寸应当变化"
    );
    // 宽高应当互换（max_size 对两边等比缩放，允许 1 像素取整误差）
    assert!(
        width.abs_diff(init.height) <= 1 && height.abs_diff(init.width) <= 1,
        "旋转后宽高应互换：原 {}x{}，新 {}x{}",
        init.width,
        init.height,
        width,
        height
    );
}
