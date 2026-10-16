import type { WorkspaceTab } from './pages/DevicesPage';

/**
 * 当前 webview 渲染什么。
 *
 * 设备工作区是**独立窗口**，和主窗口共用同一份前端产物：
 * 主窗口 `index.html`，设备窗口 `index.html?window=device&serial=...&tab=...`。
 * 用查询串区分，就不必再维护两套 html 入口。
 */
export type WindowRoute = { kind: 'shell' } | { kind: 'device'; serial: string; tab: WorkspaceTab };

const TABS: WorkspaceTab[] = ['mirror', 'apps', 'files'];

/**
 * 解析查询串决定渲染内容。
 *
 * 纯函数：故意不打 sound 检查 `window` 是否为 Tauri 环境，
 * 这样浏览器预览也能用 `?window=device&serial=x&tab=apps` 打开同一页面调试。
 */
export function parseWindowRoute(search: string): WindowRoute {
  const params = new URLSearchParams(search);
  if (params.get('window') !== 'device') return { kind: 'shell' };

  const serial = params.get('serial');
  if (!serial) return { kind: 'shell' };

  const raw = params.get('tab');
  const tab = TABS.includes(raw as WorkspaceTab) ? (raw as WorkspaceTab) : 'mirror';

  return { kind: 'device', serial, tab };
}

/** 构建设备窗口的 URL。 */
export function buildDeviceUrl(serial: string, tab: WorkspaceTab): string {
  const params = new URLSearchParams({ window: 'device', serial, tab });
  return `index.html?${params.toString()}`;
}
