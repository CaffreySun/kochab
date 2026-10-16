import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { createApi } from './ipc';
import { createMockTransport } from './ipc/mock';
import { openDeviceWindow } from './features/window/openDeviceWindow';

// 设备工作区是独立窗口，单测只断言「点了按钮开哪个窗口」。
vi.mock('./features/window/openDeviceWindow', () => ({
  openDeviceWindow: vi.fn().mockResolvedValue(undefined),
}));

/**
 * 渲染 App 并等待首屏数据加载完成。
 * 用 `waitFor` 而不是手动 sleep，确保状态更新发生在 act 包裹内。
 */
async function renderApp(overrides: Parameters<typeof createMockTransport>[0] = {}) {
  const user = userEvent.setup();
  const api = createApi(createMockTransport(overrides));
  render(<App api={api} />);
  await waitFor(() => {
    expect(screen.getAllByTestId('device-card').length).toBeGreaterThan(0);
  });
  return user;
}

describe('App 外壳', () => {
  it('渲染左侧导航与右侧设备列表', async () => {
    await renderApp();

    expect(screen.getByTestId('nav-devices')).toBeInTheDocument();
    expect(screen.getByTestId('nav-settings')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '设备' })).toBeInTheDocument();
    expect(screen.getAllByTestId('device-card')).toHaveLength(2);
  });

  it('设备卡片展示序列号与连接状态', async () => {
    await renderApp();

    expect(await screen.findByText('d4535f72')).toBeInTheDocument();
    expect(screen.getAllByText('已连接').length).toBeGreaterThan(0);
  });

  it('切换到设置页', async () => {
    const user = await renderApp();

    await user.click(screen.getByTestId('nav-settings'));

    expect(await screen.findByRole('heading', { name: '设置' })).toBeInTheDocument();
    expect(screen.getByText('设备列表预览')).toBeInTheDocument();
    expect(screen.getByText('工具链')).toBeInTheDocument();
  });

  it('主窗口只负责开窗口，不在内部切换设备工作区', async () => {
    const user = await renderApp();
    const card = (await screen.findAllByTestId('device-card'))[0]!;

    await user.click(within(card).getByRole('button', { name: '应用' }));

    // 点「应用」只开独立窗口，主窗口仍停在设备列表
    expect(openDeviceWindow).toHaveBeenCalledWith('d4535f72', 'apps');
    expect(screen.queryByText('com.android.settings')).not.toBeInTheDocument();
    expect(screen.getAllByTestId('device-card')).toHaveLength(2);
  });

  it('多台设备各自渲染一张卡片与一路预览', async () => {
    await renderApp();

    // 两台设备都在预览并发上限内
    await waitFor(() => {
      expect(screen.getAllByTestId('preview-canvas')).toHaveLength(2);
    });
  });

  it('无设备时展示空态与引导文案，而不是空白页', async () => {
    const api = createApi(createMockTransport({ device_list: [] }));
    render(<App api={api} />);

    expect(await screen.findByTestId('empty-state')).toBeInTheDocument();
    expect(screen.getByText('没有检测到设备')).toBeInTheDocument();
    expect(screen.getByText(/USB 调试/)).toBeInTheDocument();
    expect(screen.queryAllByTestId('device-card')).toHaveLength(0);
  });

  it('设备命令失败时展示错误而不是崩溃', async () => {
    const failing = createApi({
      kind: 'mock',
      invoke: () => Promise.reject(new Error('adb server 未在响应')),
      listen: () => Promise.resolve(() => {}),
    });
    render(<App api={failing} />);

    expect(await screen.findByRole('alert')).toHaveTextContent('adb server 未在响应');
    expect(screen.queryAllByTestId('device-card')).toHaveLength(0);
  });

  // 回归：updateMirrorOptions 一度被写成柯里化 `() => (next) => ...`，
  // 调用方按普通回调传参，于是设置页改什么都没落盘——跨窗口共享自然是坏的。
  it('在设置页改投屏参数会写进 localStorage', async () => {
    window.localStorage.clear();
    const user = await renderApp();

    await user.click(screen.getByTestId('nav-settings'));
    const maxSize = (await screen.findAllByRole('textbox'))[0]!;

    await user.clear(maxSize);
    await user.type(maxSize, '720');

    await waitFor(() => {
      const raw = window.localStorage.getItem('ac.mirrorOptions');
      expect(raw).not.toBeNull();
      expect(JSON.parse(raw!)).toMatchObject({ maxSize: 720 });
    });
  });
});
