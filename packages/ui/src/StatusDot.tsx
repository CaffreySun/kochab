import type { DeviceConnectionState } from '@ac/ipc-contract';

export interface StatusDotProps {
  state: DeviceConnectionState;
  /** 是否展示状态文案（纯装饰场景可关闭） */
  showLabel?: boolean;
  className?: string;
}

/** 设备状态 → TDesign Tag 的语义色 */
const STATE_PRESENTATION: Record<
  DeviceConnectionState,
  { color: 'success' | 'warning' | 'error' | 'default'; label: string }
> = {
  device: { color: 'success', label: '就绪' },
  connecting: { color: 'warning', label: '连接中' },
  authorizing: { color: 'warning', label: '待授权' },
  unauthorized: { color: 'error', label: '未授权' },
  offline: { color: 'error', label: '离线' },
  unknown: { color: 'default', label: '未知' },
};

/** 归一化未知状态，避免新增设备状态时 UI 崩溃 */
export function resolveStatePresentation(state: string): {
  color: 'success' | 'warning' | 'error' | 'default';
  label: string;
} {
  return STATE_PRESENTATION[state as DeviceConnectionState] ?? STATE_PRESENTATION.unknown;
}

export function StatusDot({ state, showLabel = false, className }: StatusDotProps) {
  const { color: tagColor, label } = resolveStatePresentation(state);

  return (
    <span
      className={['ac-status-dot', `is-${tagColor}`, className].filter(Boolean).join(' ')}
      data-state={state}
      data-testid="device-status"
    >
      <span aria-hidden className="ac-status-dot__dot" />
      {/* 文案始终存在：不可见时供读屏器朗读，可见时直接展示，避免重复朗读 */}
      <span className={showLabel ? 'ac-status-dot__label' : 'ac-visually-hidden'}>{label}</span>
    </span>
  );
}
