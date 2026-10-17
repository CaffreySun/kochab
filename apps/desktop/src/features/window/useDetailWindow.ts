import { useEffect, useRef } from 'react';
import type { DeviceConnectionState, DeviceInfo } from '@ac/ipc-contract';
import { isTauriRuntime } from '../../ipc/tauri';

/** 竖排按钮栏实际占宽（TDesign small 图标按钮，栏本身无内边距） */
const RAIL_WIDTH = 34;
/** 详情页容器的内边距与子项间距：`.ac-detail` 用的是 `--ac-space-xs` */
const DETAIL_PADDING = 4;
const DETAIL_GAP = 4;
/** 展开面板的默认宽度（竖屏，放右侧） */
export const PANEL_WIDTH = 560;
/** 展开面板的默认高度（横屏，放下方） */
export const PANEL_HEIGHT = 320;
/** 面板被拖窄时的下限：再窄就放不下操作列了 */
const PANEL_MIN_WIDTH = 260;
const PANEL_MIN_HEIGHT = 180;
const MIN_HEIGHT = 420;
/** 窗口与屏幕边缘留的余量 */
const SCREEN_MARGIN = 24;
/** 设备分辨率读不到时的兜底比例 */
const FALLBACK_ASPECT = 9 / 16;
const MIN_WIDTH = 240;
/** 系统标题栏等窗口装饰占掉的高度（用于屏幕高度约束） */
const WINDOW_CHROME_HEIGHT = 40;

/** 画面之外占掉的横向空间（按钮栏、内边距、间距）。 */
function chromeWidth(panelOpen: boolean): number {
  const base = DETAIL_PADDING * 2 + RAIL_WIDTH + DETAIL_GAP;
  return base + (panelOpen ? PANEL_WIDTH + DETAIL_GAP : 0);
}

/** 画面宽度：高度乘宽高比。CSS 里画面也是这么定宽的。 */
export function mirrorWidthFor(aspect: number, height: number): number {
  const mirrorHeight = Math.max(height - DETAIL_PADDING * 2, 200);
  return Math.round(mirrorHeight * aspect);
}

/** 画面高度：宽度除以宽高比（横屏时画面按宽度定尺寸）。 */
export function mirrorHeightFor(aspect: number, width: number): number {
  if (aspect <= 0) return 0;
  return Math.round(Math.max(width, 1) / aspect);
}

/**
 * 按「画面刚好填满、不留黑边」推算窗口宽度。
 *
 * 画面高度 = 窗口高度 - 上下内边距，宽度再乘设备宽高比；最后加上按钮栏（与面板）。
 * 这些常量对应 `global.css` 里 `.ac-detail` 的实际取值，估歪一点只会变成几像素的
 * 居中留白，不会破坏布局。设备分辨率未知时回落到 9:16。
 */
export function computeDetailWidth(
  resolution: string | null,
  height: number,
  panelOpen: boolean,
): number {
  const aspect = parseAspect(resolution) ?? FALLBACK_ASPECT;
  return computeWidthForAspect(aspect, height, panelOpen);
}

/** 已知确切宽高比时的窗口宽度。 */
export function computeWidthForAspect(aspect: number, height: number, panelOpen: boolean): number {
  return Math.max(mirrorWidthFor(aspect, height) + chromeWidth(panelOpen), MIN_WIDTH);
}

/**
 * 由画面尺寸 + 面板状态算出窗口尺寸。
 *
 * 竖屏面板在右侧、横屏面板在下方：面板吃掉的维度不同，窗口尺寸自然不同。
 * 纯函数，便于对「横竖屏两种布局」直接断言。
 */
export function composeWindowSize(input: {
  aspect: number;
  mirrorWidth: number;
  panelOpen: boolean;
  panelWidth: number;
  panelHeight: number;
}): { width: number; height: number } {
  const { aspect, mirrorWidth, panelOpen, panelWidth, panelHeight } = input;
  const mirrorHeight = mirrorHeightFor(aspect, mirrorWidth);
  const base = DETAIL_PADDING * 2 + RAIL_WIDTH + DETAIL_GAP;
  if (aspect > 1) {
    // 横屏：画面在上、面板在下
    return {
      width: Math.max(mirrorWidth + base, MIN_WIDTH),
      height: Math.max(
        mirrorHeight + DETAIL_PADDING * 2 + (panelOpen ? DETAIL_GAP + panelHeight : 0),
        MIN_HEIGHT,
      ),
    };
  }
  // 竖屏：画面在左、面板在右
  return {
    width: Math.max(mirrorWidth + base + (panelOpen ? DETAIL_GAP + panelWidth : 0), MIN_WIDTH),
    height: Math.max(mirrorHeight + DETAIL_PADDING * 2, MIN_HEIGHT),
  };
}

function parseAspect(resolution: string | null): number | null {
  const match = resolution?.match(/^(\d+)x(\d+)$/);
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  return width / height;
}

function aspectOf(resolution: string | null): number {
  return parseAspect(resolution) ?? FALLBACK_ASPECT;
}

function titleFor(device: DeviceInfo | null): string {
  if (!device) return '设备';
  const name = [device.manufacturer, device.model].filter(Boolean).join(' ') || device.serial;
  return [name, device.serial, stateLabel(device.state)].join(' · ');
}

function stateLabel(state: DeviceConnectionState): string {
  switch (state) {
    case 'device':
      return '已连接';
    case 'offline':
      return '已离线';
    case 'unauthorized':
      return '未授权';
    case 'connecting':
      return '连接中';
    case 'authorizing':
      return '授权中';
    default:
      return '未知状态';
  }
}

/**
 * 把设备身份写进系统标题栏，并让窗口宽度跟着面板开合与设备旋转变化。
 *
 * 都放在标题栏/窗口尺寸里而不是页面里，是为了不占内容空间：这个窗口默认只有
 * 一块 9:16 的画面宽，多一行头部就少一截画面。
 *
 * 高度保持用户当前值不变，只调宽度——否则用户手动拉高窗口后一开面板就被重置。
 *
 * 两个尺寸约束：
 * - 没有面板时禁止改宽：窗口就是画面本身，拉宽只会多出黑边。
 * - 有面板时允许改宽，但宽度变化由**面板**吸收（画面按高度与比例固定），
 *   所以这里不监听 resize。
 */
export function useDetailWindow(
  device: DeviceInfo | null,
  panelOpen: boolean,
  /** 会话实时分辨率（如 `2400x1080`）。旋转后窗口要跟着变成横屏比例。 */
  liveResolution: string | null = null,
): void {
  const serial = device?.serial ?? '';
  const name = device ? [device.manufacturer, device.model].filter(Boolean).join(' ') : '';
  const state = device?.state ?? '';
  const resolution = liveResolution ?? device?.screenResolution ?? null;
  /** 上一次的画面盒子：旋转时据此把宽高互换，保持同样的物理大小 */
  const lastBox = useRef<{ width: number; height: number; landscape: boolean } | null>(null);
  /** 用户拖出来的面板尺寸：竖屏只关心宽度，横屏只关心高度 */
  const panelSize = useRef({ width: PANEL_WIDTH, height: PANEL_HEIGHT });
  /** 上一轮是否已经带着面板摆好了尺寸 */
  const lastPanelOpen = useRef(false);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    void (async () => {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        await getCurrentWindow().setTitle(titleFor(device));
      } catch (cause) {
        // 标题没写上不影响功能，但要知道为什么，所以不静默
        console.warn('设置窗口标题失败', cause);
      }
    })();
    // device 对象每次设备列表刷新都会换新引用，只依赖真正用到的字段
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serial, name, state]);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    void (async () => {
      try {
        const { getCurrentWindow, currentMonitor } = await import('@tauri-apps/api/window');
        const { LogicalPosition, LogicalSize } = await import('@tauri-apps/api/dpi');
        const win = getCurrentWindow();
        // 没有面板时窗口就是画面本身：锁死可调整，否则拉宽只会多出黑边。
        // 有面板时放开，多出来的空间由面板吸收（画面尺寸由方向决定）。
        await win.setResizable(panelOpen);
        const [inner, scale, monitor, outerPos] = await Promise.all([
          win.innerSize(),
          win.scaleFactor(),
          currentMonitor(),
          win.outerPosition(),
        ]);
        const currentWidth = inner.width / scale;
        const currentHeight = inner.height / scale;

        const aspect = aspectOf(resolution);
        const landscape = aspect > 1;
        const base = DETAIL_PADDING * 2 + RAIL_WIDTH + DETAIL_GAP;
        const previous = lastBox.current;
        const rotated = previous !== null && previous.landscape !== landscape;

        // 画面尺寸的来源：旋转时把上一帧画面宽高互换（同样的物理大小转 90°），
        // 否则按当前方向从窗口推算——竖屏由高度定，横屏由宽度定。
        let mirrorWidth: number;
        let mirrorHeight: number;
        if (rotated && previous) {
          mirrorWidth = previous.height;
          mirrorHeight = previous.width;
        } else if (landscape) {
          mirrorWidth = Math.max(currentWidth - base, MIN_WIDTH);
          mirrorHeight = mirrorHeightFor(aspect, mirrorWidth);
        } else {
          mirrorHeight = Math.max(currentHeight - DETAIL_PADDING * 2, 200);
          mirrorWidth = Math.round(mirrorHeight * aspect);
        }

        // 面板尺寸沿用用户拖出来的值：竖屏记宽度，横屏记高度。
        //
        // 只有「窗口已经按面板状态摆好」时才反推，否则会把初始窗口
        // 或刚展开面板前的窗口当成用户拖出来的尺寸，把面板夹到下限。
        const size = panelSize.current;
        if (panelOpen && rotated && previous) {
          // 旋转前的那一帧仍反映用户拖好的面板：用旧画面尺寸反推
          if (previous.landscape) {
            size.height = Math.max(
              currentHeight - (previous.height + DETAIL_PADDING * 2) - DETAIL_GAP,
              PANEL_MIN_HEIGHT,
            );
          } else {
            size.width = Math.max(
              currentWidth - (previous.width + base) - DETAIL_GAP,
              PANEL_MIN_WIDTH,
            );
          }
        } else if (panelOpen && lastPanelOpen.current) {
          // 方向没变（例如设备改了分辨率）：按当前布局反推
          if (landscape) {
            size.height = Math.max(
              currentHeight - (mirrorHeight + DETAIL_PADDING * 2) - DETAIL_GAP,
              PANEL_MIN_HEIGHT,
            );
          } else {
            size.width = Math.max(
              currentWidth - (mirrorWidth + base) - DETAIL_GAP,
              PANEL_MIN_WIDTH,
            );
          }
        }

        // 超出屏幕就等比缩小画面，别把窗口顶到屏幕外
        const availableWidth = monitor
          ? monitor.size.width / scale - SCREEN_MARGIN
          : Number.POSITIVE_INFINITY;
        const availableHeight = monitor
          ? monitor.size.height / scale - SCREEN_MARGIN - WINDOW_CHROME_HEIGHT
          : Number.POSITIVE_INFINITY;

        let windowSize = composeWindowSize({
          aspect,
          mirrorWidth,
          panelOpen,
          panelWidth: size.width,
          panelHeight: size.height,
        });
        const ratio = Math.min(
          1,
          availableWidth / windowSize.width,
          availableHeight / windowSize.height,
        );
        if (ratio < 1) {
          mirrorWidth = Math.max(Math.floor(mirrorWidth * ratio), MIN_WIDTH);
          mirrorHeight = mirrorHeightFor(aspect, mirrorWidth);
          windowSize = composeWindowSize({
            aspect,
            mirrorWidth,
            panelOpen,
            panelWidth: size.width,
            panelHeight: size.height,
          });
        } else {
          mirrorHeight = mirrorHeightFor(aspect, mirrorWidth);
        }

        lastBox.current = { width: mirrorWidth, height: mirrorHeight, landscape };
        lastPanelOpen.current = panelOpen;

        // 面板打开时给一个下限，免得把面板拖到没有内容区
        const minWidth = landscape
          ? mirrorWidth + base
          : mirrorWidth + base + DETAIL_GAP + PANEL_MIN_WIDTH;
        const minHeight = landscape
          ? mirrorHeight + DETAIL_PADDING * 2 + DETAIL_GAP + PANEL_MIN_HEIGHT
          : MIN_HEIGHT;
        await win.setMinSize(new LogicalSize(minWidth, minHeight));
        await win.setSize(new LogicalSize(windowSize.width, windowSize.height));

        // 宽度变化后可能有一部分跑到屏幕右边，挪回可见范围
        if (monitor) {
          const left = monitor.position.x / scale;
          const right = left + monitor.size.width / scale - SCREEN_MARGIN;
          const x = outerPos.x / scale;
          if (x + windowSize.width > right) {
            await win.setPosition(
              new LogicalPosition(Math.max(left, right - windowSize.width), outerPos.y / scale),
            );
          }
        }
      } catch (cause) {
        // 尺寸没调成功就退化成「画面居中留黑边」，不影响投屏本身
        console.warn('调整窗口尺寸失败', cause);
      }
    })();
  }, [resolution, panelOpen]);
}
