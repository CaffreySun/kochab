/**
 * 指针手势状态机。
 *
 * 触摸板（trackpad）场景下，鼠标事件与触摸屏语义完全不同：
 * 单指拖拽是滚动，双指才是点击。因此不能把 mouse 事件直接当成 touch 下发。
 * 本模块把一串原始指针事件归一化成 scrcpy 可理解的 touch / scroll 指令序列。
 */

export type PointerAction = 'down' | 'move' | 'up' | 'cancel';

export interface PointerSample {
  action: PointerAction;
  /** 设备像素坐标（绝对值） */
  x: number;
  y: number;
}

export interface NormalizedGesture {
  /** 'touch' 表示应产生一串触摸事件；'scroll' 表示应产生滚动事件 */
  kind: 'touch' | 'scroll';
  samples: PointerSample[];
  /** 该手势是否为双击（用于模拟双击缩放等系统手势） */
  isDoubleClick: boolean;
}

export interface GesturePolicy {
  /**
   * 小于该位移（设备像素）视为「点击」，超过则视为「拖拽/滚动」。
   * 默认 8px，与 scrcpy 桌面端的判定一致。
   */
  clickSlop: number;
  /** 双击判定的时间窗口（毫秒） */
  doubleClickDelay: number;
  /** 双击判定的位移容差（设备像素） */
  doubleClickSlop: number;
}

export const DEFAULT_POLICY: Readonly<GesturePolicy> = Object.freeze({
  clickSlop: 8,
  doubleClickDelay: 300,
  doubleClickSlop: 24,
});

/**
 * 把手势判定所需的最小输入抽象出来，便于单测与后续接入 PointerEvent / TouchEvent。
 */
export interface GestureInput {
  samples: readonly PointerSample[];
  /** 从本次手势开始到结束的时长（毫秒） */
  durationMs: number;
}

const distanceFromStart = (samples: readonly PointerSample[]): number | null => {
  const first = samples[0];
  const last = samples.at(-1);
  if (!first || !last) return null;
  return Math.hypot(last.x - first.x, last.y - first.y);
};

/**
 * 判断一段指针序列是「点击」还是「拖拽」。
 *
 * 以按下点为基准计算总位移，而不是相邻采样点的位移：
 * 快速滑动时每帧位移都很小但累计位移很大，用相邻差值会误判为点击。
 */
export function isClick(gesture: GestureInput, policy: GesturePolicy = DEFAULT_POLICY): boolean {
  const last = gesture.samples.at(-1);
  if (!last || last.action === 'cancel') return false;

  const moved = distanceFromStart(gesture.samples);
  return moved !== null && moved <= policy.clickSlop;
}

/** 判断两次点击是否构成双击 */
export function isDoubleClick(
  previous: GestureInput | null,
  current: GestureInput,
  policy: GesturePolicy = DEFAULT_POLICY,
): boolean {
  if (!previous || !isClick(previous, policy) || !isClick(current, policy)) return false;
  if (current.durationMs > policy.doubleClickDelay) return false;

  const a = previous.samples.at(-1);
  const b = current.samples[0];
  if (!a || !b) return false;

  return Math.hypot(b.x - a.x, b.y - a.y) <= policy.doubleClickSlop;
}

/**
 * 把一段指针序列归一化为 scrcpy 指令。
 *
 * - 位移未超过 clickSlop → `touch`（可直接作为点击事件序列下发）
 * - 超过 → `scroll`（交由调用方转换成相对滚动量）
 */
export function normalizeGesture(
  gesture: GestureInput,
  previous: GestureInput | null = null,
  policy: GesturePolicy = DEFAULT_POLICY,
): NormalizedGesture {
  return {
    kind: isClick(gesture, policy) ? 'touch' : 'scroll',
    samples: [...gesture.samples],
    isDoubleClick: isClick(gesture, policy) && isDoubleClick(previous, gesture, policy),
  };
}

/** 将 scroll 手势累计为相对滚动量（设备像素），并夹取到设备高度以内 */
export function toScrollDelta(
  gesture: GestureInput,
  deviceHeight: number,
): { x: number; y: number } | null {
  const first = gesture.samples[0];
  const last = gesture.samples.at(-1);
  if (!first || !last) return null;
  if (last.action === 'cancel') return null;

  const dy = last.y - first.y;
  const dx = last.x - first.x;
  if (dx === 0 && dy === 0) return null;

  return {
    x: dx,
    y: Math.max(-deviceHeight, Math.min(deviceHeight, dy)),
  };
}
