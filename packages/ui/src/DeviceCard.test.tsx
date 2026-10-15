import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { DeviceInfo } from '@ac/ipc-contract';
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
  it('展示设备名称、序列号与系统版本', () => {
    renderCard();

    expect(screen.getByRole('article', { name: '设备 Xiaomi MIX 2S' })).toBeInTheDocument();
    expect(screen.getByText('d4535f72')).toBeInTheDocument();
    expect(screen.getByText('Android 13')).toBeInTheDocument();
    expect(screen.getByText('1080x2400')).toBeInTheDocument();
  });

  it('缺失信息时回退为「未知」而不是空白', () => {
    renderCard({ device: { ...offlineDevice, androidVersion: null, screenResolution: null } });

    // Android 版本与分辨率两个字段都缺失
    expect(screen.getAllByText('未知')).toHaveLength(2);
    expect(screen.queryByText(/Android \d/)).not.toBeInTheDocument();
  });

  it('厂商与型号缺失时用序列号兜底作为标题', () => {
    renderCard({ device: { ...device, model: null, manufacturer: null } });

    expect(screen.getByRole('article', { name: '设备 d4535f72' })).toBeInTheDocument();
  });

  it('点击选中回调传出 serial', async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    renderCard({ onSelect });

    await user.click(screen.getByTestId('device-select'));

    expect(onSelect).toHaveBeenCalledExactlyOnceWith('d4535f72');
  });

  it('三个快捷动作分别回调对应能力', async () => {
    const onOpenScreen = vi.fn();
    const onOpenFiles = vi.fn();
    const onOpenApps = vi.fn();
    const user = userEvent.setup();
    renderCard({ onOpenApps, onOpenFiles, onOpenScreen });

    await user.click(screen.getByRole('button', { name: '投屏' }));
    await user.click(screen.getByRole('button', { name: '应用' }));
    await user.click(screen.getByRole('button', { name: '文件' }));

    expect(onOpenScreen).toHaveBeenCalledExactlyOnceWith('d4535f72');
    expect(onOpenApps).toHaveBeenCalledExactlyOnceWith('d4535f72');
    expect(onOpenFiles).toHaveBeenCalledExactlyOnceWith('d4535f72');
  });

  it('设备未就绪时禁用所有动作', () => {
    renderCard({ device: offlineDevice });

    for (const name of ['投屏', '应用', '文件']) {
      expect(screen.getByRole('button', { name })).toBeDisabled();
    }
  });

  it('选中态写入 ac-device-card--selected class', () => {
    renderCard({ isSelected: true });

    expect(screen.getByTestId('device-card')).toHaveClass('ac-device-card--selected');
  });

  it('传输方式标签可覆盖', () => {
    renderCard({ transportLabel: { usb: '数据线', wifi: 'Wi-Fi', emulator: '模拟' } });

    expect(screen.getByText('数据线')).toBeInTheDocument();
  });
});
