/**
 * 后端 → 前端事件名注册表。
 *
 * 与命令名同理，必须与 Rust 侧 `emit_event` 的调用点保持一致。
 * 约定：`<领域>://<事件>`，领域为 kebab-case 的单段。
 */
export const EVENTS = {
  /** 设备列表或任意设备状态发生变化 */
  deviceChanged: 'device://changed',
  /** adb server 不可用或被外部关闭 */
  adbServerLost: 'adb://server-lost',

  /** 投屏会话协商完成，携带视频/音频元数据 */
  sessionMeta: 'session://meta',
  /** 一段编码后的视频数据 */
  sessionVideo: 'session://video',
  /** 周期性统计信息 */
  sessionStats: 'session://stats',
  /** 会话结束（正常关闭或异常断开） */
  sessionClosed: 'session://closed',
} as const;

export type EventName = (typeof EVENTS)[keyof typeof EVENTS];
