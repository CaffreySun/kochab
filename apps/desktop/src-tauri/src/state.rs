//! 应用全局状态。
//!
//! 只保存**有状态**的资源（adb 连接、设备缓存、投屏会话）；业务逻辑一律在 `android-core`
//! 与 `scrcpy-session` 中。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::AtomicU64;
use std::sync::Arc;

use adb_client::AdbClient;
use android_core::DeviceInfo;
use parking_lot::{Mutex, RwLock};
use scrcpy_session::{ControlSender, ScrcpySession, SessionInfo};
use tauri::{AppHandle, Manager};
use tokio::sync::watch;

/// 挂在 Tauri 上的应用状态。
#[derive(Clone)]
pub struct AppState {
    /// 命令用连接。本身不持有 socket（adb 连接是一次性的），
    /// 可以自由克隆并发使用，多设备操作互不阻塞。
    pub adb: AdbClient,
    /// 设备详情缓存，避免每次打开页面都重新 getprop。
    pub devices: Arc<RwLock<HashMap<String, DeviceInfo>>>,
    /// 活跃的投屏会话。
    pub sessions: Arc<Mutex<HashMap<u32, Arc<SessionHandle>>>>,
    /// 应用自带资源的目录（打包后是资源目录）。
    ///
    /// `scrcpy-server` 随应用分发，位置与 adb 安装目录无关，
    /// 因此必须显式告诉领域层去哪里找，不能靠「和 adb 装在一起」猜。
    pub resource_dir: Option<PathBuf>,
}

/// 一条活跃会话在命令层需要的东西。
///
/// 视频读取端在建会话时就被交给广播任务，因此这里**不持有**视频 socket；
/// 只保留控制句柄、元信息、停止信号与计数器。
pub struct SessionHandle {
    pub info: SessionInfo,
    pub control: ControlSender,
    /// 会话本体，负责收尾（删设备端 jar、撤反向隧道）。
    /// 用 `Arc` 是因为广播任务与收尾路径都要用它。
    pub session: Arc<ScrcpySession>,
    pub counters: Arc<SessionCounters>,
    /// 停止信号。用 `watch` 而不是 `Notify`：广播任务每轮循环都会重新
    /// `select`，`Notify` 可能错过在它开始等待之前发出的通知。
    stop_tx: watch::Sender<bool>,
    stop_rx: watch::Receiver<bool>,
    /// 前端逻辑会话名，见 `SessionHandle::new`
    owner: String,
    /// 占用优先级，见 `SessionHandle::new`
    priority: u8,
}

/// 会话运行计数。用原子量是因为广播任务写、命令层读，两边都不该等锁。
#[derive(Debug, Default)]
pub struct SessionCounters {
    pub frames: AtomicU64,
    pub key_frames: AtomicU64,
    pub bytes: AtomicU64,
    /// 广播失败或队列溢出导致的丢帧
    pub dropped: AtomicU64,
}

impl SessionHandle {
    /// `owner` 是前端的逻辑会话名（如 `preview-d4535f72` / `mirror-d4535f72`）。
    ///
    /// `info.session_id` 只是本进程自增的数值 id，前端并不持有它，
    /// 因此判断「是不是同一个消费方又来启动」必须靠这个字符串。
    pub fn new(
        owner: String,
        priority: u8,
        info: SessionInfo,
        control: ControlSender,
        session: Arc<ScrcpySession>,
    ) -> Self {
        let (stop_tx, stop_rx) = watch::channel(false);
        Self {
            owner,
            priority,
            info,
            control,
            session,
            counters: Arc::new(SessionCounters::default()),
            stop_tx,
            stop_rx,
        }
    }

    /// 前端逻辑会话名。
    pub fn owner(&self) -> &str {
        &self.owner
    }

    /// 本会话的占用优先级。
    pub fn priority(&self) -> u8 {
        self.priority
    }

    /// 请求停止。广播任务会在下一轮 `select` 里看到并走去收尾。
    pub fn mark_stopped(&self) {
        let _ = self.stop_tx.send(true);
    }

    pub fn is_stopped(&self) -> bool {
        *self.stop_rx.borrow()
    }

    /// 供广播任务克隆的停止信号。
    pub fn stop_signal(&self) -> watch::Receiver<bool> {
        self.stop_rx.clone()
    }
}

impl AppState {
    pub fn new(adb: AdbClient, resource_dir: Option<PathBuf>) -> Self {
        Self {
            adb,
            devices: Arc::new(RwLock::new(HashMap::new())),
            sessions: Arc::new(Mutex::new(HashMap::new())),
            resource_dir,
        }
    }

    /// 交给 ndroid-core 的额外搜索目录（自带资源优先）。
    pub fn resource_dirs(&self) -> Vec<PathBuf> {
        self.resource_dir.iter().cloned().collect()
    }

    /// 读缓存。
    pub fn cached(&self, serial: &str) -> Option<DeviceInfo> {
        self.devices.read().get(serial).cloned()
    }

    /// 写缓存。
    pub fn cache(&self, info: DeviceInfo) {
        self.devices.write().insert(info.serial.clone(), info);
    }

    /// 移除缓存（设备断开时调用）。
    pub fn forget(&self, serial: &str) {
        self.devices.write().remove(serial);
    }

    /// 取指定会话的句柄。
    pub fn session(&self, session_id: u32) -> Option<Arc<SessionHandle>> {
        self.sessions.lock().get(&session_id).cloned()
    }

    /// 找某台设备上的活跃会话（同一台设备只允许一条）。
    pub fn session_of(&self, serial: &str) -> Option<Arc<SessionHandle>> {
        self.sessions
            .lock()
            .values()
            .find(|s| s.info.serial == serial)
            .cloned()
    }

    /// 登记会话。
    pub fn insert_session(&self, handle: Arc<SessionHandle>) {
        self.sessions.lock().insert(handle.info.session_id, handle);
    }

    /// 注销会话，返回是否确实存在。
    pub fn remove_session(&self, session_id: u32) -> bool {
        self.sessions.lock().remove(&session_id).is_some()
    }

    /// 注销并返回会话句柄。
    pub fn take_session(&self, session_id: u32) -> Option<Arc<SessionHandle>> {
        self.sessions.lock().remove(&session_id)
    }

    /// 当前活跃会话的元信息。
    pub fn session_infos(&self) -> Vec<SessionInfo> {
        let mut list: Vec<_> = self
            .sessions
            .lock()
            .values()
            .map(|s| s.info.clone())
            .collect();
        list.sort_by_key(|i| i.session_id);
        list
    }
}

/// 从 Tauri 句柄取出应用状态。
pub fn state(app: &AppHandle) -> tauri::State<'_, AppState> {
    app.state::<AppState>()
}
