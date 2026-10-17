import type {
  AppExportResult,
  AppInfo,
  DeviceInfo,
  DeviceOverview,
  FileEntry,
  InstallResult,
  SessionInfo,
  SessionStats,
  ShellOutput,
  ToolchainStatus,
} from '@ac/ipc-contract';

/** 支持按入参动态生成的 fixture */
type FixtureFactory = (args?: Record<string, unknown>) => unknown;

function isFactory(value: unknown): value is FixtureFactory {
  return typeof value === 'function';
}

const MOCK_DEVICES: DeviceInfo[] = [
  {
    serial: 'd4535f72',
    state: 'device',
    isEmulator: false,
    model: 'MIX 2S',
    manufacturer: 'Xiaomi',
    brand: 'Xiaomi',
    device: 'polaris',
    androidVersion: '13',
    sdkInt: 33,
    screenResolution: '1080x2400',
    transport: 'usb',
  },
  {
    serial: 'emulator-5554',
    state: 'device',
    isEmulator: true,
    model: 'Pixel 7',
    manufacturer: 'Google',
    brand: 'google',
    device: 'panther',
    androidVersion: '14',
    sdkInt: 34,
    screenResolution: '1080x2400',
    transport: 'emulator',
  },
];

const MOCK_OVERVIEW: DeviceOverview = {
  serial: 'd4535f72',
  battery: {
    level: 82,
    status: 'discharging',
    charging: false,
    temperatureC: 31.5,
    voltageMv: 4102,
    health: 2,
    technology: 'Li-poly',
  },
  storage: {
    data: { totalKb: 54_964_260, usedKb: 16_513_412, availableKb: 38_303_392 },
    external: { totalKb: 54_964_260, usedKb: 16_513_412, availableKb: 38_303_392 },
  },
  memory: { totalKb: 5_767_104, availableKb: 2_751_928 },
  network: { wlanIpv4: '192.168.1.158' },
  system: {
    androidVersion: '13',
    sdkInt: 33,
    abi: 'arm64-v8a',
    securityPatch: '2023-08-01',
    uptimeSeconds: 160_491,
  },
};

const MOCK_APPS: AppInfo[] = [
  {
    packageName: 'com.android.settings',
    apkPath: '/system/priv-app/Settings/Settings.apk',
    versionName: '13',
    versionCode: 33,
    label: 'Settings',
    isSystem: true,
    enabled: true,
    firstInstallTime: 1_700_000_000_000,
    lastUpdateTime: 1_726_000_000_000,
    grantedPermissions: 42,
    apkSizeBytes: 18_432_000,
  },
  {
    packageName: 'com.example.notes',
    apkPath: '/data/app/com.example.notes-1/base.apk',
    versionName: '2.4.1',
    versionCode: 20401,
    label: '随手记',
    isSystem: false,
    enabled: true,
    firstInstallTime: 1_725_000_000_000,
    lastUpdateTime: 1_725_900_000_000,
    grantedPermissions: 3,
    apkSizeBytes: 5_242_880,
  },
];

const MOCK_FILES: FileEntry[] = [
  {
    name: 'Download',
    path: '/sdcard/Download',
    isDirectory: true,
    isSymlink: false,
    sizeBytes: null,
    permissions: 'drwxrwx--x',
    modifiedAt: 1_726_000_000_000,
    owner: 'root',
    group: 'sdcard_rw',
  },
  {
    name: 'DCIM',
    path: '/sdcard/DCIM',
    isDirectory: true,
    isSymlink: false,
    sizeBytes: null,
    permissions: 'drwxrwx--x',
    modifiedAt: 1_726_000_100_000,
    owner: 'root',
    group: 'sdcard_rw',
  },
  {
    name: 'note.txt',
    path: '/sdcard/note.txt',
    isDirectory: false,
    isSymlink: false,
    sizeBytes: 2048,
    permissions: '-rw-rw----',
    modifiedAt: 1_725_999_000_000,
    owner: 'shell',
    group: 'shell',
  },
];

const MOCK_TOOLCHAIN: ToolchainStatus = {
  adbPath: '/usr/local/bin/adb',
  adbVersion: '1.0.41',
  adbServerReachable: false,
  scrcpyServerPath: null,
  problems: ['当前运行在浏览器预览模式，所有数据均为演示数据。'],
};

/** 预览模式下的会话：只做到「协商完成」，不产生真实视频流 */
const MOCK_SESSION: SessionInfo = {
  sessionId: 0x1a2b3c4d,
  serial: 'd4535f72',
  localPort: 27183,
  deviceSocket: 'localabstract:scrcpy_1a2b3c4d',
  deviceName: 'MIX 2S',
  width: 540,
  height: 1080,
  codec: 'h264',
};

const MOCK_SESSION_STATS: SessionStats = {
  sessionId: MOCK_SESSION.sessionId,
  frames: 0,
  keyFrames: 0,
  bytes: 0,
  dropped: 0,
  fps: 0,
};

export interface MockOptions {
  onInvoke?: (command: string, args?: Record<string, unknown>) => void;
}

/**
 * 浏览器预览用的模拟传输。
 *
 * 存在的意义有两个：
 * 1. UI 可以在没有设备、没有 Tauri 运行时的情况下独立开发与视觉走查；
 * 2. 组件测试可以注入可控数据，无需 mock 整个 Tauri 运行时。
 */
export function createMockTransport(
  overrides: Record<string, unknown> = {},
  options: MockOptions = {},
): import('./transport').Transport {
  const fixtures: Record<string, unknown> = {
    app_info: { name: 'Android Controller', version: '0.1.0 (mock)', tauriVersion: '2.12.3' },
    toolchain_diagnostics: MOCK_TOOLCHAIN,
    shell_exec: (args?: Record<string, unknown>) =>
      ({
        command: typeof args?.command === 'string' ? args.command : '',
        exitCode: 0,
        stdout: 'ok\n',
        timedOut: false,
      }) satisfies ShellOutput,
    device_list: MOCK_DEVICES,
    device_info: (args?: Record<string, unknown>) =>
      MOCK_DEVICES.find((d) => d.serial === args?.serial) ?? MOCK_DEVICES[0],
    device_connect_wireless: null,
    device_disconnect: null,
    device_overview: MOCK_OVERVIEW,
    device_wifi_enable: {
      address: '192.168.1.158:5555',
      message: 'connected to 192.168.1.158:5555',
    },
    device_wifi_disable: '已切回 USB 模式并断开无线连接',
    device_display: {
      physicalSize: '1080x2400',
      physicalDensity: '440',
      overrideSize: null,
      overrideDensity: null,
    },
    device_reset_display: {
      overridden: false,
      before: {
        physicalSize: '1080x2400',
        physicalDensity: '440',
        overrideSize: null,
        overrideDensity: null,
      },
      message: '屏幕尺寸与 density 都是系统默认值，无需恢复',
    },
    device_screenshot: { path: '/tmp/Downloads/screenshot.png', bytes: 1_728_740 },
    device_record_start: () => ({
      active: true,
      startedAt: Date.now(),
      maxSeconds: 180,
    }),
    device_record_stop: { path: '/tmp/Downloads/recording.mp4', bytes: 68_872 },
    device_record_status: { active: false, startedAt: null, maxSeconds: 180 },
    device_record_cancel: null,
    app_list: MOCK_APPS,
    app_details: MOCK_APPS[1],
    app_install: {
      packageName: null,
      rawOutput: 'Success',
      success: true,
    } satisfies InstallResult,
    app_uninstall: null,
    app_clear_data: null,
    app_launch: null,
    app_stop: null,
    app_set_enabled: null,
    app_export: (args?: Record<string, unknown>) => {
      const packageName = typeof args?.packageName === 'string' ? args.packageName : 'com.example';
      // 真实实现里 destDir 省略即落到系统「下载」目录
      const destDir = typeof args?.destDir === 'string' ? args.destDir : '/tmp/Downloads';
      const stem =
        typeof args?.suggestedName === 'string' && args.suggestedName.trim()
          ? args.suggestedName
          : packageName;
      return {
        packageName,
        directory: destDir,
        files: [
          {
            remotePath: `/data/app/${packageName}-x==/base.apk`,
            localPath: `${destDir}/${stem}.apk`,
            bytes: 24_000_000,
          },
        ],
      } satisfies AppExportResult;
    },
    file_list: MOCK_FILES,
    file_stat: (args?: Record<string, unknown>) =>
      MOCK_FILES.find((f) => f.path === args?.path) ?? null,
    file_pull: { path: '/tmp/note.txt', bytes: 2048 },
    file_pull_dir: { path: '/tmp/Download', bytes: 4096 },
    file_push: { path: '/sdcard/Download/app.apk', bytes: 1_048_576 },
    file_delete: null,
    file_create_dir: null,
    file_rename: null,
    // 投屏：预览模式不做真实解码，只把会话协商走完
    session_start: (args?: Record<string, unknown>) =>
      ({
        ...MOCK_SESSION,
        serial: typeof args?.serial === 'string' ? args.serial : MOCK_SESSION.serial,
      }) satisfies SessionInfo,
    session_stop: null,
    session_list: [MOCK_SESSION],
    session_stats: MOCK_SESSION_STATS,
    session_touch: null,
    session_key: null,
    session_text: null,
    session_scroll: null,
    ...overrides,
  };

  return {
    kind: 'mock',
    async invoke<TResult, TArgs extends object>(command: string, args?: TArgs): Promise<TResult> {
      options.onInvoke?.(command, args as Record<string, unknown> | undefined);
      await new Promise((resolve) => setTimeout(resolve, 80));
      const value = fixtures[command];
      if (value === undefined) {
        throw new Error(`Mock 传输未实现命令：${command}`);
      }
      return (isFactory(value) ? value(args as Record<string, unknown>) : value) as TResult;
    },
    listen(): Promise<import('./transport').UnlistenFn> {
      return Promise.resolve(() => {});
    },
  };
}
