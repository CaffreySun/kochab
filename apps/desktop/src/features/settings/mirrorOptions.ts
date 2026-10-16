import { createContext, useContext } from 'react';

/**
 * 投屏默认参数。
 *
 * 设置页写在 localStorage，投屏窗口启动时读——跨窗口共享同一份配置，
 * 不必再走一遍 IPC（用户改完设置立刻开新窗口就生效）。
 *
 * 不提供 Provider 时回落到 `DEFAULT_MIRROR_OPTIONS`，
 * 这样单测与「直接渲染 MirrorTile」的场景不需要额外包裹。
 */
export interface MirrorOptions {
  /** 短边像素上限，0 表示不限制 */
  maxSize: number;
  maxFps: number;
  /** Mbps */
  bitRate: number;
  /** 显示触摸点 */
  showTouches: boolean;
  /** 投屏时保持屏幕常亮 */
  stayAwake: boolean;
}

/** 与 `scrcpy-session` 的 `SessionOptions::default()` 保持一致。 */
export const DEFAULT_MIRROR_OPTIONS: MirrorOptions = {
  maxSize: 1080,
  maxFps: 30,
  bitRate: 8,
  showTouches: true,
  stayAwake: true,
};

const STORAGE_KEY = 'ac.mirrorOptions';

export const MirrorOptionsContext = createContext<MirrorOptions>(DEFAULT_MIRROR_OPTIONS);

/** 从 localStorage 读用户设置；损坏或缺失时回落到默认值。 */
export function readMirrorOptions(): MirrorOptions {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_MIRROR_OPTIONS;
    const parsed = JSON.parse(raw) as Partial<MirrorOptions>;
    const num = (value: unknown, fallback: number, min: number): number =>
      typeof value === 'number' && Number.isFinite(value) && value >= min ? value : fallback;
    return {
      maxSize: num(parsed.maxSize, DEFAULT_MIRROR_OPTIONS.maxSize, 0),
      maxFps: num(parsed.maxFps, DEFAULT_MIRROR_OPTIONS.maxFps, 1),
      bitRate: num(parsed.bitRate, DEFAULT_MIRROR_OPTIONS.bitRate, 1),
      showTouches:
        typeof parsed.showTouches === 'boolean'
          ? parsed.showTouches
          : DEFAULT_MIRROR_OPTIONS.showTouches,
      stayAwake:
        typeof parsed.stayAwake === 'boolean' ? parsed.stayAwake : DEFAULT_MIRROR_OPTIONS.stayAwake,
    };
  } catch {
    // localStorage 不可用（隐私模式）或内容损坏：不该因此崩掉设置页
    return DEFAULT_MIRROR_OPTIONS;
  }
}

export function writeMirrorOptions(options: MirrorOptions): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(options));
  } catch {
    // 写不进去就退化成「本次会话内生效」，不阻断设置流程
  }
}

/** 投屏窗口专用：一次性读到设置并监听后续变更。 */
export function useMirrorOptions(): MirrorOptions {
  return useContext(MirrorOptionsContext);
}
