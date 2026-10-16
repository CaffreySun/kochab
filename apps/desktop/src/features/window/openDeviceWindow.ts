import { MessagePlugin } from 'tdesign-react';
import type { WorkspaceTab } from '../../pages/DevicesPage';
import { buildDeviceUrl } from '../../windowMode';

/**
 * 请求设备窗口切到某个标签。
 *
 * 只用于**前端窗口之间**（主窗口 → 设备窗口），不经过 Rust，因此不进
 * `@ac/ipc-contract` 的事件表——那张表是与 Rust `emit` 调用点一一对应的。
 * 命名仍沿用 `<领域>://<事件>` 约定。
 */
export const DEVICE_TAB_EVENT = 'device://tab-request';

export interface DeviceTabRequest {
  tab: WorkspaceTab;
}

/**
 * 窗口标签是 `device-<serial>`：**一台设备只有一个窗口**。
 *
 * 投屏 / 应用 / 文件是同一个窗口里的标签页，切换时不再开新窗口。
 * 需要并排看时开两个设备窗口没有意义（同一设备同时只能有一条投屏会话），
 * 真要并排的是两台不同设备。
 */
export function deviceWindowLabel(serial: string): string {
  return `device-${serial}`;
}

/**
 * 打开（或聚焦）某台设备的独立窗口，并切到指定标签。
 *
 * 窗口已存在时不重建视图：投屏会话是有状态的，重建会把正在跑的会话打断，
 * 所以改用窗口事件把「切标签」的意图送进去。
 */
export async function openDeviceWindow(serial: string, tab: WorkspaceTab): Promise<void> {
  const url = buildDeviceUrl(serial, tab);

  // 非 Tauri 环境（浏览器预览 / 单测）没有 WebviewWindow，退化为同页查询串。
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) {
    window.location.href = url;
    return;
  }

  const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
  const label = deviceWindowLabel(serial);

  try {
    const existing = await WebviewWindow.getByLabel(label);
    if (existing) {
      await existing.show();
      await existing.unminimize();
      await existing.setFocus();
      const { emitTo } = await import('@tauri-apps/api/event');
      await emitTo(label, DEVICE_TAB_EVENT, { tab } satisfies DeviceTabRequest);
      return;
    }
  } catch {
    // 拿不到窗口列表不算致命：继续按新建处理即可。
  }

  const created = new WebviewWindow(label, {
    title: `设备 · ${serial}`,
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
