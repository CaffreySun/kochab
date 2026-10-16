import { useMemo, useState } from 'react';
import { Loading } from 'tdesign-react';
import { AppShell, type ShellView } from './app/AppShell';
import type { Api } from './ipc';
import { useApi, useDevices } from './features/devices/useDevices';
import { openDeviceWindow } from './features/window/openDeviceWindow';
import { DeviceWorkspacePage } from './pages/DeviceWorkspacePage';
import { DevicesPage, DEFAULT_PREVIEW_LIMIT } from './pages/DevicesPage';
import { SettingsPage } from './pages/SettingsPage';
import { parseWindowRoute } from './windowMode';

export interface AppProps {
  /**
   * 显式注入 API；默认由 `useApi` 按运行环境选择真实或 mock 传输。
   * 测试可通过注入 mock 传输来驱动同一套界面。
   */
  api?: Api;
}

/** 主窗口右侧内容区显示什么。 */
type ShellRoute = { kind: 'devices' } | { kind: 'settings' };

export function App({ api: injected }: AppProps = {}) {
  const autoApi = useApi();
  const api = injected ?? autoApi;

  // 同一个前端产物有三个形态：主窗口、设备窗口、以及启动占位。
  const route = parseWindowRoute(typeof window === 'undefined' ? '' : window.location.search);

  // 设备列表在整个主窗口只订阅一次，工作区与列表页共用同一份数据。
  const deviceState = useDevices(api);
  const { devices } = deviceState;

  const [shellRoute, setShellRoute] = useState<ShellRoute>({ kind: 'devices' });
  const [previewEnabled, setPreviewEnabled] = useState(true);
  const [previewLimit, setPreviewLimit] = useState(DEFAULT_PREVIEW_LIMIT);

  const currentDevice = useMemo(
    () =>
      route.kind === 'device' ? (devices.find((d) => d.serial === route.serial) ?? null) : null,
    [route, devices],
  );

  if (!api) {
    return (
      <div className="ac-app">
        <Loading loading size="small" text="正在初始化…" />
      </div>
    );
  }

  if (route.kind === 'device') {
    return (
      <DeviceWorkspacePage
        api={api}
        device={currentDevice}
        tab={route.tab}
        onTabChange={(tab) => {
          if (route.serial !== currentDevice?.serial) return;
          // 独立窗口之间不共享路由：换标签就是开另一个窗口
          void openDeviceWindow(route.serial, tab);
        }}
      />
    );
  }

  const shellView: ShellView = shellRoute.kind === 'settings' ? 'settings' : 'devices';

  return (
    <AppShell
      active={shellView}
      title={shellRoute.kind === 'settings' ? '设置' : '设备'}
      onChange={(view) =>
        setShellRoute(view === 'settings' ? { kind: 'settings' } : { kind: 'devices' })
      }
    >
      {shellRoute.kind === 'devices' ? (
        <DevicesPage
          api={api}
          devices={deviceState}
          previewEnabled={previewEnabled}
          previewLimit={previewLimit}
        />
      ) : null}

      {shellRoute.kind === 'settings' ? (
        <SettingsPage
          api={api}
          previewEnabled={previewEnabled}
          previewLimit={previewLimit}
          onPreviewEnabledChange={setPreviewEnabled}
          onPreviewLimitChange={setPreviewLimit}
        />
      ) : null}
    </AppShell>
  );
}
