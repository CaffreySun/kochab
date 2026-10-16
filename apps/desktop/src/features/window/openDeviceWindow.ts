import { MessagePlugin } from 'tdesign-react';
import type { WorkspaceTab } from '../../pages/DevicesPage';
import { buildDeviceUrl } from '../../windowMode';

/** 设备窗口标题带上标签，多开时不会只看到一串相同的窗口名。 */
const TAB_LABELS: Record<WorkspaceTab, string> = {
  apps: '应用',
  files: '文件',
  mirror: '投屏',
};

export function deviceWindowLabel(serial: string, tab: WorkspaceTab): string {
  return `device-${serial}-${tab}`;
}

/**
 * 打开（或聚焦）某台设备的独立窗口。
 *
 * 标签规则 `device-<serial>-<tab>`：同一个按钮重复点击是聚焦已有窗口，
 * 不同标签各自独立窗口——互不抢占，也不靠切换路由重建视图。
 */
export async function openDeviceWindow(serial: string, tab: WorkspaceTab): Promise<void> {
  const url = buildDeviceUrl(serial, tab);

  // 非 Tauri 环境（浏览器预览 / 单测）没有 WebviewWindow，退化为同页查询串。
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) {
    window.location.href = url;
    return;
  }

  const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
  const label = deviceWindowLabel(serial, tab);

  try {
    const existing = await WebviewWindow.getByLabel(label);
    if (existing) {
      await existing.show();
      await existing.unminimize();
      await existing.setFocus();
      return;
    }
  } catch {
    // 拿不到窗口列表不算致命：继续按新建处理即可。
  }

  const created = new WebviewWindow(label, {
    title: `${TAB_LABELS[tab]} · ${serial}`,
    url,
    width: 1080,
    height: 760,
    minWidth: 720,
    minHeight: 540,
    center: true,
    focus: true,
  });

  // 创建是异步的；失败必须让用户看见，否则点了按钮像是没反应。
  void created.once('tauri://error', (event) => {
    const payload = event.payload;
    const detail = typeof payload === 'string' ? payload : '未知错误';
    void MessagePlugin.error(`打开设备窗口失败：${detail}`);
  });
}
