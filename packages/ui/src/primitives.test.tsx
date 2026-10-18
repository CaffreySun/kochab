import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { StatusDot, resolveStatePresentation } from './StatusDot';
import { EmptyState } from './EmptyState';

describe('resolveStatePresentation', () => {
  it.each([
    ['device', 'success', '就绪'],
    ['connecting', 'warning', '连接中'],
    ['authorizing', 'warning', '待授权'],
    ['unauthorized', 'error', '未授权'],
    ['offline', 'error', '离线'],
    ['unknown', 'default', '未知'],
  ] as const)('%s → %s / %s', (state, color, label) => {
    expect(resolveStatePresentation(state)).toEqual({ color, label });
  });

  it('未知状态回退为 default 而不是抛错', () => {
    expect(resolveStatePresentation('brand-new-state')).toEqual({
      color: 'default',
      label: '未知',
    });
  });
});

describe('StatusDot', () => {
  it('默认不展示可见文案，但保留无障碍文案', () => {
    render(<StatusDot state="device" />);

    expect(screen.getByText('就绪')).toHaveClass('kochab-visually-hidden');
    expect(screen.getByTestId('device-status')).toHaveAttribute('data-state', 'device');
  });

  it('showLabel 时文案可见', () => {
    render(<StatusDot showLabel state="offline" />);

    expect(screen.getByText('离线')).not.toHaveClass('kochab-visually-hidden');
  });
});

describe('EmptyState', () => {
  it('渲染标题与描述', () => {
    render(<EmptyState description="请连接设备后重试" title="没有找到设备" />);

    expect(screen.getByText('没有找到设备')).toBeInTheDocument();
    expect(screen.getByText('请连接设备后重试')).toBeInTheDocument();
  });

  it('可选传入操作区', () => {
    render(<EmptyState action={<button type="button">刷新</button>} title="空" />);

    expect(screen.getByRole('button', { name: '刷新' })).toBeInTheDocument();
  });
});
