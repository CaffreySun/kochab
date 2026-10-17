/**
 * 后端 → 渲染进程的传输结构。
 *
 * 序列化规则由 Rust 侧的 `#[serde(rename_all = "camelCase")]` 决定；
 * 此处字段名必须逐字匹配，否则运行时会拿到 undefined。
 * `cargo test -p android-controller` 会校验契约文件与命令清单的一致性。
 */

/** adb 设备连接状态 */
export type DeviceConnectionState =
  'offline' | 'unauthorized' | 'connecting' | 'device' | 'authorizing' | 'unknown';

/** 设备连接方式 */
export type DeviceTransport = 'usb' | 'wifi' | 'emulator';

export interface DeviceInfo {
  /** adb serial，例如 `d4535f72` 或 `192.168.1.10:5555` */
  serial: string;
  state: DeviceConnectionState;
  isEmulator: boolean;
  /** ro.product.model */
  model: string | null;
  /** ro.product.manufacturer */
  manufacturer: string | null;
  /** ro.product.brand */
  brand: string | null;
  /** ro.product.device */
  device: string | null;
  /** ro.build.version.release */
  androidVersion: string | null;
  /** ro.build.version.sdk */
  sdkInt: number | null;
  /** 屏幕尺寸，形如 `1080x2400`；已覆盖时为开发者选项设置的值 */
  screenResolution: string | null;
  transport: DeviceTransport;
}

/** 导出后落盘的一个安装文件 */
export interface ExportedApk {
  remotePath: string;
  localPath: string;
  bytes: number;
}

/**
 * 导出应用的结果。
 *
 * 一个包可能有多个安装文件（base + split）：单个时 `directory` 就是用户选的目录，
 * 多个时会多一层以应用命名的子目录。
 */
export interface AppExportResult {
  packageName: string;
  directory: string;
  files: ExportedApk[];
}

/** 电池充电状态（`dumpsys battery` 的 status） */
export type BatteryStatus = 'unknown' | 'charging' | 'discharging' | 'not-charging' | 'full';

/** 电池信息；字段读不到时为 null，而不是猜一个值 */
export interface BatteryInfo {
  /** 0–100 */
  level: number | null;
  status: BatteryStatus;
  /** AC / USB / 无线任一在供电 */
  charging: boolean;
  temperatureC: number | null;
  voltageMv: number | null;
  /** dumpsys 的原始 health 值，含义随厂商而异 */
  health: number | null;
  technology: string | null;
}

/** 单个挂载点的容量，单位 KB */
export interface StorageVolume {
  totalKb: number;
  usedKb: number;
  availableKb: number;
}

export interface StorageInfo {
  /** 内部存储（/data） */
  data: StorageVolume;
  /** 用户可见存储；与 data 同分区时数值相同 */
  external: StorageVolume | null;
}

export interface MemoryInfo {
  totalKb: number;
  availableKb: number;
}

export interface NetworkInfo {
  /** wlan0 的 IPv4；未连 Wi-Fi 时为 null */
  wlanIpv4: string | null;
}

export interface SystemInfo {
  androidVersion: string | null;
  sdkInt: number | null;
  abi: string | null;
  securityPatch: string | null;
  uptimeSeconds: number | null;
}

/** 设备概览：每一项都是尽力而为，读不到即为 null */
export interface DeviceOverview {
  serial: string;
  battery: BatteryInfo | null;
  storage: StorageInfo | null;
  memory: MemoryInfo | null;
  network: NetworkInfo;
  system: SystemInfo;
}

/** 截屏 / 录屏落盘结果 */
export interface SavedFile {
  path: string;
  bytes: number;
}

/** 录屏状态；跨窗口统一以它为准 */
export interface RecordingStatus {
  active: boolean;
  /** 开始录制的 Unix 毫秒；未录制时为 null */
  startedAt: number | null;
  /** 设备端 screenrecord 的时限（秒） */
  maxSeconds: number;
}

/** 录屏状态变化事件 */
export interface RecordingChangedPayload {
  serial: string;
  active: boolean;
  startedAt: number | null;
  maxSeconds: number;
}

/** 切到无线调试后的连接信息 */
export interface WirelessEnabled {
  /** 形如 `192.168.1.158:5555` */
  address: string;
  message: string;
}

/** `wm size` / `wm density` 的覆盖现状 */
export interface DisplayOverride {
  physicalSize: string | null;
  physicalDensity: string | null;
  overrideSize: string | null;
  overrideDensity: string | null;
}

/** 恢复屏幕尺寸 / density 的结果 */
export interface DisplayResetResult {
  /** 是否有覆盖项需要恢复；false 表示没有执行任何 reset */
  overridden: boolean;
  before: DisplayOverride;
  message: string;
}

export interface AppInfo {
  packageName: string;
  /** pm list -f 解析出的 apk 安装路径 */
  apkPath: string | null;
  versionName: string | null;
  versionCode: number | null;
  /** 应用显示名；无法确定时为 null，前端回退到包名 */
  label: string | null;
  /** 是否为系统应用（安装在 /system、/product 等分区） */
  isSystem: boolean;
  /** 是否处于启用状态 */
  enabled: boolean;
  /** Unix 毫秒时间戳 */
  firstInstallTime: number | null;
  lastUpdateTime: number | null;
  grantedPermissions: number | null;
  apkSizeBytes: number | null;
}

export interface FileEntry {
  name: string;
  /** 设备端绝对路径 */
  path: string;
  isDirectory: boolean;
  isSymlink: boolean;
  /** 目录为 null */
  sizeBytes: number | null;
  /** Unix 权限位，形如 `drwxr-xr-x` */
  permissions: string;
  /** Unix 毫秒时间戳 */
  modifiedAt: number | null;
  owner: string | null;
  group: string | null;
}

/**
 * shell 执行结果。
 *
 * 注意：`adb shell` 会把 stdout 与 stderr 合并，因此这里没有 `stderr` 字段。
 */
export interface ShellOutput {
  command: string;
  exitCode: number;
  stdout: string;
  timedOut: boolean;
}

export interface InstallResult {
  /** pm install 不回显包名，安装成功后为 null，由前端刷新列表获取 */
  packageName: string | null;
  /** `Success` 或 `Failure [INSTALL_FAILED_xxx]` */
  rawOutput: string;
  success: boolean;
}

export interface ToolchainStatus {
  adbPath: string | null;
  adbVersion: string | null;
  adbServerReachable: boolean;
  scrcpyServerPath: string | null;
  /** 面向用户的问题列表，空数组表示一切正常 */
  problems: string[];
}

/** 桌面应用自身的版本信息 */
export interface AppSelfInfo {
  name: string;
  version: string;
  tauriVersion: string;
}

/** 后端返回的统一错误结构 */
export interface CommandError {
  /** 稳定的机器可读错误码 */
  code: string;
  /** 面向用户的可读文案 */
  message: string;
}

// ---------------------------------------------------------------- 投屏会话

/** 视频编码格式，取自字节流的 ASCII FOURCC */
export type VideoCodec = 'h264' | 'h265' | 'av1' | 'vp8' | 'vp9' | 'unknown';

/** 会话协商完成后的元信息 */
export interface SessionInfo {
  /** 由 `sessionId` 字符串散列而来，同时用作 scrcpy 的 scid */
  sessionId: number;
  serial: string;
  /** 本机监听端口 */
  localPort: number;
  /** 设备端 abstract socket 名 */
  deviceSocket: string;
  /** 设备在 server 侧的名字，形如 `MIX 2S` */
  deviceName: string;
  /** 视频宽度（设备像素） */
  width: number;
  /** 视频高度（设备像素） */
  height: number;
  codec: VideoCodec;
}

/**
 * 一个编码后的视频包。
 *
 * `data` 是 base64 —— Tauri 事件负载走 JSON，直接传字节数组会有约 4 倍膨胀。
 */
export interface VideoFramePayload {
  sessionId: number;
  /** 单调递增，前端据此发现丢帧 */
  sequence: number;
  /** 展示时间戳（微秒）；config 包为 0 */
  ptsUs: number;
  keyFrame: boolean;
  /** 编码器初始化数据（SPS/PPS），必须交给解码器 configure */
  config: boolean;
  data: string;
}

/** 会话画面尺寸变化（设备旋转或客户端请求 resize） */
export interface SessionSizePayload {
  sessionId: number;
  /** 新的画面宽度（设备像素） */
  width: number;
  height: number;
}

/** 周期性统计 */
export interface SessionStats {
  sessionId: number;
  frames: number;
  keyFrames: number;
  bytes: number;
  dropped: number;
  /** 最近一个统计窗口内的帧率 */
  fps: number;
}

/** 会话结束 */
export interface SessionClosedPayload {
  sessionId: number;
  /** `true` = 用户主动停止；`false` = 视频流意外中断 */
  requested: boolean;
  reason: string | null;
}
