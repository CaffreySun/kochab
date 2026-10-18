import { useCallback, useEffect, useState } from 'react';
import { Button, Loading, MessagePlugin, Progress, Tag } from 'tdesign-react';
import { RefreshIcon } from 'tdesign-icons-react';
import type {
  BatteryStatus,
  DeviceInfo,
  DeviceOverview,
  DisplayOverride,
  StorageVolume,
} from '@kochab/ipc-contract';
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
  const [display, setDisplay] = useState<DisplayOverride | null>(null);
  const [displayBusy, setDisplayBusy] = useState(false);
  // 初值就是「加载中」：首帧直接是加载态，避免在 effect 里同步 setState
  const [status, setStatus] = useState<Status>('loading');
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!api || !serial) return;
    setStatus('loading');
    setError(null);
    try {
      // 显示信息是可选增强：读不到也不该让整页失败
      const [nextOverview, nextDisplay] = await Promise.all([
        api.deviceOverview(serial),
        api.deviceDisplay(serial).catch(() => null),
      ]);
      setOverview(nextOverview);
      setDisplay(nextDisplay);
      setStatus('ready');
    } catch (cause) {
      setError(toMessage(cause, '读取设备概览失败'));
      setStatus('error');
    }
  }, [api, serial]);

  const resetDisplay = useCallback(async () => {
    if (!api || !serial) return;
    setDisplayBusy(true);
    try {
      const result = await api.resetDisplay(serial);
      if (result.overridden) {
        void MessagePlugin.success(result.message);
        await refresh();
      } else {
        void MessagePlugin.info(result.message);
      }
    } catch (cause) {
      void MessagePlugin.error(`恢复显示失败：${toMessage(cause)}`);
    } finally {
      setDisplayBusy(false);
    }
  }, [api, serial, refresh]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!serial) {
    return (
      <div className="kochab-overview">
        <p className="kochab-overview__empty">设备未连接，无法读取概览。</p>
      </div>
    );
  }

  return (
    <div className="kochab-overview">
      <div className="kochab-page__toolbar">
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
        <div className="kochab-overview__grid">
          <section className="kochab-overview__card">
            <h3>电池</h3>
            {overview.battery ? (
              <>
                <div className="kochab-overview__headline">
                  <span className="kochab-overview__big">
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
                <dl className="kochab-overview__rows">
                  <Row label="温度" value={formatTemperature(overview.battery.temperatureC)} />
                  <Row label="电压" value={formatVoltage(overview.battery.voltageMv)} />
                  <Row label="电池类型" value={overview.battery.technology ?? '—'} />
                </dl>
              </>
            ) : (
              <p className="kochab-overview__empty">读不到电池信息。</p>
            )}
          </section>

          <section className="kochab-overview__card">
            <h3>存储</h3>
            {overview.storage ? (
              <>
                <VolumeRow label="内部存储" volume={overview.storage.data} />
                {overview.storage.external ? (
                  <VolumeRow label="共享存储" volume={overview.storage.external} />
                ) : null}
              </>
            ) : (
              <p className="kochab-overview__empty">读不到存储信息。</p>
            )}
          </section>

          <section className="kochab-overview__card">
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
              <p className="kochab-overview__empty">读不到内存信息。</p>
            )}
          </section>

          <section className="kochab-overview__card">
            <h3>网络</h3>
            <dl className="kochab-overview__rows">
              <Row label="WLAN 地址" value={overview.network.wlanIpv4 ?? '未连接 Wi-Fi'} />
            </dl>
          </section>

          <section className="kochab-overview__card">
            <h3>显示</h3>
            {display ? (
              <>
                <dl className="kochab-overview__rows">
                  <Row label="分辨率" value={display.overrideSize ?? display.physicalSize ?? '—'} />
                  <Row
                    label="密度"
                    value={`${display.overrideDensity ?? display.physicalDensity ?? '—'} dpi`}
                  />
                </dl>
                <div className="kochab-overview__display-foot">
                  {display.overrideSize || display.overrideDensity ? (
                    <>
                      <Tag size="small" theme="warning" variant="light-outline">
                        已被覆盖
                      </Tag>
                      <Button
                        loading={displayBusy}
                        size="small"
                        theme="primary"
                        variant="outline"
                        onClick={() => void resetDisplay()}
                      >
                        恢复默认
                      </Button>
                    </>
                  ) : (
                    <span className="kochab-overview__muted">系统默认显示参数</span>
                  )}
                </div>
              </>
            ) : (
              <p className="kochab-overview__empty">读不到显示信息。</p>
            )}
          </section>

          <section className="kochab-overview__card">
            <h3>系统</h3>
            <dl className="kochab-overview__rows">
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
    <div className="kochab-overview__row">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function VolumeRow({ label, volume }: { label: string; volume: StorageVolume }) {
  const usedPct =
    volume.totalKb > 0 ? Math.min(100, Math.round((volume.usedKb / volume.totalKb) * 100)) : 0;
  return (
    <div className="kochab-overview__volume">
      <div className="kochab-overview__volume-head">
        <span>{label}</span>
        <span className="kochab-overview__muted">
          {formatSize(volume.usedKb)} / {formatSize(volume.totalKb)}
        </span>
      </div>
      <Progress percentage={usedPct} size="small" theme="line" />
      <p className="kochab-overview__muted">可用 {formatSize(volume.availableKb)}</p>
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
