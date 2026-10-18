import type {
  AppExportResult,
  AppInfo,
  AppSelfInfo,
  CommandError,
  CommandPayloads,
  DeviceInfo,
  DeviceOverview,
  DisplayOverride,
  DisplayResetResult,
  FileEntry,
  InstallResult,
  RecordingChangedPayload,
  RecordingStatus,
  SavedFile,
  SessionClosedPayload,
  SessionInfo,
  SessionSizePayload,
  SessionStartOptions,
  SessionStats,
  ShellOutput,
  ToolchainStatus,
  TouchAction,
  TransferResult,
  VideoFramePayload,
  WirelessEnabled,
} from '@kochab/ipc-contract';
import { COMMANDS, EVENTS } from '@kochab/ipc-contract';
import type { Transport, UnlistenFn } from './transport';
import { createMockTransport } from './mock';
import { createTauriTransport, isTauriRuntime } from './tauri';

export type { Transport, UnlistenFn } from './transport';

/** 从后端错误中取出可读文案 */
export function toMessage(error: unknown, fallback = '未知错误'): string {
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as CommandError).message);
  }
  return fallback;
}

/** 从后端错误中取出稳定错误码 */
export function toCode(error: unknown, fallback = 'internal'): string {
  if (error && typeof error === 'object' && 'code' in error) {
    return String((error as CommandError).code);
  }
  return fallback;
}

/**
 * 把命令名与其参数/返回类型绑定，编译期保证调用点与契约一致。
 * 新增命令只需在 `@kochab/ipc-contract` 登记，这里自动获得类型。
 */
export function createApi(transport: Transport) {
  return {
    transportKind: transport.kind,

    appInfo: () => transport.invoke<AppSelfInfo>(COMMANDS.appInfo),

    toolchainDiagnostics: () => transport.invoke<ToolchainStatus>(COMMANDS.toolchainDiagnostics),

    shellExec: (serial: string, command: string, timeoutMs?: number) =>
      transport.invoke<ShellOutput, CommandPayloads[typeof COMMANDS.shellExec]>(
        COMMANDS.shellExec,
        { serial, command, ...(timeoutMs === undefined ? {} : { timeoutMs }) },
      ),

    // ---- 设备 ----
    deviceList: () => transport.invoke<DeviceInfo[]>(COMMANDS.deviceList),

    deviceInfo: (serial: string) =>
      transport.invoke<DeviceInfo, CommandPayloads[typeof COMMANDS.deviceInfo]>(
        COMMANDS.deviceInfo,
        { serial },
      ),

    connectWireless: (address: string) =>
      transport.invoke<string, CommandPayloads[typeof COMMANDS.deviceConnectWireless]>(
        COMMANDS.deviceConnectWireless,
        { address },
      ),

    disconnect: (serial: string) =>
      transport.invoke<string, CommandPayloads[typeof COMMANDS.deviceDisconnect]>(
        COMMANDS.deviceDisconnect,
        { serial },
      ),

    deviceOverview: (serial: string) =>
      transport.invoke<DeviceOverview, CommandPayloads[typeof COMMANDS.deviceOverview]>(
        COMMANDS.deviceOverview,
        { serial },
      ),

    enableWireless: (serial: string) =>
      transport.invoke<WirelessEnabled, CommandPayloads[typeof COMMANDS.deviceWifiEnable]>(
        COMMANDS.deviceWifiEnable,
        { serial },
      ),

    disableWireless: (serial: string) =>
      transport.invoke<string, CommandPayloads[typeof COMMANDS.deviceWifiDisable]>(
        COMMANDS.deviceWifiDisable,
        { serial },
      ),

    resetDisplay: (serial: string) =>
      transport.invoke<DisplayResetResult, CommandPayloads[typeof COMMANDS.deviceResetDisplay]>(
        COMMANDS.deviceResetDisplay,
        { serial },
      ),

    deviceDisplay: (serial: string) =>
      transport.invoke<DisplayOverride, CommandPayloads[typeof COMMANDS.deviceDisplay]>(
        COMMANDS.deviceDisplay,
        { serial },
      ),

    screenshot: (serial: string, suggestedName?: string) =>
      transport.invoke<SavedFile, CommandPayloads[typeof COMMANDS.deviceScreenshot]>(
        COMMANDS.deviceScreenshot,
        { serial, ...(suggestedName ? { suggestedName } : {}) },
      ),

    startRecording: (serial: string) =>
      transport.invoke<RecordingStatus, CommandPayloads[typeof COMMANDS.deviceRecordStart]>(
        COMMANDS.deviceRecordStart,
        { serial },
      ),

    stopRecording: (serial: string, suggestedName?: string) =>
      transport.invoke<SavedFile | null, CommandPayloads[typeof COMMANDS.deviceRecordStop]>(
        COMMANDS.deviceRecordStop,
        { serial, ...(suggestedName ? { suggestedName } : {}) },
      ),

    recordStatus: (serial: string) =>
      transport.invoke<RecordingStatus, CommandPayloads[typeof COMMANDS.deviceRecordStatus]>(
        COMMANDS.deviceRecordStatus,
        { serial },
      ),

    cancelRecording: (serial: string) =>
      transport.invoke<void, CommandPayloads[typeof COMMANDS.deviceRecordCancel]>(
        COMMANDS.deviceRecordCancel,
        { serial },
      ),

    // ---- 应用 ----
    listApps: (serial: string, options: { filter?: string; showSystemApps?: boolean } = {}) =>
      transport.invoke<AppInfo[], CommandPayloads[typeof COMMANDS.appList]>(COMMANDS.appList, {
        serial,
        ...options,
      }),

    appDetails: (serial: string, packageName: string) =>
      transport.invoke<AppInfo, CommandPayloads[typeof COMMANDS.appDetails]>(COMMANDS.appDetails, {
        serial,
        packageName,
      }),

    installApk: (serial: string, apkPath: string, allowDowngrade = false) =>
      transport.invoke<InstallResult, CommandPayloads[typeof COMMANDS.appInstall]>(
        COMMANDS.appInstall,
        { serial, apkPath, allowDowngrade },
      ),

    uninstallApp: (serial: string, packageName: string, keepData = false) =>
      transport.invoke<void, CommandPayloads[typeof COMMANDS.appUninstall]>(COMMANDS.appUninstall, {
        serial,
        packageName,
        keepData,
      }),

    clearAppData: (serial: string, packageName: string) =>
      transport.invoke<void, CommandPayloads[typeof COMMANDS.appClearData]>(COMMANDS.appClearData, {
        serial,
        packageName,
      }),

    launchApp: (serial: string, packageName: string) =>
      transport.invoke<void, CommandPayloads[typeof COMMANDS.appLaunch]>(COMMANDS.appLaunch, {
        serial,
        packageName,
      }),

    stopApp: (serial: string, packageName: string) =>
      transport.invoke<void, CommandPayloads[typeof COMMANDS.appStop]>(COMMANDS.appStop, {
        serial,
        packageName,
      }),

    setAppEnabled: (serial: string, packageName: string, enabled: boolean) =>
      transport.invoke<void, CommandPayloads[typeof COMMANDS.appSetEnabled]>(
        COMMANDS.appSetEnabled,
        { serial, packageName, enabled },
      ),

    exportApp: (serial: string, packageName: string, suggestedName?: string) =>
      transport.invoke<AppExportResult, CommandPayloads[typeof COMMANDS.appExport]>(
        COMMANDS.appExport,
        { serial, packageName, ...(suggestedName ? { suggestedName } : {}) },
      ),

    // ---- 文件 ----
    listFiles: (serial: string, path: string) =>
      transport.invoke<FileEntry[], CommandPayloads[typeof COMMANDS.fileList]>(COMMANDS.fileList, {
        serial,
        path,
      }),

    statFile: (serial: string, path: string) =>
      transport.invoke<FileEntry | null, CommandPayloads[typeof COMMANDS.fileStat]>(
        COMMANDS.fileStat,
        { serial, path },
      ),

    pullFile: (serial: string, remotePath: string, localPath: string) =>
      transport.invoke<TransferResult, CommandPayloads[typeof COMMANDS.filePull]>(
        COMMANDS.filePull,
        {
          serial,
          remotePath,
          localPath,
        },
      ),

    pullDir: (serial: string, remotePath: string, destDir: string) =>
      transport.invoke<TransferResult, CommandPayloads[typeof COMMANDS.filePullDir]>(
        COMMANDS.filePullDir,
        { serial, remotePath, destDir },
      ),

    pushFile: (serial: string, localPath: string, remotePath: string) =>
      transport.invoke<TransferResult, CommandPayloads[typeof COMMANDS.filePush]>(
        COMMANDS.filePush,
        {
          serial,
          localPath,
          remotePath,
        },
      ),

    deletePath: (serial: string, path: string) =>
      transport.invoke<void, CommandPayloads[typeof COMMANDS.fileDelete]>(COMMANDS.fileDelete, {
        serial,
        path,
      }),

    createDir: (serial: string, path: string) =>
      transport.invoke<void, CommandPayloads[typeof COMMANDS.fileCreateDir]>(
        COMMANDS.fileCreateDir,
        { serial, path },
      ),

    renamePath: (serial: string, from: string, to: string) =>
      transport.invoke<void, CommandPayloads[typeof COMMANDS.fileRename]>(COMMANDS.fileRename, {
        serial,
        from,
        to,
      }),

    // ---- 投屏会话 ----
    startSession: (serial: string, sessionId: string, options: SessionStartOptions = {}) =>
      transport.invoke<SessionInfo, CommandPayloads[typeof COMMANDS.sessionStart]>(
        COMMANDS.sessionStart,
        { serial, sessionId, options },
      ),

    stopSession: (sessionId: number) =>
      transport.invoke<void, CommandPayloads[typeof COMMANDS.sessionStop]>(COMMANDS.sessionStop, {
        sessionId,
      }),

    listSessions: () => transport.invoke<SessionInfo[]>(COMMANDS.sessionList),

    sessionStats: (sessionId: number) =>
      transport.invoke<SessionStats, CommandPayloads[typeof COMMANDS.sessionStats]>(
        COMMANDS.sessionStats,
        { sessionId },
      ),

    sessionTouch: (sessionId: number, action: TouchAction, x: number, y: number) =>
      transport.invoke<void, CommandPayloads[typeof COMMANDS.sessionTouch]>(COMMANDS.sessionTouch, {
        sessionId,
        action,
        x,
        y,
      }),

    sessionKey: (sessionId: number, keycode: number, pressed: boolean) =>
      transport.invoke<void, CommandPayloads[typeof COMMANDS.sessionKey]>(COMMANDS.sessionKey, {
        sessionId,
        keycode,
        pressed,
      }),

    sessionText: (sessionId: number, text: string) =>
      transport.invoke<void, CommandPayloads[typeof COMMANDS.sessionText]>(COMMANDS.sessionText, {
        sessionId,
        text,
      }),

    sessionScroll: (sessionId: number, x: number, y: number, hScroll: number, vScroll: number) =>
      transport.invoke<void, CommandPayloads[typeof COMMANDS.sessionScroll]>(
        COMMANDS.sessionScroll,
        { sessionId, x, y, hScroll, vScroll },
      ),

    // ---- 事件 ----
    onDeviceChanged: (handler: (devices: DeviceInfo[]) => void): Promise<UnlistenFn> =>
      transport.listen<DeviceInfo[]>(EVENTS.deviceChanged, handler),

    onAdbServerLost: (handler: (reason: string) => void): Promise<UnlistenFn> =>
      transport.listen<string>(EVENTS.adbServerLost, handler),

    onSessionMeta: (handler: (info: SessionInfo) => void): Promise<UnlistenFn> =>
      transport.listen<SessionInfo>(EVENTS.sessionMeta, handler),

    onSessionVideo: (handler: (frame: VideoFramePayload) => void): Promise<UnlistenFn> =>
      transport.listen<VideoFramePayload>(EVENTS.sessionVideo, handler),

    onSessionSize: (handler: (payload: SessionSizePayload) => void): Promise<UnlistenFn> =>
      transport.listen<SessionSizePayload>(EVENTS.sessionSize, handler),

    onSessionStats: (handler: (stats: SessionStats) => void): Promise<UnlistenFn> =>
      transport.listen<SessionStats>(EVENTS.sessionStats, handler),

    onSessionClosed: (handler: (payload: SessionClosedPayload) => void): Promise<UnlistenFn> =>
      transport.listen<SessionClosedPayload>(EVENTS.sessionClosed, handler),

    onRecordingChanged: (
      handler: (payload: RecordingChangedPayload) => void,
    ): Promise<UnlistenFn> =>
      transport.listen<RecordingChangedPayload>(EVENTS.recordingChanged, handler),
  };
}

export type Api = ReturnType<typeof createApi>;

/** 根据运行环境选择真实或模拟传输 */
export async function createDefaultTransport(): Promise<Transport> {
  if (isTauriRuntime()) return createTauriTransport();
  return createMockTransport();
}
