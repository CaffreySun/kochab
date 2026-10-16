import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { COMMANDS, type DeviceInfo } from '@ac/ipc-contract';
import { createApi } from '../ipc';
import { createMockTransport } from '../ipc/mock';
import { AppsPage } from './AppsPage';
import { DevicesPage } from './DevicesPage';
import { DeviceWorkspacePage } from './DeviceWorkspacePage';
import { useDevices } from '../features/devices/useDevices';
import { FilesPage } from './FilesPage';
import { MirrorTile } from '../features/mirror/MirrorTile';
import { MIRROR_PRIORITY, PREVIEW_PRIORITY } from '../features/mirror/useMirror';
import { openDeviceWindow } from '../features/window/openDeviceWindow';

// 独立窗口靠 Tauri 的 WebviewWindow 创建；单测只关心「点了按钮开哪个窗口」。
vi.mock('../features/window/openDeviceWindow', () => ({
  openDeviceWindow: vi.fn().mockResolvedValue(undefined),
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
  function DevicesPageHarness(props: Omit<React.ComponentProps<typeof DevicesPage>, 'devices'>) {
    const devices = useDevices(props.api);
    return <DevicesPage {...props} devices={devices} />;
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

  it('不同标签各自独立：投屏与应用不会复用同一个窗口', async () => {
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
});

describe('MirrorTile', () => {
  it('开始投屏后进入投屏中状态并展示分辨率', async () => {
    const { api } = setup();
    const user = userEvent.setup();
    render(<MirrorTile api={api} device={READY_DEVICE} />);

    await user.click(screen.getByRole('button', { name: '开始投屏' }));

    await waitFor(() => {
      expect(screen.getByTestId('mirror-status')).toHaveTextContent('投屏中');
    });
    expect(screen.getByText(/540×1080/)).toBeInTheDocument();
  });

  it('未开始投屏时按键不会下发 session_key', async () => {
    const { api, onInvoke } = setup();
    const user = userEvent.setup();
    render(<MirrorTile api={api} device={READY_DEVICE} />);

    // TDesign 的 disabled 按钮会渲染成不可交互元素，直接断言「点了也没发命令」
    await user.click(screen.getByText('返回'));

    expect(onInvoke).not.toHaveBeenCalledWith(COMMANDS.sessionKey, expect.anything());
  });
});

describe('DeviceWorkspacePage', () => {
  it('独立窗口自带设备标识与三个标签页', () => {
    const { api } = setup();
    render(
      <DeviceWorkspacePage api={api} device={READY_DEVICE} tab="apps" onTabChange={vi.fn()} />,
    );

    // 窗口内必须自报家门：多开时全靠这一行分辨是哪台设备
    const header = screen.getByText('Xiaomi MIX 2S').closest('header');
    expect(header).not.toBeNull();
    expect(within(header!).getByText('d4535f72')).toBeInTheDocument();

    // TDesign 的 Tabs 不带 ARIA role，只能按导航区作用域断言文案
    const nav = document.querySelector('.t-tabs__nav');
    expect(nav).not.toBeNull();
    for (const label of ['投屏', '应用', '文件']) {
      expect(within(nav as HTMLElement).getByText(label)).toBeInTheDocument();
    }
  });

  it('切换标签把意图交回给调用方去开另一个窗口', async () => {
    const onTabChange = vi.fn();
    const { api } = setup();
    const user = userEvent.setup();
    render(
      <DeviceWorkspacePage api={api} device={READY_DEVICE} tab="apps" onTabChange={onTabChange} />,
    );

    const nav = document.querySelector('.t-tabs__nav') as HTMLElement;
    await user.click(within(nav).getByText('文件'));

    expect(onTabChange).toHaveBeenCalledWith('files');
  });

  it('设备消失时给出提示而不是崩溃', () => {
    const { api } = setup();
    render(<DeviceWorkspacePage api={api} device={null} tab="apps" onTabChange={vi.fn()} />);

    expect(screen.getByText('设备未连接')).toBeInTheDocument();
  });
});
