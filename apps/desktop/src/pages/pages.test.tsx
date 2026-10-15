import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { COMMANDS, type DeviceInfo } from '@ac/ipc-contract';
import { createApi } from '../ipc';
import { createMockTransport } from '../ipc/mock';
import { AppsPage } from './AppsPage';
import { FilesPage } from './FilesPage';
import { MirrorPage } from './MirrorPage';

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

describe('MirrorPage', () => {
  it('开始投屏后进入投屏中状态', async () => {
    const { api } = setup();
    const user = userEvent.setup();
    render(<MirrorPage api={api} device={READY_DEVICE} />);

    await user.click(screen.getByRole('button', { name: '开始投屏' }));

    await waitFor(() => {
      expect(screen.getByTestId('mirror-status')).toHaveTextContent('投屏中');
    });
    // 会话协商出来的分辨率会展示出来
    expect(screen.getByText(/540×1080/)).toBeInTheDocument();
  });

  it('开始投屏会带设备序列号调用 session_start', async () => {
    const { api, onInvoke } = setup();
    const user = userEvent.setup();
    render(<MirrorPage api={api} device={READY_DEVICE} />);

    await user.click(screen.getByRole('button', { name: '开始投屏' }));

    await waitFor(() => {
      expect(onInvoke).toHaveBeenCalledWith(
        COMMANDS.sessionStart,
        expect.objectContaining({ serial: 'd4535f72' }),
      );
    });
  });

  it('控制按钮会下发按键，抬起与按下成对', async () => {
    const { api, onInvoke } = setup();
    const user = userEvent.setup();
    render(<MirrorPage api={api} device={READY_DEVICE} />);

    await user.click(screen.getByRole('button', { name: '开始投屏' }));
    await waitFor(() => expect(screen.getByTestId('mirror-status')).toHaveTextContent('投屏中'));

    await user.click(screen.getByRole('button', { name: '返回' }));

    await waitFor(() => {
      expect(onInvoke).toHaveBeenCalledWith(COMMANDS.sessionKey, {
        sessionId: expect.any(Number) as number,
        keycode: 4,
        pressed: true,
      });
    });
  });

  it('未选设备时展示空态', () => {
    const { api } = setup();
    render(<MirrorPage api={api} device={null} />);

    expect(screen.getByText('没有选中的设备')).toBeInTheDocument();
  });

  it('设备未就绪时给出明确原因', () => {
    const { api } = setup();
    render(<MirrorPage api={api} device={OFFLINE_DEVICE} />);

    expect(screen.getByText('设备未就绪')).toBeInTheDocument();
    expect(screen.getByText(/unauthorized/)).toBeInTheDocument();
  });
});
