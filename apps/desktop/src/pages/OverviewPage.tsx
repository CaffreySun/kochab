import { useCallback, useEffect, useState } from 'react';
import { Button, Loading, Progress, Tag } from 'tdesign-react';
import { RefreshIcon } from 'tdesign-icons-react';
import type { BatteryStatus, DeviceInfo, DeviceOverview, StorageVolume } from '@ac/ipc-contract';
import type { Api } from '../ipc';
import { toMessage } from '../ipc';

export interface OverviewPageProps {
  api: Api | null;
  device: DeviceInfo | null;
}

type Status = 'idle' | 'loading' | 'ready' | 'error';

/** 设备概览：电量 / 存储 / 内存 / 网络 / 系统。 */
export function OverviewPage({ api, device }: OverviewPageProps) {
  const serial = device?.state === 'device' ? device.serial : null;
  const [overview, setOverview] = useState<DeviceOverview | null>(null);
  // 初值就是「加载中」：首帧直接是加载态，避免在 effect 里同步 setState
  const [status, setStatus] = useState<Status>('loading');
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!api || !serial) return;
    setStatus('loading');
    setError(null);
    try {
      setOverview(await api.deviceOverview(serial));
      setStatus('ready');
    } catch (cause) {
      setError(toMessage(cause, '读取设备概览失败'));
      setStatus('error');
    }
  }, [api, serial]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!serial) {
    return (
      <div className="ac-overview">
        <p className="ac-overview__empty">设备未连接，无法读取概览。</p>
      </div>
    );
  }

  return (
    <div className="ac-overview">
      <div className="ac-page__toolbar">
        <Button
          icon={<RefreshIcon />}
          loading={status === 'loading'}
          size="small"
          variant="outline"
          onClick={() => void refresh()}
        >
          刷新
        </Button>
        {error ? (
          <span role="alert">
            <Tag theme="danger" variant="light-outline">
              {error}
            </Tag>
          </span>
        ) : null}
      </div>

      {status === 'loading' && !overview ? (
        <Loading loading size="small" text="正在读取设备信息…" />
      ) : null}

      {overview ? (
        <div className="ac-overview__grid">
          <section className="ac-overview__card">
            <h3>电池</h3>
            {overview.battery ? (
              <>
                <div className="ac-overview__headline">
                  <span className="ac-overview__big">
                    {overview.battery.level === null ? '—' : `${overview.battery.level}%`}
                  </span>
                  <Tag size="small" variant="light-outline">
                    {batteryStatusLabel(overview.battery.status)}
                  </Tag>
                  {overview.battery.charging ? (
                    <Tag size="small" theme="success" variant="light-outline">
                      正在供电
                    </Tag>
                  ) : null}
                </div>
                {overview.battery.level === null ? null : (
                  <Progress percentage={overview.battery.level} size="small" theme="line" />
                )}
                <dl className="ac-overview__rows">
                  <Row label="温度" value={formatTemperature(overview.battery.temperatureC)} />
                  <Row label="电压" value={formatVoltage(overview.battery.voltageMv)} />
                  <Row label="电池" value={overview.battery.technology ?? '—'} />
                </dl>
              </>
            ) : (
              <p className="ac-overview__empty">读不到电池信息。</p>
            )}
          </section>

          <section className="ac-overview__card">
            <h3>存储</h3>
            {overview.storage ? (
              <>
                <VolumeRow label="内部存储" volume={overview.storage.data} />
                {overview.storage.external ? (
                  <VolumeRow label="共享存储" volume={overview.storage.external} />
                ) : null}
              </>
            ) : (
              <p className="ac-overview__empty">读不到存储信息。</p>
            )}
          </section>

          <section className="ac-overview__card">
            <h3>内存</h3>
            {overview.memory ? (
              <VolumeRow
                label="运行内存"
                volume={{
                  totalKb: overview.memory.totalKb,
                  usedKb: overview.memory.totalKb - overview.memory.availableKb,
                  availableKb: overview.memory.availableKb,
                }}
              />
            ) : (
              <p className="ac-overview__empty">读不到内存信息。</p>
            )}
          </section>

          <section className="ac-overview__card">
            <h3>网络</h3>
            <dl className="ac-overview__rows">
              <Row label="WLAN 地址" value={overview.network.wlanIpv4 ?? '未连接 Wi-Fi'} />
            </dl>
          </section>

          <section className="ac-overview__card">
            <h3>系统</h3>
            <dl className="ac-overview__rows">
              <Row
                label="Android"
                value={
                  overview.system.androidVersion
                    ? `${overview.system.androidVersion}${
                        overview.system.sdkInt === null ? '' : `（API ${overview.system.sdkInt}）`
                      }`
                    : '—'
                }
              />
              <Row label="CPU 架构" value={overview.system.abi ?? '—'} />
              <Row label="安全补丁" value={overview.system.securityPatch ?? '—'} />
              <Row label="已开机" value={formatUptime(overview.system.uptimeSeconds)} />
            </dl>
          </section>
        </div>
      ) : null}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="ac-overview__row">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function VolumeRow({ label, volume }: { label: string; volume: StorageVolume }) {
  const usedPct =
    volume.totalKb > 0 ? Math.min(100, Math.round((volume.usedKb / volume.totalKb) * 100)) : 0;
  return (
    <div className="ac-overview__volume">
      <div className="ac-overview__volume-head">
        <span>{label}</span>
        <span className="ac-overview__muted">
          {formatSize(volume.usedKb)} / {formatSize(volume.totalKb)}
        </span>
      </div>
      <Progress percentage={usedPct} size="small" theme="line" />
      <p className="ac-overview__muted">可用 {formatSize(volume.availableKb)}</p>
    </div>
  );
}

function batteryStatusLabel(status: BatteryStatus): string {
  switch (status) {
    case 'charging':
      return '充电中';
    case 'discharging':
      return '放电中';
    case 'not-charging':
      return '未充电';
    case 'full':
      return '已充满';
    default:
      return '未知';
  }
}

function formatTemperature(celsius: number | null): string {
  return celsius === null ? '—' : `${celsius.toFixed(1)} °C`;
}

function formatVoltage(mv: number | null): string {
  return mv === null ? '—' : `${(mv / 1000).toFixed(2)} V`;
}

/** KB → 人类可读；设备上报的就是 KB，不需要更高精度。 */
function formatSize(kb: number): string {
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(0)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

function formatUptime(seconds: number | null): string {
  if (seconds === null) return '—';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours === 0) return `${minutes} 分钟`;
  return `${hours} 小时 ${minutes} 分`;
}
