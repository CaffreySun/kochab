import { useEffect } from 'react';
import type { DeviceConnectionState, DeviceInfo } from '@ac/ipc-contract';
import { isTauriRuntime } from '../../ipc/tauri';

/** 竖排按钮栏实际占宽（TDesign small 图标按钮，栏本身无内边距） */
const RAIL_WIDTH = 34;
/** 详情页容器的内边距与子项间距：`.ac-detail` 用的是 `--ac-space-xs` */
const DETAIL_PADDING = 4;
const DETAIL_GAP = 4;
/** 展开面板的固定宽度 */
export const PANEL_WIDTH = 560;
/** 设备分辨率读不到时的兜底比例 */
const FALLBACK_ASPECT = 9 / 16;
const MIN_WIDTH = 240;

/** 画面之外占掉的横向空间。 */
function chromeWidth(panelOpen: boolean): number {
  const base = DETAIL_PADDING * 2 + RAIL_WIDTH + DETAIL_GAP;
  return base + (panelOpen ? PANEL_WIDTH + DETAIL_GAP : 0);
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
  const mirrorHeight = Math.max(height - DETAIL_PADDING * 2, 200);
  const mirrorWidth = Math.round(mirrorHeight * aspect);
  return Math.max(mirrorWidth + chromeWidth(panelOpen), MIN_WIDTH);
}

function parseAspect(resolution: string | null): number | null {
  const match = resolution?.match(/^(\d+)x(\d+)$/);
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  return width / height;
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
 * 把设备身份写进系统标题栏，并让窗口宽度跟着面板开合变化。
 *
 * 都放在标题栏/窗口尺寸里而不是页面里，是为了不占内容空间：这个窗口默认只有
 * 一块 9:16 的画面宽，多一行头部就少一截画面。
 *
 * 高度保持用户当前值不变，只调宽度——否则用户手动拉高窗口后一开面板就被重置。
 */
export function useDetailWindow(device: DeviceInfo | null, panelOpen: boolean): void {
  const serial = device?.serial ?? '';
  const name = device ? [device.manufacturer, device.model].filter(Boolean).join(' ') : '';
  const state = device?.state ?? '';
  const resolution = device?.screenResolution ?? null;

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
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        const { LogicalSize } = await import('@tauri-apps/api/dpi');
        const win = getCurrentWindow();
        const [inner, scale] = await Promise.all([win.innerSize(), win.scaleFactor()]);
        const height = inner.height / scale;
        const width = computeDetailWidth(resolution, height, panelOpen);
        await win.setSize(new LogicalSize(width, height));
      } catch (cause) {
        // 尺寸没调成功就退化成「画面居中留黑边」，不影响投屏本身
        console.warn('调整窗口尺寸失败', cause);
      }
    })();
  }, [resolution, panelOpen]);
}
