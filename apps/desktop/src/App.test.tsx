import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from './App';
import { createApi } from './ipc';
import { createMockTransport } from './ipc/mock';

/**
 * 渲染 App 并等待首屏数据加载完成。
 * 用 `waitFor` 而不是手动 sleep，确保状态更新发生在 act 包裹内。
 */
async function renderApp(overrides: Parameters<typeof createMockTransport>[0] = {}) {
  const user = userEvent.setup();
  const api = createApi(createMockTransport(overrides));
  render(<App api={api} />);
  await waitFor(() => {
    expect(screen.getByTestId('device-count')).toHaveTextContent(/共 \d+ 台设备/);
  });
  return user;
}

describe('App', () => {
  it('渲染设备列表', async () => {
    await renderApp();

    expect(await screen.findAllByTestId('device-card')).toHaveLength(2);
    expect(screen.getByText('共 2 台设备')).toBeInTheDocument();
  });

  it('展示设备详情', async () => {
    await renderApp();

    expect(await screen.findByRole('article', { name: '设备 Xiaomi MIX 2S' })).toBeInTheDocument();
    expect(screen.getByText('d4535f72')).toBeInTheDocument();
    expect(screen.getByText('Android 13')).toBeInTheDocument();
  });

  it('浏览器预览模式下给出明确提示', async () => {
    await renderApp();

    expect(screen.getByText(/浏览器预览模式/)).toBeInTheDocument();
  });

  it('点击设备卡片可选中，且默认选中第一台', async () => {
    const user = await renderApp();

    const cards = await screen.findAllByTestId('device-card');
    expect(cards[0]).toHaveClass('ac-device-card--selected');
    expect(cards[1]).not.toHaveClass('ac-device-card--selected');

    await user.click(within(cards[1]!).getByTestId('device-select'));

    expect(cards[1]).toHaveClass('ac-device-card--selected');
    expect(cards[0]).not.toHaveClass('ac-device-card--selected');
  });

  it('设备卡片的快捷动作会切换到对应页面', async () => {
    const user = await renderApp();
    const card = (await screen.findAllByTestId('device-card'))[0]!;

    await user.click(within(card).getByRole('button', { name: '投屏' }));

    // 投屏页出现建立会话的入口
    expect(await screen.findByRole('button', { name: '开始投屏' })).toBeInTheDocument();
  });

  it('无设备时展示空态与引导文案，而不是空白页', async () => {
    await renderApp({ device_list: [] });

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
    // 错误态下仍可手动重试
    expect(screen.getByRole('button', { name: '刷新' })).toBeEnabled();
  });
});
