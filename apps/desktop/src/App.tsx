import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loading } from 'tdesign-react';
import { AppShell, type ShellView } from './app/AppShell';
import type { Api } from './ipc';
import { useApi, useDevices, type DevicesState } from './features/devices/useDevices';
import { openDeviceWindow } from './features/window/openDeviceWindow';
import { DeviceWorkspacePage } from './pages/DeviceWorkspacePage';
import { DevicesPage, DEFAULT_PREVIEW_LIMIT } from './pages/DevicesPage';
import { SettingsPage } from './pages/SettingsPage';
import { TasksPage } from './pages/TasksPage';
import { TasksProvider, useTasks } from './features/tasks/TasksProvider';
import { parseWindowRoute } from './windowMode';
import {
  MirrorOptionsContext,
  readMirrorOptions,
  writeMirrorOptions,
  type MirrorOptions,
} from './features/settings/mirrorOptions';

export interface AppProps {
  /**
   * 显式注入 API；默认由 `useApi` 按运行环境选择真实或 mock 传输。
   * 测试可通过注入 mock 传输来驱动同一套界面。
   */
  api?: Api;
}

/** 主窗口右侧内容区显示什么。 */
type ShellRoute = { kind: 'devices' } | { kind: 'tasks' } | { kind: 'settings' };

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
  // 投屏参数存在 localStorage：投屏窗口是独立 webview，靠它跨窗口共享设置。
  const [mirrorOptions, setMirrorOptions] = useState<MirrorOptions>(() => readMirrorOptions());

  const updateMirrorOptions = useCallback((next: MirrorOptions) => {
    setMirrorOptions(next);
    writeMirrorOptions(next);
  }, []);

  // 另一个窗口改了设置时（例如设备窗口里没改，但设置页可能重开）同步过来。
  useEffect(() => {
    const onStorage = () => setMirrorOptions(readMirrorOptions());
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

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
      <MirrorOptionsContext.Provider value={mirrorOptions}>
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
      </MirrorOptionsContext.Provider>
    );
  }

  return (
    <TasksProvider>
      <ShellContent
        api={api}
        deviceState={deviceState}
        mirrorOptions={mirrorOptions}
        previewEnabled={previewEnabled}
        previewLimit={previewLimit}
        route={shellRoute}
        setPreviewEnabled={setPreviewEnabled}
        setPreviewLimit={setPreviewLimit}
        setShellRoute={setShellRoute}
        updateMirrorOptions={updateMirrorOptions}
      />
    </TasksProvider>
  );
}

interface ShellContentProps {
  api: Api;
  deviceState: DevicesState;
  mirrorOptions: MirrorOptions;
  previewEnabled: boolean;
  previewLimit: number;
  route: ShellRoute;
  updateMirrorOptions: (options: MirrorOptions) => void;
  setPreviewEnabled: (enabled: boolean) => void;
  setPreviewLimit: (limit: number) => void;
  setShellRoute: (route: ShellRoute) => void;
}

/** 主窗口内容。任务队列必须读同一个 Provider，所以单独拆一个组件。 */
function ShellContent({
  api,
  deviceState,
  mirrorOptions,
  previewEnabled,
  previewLimit,
  route,
  updateMirrorOptions,
  setPreviewEnabled,
  setPreviewLimit,
  setShellRoute,
}: ShellContentProps) {
  const { tasks } = useTasks();
  const running = tasks.filter((task) => task.status === 'running').length;
  const shellView: ShellView = route.kind;
  const title = route.kind === 'settings' ? '设置' : route.kind === 'tasks' ? '任务' : '设备';

  return (
    <AppShell
      active={shellView}
      runningCount={running}
      title={title}
      onChange={(view) =>
        setShellRoute(view === 'settings' ? { kind: 'settings' } : { kind: view })
      }
    >
      {route.kind === 'devices' ? (
        <DevicesPage
          api={api}
          devices={deviceState}
          previewEnabled={previewEnabled}
          previewLimit={previewLimit}
        />
      ) : null}

      {route.kind === 'tasks' ? <TasksPage /> : null}

      {route.kind === 'settings' ? (
        <SettingsPage
          api={api}
          mirrorOptions={mirrorOptions}
          previewEnabled={previewEnabled}
          previewLimit={previewLimit}
          onMirrorOptionsChange={updateMirrorOptions}
          onPreviewEnabledChange={setPreviewEnabled}
          onPreviewLimitChange={setPreviewLimit}
        />
      ) : null}
    </AppShell>
  );
}
