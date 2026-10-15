//! 手工排查投屏链路的小工具：建立一次真实会话并打印前若干帧。
//!
//! ```text
//! ANDROID_TEST_DEVICE=<serial> RUST_LOG=debug \
//!   cargo run -p scrcpy-session --example start
//! ```
//!
//! 默认连第一台 `adb devices` 里的设备。它不参与自动化校验，
//! 存在的意义是：协议出问题时能一步看到「卡在哪一段」。

use std::path::PathBuf;

use adb_client::AdbClient;
use scrcpy_session::{SessionFactory, SessionOptions};

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_max_level(tracing::Level::DEBUG)
        .init();

    let serial = std::env::var("ANDROID_TEST_DEVICE").unwrap_or_else(|_| "d4535f72".to_owned());
    let jar = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../assets/scrcpy-server-v4.1");

    let client = AdbClient::connect().expect("连接 adb 守护进程失败");
    let probe = client.clone();
    let factory = SessionFactory::new(client, jar);

    let session = match factory
        .start("it-debug", &serial, &SessionOptions::default())
        .await
    {
        Ok(session) => session,
        Err(e) => {
            eprintln!("建立会话失败：{e:?}");
            eprintln!("当前反向隧道：{:?}", probe.list_reverse(&serial).await);
            let ps = probe
                .shell(&serial, "ps -A -o PID,ARGS | grep scrcpy")
                .await;
            eprintln!("设备端进程：{:?}", ps.map(|o| o.stdout));
            std::process::exit(1);
        }
    };

    println!("会话已建立：{:?}", session.info());

    let (info, mut packets) = session.pump_video().await.expect("启动视频泵失败");
    println!(
        "开始接收 {}x{} {:?} 的视频流",
        info.width, info.height, info.codec
    );

    for index in 0..10 {
        match packets.recv().await {
            Some(packet) => println!("包 {index}: {} 字节", packet.data().len()),
            None => {
                println!("视频流结束");
                break;
            }
        }
    }
}
