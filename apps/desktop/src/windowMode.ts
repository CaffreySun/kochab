import type { WorkspaceTab } from './pages/DevicesPage';

/**
 * 详情页右栏可以显示什么。
 *
 * 投屏不在其中：它是常驻左栏，不进标签页。
 */
export type DetailPanel = 'apps' | 'files' | 'overview';

/**
 * 当前 webview 渲染什么。
 *
 * 设备详情是**独立窗口**，和主窗口共用同一份前端产物：
 * 主窗口 `index.html`，详情窗口 `index.html?window=device&serial=...`。
 * 用查询串区分，就不必再维护两套 html 入口。
 */
export type WindowRoute =
  | { kind: 'shell' }
  | {
      kind: 'device';
      serial: string;
      /** 初始右栏；`null` 表示不开面板，窗口就只有投屏 + 按钮栏 */
      panel: DetailPanel | null;
      /** 进入窗口时是否自动建立投屏会话 */
      startMirror: boolean;
    };

const PANELS: DetailPanel[] = ['apps', 'files', 'overview'];

/** 卡片入口表达的意图。 */
export interface EntryIntent {
  /** 是否要打开/切换面板；`undefined` 表示不动（沿用当前）。 */
  panel?: DetailPanel;
  /** 是否要立即建立投屏会话。 */
  startMirror: boolean;
}

/**
 * 把卡片上的入口翻译成详情页动作。
 *
 * `投屏` 只表达「我要投屏」——不开面板，窗口保持只有画面的窄宽度，
 * 用户可能正看着某个面板，也不该被抢走。
 * `应用`/`文件` 只定位面板，**不**替用户开会话：只想翻文件的人不该被占掉
 * 一条设备会话，那时画面中央显示「开始投屏」由用户自己决定。
 */
export function entryIntent(tab: WorkspaceTab): EntryIntent {
  switch (tab) {
    case 'mirror':
      return { startMirror: true };
    case 'files':
      return { panel: 'files', startMirror: false };
    default:
      return { panel: 'apps', startMirror: false };
  }
}

/**
 * 解析查询串决定渲染内容。
 *
 * 纯函数：故意不检查 `window` 是否为 Tauri 环境，
 * 这样浏览器预览也能用 `?window=device&serial=x&panel=files` 打开同一页面调试。
 */
export function parseWindowRoute(search: string): WindowRoute {
  const params = new URLSearchParams(search);
  if (params.get('window') !== 'device') return { kind: 'shell' };

  const serial = params.get('serial');
  if (!serial) return { kind: 'shell' };

  const raw = params.get('panel');
  const panel = PANELS.includes(raw as DetailPanel) ? (raw as DetailPanel) : null;

  return { kind: 'device', serial, panel, startMirror: params.get('mirror') === '1' };
}

/** 构建设备详情窗口的 URL（按入口意图决定初始状态）。 */
export function buildDeviceUrl(serial: string, tab: WorkspaceTab): string {
  const intent = entryIntent(tab);
  const params = new URLSearchParams({
    window: 'device',
    serial,
    mirror: intent.startMirror ? '1' : '0',
  });
  // 没面板时不写该参数：解析侧把缺省当作 null
  if (intent.panel) params.set('panel', intent.panel);
  return `index.html?${params.toString()}`;
}
