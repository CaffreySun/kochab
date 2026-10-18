import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { DeviceInfo } from '@kochab/ipc-contract';
import { DeviceCard } from './DeviceCard';

const device: DeviceInfo = {
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

const offlineDevice: DeviceInfo = { ...device, state: 'unauthorized', androidVersion: null };

function renderCard(props: Partial<React.ComponentProps<typeof DeviceCard>> = {}) {
  return render(<DeviceCard device={device} {...props} />);
}

describe('DeviceCard', () => {
  it('展示序列号、连接状态与系统信息', () => {
    renderCard();

    expect(screen.getByRole('article', { name: '设备 Xiaomi MIX 2S' })).toBeInTheDocument();
    expect(screen.getByText('d4535f72')).toBeInTheDocument();
    expect(screen.getByText('已连接')).toBeInTheDocument();
    expect(screen.getByText(/Android 13/)).toBeInTheDocument();
    expect(screen.getByText(/1080x2400/)).toBeInTheDocument();
  });

  it('厂商与型号缺失时用序列号兜底作为标题', () => {
    renderCard({ device: { ...device, model: null, manufacturer: null } });

    expect(screen.getByRole('article', { name: '设备 d4535f72' })).toBeInTheDocument();
  });

  it('未授权设备显示「未授权」而不是「已连接」', () => {
    renderCard({ device: offlineDevice });

    expect(screen.getAllByText('未授权').length).toBeGreaterThan(0);
    expect(screen.queryByText('已连接')).not.toBeInTheDocument();
  });

  it('默认显示机型，序列号作为副标题', () => {
    renderCard();

    const identity = screen.getByTestId('device-select');
    expect(identity).toHaveTextContent('MIX 2S');
    expect(identity).toHaveTextContent('d4535f72');
  });

  it('自定义名称优先于序列号，序列号仍保留在 tooltip 里', () => {
    renderCard({ name: '测试机 A' });

    const identity = screen.getByTestId('device-select');
    expect(identity).toHaveTextContent('测试机 A');
    expect(identity).toHaveAttribute('title', 'd4535f72 · Xiaomi MIX 2S');
  });

  it('点序列号或缩略图都会打开详情', async () => {
    const onOpen = vi.fn();
    const user = userEvent.setup();
    renderCard({ onOpen });

    await user.click(screen.getByTestId('device-select'));
    await user.click(screen.getByTestId('device-preview'));

    expect(onOpen).toHaveBeenCalledTimes(2);
    expect(onOpen).toHaveBeenCalledWith('d4535f72');
  });

  it('分组是独立按钮，不会顺带打开详情', async () => {
    const onOpen = vi.fn();
    const onGroup = vi.fn();
    const user = userEvent.setup();
    renderCard({ onOpen, onGroup });

    await user.click(screen.getByTestId('device-group'));

    expect(onGroup).toHaveBeenCalledExactlyOnceWith('d4535f72');
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('四个操作分别回调对应的动作', async () => {
    const onAction = vi.fn();
    const user = userEvent.setup();
    renderCard({ onAction });

    await user.click(screen.getByRole('button', { name: '投屏' }));
    await user.click(screen.getByRole('button', { name: '应用' }));
    await user.click(screen.getByRole('button', { name: '文件' }));
    await user.click(screen.getByRole('button', { name: '更多' }));

    expect(onAction).toHaveBeenNthCalledWith(1, 'screen', 'd4535f72');
    expect(onAction).toHaveBeenNthCalledWith(2, 'apps', 'd4535f72');
    expect(onAction).toHaveBeenNthCalledWith(3, 'files', 'd4535f72');
    expect(onAction).toHaveBeenNthCalledWith(4, 'more', 'd4535f72');
  });

  it('设备未就绪时禁用所有动作', () => {
    renderCard({ device: offlineDevice });

    for (const name of ['投屏', '应用', '文件', '更多']) {
      expect(screen.getByRole('button', { name })).toBeDisabled();
    }
  });

  it('勾选变化回调传出 serial 与勾选状态', async () => {
    const onCheckedChange = vi.fn();
    const user = userEvent.setup();
    renderCard({ onCheckedChange });

    await user.click(screen.getByRole('checkbox'));

    expect(onCheckedChange).toHaveBeenCalledExactlyOnceWith('d4535f72', true);
  });

  it('渲染预览插槽的内容', () => {
    renderCard({ preview: <span data-testid="fake-preview" /> });

    expect(screen.getByTestId('fake-preview')).toBeInTheDocument();
  });

  it('没有分组时显示「未分组」', () => {
    renderCard();

    expect(screen.getByText('未分组')).toBeInTheDocument();
  });
});
