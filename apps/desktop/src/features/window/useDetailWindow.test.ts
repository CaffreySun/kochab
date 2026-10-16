import { describe, expect, it } from 'vitest';
import { computeDetailWidth, PANEL_WIDTH } from './useDetailWindow';

describe('详情窗口宽度', () => {
  // 窗口宽度要保证「画面刚好填满」，所以是按设备分辨率算出来的，
  // 不是固定的 9:16——大多数手机是 9:20 左右。
  it('按设备分辨率推算，让画面填满', () => {
    // 1080x2160 → 宽高比 0.5；875 高时画面可用 867
    expect(computeDetailWidth('1080x2160', 875, false)).toBe(480);
  });

  it('分辨率未知时回落到 9:16', () => {
    expect(computeDetailWidth(null, 875, false)).toBe(534);
  });

  it('分辨率字符串损坏时也回落到 9:16，而不是抛错', () => {
    expect(computeDetailWidth('1080', 875, false)).toBe(534);
    expect(computeDetailWidth('0x0', 875, false)).toBe(534);
  });

  it('展开面板只是把窗口变宽，画面宽度不变', () => {
    const narrow = computeDetailWidth('1080x2160', 875, false);
    const wide = computeDetailWidth('1080x2160', 875, true);
    // 差值就是面板宽度加上一个间距
    expect(wide - narrow).toBe(PANEL_WIDTH + 4);
  });

  it('窗口被压得很矮时仍有最小宽度', () => {
    expect(computeDetailWidth('1080x2160', 60, false)).toBe(240);
  });
});
