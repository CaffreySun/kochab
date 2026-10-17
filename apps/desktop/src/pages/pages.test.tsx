import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type React from 'react';
import { COMMANDS, type DeviceInfo, type SessionInfo } from '@ac/ipc-contract';
import { KEYCODE_BACK } from '@ac/scrcpy-web';
import { createApi } from '../ipc';
import { createMockTransport } from '../ipc/mock';
import { AppsPage } from './AppsPage';
import { DevicesPage } from './DevicesPage';
import { DeviceDetailPage } from './DeviceDetailPage';
import { OverviewPage } from './OverviewPage';
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

    expect(await screen.findByText(/com\.android\.settings/)).toBeInTheDocument();
    expect(screen.getByText(/com\.example\.notes/)).toBeInTheDocument();
  });

  it('点击应用行打开详情，展示版本与安装时间', async () => {
    const { api } = setup();
    const user = userEvent.setup();
    render(<AppsPage api={api} device={READY_DEVICE} />);

    await user.click(await screen.findByRole('button', { name: /com\.example\.notes/ }));

    expect(await screen.findByText('应用详情')).toBeInTheDocument();
    expect(await screen.findByText(/2\.4\.1（20401）/)).toBeInTheDocument();
    expect(screen.getByText(/2024\/9\/10/)).toBeInTheDocument();
  });

  it('关键字可以过滤列表', async () => {
    const { api } = setup();
    const user = userEvent.setup();
    render(<AppsPage api={api} device={READY_DEVICE} />);

    await screen.findByText(/com\.android\.settings/);
    await user.type(screen.getByPlaceholderText('搜索包名或应用名'), 'notes');

    await waitFor(() => {
      expect(screen.queryByText(/com\.android\.settings/)).not.toBeInTheDocument();
    });
    expect(screen.getByText(/com\.example\.notes/)).toBeInTheDocument();
  });

  it('系统应用不可卸载：点击不会下发 app_uninstall', async () => {
    const { api, onInvoke } = setup();
    const user = userEvent.setup();
    render(<AppsPage api={api} device={READY_DEVICE} />);

    const row = (await screen.findByText(/com\.android\.settings/)).closest('tr');
    expect(row).not.toBeNull();
    await user.click(within(row as HTMLElement).getByText('卸载'));

    expect(onInvoke).not.toHaveBeenCalledWith(
      COMMANDS.appUninstall,
      expect.objectContaining({ packageName: 'com.android.settings' }),
    );
  });

  it('第三方应用卸载需要确认后才下发 app_uninstall', async () => {
    const { api, onInvoke } = setup();
    const user = userEvent.setup();
    render(<AppsPage api={api} device={READY_DEVICE} />);

    const row = (await screen.findByText(/com\.example\.notes/)).closest('tr');
    await user.click(within(row as HTMLElement).getByRole('button', { name: '卸载' }));

    // 确认弹层出现前不执行卸载
    expect(onInvoke).not.toHaveBeenCalledWith(
      COMMANDS.appUninstall,
      expect.objectContaining({ packageName: 'com.example.notes' }),
    );
    // 弹层挂在 body 末尾，同名按钮里最后一个是对话框的确认键
    const confirmButtons = await screen.findAllByRole('button', { name: '卸载' });
    await user.click(confirmButtons[confirmButtons.length - 1]!);

    await waitFor(() => {
      expect(onInvoke).toHaveBeenCalledWith(
        COMMANDS.appUninstall,
        expect.objectContaining({ packageName: 'com.example.notes' }),
      );
    });
  });

  it('清除数据同样需要确认', async () => {
    const { api, onInvoke } = setup();
    const user = userEvent.setup();
    render(<AppsPage api={api} device={READY_DEVICE} />);

    const row = (await screen.findByText(/com\.example\.notes/)).closest('tr');
    await user.click(within(row as HTMLElement).getByRole('button', { name: '清除数据' }));

    expect(onInvoke).not.toHaveBeenCalledWith(COMMANDS.appClearData, expect.anything());
    const confirmButtons = await screen.findAllByRole('button', { name: '清除数据' });
    await user.click(confirmButtons[confirmButtons.length - 1]!);

    await waitFor(() => {
      expect(onInvoke).toHaveBeenCalledWith(
        COMMANDS.appClearData,
        expect.objectContaining({ packageName: 'com.example.notes' }),
      );
    });
  });

  it('启动应用会调用 app_launch', async () => {
    const { api, onInvoke } = setup();
    const user = userEvent.setup();
    render(<AppsPage api={api} device={READY_DEVICE} />);

    const row = (await screen.findByText(/com\.example\.notes/)).closest('tr');
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

    const row = (await screen.findByText(/com\.example\.notes/)).closest('tr');
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

  it('多选后可以批量下载：目录递归、文件直传', async () => {
    const { api, onInvoke } = setup();
    const user = userEvent.setup();
    render(<FilesPage api={api} device={READY_DEVICE} />);

    const dirRow = (await screen.findByRole('button', { name: /📁 Download/ })).closest('tr')!;
    const fileRow = (await screen.findByRole('button', { name: /📄 note\.txt/ })).closest('tr')!;
    await user.click(within(dirRow).getByRole('checkbox'));
    await user.click(within(fileRow).getByRole('checkbox'));

    await user.click(screen.getByRole('button', { name: /下载所选（2）/ }));

    await waitFor(() => {
      expect(onInvoke).toHaveBeenCalledWith(COMMANDS.filePullDir, {
        serial: 'd4535f72',
        remotePath: '/sdcard/Download',
        destDir: '/tmp/out',
      });
      expect(onInvoke).toHaveBeenCalledWith(COMMANDS.filePull, {
        serial: 'd4535f72',
        remotePath: '/sdcard/note.txt',
        localPath: '/tmp/out/note.txt',
      });
    });
  });

  it('删除前必须确认，确认后才下发 file_delete', async () => {
    const { api, onInvoke } = setup();
    const user = userEvent.setup();
    render(<FilesPage api={api} device={READY_DEVICE} />);

    const fileRow = (await screen.findByText(/note\.txt/)).closest('tr')!;
    await user.click(within(fileRow).getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: /删除所选（1）/ }));

    expect(onInvoke).not.toHaveBeenCalledWith(COMMANDS.fileDelete, expect.anything());

    // 弹层挂在 body 末尾，同名按钮里最后一个是确认键
    const confirmButtons = await screen.findAllByRole('button', { name: '删除' });
    await user.click(confirmButtons[confirmButtons.length - 1]!);

    await waitFor(() => {
      expect(onInvoke).toHaveBeenCalledWith(COMMANDS.fileDelete, {
        serial: 'd4535f72',
        path: '/sdcard/note.txt',
      });
    });
  });

  it('可以直接编辑路径跳转', async () => {
    const { api, onInvoke } = setup();
    const user = userEvent.setup();
    render(<FilesPage api={api} device={READY_DEVICE} />);

    await screen.findByText(/note\.txt/);
    await user.click(screen.getByRole('button', { name: '编辑路径' }));

    const input = screen.getByDisplayValue('/sdcard');
    await user.clear(input);
    await user.type(input, '/sdcard/DCIM{Enter}');

    await waitFor(() => {
      expect(onInvoke).toHaveBeenCalledWith(COMMANDS.fileList, {
        serial: 'd4535f72',
        path: '/sdcard/DCIM',
      });
    });
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

  it('连接设备在对话框里完成并记住地址', async () => {
    window.localStorage.clear();
    const user = userEvent.setup();
    const { onInvoke } = renderPage({ device_list: [READY_DEVICE] });

    await user.click(await screen.findByRole('button', { name: '连接设备' }));
    await user.type(await screen.findByPlaceholderText('192.168.1.10:5555'), '192.168.1.50:5555');
    const connectButtons = await screen.findAllByRole('button', { name: '连接' });
    await user.click(connectButtons[connectButtons.length - 1]!);

    await waitFor(() => {
      expect(onInvoke).toHaveBeenCalledWith(COMMANDS.deviceConnectWireless, {
        address: '192.168.1.50:5555',
      });
    });
    await waitFor(() => {
      expect(JSON.parse(window.localStorage.getItem('ac.recentAddresses') ?? '[]')).toContain(
        '192.168.1.50:5555',
      );
    });
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

  it('全选与取消全选只作用于当前可见的就绪设备', async () => {
    const user = userEvent.setup();
    renderPage({ device_list: [READY_DEVICE, second] });

    await user.click(await screen.findByRole('button', { name: '全选' }));
    expect(await screen.findByText('已选 2 台')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '取消全选' }));
    expect(await screen.findByText('已选 0 台')).toBeInTheDocument();
  });

  it('设备可以自定义名称并持久化展示', async () => {
    window.localStorage.clear();
    const user = userEvent.setup();
    renderPage({ device_list: [READY_DEVICE] });

    const card = (await screen.findAllByTestId('device-card'))[0]!;
    await user.click(within(card).getByRole('button', { name: '更多' }));
    await user.click(await screen.findByText('重命名设备'));

    await user.type(screen.getByPlaceholderText('MIX 2S'), '我的测试机');
    await user.click(screen.getByRole('button', { name: '保存' }));

    expect(await screen.findByText('我的测试机')).toBeInTheDocument();
    expect(JSON.parse(window.localStorage.getItem('ac.devicePrefs') ?? '{}')).toMatchObject({
      aliases: { d4535f72: '我的测试机' },
    });
  });

  it('置顶设备会移到列表最前', async () => {
    window.localStorage.clear();
    const user = userEvent.setup();
    renderPage({ device_list: [READY_DEVICE, second] });

    const cards = await screen.findAllByTestId('device-card');
    await user.click(within(cards[1]!).getByRole('button', { name: '更多' }));
    await user.click(await screen.findByText('置顶'));

    const after = await screen.findAllByTestId('device-card');
    expect(within(after[0]!).getByText('emulator-5554')).toBeInTheDocument();
    expect(JSON.parse(window.localStorage.getItem('ac.devicePrefs') ?? '{}')).toMatchObject({
      pinned: ['emulator-5554'],
    });
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

  it('快捷命令会填入输入框并记录到历史', async () => {
    window.localStorage.clear();
    const { api, onInvoke } = setup();
    const user = userEvent.setup();
    render(<DeviceMoreMenu api={api} device={READY_DEVICE} />);

    await user.click(screen.getByLabelText('更多'));
    await user.click(await screen.findByText('命令行'));
    await user.click(await screen.findByRole('button', { name: '电池' }));

    const input = await screen.findByPlaceholderText('例如：dumpsys battery');
    expect(input).toHaveValue('dumpsys battery');

    await user.click(screen.getByRole('button', { name: '执行' }));
    await waitFor(() => {
      expect(onInvoke).toHaveBeenCalledWith(COMMANDS.shellExec, {
        serial: 'd4535f72',
        command: 'dumpsys battery',
      });
    });
    expect(JSON.parse(window.localStorage.getItem('ac.shellHistory') ?? '[]')).toEqual([
      'dumpsys battery',
    ]);
  });

  // 无线调试不是「读出地址让用户自己连」：后端要 tcpip + connect，
  // 否则用户还得去别处执行 adb tcpip。
  it('无线调试调用后端切换并提示连接地址', async () => {
    const { api, onInvoke } = setup();
    const user = userEvent.setup();
    render(<DeviceMoreMenu api={api} device={READY_DEVICE} />);

    await user.click(screen.getByLabelText('更多'));
    await user.click(await screen.findByText('无线调试'));

    await waitFor(() => {
      expect(onInvoke).toHaveBeenCalledWith(COMMANDS.deviceWifiEnable, {
        serial: 'd4535f72',
      });
    });
    expect(await screen.findByText(/192\.168\.1\.158:5555/)).toBeInTheDocument();
  });

  it('无线设备可以从菜单切回 USB 模式', async () => {
    const { api, onInvoke } = setup();
    const user = userEvent.setup();
    render(<DeviceMoreMenu api={api} device={{ ...READY_DEVICE, transport: 'wifi' }} />);

    await user.click(screen.getByLabelText('更多'));
    await user.click(await screen.findByText('关闭无线端口'));

    await waitFor(() => {
      expect(onInvoke).toHaveBeenCalledWith(COMMANDS.deviceWifiDisable, {
        serial: 'd4535f72',
      });
    });
    expect(await screen.findByText('已切回 USB 模式并断开无线连接')).toBeInTheDocument();
  });

  it('截屏落盘后把路径反馈给用户', async () => {
    const { api, onInvoke } = setup();
    const user = userEvent.setup();
    render(<DeviceMoreMenu api={api} device={READY_DEVICE} />);

    await user.click(screen.getByLabelText('更多'));
    await user.click(await screen.findByText('截屏'));

    await waitFor(() => {
      const call = onInvoke.mock.calls.find(([command]) => command === COMMANDS.deviceScreenshot);
      expect(call).toBeDefined();
      const payload = call?.[1] as { serial: string; suggestedName: string };
      expect(payload.serial).toBe('d4535f72');
      expect(payload.suggestedName).toMatch(/^截屏_\d{8}_\d{6}$/);
    });
    expect(await screen.findByText(/screenshot\.png/)).toBeInTheDocument();
  });

  it('恢复分辨率展示后端实际恢复的内容', async () => {
    const { api, onInvoke } = setup({
      device_reset_display: {
        overridden: true,
        before: {
          physicalSize: '1080x2160',
          physicalDensity: '440',
          overrideSize: '720x1440',
          overrideDensity: '320',
        },
        message: '已恢复屏幕：720x1440 → 1080x2160；密度 320 → 440',
      },
    });
    const user = userEvent.setup();
    render(<DeviceMoreMenu api={api} device={READY_DEVICE} />);

    await user.click(screen.getByLabelText('更多'));
    await user.click(await screen.findByText('恢复分辨率'));

    await waitFor(() => {
      expect(onInvoke).toHaveBeenCalledWith(COMMANDS.deviceResetDisplay, {
        serial: 'd4535f72',
      });
    });
    expect(await screen.findByText(/密度 320 → 440/)).toBeInTheDocument();
  });

  it('录屏先开始、再停止并展示保存路径', async () => {
    const { api, onInvoke } = setup();
    const user = userEvent.setup();
    render(<DeviceMoreMenu api={api} device={READY_DEVICE} />);

    await user.click(screen.getByLabelText('更多'));
    await user.click(await screen.findByText('录屏'));
    await user.click(await screen.findByRole('button', { name: '开始录制' }));

    await waitFor(() => {
      expect(onInvoke).toHaveBeenCalledWith(COMMANDS.deviceRecordStart, {
        serial: 'd4535f72',
      });
    });
    expect(await screen.findByTestId('record-clock')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '停止并保存' }));

    await waitFor(() => {
      const call = onInvoke.mock.calls.find(([command]) => command === COMMANDS.deviceRecordStop);
      expect(call).toBeDefined();
      const payload = call?.[1] as { serial: string; suggestedName: string };
      expect(payload.serial).toBe('d4535f72');
      expect(payload.suggestedName).toMatch(/^录屏_\d{8}_\d{6}$/);
    });
    expect(await screen.findByText(/recording\.mp4/)).toBeInTheDocument();
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

  it('竖排栏的截屏按钮直接保存到下载目录', async () => {
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

    await user.click(screen.getByRole('button', { name: '截屏' }));

    await waitFor(() => {
      expect(onInvoke).toHaveBeenCalledWith(
        COMMANDS.deviceScreenshot,
        expect.objectContaining({ serial: 'd4535f72' }),
      );
    });
    expect(await screen.findByText(/screenshot\.png/)).toBeInTheDocument();
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

  it('投屏中按键先按下再抬起（返回 / 主页 / 多任务只在抬起时生效）', async () => {
    const { api, onInvoke } = setup();
    const user = userEvent.setup();
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

    await user.click(screen.getByLabelText('返回键'));

    await waitFor(() => {
      const keys = onInvoke.mock.calls
        .filter(([command]) => command === COMMANDS.sessionKey)
        .map(([, args]) => args as { keycode: number; pressed: boolean });
      expect(keys.map(({ keycode, pressed }) => ({ keycode, pressed }))).toEqual([
        { keycode: KEYCODE_BACK, pressed: true },
        { keycode: KEYCODE_BACK, pressed: false },
      ]);
    });
  });

  it('设备消失时给出提示而不是崩溃', () => {
    renderDetail({ device: null });

    expect(screen.getByText('设备未连接')).toBeInTheDocument();
    expect(screen.queryByTestId('mirror-stage')).not.toBeInTheDocument();
  });
});
describe('OverviewPage', () => {
  it('显示被覆盖的尺寸/density 并可一键恢复', async () => {
    const { api, onInvoke } = setup({
      device_display: {
        physicalSize: '1080x2160',
        physicalDensity: '440',
        overrideSize: '720x1440',
        overrideDensity: '320',
      },
      device_reset_display: {
        overridden: true,
        before: {
          physicalSize: '1080x2160',
          physicalDensity: '440',
          overrideSize: '720x1440',
          overrideDensity: '320',
        },
        message: '已恢复屏幕：720x1440 → 1080x2160；密度 320 → 440',
      },
    });
    const user = userEvent.setup();
    render(<OverviewPage api={api} device={READY_DEVICE} />);

    expect(await screen.findByText('720x1440')).toBeInTheDocument();
    expect(screen.getByText('已被覆盖')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '恢复默认' }));

    await waitFor(() => {
      expect(onInvoke).toHaveBeenCalledWith(COMMANDS.deviceResetDisplay, {
        serial: 'd4535f72',
      });
    });
    expect(await screen.findByText(/已恢复屏幕/)).toBeInTheDocument();
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

  it('画质预设会一次性更新分辨率、帧率与码率', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    renderSettings({ onMirrorOptionsChange: onChange });

    await user.click(screen.getByRole('button', { name: '流畅' }));

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ maxSize: 720, maxFps: 30, bitRate: 4 }),
    );
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
