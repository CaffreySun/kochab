import { describe, expect, it } from 'vitest';
import {
  DEFAULT_POLICY,
  type GestureInput,
  type PointerSample,
  isClick,
  isDoubleClick,
  normalizeGesture,
  toScrollDelta,
} from './pointer';

const sample = (action: PointerSample['action'], x: number, y: number): PointerSample => ({
  action,
  x,
  y,
});

const gesture = (samples: PointerSample[], durationMs = 100): GestureInput => ({
  samples,
  durationMs,
});

describe('isClick', () => {
  it('空序列不是点击', () => {
    expect(isClick(gesture([]))).toBe(false);
  });

  it('位移在阈值内是点击', () => {
    expect(isClick(gesture([sample('down', 100, 100), sample('up', 103, 104)]))).toBe(true);
  });

  it('位移等于阈值仍然是点击', () => {
    expect(
      isClick(gesture([sample('down', 0, 0), sample('up', DEFAULT_POLICY.clickSlop, 0)])),
    ).toBe(true);
  });

  it('位移超过阈值不是点击', () => {
    expect(
      isClick(gesture([sample('down', 0, 0), sample('up', DEFAULT_POLICY.clickSlop + 1, 0)])),
    ).toBe(false);
  });

  it('以按下点为基准判定，快速移动采样点之间的小步长不会误判为点击', () => {
    const samples = [sample('down', 0, 0)];
    for (let i = 1; i <= 20; i += 1) samples.push(sample('move', i, i));
    samples.push(sample('up', 20, 20));

    expect(isClick(gesture(samples))).toBe(false);
  });

  it('cancel 结尾的序列不算点击', () => {
    expect(isClick(gesture([sample('down', 0, 0), sample('cancel', 0, 0)]))).toBe(false);
  });

  it('自定义阈值生效', () => {
    const g = gesture([sample('down', 0, 0), sample('up', 5, 5)]);
    expect(isClick(g, { ...DEFAULT_POLICY, clickSlop: 2 })).toBe(false);
  });
});

describe('isDoubleClick', () => {
  const clickAt = (x: number, y: number, durationMs = 80) =>
    gesture([sample('down', x, y), sample('up', x, y)], durationMs);

  it('两次相邻且快速的点击构成双击', () => {
    expect(isDoubleClick(clickAt(100, 100), clickAt(105, 102))).toBe(true);
  });

  it('没有上一次点击时不算双击', () => {
    expect(isDoubleClick(null, clickAt(100, 100))).toBe(false);
  });

  it('超过时间窗口不算双击', () => {
    expect(isDoubleClick(clickAt(100, 100), clickAt(100, 100, 1000))).toBe(false);
  });

  it('距离过远不算双击', () => {
    expect(isDoubleClick(clickAt(100, 100), clickAt(200, 200))).toBe(false);
  });

  it('前一次是拖拽时不算双击', () => {
    const drag = gesture([sample('down', 100, 100), sample('up', 400, 400)]);
    expect(isDoubleClick(drag, clickAt(100, 100))).toBe(false);
  });
});

describe('normalizeGesture', () => {
  it('点击归一化为 touch 并标记双击', () => {
    const first = gesture([sample('down', 10, 10), sample('up', 10, 10)]);
    const second = gesture([sample('down', 11, 11), sample('up', 11, 11)]);

    const normalized = normalizeGesture(second, first);

    expect(normalized.kind).toBe('touch');
    expect(normalized.isDoubleClick).toBe(true);
    expect(normalized.samples).toHaveLength(2);
  });

  it('拖拽归一化为 scroll', () => {
    const normalized = normalizeGesture(gesture([sample('down', 0, 0), sample('up', 300, 0)]));

    expect(normalized.kind).toBe('scroll');
    expect(normalized.isDoubleClick).toBe(false);
  });
});

describe('toScrollDelta', () => {
  it('返回首尾差值', () => {
    expect(
      toScrollDelta(gesture([sample('down', 100, 100), sample('up', 120, 260)]), 2400),
    ).toEqual({ x: 20, y: 160 });
  });

  it('无位移返回 null', () => {
    expect(toScrollDelta(gesture([sample('down', 5, 5), sample('up', 5, 5)]), 2400)).toBeNull();
  });

  it('空序列返回 null', () => {
    expect(toScrollDelta(gesture([]), 2400)).toBeNull();
  });

  it('cancel 序列返回 null', () => {
    expect(
      toScrollDelta(gesture([sample('down', 0, 0), sample('cancel', 0, 300)]), 2400),
    ).toBeNull();
  });

  it('超长位移被夹取到设备高度以内', () => {
    expect(toScrollDelta(gesture([sample('down', 0, 0), sample('up', 0, 99999)]), 2400)).toEqual({
      x: 0,
      y: 2400,
    });
  });
});
