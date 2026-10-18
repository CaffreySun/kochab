import { MessagePlugin } from 'tdesign-react';
import type { WorkspaceTab } from '../../pages/DevicesPage';
import { buildDeviceUrl } from '../../windowMode';

/**
 * 主窗口 → 详情窗口的入口意图。
 *
 * 只用于**前端窗口之间**，不经过 Rust，因此不进 `@kochab/ipc-contract` 的事件表——
 * 那张表是与 Rust `emit` 调用点一一对应的。命名仍沿用 `<领域>://<事件>` 约定。
 */
export const DEVICE_ENTRY_EVENT = 'device://entry-request';

export interface DeviceEntryRequest {
  tab: WorkspaceTab;
}

/**
 * 窗口标签是 `device-<serial>`：**一台设备只有一个窗口**。
 *
 * 投屏常驻左栏，应用 / 文件 / 概览是右栏的标签页；再点卡片上的入口只是
 * 让它聚焦并切到对应状态，不再开新窗口。
 */
export function deviceWindowLabel(serial: string): string {
  return `device-${serial}`;
}

/**
 * 打开（或聚焦）某台设备的详情窗口，并送达入口意图。
 *
 * 窗口已存在时不重建视图：投屏会话是有状态的，重建会把它打断，
 * 所以改用窗口事件把「切到哪个面板 / 是否开始投屏」送进去。
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
      await emitTo(label, DEVICE_ENTRY_EVENT, { tab } satisfies DeviceEntryRequest);
      return;
    }
  } catch {
    // 拿不到窗口列表不算致命：继续按新建处理即可。
  }

  const created = new WebviewWindow(label, {
    title: `Kochab · 设备 · ${serial}`,
    url,
    // 只是初值：窗口挂载后会按设备分辨率把宽度调成「画面刚好填满」，
    // 面板打开时再向右变宽。这里给一个偏窄的起点，避免先宽后窄的跳动。
    width: 480,
    height: 840,
    minWidth: 240,
    minHeight: 420,
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
