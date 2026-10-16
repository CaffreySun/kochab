import { useCallback, useMemo, useState } from 'react';
import { Button, Input, Select, Space, Tag } from 'tdesign-react';
import { LinkIcon, RefreshIcon, SearchIcon } from 'tdesign-icons-react';
import type { DeviceConnectionState, DeviceInfo } from '@ac/ipc-contract';
import { DeviceCard, EmptyState, type DeviceCardAction } from '@ac/ui';
import type { Api } from '../ipc';
import { DevicePreview } from '../features/preview/DevicePreview';
import { DeviceMoreMenu } from '../features/devices/DeviceMoreMenu';
import { BatchToolbar } from '../features/devices/BatchToolbar';
import type { DevicesState } from '../features/devices/useDevices';
import { openDeviceWindow } from '../features/window/openDeviceWindow';

/** 默认同时开启多少路缩略图预览。 */
export const DEFAULT_PREVIEW_LIMIT = 4;

export interface DevicesPageProps {
  api: Api | null;
  /** 设备数据由 App 统一订阅后传入，避免两处各维护一份列表 */
  devices: DevicesState;
  previewEnabled: boolean;
  previewLimit: number;
}

export type WorkspaceTab = 'mirror' | 'apps' | 'files';

type StateFilter = 'all' | DeviceConnectionState;

/** 设备列表页：工具栏 + 设备卡片网格（含实时缩略图与竖排操作栏）。 */
export function DevicesPage({
  api,
  devices: devicesState,
  previewEnabled,
  previewLimit,
}: DevicesPageProps) {
  const { devices, status, error, refresh } = devicesState;
  const [keyword, setKeyword] = useState('');
  const [stateFilter, setStateFilter] = useState<StateFilter>('all');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [address, setAddress] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);

  const visible = useMemo(() => {
    const needle = keyword.trim().toLowerCase();
    return devices.filter((device) => {
      if (stateFilter !== 'all' && device.state !== stateFilter) return false;
      if (!needle) return true;
      return (
        device.serial.toLowerCase().includes(needle) ||
        (device.model ?? '').toLowerCase().includes(needle) ||
        (device.manufacturer ?? '').toLowerCase().includes(needle)
      );
    });
  }, [devices, keyword, stateFilter]);

  /** 前 N 台就绪设备参与缩略图预览，避免设备一多就把主机压垮 */
  const previewSerials = useMemo(() => {
    const ready = visible.filter((device) => device.state === 'device');
    return new Set(ready.slice(0, previewLimit).map((device) => device.serial));
  }, [visible, previewLimit]);

  const selectedSerials = useMemo(() => [...selected].sort(), [selected]);

  const toggleSelected = useCallback((serial: string, checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(serial);
      else next.delete(serial);
      return next;
    });
  }, []);

  const handleAction = useCallback((action: DeviceCardAction, serial: string) => {
    // 设备工作区是独立窗口，不再在主窗口内切换路由
    switch (action) {
      case 'apps':
        void openDeviceWindow(serial, 'apps');
        break;
      case 'files':
        void openDeviceWindow(serial, 'files');
        break;
      default:
        void openDeviceWindow(serial, 'mirror');
        break;
    }
  }, []);

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
    <>
      <div className="ac-devices__toolbar">
        <Space breakLine size="small">
          <Select
            options={[
              { label: '全部状态', value: 'all' },
              { label: '已连接', value: 'device' },
              { label: '未授权', value: 'unauthorized' },
              { label: '已断开', value: 'offline' },
            ]}
            size="small"
            style={{ width: 120 }}
            value={stateFilter}
            onChange={(value) => setStateFilter(value as StateFilter)}
          />
          <Input
            clearable
            placeholder="搜索设备"
            prefixIcon={<SearchIcon />}
            size="small"
            style={{ width: 150 }}
            value={keyword}
            onChange={(value) => setKeyword(value)}
          />
          <Tag variant="light-outline">已选 {selected.size} 台</Tag>
          <Tag variant="light-outline">
            共 {visible.length} 台 · 预览 {previewSerials.size}/{previewLimit}
          </Tag>
        </Space>

        <Space size="small">
          <Input
            placeholder="192.168.1.10:5555"
            size="small"
            style={{ width: 150 }}
            value={address}
            onChange={(value) => setAddress(value)}
          />
          <Button
            icon={<LinkIcon />}
            loading={connecting}
            size="small"
            variant="outline"
            onClick={() => void connect()}
          >
            连接设备
          </Button>
          <Button
            icon={<RefreshIcon />}
            loading={status === 'loading'}
            size="small"
            variant="outline"
            onClick={() => void refresh()}
          >
            刷新
          </Button>
        </Space>
      </div>

      <BatchToolbar
        api={api}
        selected={selectedSerials}
        onClear={() => setSelected(new Set())}
        onMirrorWall={(serials) => {
          // 投屏墙 = 每台设备各开一个独立投屏窗口，不做单窗口多宫格
          for (const serial of serials) void openDeviceWindow(serial, 'mirror');
        }}
      />

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

      {status !== 'loading' && visible.length === 0 ? (
        <EmptyState
          action={
            <Button size="small" variant="outline" onClick={() => void refresh()}>
              重新扫描
            </Button>
          }
          description="请打开手机「开发者选项 → USB 调试」，连接后在本机确认授权。"
          title={devices.length === 0 ? '没有检测到设备' : '没有匹配的设备'}
        />
      ) : null}

      <div className="ac-device-grid">
        {visible.map((device: DeviceInfo) => (
          <DeviceCard
            key={device.serial}
            checked={selected.has(device.serial)}
            device={device}
            preview={
              <DevicePreview
                api={api}
                device={device}
                enabled={previewEnabled && previewSerials.has(device.serial)}
              />
            }
            railMore={<DeviceMoreMenu api={api} device={device} />}
            onAction={handleAction}
            onCheckedChange={toggleSelected}
          />
        ))}
      </div>
    </>
  );
}
