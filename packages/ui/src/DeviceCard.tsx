import type { DeviceInfo } from '@ac/ipc-contract';
import { Tag } from 'tdesign-react';
import { ActionButton } from './ActionButton';
import { StatusDot } from './StatusDot';

export interface DeviceCardProps {
  device: DeviceInfo;
  isSelected?: boolean;
  onSelect?: (serial: string) => void;
  onOpenApps?: (serial: string) => void;
  onOpenFiles?: (serial: string) => void;
  onOpenScreen?: (serial: string) => void;
  /** 传输方式的中文标签 */
  transportLabel?: Record<DeviceInfo['transport'], string>;
}

const DEFAULT_TRANSPORT_LABEL: Record<DeviceInfo['transport'], string> = {
  usb: 'USB',
  wifi: '无线',
  emulator: '模拟器',
};

/** 设备卡片：设备列表的主入口，承载「选中设备 + 三个快捷动作」 */
export function DeviceCard({
  device,
  isSelected = false,
  onSelect,
  onOpenApps,
  onOpenFiles,
  onOpenScreen,
  transportLabel = DEFAULT_TRANSPORT_LABEL,
}: DeviceCardProps) {
  const ready = device.state === 'device';
  const title = [device.manufacturer, device.model].filter(Boolean).join(' ') || device.serial;

  return (
    <article
      aria-label={`设备 ${title}`}
      className={[
        'ac-device-card',
        isSelected ? 'ac-device-card--selected' : '',
        ready ? '' : 'ac-device-card--offline',
      ]
        .filter(Boolean)
        .join(' ')}
      data-serial={device.serial}
      data-testid="device-card"
    >
      <header className="ac-device-card__header">
        <button
          className="ac-device-card__identity"
          data-testid="device-select"
          type="button"
          onClick={() => onSelect?.(device.serial)}
        >
          <StatusDot showLabel state={device.state} />
          <span className="ac-device-card__title">{title}</span>
        </button>
        <Tag size="small" theme="default" variant="light-outline">
          {transportLabel[device.transport] ?? device.transport}
        </Tag>
      </header>

      <dl className="ac-device-card__meta">
        <div>
          <dt>序列号</dt>
          <dd>{device.serial}</dd>
        </div>
        <div>
          <dt>Android</dt>
          <dd>{device.androidVersion ? `Android ${device.androidVersion}` : '未知'}</dd>
        </div>
        <div>
          <dt>分辨率</dt>
          <dd>{device.screenResolution ?? '未知'}</dd>
        </div>
      </dl>

      <footer className="ac-device-card__actions">
        <ActionButton
          disabled={!ready}
          size="small"
          variant="outline"
          onClick={() => onOpenScreen?.(device.serial)}
        >
          投屏
        </ActionButton>
        <ActionButton
          disabled={!ready}
          size="small"
          variant="outline"
          onClick={() => onOpenApps?.(device.serial)}
        >
          应用
        </ActionButton>
        <ActionButton
          disabled={!ready}
          size="small"
          variant="outline"
          onClick={() => onOpenFiles?.(device.serial)}
        >
          文件
        </ActionButton>
      </footer>
    </article>
  );
}
