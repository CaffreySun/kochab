/**
 * Tauri 命令名注册表。
 *
 * 约定：Rust 侧 `src-tauri/src/commands/*` 中每个 `#[tauri::command]` 的函数名
 * 必须在此登记。`cargo test -p android-controller` 会对契约与命令清单做**双向**比对，
 * 任何一侧漏登记都会导致测试失败。
 *
 * 命名规则：`snake_case` 的 `{领域}_{动作}`。
 */
export const COMMANDS = {
  // ---- 应用自身 ----
  appInfo: 'app_info',
  toolchainDiagnostics: 'toolchain_diagnostics',
  shellExec: 'shell_exec',

  // ---- 设备 ----
  deviceList: 'device_list',
  deviceInfo: 'device_info',
  deviceConnectWireless: 'device_connect_wireless',
  deviceDisconnect: 'device_disconnect',
  deviceOverview: 'device_overview',
  deviceWifiEnable: 'device_wifi_enable',
  deviceWifiDisable: 'device_wifi_disable',
  deviceResetDisplay: 'device_reset_display',
  deviceDisplay: 'device_display',

  // ---- 截屏 / 录屏 ----
  deviceScreenshot: 'device_screenshot',
  deviceRecordStart: 'device_record_start',
  deviceRecordStop: 'device_record_stop',
  deviceRecordStatus: 'device_record_status',
  deviceRecordCancel: 'device_record_cancel',

  // ---- 应用管理 ----
  appList: 'app_list',
  appDetails: 'app_details',
  appInstall: 'app_install',
  appUninstall: 'app_uninstall',
  appClearData: 'app_clear_data',
  appLaunch: 'app_launch',
  appStop: 'app_stop',
  appSetEnabled: 'app_set_enabled',
  appExport: 'app_export',

  // ---- 文件管理 ----
  fileList: 'file_list',
  fileStat: 'file_stat',
  filePull: 'file_pull',
  filePullDir: 'file_pull_dir',
  filePush: 'file_push',
  fileDelete: 'file_delete',
  fileCreateDir: 'file_create_dir',
  fileRename: 'file_rename',

  // ---- 投屏会话 ----
  sessionStart: 'session_start',
  sessionStop: 'session_stop',
  sessionList: 'session_list',
  sessionStats: 'session_stats',
  sessionTouch: 'session_touch',
  sessionKey: 'session_key',
  sessionText: 'session_text',
  sessionScroll: 'session_scroll',
} as const;

export type CommandName = (typeof COMMANDS)[keyof typeof COMMANDS];

/** 命令名 → 参数字典，供前端封装做类型推导 */
export interface CommandPayloads {
  [COMMANDS.appInfo]: Record<string, never>;
  [COMMANDS.toolchainDiagnostics]: Record<string, never>;
  [COMMANDS.shellExec]: { serial: string; command: string; timeoutMs?: number };

  [COMMANDS.deviceList]: Record<string, never>;
  [COMMANDS.deviceInfo]: { serial: string };
  [COMMANDS.deviceConnectWireless]: { address: string };
  [COMMANDS.deviceDisconnect]: { serial: string };
  [COMMANDS.deviceOverview]: { serial: string };
  [COMMANDS.deviceWifiEnable]: { serial: string };
  [COMMANDS.deviceWifiDisable]: { serial: string };
  [COMMANDS.deviceResetDisplay]: { serial: string };
  [COMMANDS.deviceDisplay]: { serial: string };

  [COMMANDS.deviceScreenshot]: { serial: string; suggestedName?: string };
  [COMMANDS.deviceRecordStart]: { serial: string };
  [COMMANDS.deviceRecordStop]: { serial: string; suggestedName?: string };
  [COMMANDS.deviceRecordStatus]: { serial: string };
  [COMMANDS.deviceRecordCancel]: { serial: string };

  [COMMANDS.appList]: { serial: string; filter?: string; showSystemApps?: boolean };
  [COMMANDS.appDetails]: { serial: string; packageName: string };
  [COMMANDS.appInstall]: { serial: string; apkPath: string; allowDowngrade?: boolean };
  [COMMANDS.appUninstall]: { serial: string; packageName: string; keepData?: boolean };
  [COMMANDS.appClearData]: { serial: string; packageName: string };
  [COMMANDS.appLaunch]: { serial: string; packageName: string };
  [COMMANDS.appStop]: { serial: string; packageName: string };
  [COMMANDS.appSetEnabled]: { serial: string; packageName: string; enabled: boolean };
  [COMMANDS.appExport]: {
    serial: string;
    packageName: string;
    /** 本机目标目录；留空则落到系统「下载」目录 */
    destDir?: string;
    /** 建议的文件/子目录名，留空则用包名 */
    suggestedName?: string;
  };

  [COMMANDS.fileList]: { serial: string; path: string };
  [COMMANDS.fileStat]: { serial: string; path: string };
  [COMMANDS.filePull]: { serial: string; remotePath: string; localPath: string };
  [COMMANDS.filePullDir]: { serial: string; remotePath: string; destDir: string };
  [COMMANDS.filePush]: { serial: string; localPath: string; remotePath: string };
  [COMMANDS.fileDelete]: { serial: string; path: string };
  [COMMANDS.fileCreateDir]: { serial: string; path: string };
  [COMMANDS.fileRename]: { serial: string; from: string; to: string };

  [COMMANDS.sessionStart]: {
    serial: string;
    sessionId: string;
    options?: SessionStartOptions;
  };
  [COMMANDS.sessionStop]: { sessionId: number };
  [COMMANDS.sessionList]: Record<string, never>;
  [COMMANDS.sessionStats]: { sessionId: number };
  [COMMANDS.sessionTouch]: {
    sessionId: number;
    action: TouchAction;
    /** 设备像素坐标 */
    x: number;
    y: number;
  };
  [COMMANDS.sessionKey]: { sessionId: number; keycode: number; pressed: boolean };
  [COMMANDS.sessionText]: { sessionId: number; text: string };
  [COMMANDS.sessionScroll]: {
    sessionId: number;
    /** 设备像素坐标 */
    x: number;
    y: number;
    hScroll: number;
    vScroll: number;
  };
}

/** 投屏启动参数；缺省字段由后端使用默认值 */
export interface SessionStartOptions {
  /** 短边像素上限，0 表示不限制 */
  maxSize?: number;
  maxFps?: number;
  /** Mbps */
  bitRate?: number;
  control?: boolean;
  showTouches?: boolean;
  stayAwake?: boolean;
  /**
   * 会话优先级，数值越大越优先。
   *
   * 同一台设备同时只能有一条 scrcpy 会话，所以多个消费方（卡片缩略图、
   * 独立投屏窗口）会争抢。只有**优先级不低于**当前占用者的请求才能接管，
   * 否则缩略图会把正在用的投屏窗口顶掉，来回抢占导致两边都闪黑。
   *
   * 约定：卡片缩略图 `PREVIEW_PRIORITY`，交互式投屏 `MIRROR_PRIORITY`。
   */
  priority?: number;
}

/** 触摸动作，与 Rust 侧 `TouchActionPayload` 一致 */
export type TouchAction = 'down' | 'move' | 'up';

/** 传输结果（上传/下载） */
export interface TransferResult {
  path: string;
  bytes: number;
}
