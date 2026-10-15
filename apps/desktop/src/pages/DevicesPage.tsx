import { Button, Input, Loading, Space, Tag } from 'tdesign-react';
import { DeviceCard, EmptyState } from '@ac/ui';
import type { DeviceInfo } from '@ac/ipc-contract';
import { useDevices } from '../features/devices/useDevices';
import type { Api } from '../ipc';
import { useState } from 'react';

export interface DevicesPageProps {
  api: Api | null;
  onOpenPage: (page: 'apps' | 'files' | 'mirror', serial: string) => void;
}

/** 设备页：列出设备、无线连接、进入各功能页。 */
export function DevicesPage({ api, onOpenPage }: DevicesPageProps) {
  const { devices, status, error, selectedSerial, select, refresh, transportKind } =
    useDevices(api);
  const [address, setAddress] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);

  const connect = async () => {
    if (!api || !address.trim()) return;
    setConnecting(true);
    setConnectError(null);
    try {
      await api.connectWireless(address.trim());
      setAddress('');
      await refresh();
    } catch (cause) {
      setConnectError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setConnecting(false);
    }
  };

  return (
    <div className="ac-page">
      <div className="ac-page__toolbar">
        <Space breakLine size="small">
          <span className="ac-app__count" data-testid="device-count">
            {status === 'loading' ? '正在读取设备列表…' : `共 ${devices.length} 台设备`}
          </span>
          <Button
            loading={status === 'loading'}
            size="small"
            variant="outline"
            onClick={() => void refresh()}
          >
            刷新
          </Button>
          {transportKind === 'mock' ? (
            <Tag theme="warning" variant="light-outline">
              浏览器预览模式 · 数据为演示数据
            </Tag>
          ) : null}
        </Space>
      </div>

      <div className="ac-page__toolbar">
        <Space size="small">
          <Input
            placeholder="192.168.1.10:5555"
            size="small"
            style={{ width: 220 }}
            value={address}
            onChange={(value) => setAddress(value)}
          />
          <Button loading={connecting} size="small" onClick={() => void connect()}>
            无线连接
          </Button>
        </Space>
      </div>

      {error ? (
        <div role="alert">
          <Tag theme="danger" variant="light-outline">
            {error}
          </Tag>
        </div>
      ) : null}
      {connectError ? (
        <div role="alert">
          <Tag theme="danger" variant="light-outline">
            {connectError}
          </Tag>
        </div>
      ) : null}

      {status === 'loading' ? <Loading loading size="small" text="正在读取设备列表…" /> : null}

      {status !== 'loading' && devices.length === 0 ? (
        <EmptyState
          action={
            <Button size="small" variant="outline" onClick={() => void refresh()}>
              重新扫描
            </Button>
          }
          description="请打开手机「开发者选项 → USB 调试」，连接后在本机确认授权。"
          title="没有检测到设备"
        />
      ) : null}

      {devices.length > 0 ? (
        <div className="ac-device-grid">
          {devices.map((device: DeviceInfo) => (
            <DeviceCard
              key={device.serial}
              device={device}
              isSelected={device.serial === selectedSerial}
              onOpenApps={(serial) => onOpenPage('apps', serial)}
              onOpenFiles={(serial) => onOpenPage('files', serial)}
              onOpenScreen={(serial) => onOpenPage('mirror', serial)}
              onSelect={select}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
