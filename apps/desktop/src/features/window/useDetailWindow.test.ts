import { describe, expect, it } from 'vitest';
import {
  composeWindowSize,
  computeDetailWidth,
  mirrorHeightFor,
  mirrorWidthFor,
  PANEL_HEIGHT,
  PANEL_WIDTH,
} from './useDetailWindow';

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

  // 旋转后会话上报的尺寸互换，窗口要跟着变成横屏比例，否则画面被塞进竖屏窗口
  it('横屏分辨率下窗口变宽、画面比例跟着互换', () => {
    const portrait = computeDetailWidth('1080x2160', 875, false);
    const landscape = computeDetailWidth('2160x1080', 875, false);
    expect(landscape).toBeGreaterThan(portrait);

    // 画面宽度 = 高度 × 宽高比
    expect(mirrorWidthFor(1080 / 2160, 875)).toBe(434);
    expect(mirrorWidthFor(2160 / 1080, 875)).toBe(1734);
    // 互换只是把同一对数字调个方向：两个方向的和 = 可用高度 × (比例 + 倒数)
    expect(mirrorWidthFor(1080 / 2160, 875) + mirrorWidthFor(2160 / 1080, 875)).toBe(
      Math.round((875 - 8) * (0.5 + 2)),
    );
  });

  // 横屏时面板在下方：窗口高度要加上面板高度，宽度只跟画面有关
  it('横屏把面板放在下方，窗口只往上长', () => {
    const aspect = 2160 / 1080;
    const closed = composeWindowSize({
      aspect,
      mirrorWidth: 1700,
      panelOpen: false,
      panelWidth: PANEL_WIDTH,
      panelHeight: PANEL_HEIGHT,
    });
    const open = composeWindowSize({
      aspect,
      mirrorWidth: 1700,
      panelOpen: true,
      panelWidth: PANEL_WIDTH,
      panelHeight: PANEL_HEIGHT,
    });

    // 宽度不变，高度增加「间距 + 面板高度」
    expect(open.width).toBe(closed.width);
    expect(open.height - closed.height).toBe(4 + PANEL_HEIGHT);
  });

  it('竖屏把面板放在右侧，窗口只往右长', () => {
    const aspect = 1080 / 2160;
    const closed = composeWindowSize({
      aspect,
      mirrorWidth: 434,
      panelOpen: false,
      panelWidth: PANEL_WIDTH,
      panelHeight: PANEL_HEIGHT,
    });
    const open = composeWindowSize({
      aspect,
      mirrorWidth: 434,
      panelOpen: true,
      panelWidth: PANEL_WIDTH,
      panelHeight: PANEL_HEIGHT,
    });

    expect(open.height).toBe(closed.height);
    expect(open.width - closed.width).toBe(4 + PANEL_WIDTH);
  });

  it('横屏画面由宽度决定高度，竖屏反过来', () => {
    expect(mirrorHeightFor(2, 1700)).toBe(850);
    // 竖屏按「高度 - 上下内边距」乘比例
    expect(mirrorWidthFor(0.5, 858)).toBe(425);
  });
});
