import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type React from 'react';
import { COMMANDS, type DeviceInfo, type SessionInfo } from '@ac/ipc-contract';
import { createApi } from '../ipc';
import { createMockTransport } from '../ipc/mock';
import { AppsPage } from './AppsPage';
import { DevicesPage } from './DevicesPage';
import { DeviceDetailPage } from './DeviceDetailPage';
import { SettingsPage } from './SettingsPage';
import { DeviceMoreMenu } from '../features/devices/DeviceMoreMenu';
import { TasksProvider } from '../features/tasks/TasksProvider';
import { useDevices } from '../features/devices/useDevices';
import { FilesPage } from './FilesPage';
import { MirrorStage } from '../features/mirror/MirrorStage';
import { MIRROR_PRIORITY, PREVIEW_PRIORITY } from '../features/mirror/useMirror';
import { openDeviceWindow } from '../features/window/openDeviceWindow';
import {
  DEFAULT_MIRROR_OPTIONS,
  readMirrorOptions,
  writeMirrorOptions,
} from '../features/settings/mirrorOptions';

// 独立窗口靠 Tauri 的 WebviewWindow 创建；单测只关心「点了按钮开哪个窗口」。
vi.mock('../features/window/openDeviceWindow', () => ({
  openDeviceWindow: vi.fn().mockResolvedValue(undefined),
}));

// 安装 APK 要弹系统对话框；单测里固定返回一个路径，避免真的调系统 API。
vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn().mockResolvedValue('/tmp/out'),
}));

const READY_DEVICE: DeviceInfo = {
  serial: 'd4535f72',
  state: 'device',
  isEmulator: false,
  model: 'MIX 2S',
  manufacturer: 'Xiaomi',
  brand: 'Xiaomi',
  device: 'polaris',
  androidVersion: '13',
  sdkInt: 33,
  screenResolution: '1080x2400',
  transport: 'usb',
};

const OFFLINE_DEVICE: DeviceInfo = { ...READY_DEVICE, state: 'unauthorized' };

function setup(overrides: Record<string, unknown> = {}) {
  const onInvoke = vi.fn();
  const transport = createMockTransport(overrides, { onInvoke });
  return { api: createApi(transport), onInvoke };
}

describe('AppsPage', () => {
  it('列出应用并展示包名', async () => {
    const { api } = setup();
    render(<AppsPage api={api} device={READY_DEVICE} />);

    expect(await screen.findByText('com.android.settings')).toBeInTheDocument();
    expect(screen.getByText('com.example.notes')).toBeInTheDocument();
  });

  it('关键字可以过滤列表', async () => {
    const { api } = setup();
    const user = userEvent.setup();
    render(<AppsPage api={api} device={READY_DEVICE} />);

    await screen.findByText('com.android.settings');
    await user.type(screen.getByPlaceholderText('搜索包名或应用名'), 'notes');

    await waitFor(() => {
      expect(screen.queryByText('com.android.settings')).not.toBeInTheDocument();
    });
    expect(screen.getByText('com.example.notes')).toBeInTheDocument();
  });

  it('系统应用不可卸载：点击不会下发 app_uninstall', async () => {
    const { api, onInvoke } = setup();
    const user = userEvent.setup();
    render(<AppsPage api={api} device={READY_DEVICE} />);

    const row = (await screen.findByText('com.android.settings')).closest('tr');
    expect(row).not.toBeNull();
    await user.click(within(row as HTMLElement).getByText('卸载'));

    expect(onInvoke).not.toHaveBeenCalledWith(
      COMMANDS.appUninstall,
      expect.objectContaining({ packageName: 'com.android.settings' }),
    );
  });

  it('第三方应用卸载会下发 app_uninstall', async () => {
    const { api, onInvoke } = setup();
    const user = userEvent.setup();
    render(<AppsPage api={api} device={READY_DEVICE} />);

    const row = (await screen.findByText('com.example.notes')).closest('tr');
    await user.click(within(row as HTMLElement).getByRole('button', { name: '卸载' }));

    await waitFor(() => {
      expect(onInvoke).toHaveBeenCalledWith(
        COMMANDS.appUninstall,
        expect.objectContaining({ packageName: 'com.example.notes' }),
      );
    });
  });

  it('启动应用会调用 app_launch', async () => {
    const { api, onInvoke } = setup();
    const user = userEvent.setup();
    render(<AppsPage api={api} device={READY_DEVICE} />);

    const row = (await screen.findByText('com.example.notes')).closest('tr');
    await user.click(within(row as HTMLElement).getByRole('button', { name: '启动' }));

    await waitFor(() => {
      expect(onInvoke).toHaveBeenCalledWith(COMMANDS.appLaunch, {
        serial: 'd4535f72',
        packageName: 'com.example.notes',
      });
    });
  });

  it('设备未就绪时不发任何命令', () => {
    const { api, onInvoke } = setup();
    render(<AppsPage api={api} device={OFFLINE_DEVICE} />);

    expect(screen.getByText('设备未就绪')).toBeInTheDocument();
    expect(onInvoke).not.toHaveBeenCalled();
  });

  // 导出：不选目录，直接把包名与建议名交给后端（落到系统「下载」目录）
  it('导出应用直接下发 app_export，由后端决定目录', async () => {
    const { api, onInvoke } = setup();
    const user = userEvent.setup();
    render(<AppsPage api={api} device={READY_DEVICE} />);

    const row = (await screen.findByText('com.example.notes')).closest('tr');
    await user.click(within(row as HTMLElement).getByRole('button', { name: '导出' }));

    await waitFor(() => {
      expect(onInvoke).toHaveBeenCalledWith(COMMANDS.appExport, {
        serial: 'd4535f72',
        packageName: 'com.example.notes',
        suggestedName: '随手记_2.4.1',
      });
    });
  });
});

describe('FilesPage', () => {
  it('默认进入 /sdcard 并列出内容', async () => {
    const { api, onInvoke } = setup();
    render(<FilesPage api={api} device={READY_DEVICE} />);

    expect(await screen.findByText(/note\.txt/)).toBeInTheDocument();
    expect(onInvoke).toHaveBeenCalledWith(COMMANDS.fileList, {
      serial: 'd4535f72',
      path: '/sdcard',
    });
  });

  it('点击目录会进入该路径', async () => {
    const { api, onInvoke } = setup();
    const user = userEvent.setup();
    render(<FilesPage api={api} device={READY_DEVICE} />);

    await user.click(await screen.findByRole('button', { name: /Download/ }));

    await waitFor(() => {
      expect(onInvoke).toHaveBeenCalledWith(COMMANDS.fileList, {
        serial: 'd4535f72',
        path: '/sdcard/Download',
      });
    });
  });

  it('普通文件不可进入，展示大小', async () => {
    const { api } = setup();
    render(<FilesPage api={api} device={READY_DEVICE} />);

    const file = await screen.findByRole('button', { name: /note\.txt/ });
    expect(file).toBeDisabled();
    expect(screen.getByText('2.0 KB')).toBeInTheDocument();
  });

  it('读取失败时展示错误码文案', async () => {
    const { api } = setup({
      file_list: () => {
        throw new Error('路径不存在：/sdcard/nope');
      },
    });
    render(<FilesPage api={api} device={READY_DEVICE} />);

    expect(await screen.findByRole('alert')).toHaveTextContent('路径不存在');
  });
});

describe('DevicesPage（多设备）', () => {
  const second = { ...READY_DEVICE, serial: 'emulator-5554', model: 'Pixel 7' };

  /** DevicesPage 的设备数据由上层传入，测试里用真实 hook 的薄包装提供。 */
  // 批量工具栏要读全局任务队列，单测里照样要包 Provider，
  // 否则测的是一个生产环境不存在的组件树。
  function DevicesPageHarness(props: Omit<React.ComponentProps<typeof DevicesPage>, 'devices'>) {
    const devices = useDevices(props.api);
    return (
      <TasksProvider>
        <DevicesPage {...props} devices={devices} />
      </TasksProvider>
    );
  }

  function renderPage(overrides: Record<string, unknown> = {}, limit = 4) {
    const { api, onInvoke } = setup(overrides);
    render(<DevicesPageHarness previewEnabled api={api} previewLimit={limit} />);
    return { api, onInvoke };
  }

  it('为每台设备渲染一张卡片', async () => {
    renderPage({ device_list: [READY_DEVICE, second] });
    expect(await screen.findAllByTestId('device-card')).toHaveLength(2);
  });

  it('卡片操作栏为每台设备各开一个独立窗口', async () => {
    const user = userEvent.setup();
    renderPage({ device_list: [READY_DEVICE, second] });

    const cards = await screen.findAllByTestId('device-card');
    await user.click(within(cards[1]!).getByRole('button', { name: '文件' }));

    expect(openDeviceWindow).toHaveBeenCalledWith('emulator-5554', 'files');
  });

  it('卡片上的入口都指向同一台设备，只是初始标签不同', async () => {
    const user = userEvent.setup();
    renderPage({ device_list: [READY_DEVICE] });

    const card = (await screen.findAllByTestId('device-card'))[0]!;
    await user.click(within(card).getByRole('button', { name: '投屏' }));
    await user.click(within(card).getByRole('button', { name: '应用' }));

    expect(openDeviceWindow).toHaveBeenNthCalledWith(1, 'd4535f72', 'mirror');
    expect(openDeviceWindow).toHaveBeenNthCalledWith(2, 'd4535f72', 'apps');
  });

  it('勾选设备后出现批量操作条', async () => {
    const user = userEvent.setup();
    renderPage({ device_list: [READY_DEVICE, second] });

    expect(screen.queryByText('取消选择')).not.toBeInTheDocument();

    const cards = await screen.findAllByTestId('device-card');
    await user.click(within(cards[0]!).getByRole('checkbox'));

    expect(await screen.findByText('取消选择')).toBeInTheDocument();
  });

  it('缩略图与投屏窗口使用不同的会话名，避免抢同一台设备时互相复用', async () => {
    const { api, onInvoke } = setup({ device_list: [READY_DEVICE] });
    render(<DevicesPageHarness previewEnabled api={api} previewLimit={4} />);

    await screen.findByTestId('preview-canvas');
    await waitFor(() => {
      expect(onInvoke).toHaveBeenCalledWith(
        COMMANDS.sessionStart,
        expect.objectContaining({ sessionId: 'preview-d4535f72' }),
      );
    });

    // 投屏磁贴必须用另一个名字：Rust 侧靠它区分「同一消费方」与「换人了」
    const startPayloads = onInvoke.mock.calls
      .filter((call: unknown[]) => call[0] === COMMANDS.sessionStart)
      .map((call: unknown[]) => (call[1] as { sessionId?: string } | undefined)?.sessionId);
    expect(startPayloads.length).toBeGreaterThan(0);
    expect(startPayloads).not.toContain('mirror-d4535f72');
    // 缩略图优先级必须低于投屏，否则会反向抢占
    expect(PREVIEW_PRIORITY).toBeLessThan(MIRROR_PRIORITY);
  });

  it('批量重启后任务页留下逐台结果', async () => {
    const user = userEvent.setup();
    const { api } = setup({ device_list: [READY_DEVICE] });
    render(<DevicesPageHarness previewEnabled api={api} previewLimit={4} />);

    const cards = await screen.findAllByTestId('device-card');
    await user.click(within(cards[0]!).getByRole('checkbox'));
    await user.click(await screen.findByRole('button', { name: '重启设备' }));

    // 任务队列是异步逐台跑的，等它落到终态
    await waitFor(
      () => {
        expect(screen.getByText('重启设备')).toBeInTheDocument();
      },
      { timeout: 5000 },
    );
  });
  it('预览并发受上限约束：超出的设备显示关闭占位', async () => {
    renderPage({ device_list: [READY_DEVICE, second] }, 1);

    expect(await screen.findAllByTestId('device-card')).toHaveLength(2);
    // 上限为 1，因此只有一台拿到 canvas
    await waitFor(() => {
      expect(screen.getAllByTestId('preview-canvas')).toHaveLength(1);
    });
    expect(screen.getAllByText('预览已关闭')).toHaveLength(1);
  });

  it('关闭预览开关后全部显示占位且不建立会话', async () => {
    const { api, onInvoke } = setup({ device_list: [READY_DEVICE] });
    render(<DevicesPageHarness api={api} previewEnabled={false} previewLimit={4} />);

    expect(await screen.findByText('预览已关闭')).toBeInTheDocument();
    expect(onInvoke).not.toHaveBeenCalledWith(COMMANDS.sessionStart, expect.anything());
  });

  it('关键字过滤设备', async () => {
    const user = userEvent.setup();
    renderPage({ device_list: [READY_DEVICE, second] });
    await screen.findAllByTestId('device-card');

    await user.type(screen.getByPlaceholderText('搜索设备'), 'pixel');

    await waitFor(() => {
      expect(screen.getAllByTestId('device-card')).toHaveLength(1);
    });
  });

  it('勾选设备会累计到批量作用域', async () => {
    const user = userEvent.setup();
    renderPage({ device_list: [READY_DEVICE, second] });

    const cards = await screen.findAllByTestId('device-card');
    await user.click(within(cards[0]!).getByRole('checkbox'));

    expect(screen.getByText('已选 1 台')).toBeInTheDocument();
  });

  it('新建分组后设备归入该分组', async () => {
    window.localStorage.clear();
    const user = userEvent.setup();
    renderPage({ device_list: [READY_DEVICE] });

    const card = (await screen.findAllByTestId('device-card'))[0]!;
    await user.click(within(card).getByTestId('device-group'));
    await user.type(await screen.findByPlaceholderText('新建分组名称'), '测试组');
    await user.click(confirmDialog());

    await waitFor(() => {
      expect(within(card).getByText('测试组')).toBeInTheDocument();
    });
  });

  // 回归：applyAssign 之前不更新 current，高亮会停在旧分组。
  it('对话框里改分组会即时更新高亮', async () => {
    window.localStorage.clear();
    const user = userEvent.setup();
    renderPage({ device_list: [READY_DEVICE] });

    const card = (await screen.findAllByTestId('device-card'))[0]!;
    await user.click(within(card).getByTestId('device-group'));
    await user.type(await screen.findByPlaceholderText('新建分组名称'), 'A组');
    await user.click(confirmDialog());
    await waitFor(() => expect(within(card).getByText('A组')).toBeInTheDocument());

    await user.click(within(card).getByTestId('device-group'));
    await user.click(await screen.findByRole('button', { name: '未分组' }));

    await waitFor(() => {
      expect(within(card).getByText('未分组')).toBeInTheDocument();
    });
  });
});

/** Dialog 挂在 body 上，用 role 查询即可（按钮文案由 DevicesPage 显式指定）。 */
function confirmDialog(): HTMLElement {
  return screen.getByRole('button', { name: '确定' });
}

describe('DeviceMoreMenu', () => {
  // 回归：最初只弹一条 toast 就关掉弹层，命令的 stdout 被直接丢掉。
  it('命令行执行后要在弹层里展示输出', async () => {
    const { api, onInvoke } = setup();
    const user = userEvent.setup();
    render(<DeviceMoreMenu api={api} device={READY_DEVICE} />);

    await user.click(screen.getByLabelText('更多'));
    await user.click(await screen.findByText('命令行'));

    await user.type(
      await screen.findByPlaceholderText('例如：dumpsys battery'),
      'getprop ro.product.model',
    );
    await user.click(screen.getByRole('button', { name: '执行' }));

    const output = await screen.findByTestId('shell-output');
    expect(output).toHaveTextContent('ok');
    expect(onInvoke).toHaveBeenCalledWith(COMMANDS.shellExec, {
      serial: 'd4535f72',
      command: 'getprop ro.product.model',
    });
  });

  // 回归：命令写成 `ip -4 route show wlan0` 会被 Android 的 iproute2 拒绝，
  // 于是手机明明连着 Wi-Fi 也报「读不到 Wi-Fi 地址」。
  it('无线连接能读出 wlan0 的 IPv4 地址', async () => {
    const { api } = setup({
      shell_exec: () => ({
        command: 'ip -4 addr show wlan0',
        exitCode: 0,
        stdout:
          '30: wlan0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 state UP\n' +
          '    inet 192.168.1.158/24 brd 192.168.1.255 scope global wlan0\n',
        timedOut: false,
      }),
    });
    const user = userEvent.setup();
    render(<DeviceMoreMenu api={api} device={READY_DEVICE} />);

    await user.click(screen.getByLabelText('更多'));
    await user.click(await screen.findByText('无线连接'));

    expect(await screen.findByText(/192\.168\.1\.158:5555/)).toBeInTheDocument();
  });
});

describe('MirrorStage', () => {
  const SESSION_INFO = {
    sessionId: 1,
    serial: 'd4535f72',
    localPort: 5000,
    deviceSocket: 'scrcpy_abc',
    deviceName: 'MIX 2S',
    width: 540,
    height: 1080,
  } as SessionInfo;
  const SESSION_STATS = {
    sessionId: 1,
    frames: 100,
    keyFrames: 2,
    bytes: 1024,
    dropped: 0,
    fps: 27,
  };
  const baseProps = {
    setCanvas: vi.fn(),
    info: null,
    stats: null,
    error: null,
    sendTouch: vi.fn(),
  };

  it('未开始时给出「开始投屏」入口', async () => {
    const onStart = vi.fn();
    const user = userEvent.setup();
    render(<MirrorStage {...baseProps} status="idle" onStart={onStart} />);

    await user.click(screen.getByRole('button', { name: '开始投屏' }));

    expect(onStart).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('mirror-status')).toHaveTextContent('未开始');
  });

  it('协商中不显示开始按钮', () => {
    render(<MirrorStage {...baseProps} status="starting" onStart={vi.fn()} />);

    expect(screen.queryByRole('button', { name: '开始投屏' })).not.toBeInTheDocument();
    expect(screen.getByText('正在协商会话…')).toBeInTheDocument();
  });

  it('出错时把原因说清楚，而不是只留一块黑板', () => {
    render(<MirrorStage {...baseProps} error="设备已离线" status="error" onStart={vi.fn()} />);

    expect(screen.getByRole('alert')).toHaveTextContent('设备已离线');
  });

  it('投屏中显示分辨率与帧率，且不再显示开始入口', () => {
    render(
      <MirrorStage
        {...baseProps}
        info={SESSION_INFO}
        stats={{ ...SESSION_STATS, fps: 27 }}
        status="streaming"
        onStart={vi.fn()}
      />,
    );

    expect(screen.getByText('540×1080')).toBeInTheDocument();
    expect(screen.getByTestId('mirror-fps')).toHaveTextContent('27 fps');
    expect(screen.queryByRole('button', { name: '开始投屏' })).not.toBeInTheDocument();
  });
});

describe('DeviceDetailPage', () => {
  function renderDetail(overrides: Partial<React.ComponentProps<typeof DeviceDetailPage>> = {}) {
    const { api } = setup();
    const props: React.ComponentProps<typeof DeviceDetailPage> = {
      api,
      device: READY_DEVICE,
      panel: null,
      startRequest: 0,
      onPanelChange: vi.fn(),
      ...overrides,
    };
    render(<DeviceDetailPage {...props} />);
    return props;
  }

  it('默认只有投屏与竖排按钮栏，没有头部与标签页', () => {
    renderDetail();

    expect(screen.getByTestId('mirror-stage')).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: '投屏操作' })).toBeInTheDocument();
    // 设备身份写在系统标题栏，页面里不再重复
    expect(screen.queryByText('d4535f72')).not.toBeInTheDocument();
    // 没有面板就不渲染面板容器
    expect(document.querySelector('.ac-detail__panel')).toBeNull();
  });

  it('startRequest 递增会自动开始投屏，不必手点', async () => {
    const { api, onInvoke } = setup();
    render(
      <DeviceDetailPage
        api={api}
        device={READY_DEVICE}
        panel={null}
        startRequest={1}
        onPanelChange={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('mirror-status')).toHaveTextContent('投屏中');
    });
    expect(onInvoke).toHaveBeenCalledWith(
      COMMANDS.sessionStart,
      expect.objectContaining({ serial: 'd4535f72' }),
    );
  });

  it('按钮栏里的应用/概览/文件只切换面板，不卸载投屏', async () => {
    const user = userEvent.setup();
    const props = renderDetail({ panel: null });

    await user.click(screen.getByRole('button', { name: '应用' }));

    expect(props.onPanelChange).toHaveBeenCalledWith('apps');
    // 关键：切面板不能把画面卸载掉（否则会话会被停掉重建）
    expect(screen.getByTestId('mirror-stage')).toBeInTheDocument();
    expect(openDeviceWindow).not.toHaveBeenCalled();
  });

  it('点已打开的面板按钮表示关闭', async () => {
    const user = userEvent.setup();
    const props = renderDetail({ panel: 'files' });

    await user.click(screen.getByRole('button', { name: '文件' }));

    expect(props.onPanelChange).toHaveBeenCalledWith(null);
  });

  it('面板打开时渲染对应页面', async () => {
    renderDetail({ panel: 'overview' });

    expect(document.querySelector('.ac-detail__panel')).not.toBeNull();
    // 概览要先取一次数据，所以是异步出现
    expect(await screen.findByRole('heading', { name: '电池' })).toBeInTheDocument();
  });

  it('未开始投屏时按键不会下发 session_key', async () => {
    const { api, onInvoke } = setup();
    const user = userEvent.setup();
    render(
      <DeviceDetailPage
        api={api}
        device={READY_DEVICE}
        panel={null}
        startRequest={0}
        onPanelChange={vi.fn()}
      />,
    );

    await user.click(screen.getByLabelText('返回键'));

    expect(onInvoke).not.toHaveBeenCalledWith(COMMANDS.sessionKey, expect.anything());
  });

  it('设备消失时给出提示而不是崩溃', () => {
    renderDetail({ device: null });

    expect(screen.getByText('设备未连接')).toBeInTheDocument();
    expect(screen.queryByTestId('mirror-stage')).not.toBeInTheDocument();
  });
});
describe('SettingsPage', () => {
  const renderSettings = (props: Partial<React.ComponentProps<typeof SettingsPage>> = {}) =>
    render(
      <SettingsPage
        previewEnabled
        api={null}
        mirrorOptions={DEFAULT_MIRROR_OPTIONS}
        previewLimit={8}
        onMirrorOptionsChange={vi.fn()}
        onPreviewEnabledChange={vi.fn()}
        onPreviewLimitChange={vi.fn()}
        {...props}
      />,
    );

  // 回归：Form.FormItem 会给直接子控件注入 value=undefined，把显式 value 覆盖成空。
  it('所有受控输入框与开关都要真正显示传入的值', () => {
    const { container } = renderSettings();

    const values = Array.from(container.querySelectorAll('input')).map((i) => i.value);
    expect(values).toEqual(['1080', '30', '8', '8']);

    const switches = Array.from(container.querySelectorAll('.t-switch'));
    expect(switches).toHaveLength(3);
    for (const node of switches) {
      expect(node.className).toContain('t-is-checked');
    }
  });

  it('关闭的开关要真实反映为关闭', () => {
    const { container } = renderSettings({
      mirrorOptions: { ...DEFAULT_MIRROR_OPTIONS, showTouches: false, stayAwake: false },
      previewEnabled: false,
    });

    const switches = Array.from(container.querySelectorAll('.t-switch'));
    expect(switches.map((n) => n.className.includes('t-is-checked'))).toEqual([
      false,
      false,
      false,
    ]);
  });

  it('修改分辨率上限会回传新设置', async () => {
    const onMirrorOptionsChange = vi.fn();
    const { container } = renderSettings({ onMirrorOptionsChange });

    const maxSize = container.querySelector('input');
    expect(maxSize).not.toBeNull();
    await userEvent.clear(maxSize!);
    await userEvent.type(maxSize!, '720');

    expect(onMirrorOptionsChange).toHaveBeenCalledWith(expect.objectContaining({ maxSize: 720 }));
  });
});

describe('mirrorOptions 持久化', () => {
  it('maxSize=0 表示不限制，读回来必须还是 0', () => {
    writeMirrorOptions({ ...DEFAULT_MIRROR_OPTIONS, maxSize: 0 });

    expect(readMirrorOptions().maxSize).toBe(0);
  });

  it('损坏的数值回落到默认值', () => {
    window.localStorage.setItem(
      'ac.mirrorOptions',
      JSON.stringify({ maxSize: 'big', maxFps: -5, bitRate: null, showTouches: 'yes' }),
    );

    expect(readMirrorOptions()).toEqual(DEFAULT_MIRROR_OPTIONS);
  });

  it('缺失存储时返回默认值', () => {
    window.localStorage.removeItem('ac.mirrorOptions');

    expect(readMirrorOptions()).toEqual(DEFAULT_MIRROR_OPTIONS);
  });
});
