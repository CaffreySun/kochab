import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loading } from 'tdesign-react';
import { AppShell, type ShellView } from './app/AppShell';
import type { Api } from './ipc';
import { useApi, useDevices, type DevicesState } from './features/devices/useDevices';
import { DEVICE_ENTRY_EVENT, type DeviceEntryRequest } from './features/window/openDeviceWindow';
import { DeviceDetailPage } from './pages/DeviceDetailPage';
import { DevicesPage, DEFAULT_PREVIEW_LIMIT } from './pages/DevicesPage';
import { SettingsPage } from './pages/SettingsPage';
import { TasksPage } from './pages/TasksPage';
import { TasksProvider, useTasks } from './features/tasks/TasksProvider';
import { entryIntent, parseWindowRoute, type DetailPanel } from './windowMode';
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

  // 设备窗口只有一个，标签在窗口内切换：URL 上的 tab 只是**初始值**，
  // 之后由用户在窗口内改，或由主窗口通过 DEVICE_TAB_EVENT 指定。
  // 详情窗口只有一个：面板开合与「是否已请求开始投屏」都在窗口内演进。
  // URL 上的 panel / mirror 只是**初始值**，之后由用户操作或主窗口的入口意图更新。
  const [detail, setDetail] = useState<{ panel: DetailPanel | null; startRequests: number }>(() =>
    route.kind === 'device'
      ? { panel: route.panel, startRequests: route.startMirror ? 1 : 0 }
      : { panel: null, startRequests: 0 },
  );

  useEffect(() => {
    if (route.kind !== 'device') return;
    // 浏览器预览 / 单测里没有窗口间事件，直接跳过。
    if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return;

    let unlisten: (() => void) | undefined;
    void import('@tauri-apps/api/event')
      .then(({ listen }) =>
        listen<DeviceEntryRequest>(DEVICE_ENTRY_EVENT, (event) => {
          const intent = entryIntent(event.payload.tab);
          setDetail((prev) => ({
            // 「投屏」入口不抢右栏：用户可能正开着文件页
            panel: intent.panel ?? prev.panel,
            startRequests: intent.startMirror ? prev.startRequests + 1 : prev.startRequests,
          }));
        }),
      )
      .then((fn) => {
        unlisten = fn;
      });
    return () => unlisten?.();
  }, [route]);

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
        <DeviceDetailPage
          api={api}
          device={currentDevice}
          panel={detail.panel}
          startRequest={detail.startRequests}
          onPanelChange={(panel) => setDetail((prev) => ({ ...prev, panel }))}
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
