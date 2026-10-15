import { describe, expect, it } from 'vitest';
import {
  clientPointToDevice,
  computeVideoLayout,
  devicePointToClient,
  isOutsideVideo,
} from './coords';

const FRAME = { width: 1080, height: 2400 };

describe('computeVideoLayout', () => {
  it('容器与视频同比例时铺满整个容器', () => {
    const layout = computeVideoLayout(FRAME, { width: 1080, height: 2400 });

    expect(layout).toEqual({ offsetX: 0, offsetY: 0, width: 1080, height: 2400, scale: 1 });
  });

  it('容器更宽时左右留白，保持宽高比', () => {
    const layout = computeVideoLayout(FRAME, { width: 3400, height: 2400 });

    expect(layout.scale).toBeCloseTo(1);
    expect(layout.height).toBeCloseTo(2400);
    expect(layout.offsetY).toBeCloseTo(0);
    expect(layout.offsetX).toBeCloseTo((3400 - 1080) / 2);
  });

  it('容器更矮时上下留白', () => {
    const layout = computeVideoLayout(FRAME, { width: 1080, height: 1000 });

    expect(layout.scale).toBeCloseTo(1000 / 2400);
    expect(layout.offsetX).toBeCloseTo((1080 - layout.width) / 2);
    expect(layout.offsetY).toBeCloseTo(0);
  });

  it('容器尺寸为 0 时返回空布局而不是抛错', () => {
    expect(computeVideoLayout(FRAME, { width: 0, height: 0 })).toEqual({
      offsetX: 0,
      offsetY: 0,
      width: 0,
      height: 0,
      scale: 0,
    });
  });

  it('视频尺寸非法时抛 RangeError', () => {
    expect(() =>
      computeVideoLayout({ width: 0, height: 100 }, { width: 100, height: 100 }),
    ).toThrow(RangeError);
    expect(() =>
      computeVideoLayout({ width: Number.NaN, height: 100 }, { width: 100, height: 100 }),
    ).toThrow(RangeError);
  });
});

describe('clientPointToDevice', () => {
  const canvas = { left: 100, top: 50, width: 540, height: 1200 };

  it('1:1 缩放时原样映射', () => {
    const full = { left: 0, top: 0, width: 1080, height: 2400 };

    expect(clientPointToDevice({ x: 50, y: 50 }, full, FRAME)).toEqual({ x: 50, y: 50 });
  });

  it('按画布缩放比例映射', () => {
    // 画布为设备分辨率的一半，因此设备坐标是画布坐标的两倍
    expect(clientPointToDevice({ x: 150, y: 100 }, canvas, FRAME)).toEqual({ x: 100, y: 100 });
  });

  it('负坐标被夹取到 0', () => {
    expect(clientPointToDevice({ x: 0, y: 0 }, canvas, FRAME)).toEqual({ x: 0, y: 0 });
  });

  it('超出右下角被夹取到 frame 右下角', () => {
    expect(clientPointToDevice({ x: 9999, y: 9999 }, canvas, FRAME)).toEqual({
      x: 1079,
      y: 2399,
    });
  });

  it('画布尺寸为 0 时抛 RangeError', () => {
    expect(() =>
      clientPointToDevice({ x: 1, y: 1 }, { left: 0, top: 0, width: 0, height: 10 }, FRAME),
    ).toThrow(RangeError);
  });
});

describe('devicePointToClient', () => {
  it('与 clientPointToDevice 互为逆运算', () => {
    const canvas = { left: 100, top: 50, width: 540, height: 1200 };
    const device = { x: 377, y: 1831 };
    const client = devicePointToClient(device, canvas, FRAME);

    expect(clientPointToDevice(client, canvas, FRAME)).toEqual(device);
  });
});

describe('isOutsideVideo', () => {
  const canvas = { left: 0, top: 0, width: 1000, height: 1000 };

  it('画面内返回 false', () => {
    expect(isOutsideVideo({ x: 500, y: 500 }, canvas, FRAME)).toBe(false);
  });

  it('左右留白返回 true', () => {
    expect(isOutsideVideo({ x: 1, y: 500 }, canvas, FRAME)).toBe(true);
    expect(isOutsideVideo({ x: 999, y: 500 }, canvas, FRAME)).toBe(true);
  });
});
