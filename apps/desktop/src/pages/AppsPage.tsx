import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Button,
  Dialog,
  Input,
  Loading,
  MessagePlugin,
  Select,
  Space,
  Switch,
  Table,
  Tag,
} from 'tdesign-react';
import { open } from '@tauri-apps/plugin-dialog';
import type { AppInfo, DeviceInfo } from '@ac/ipc-contract';
import { EmptyState } from '@ac/ui';
import type { Api } from '../ipc';
import { toMessage } from '../ipc';

export interface AppsPageProps {
  api: Api | null;
  device: DeviceInfo | null;
}

type Status = 'idle' | 'loading' | 'ready' | 'error';
type SortKey = 'name' | 'updated' | 'size';

const SORT_OPTIONS: Array<{ label: string; value: SortKey }> = [
  { label: '名称', value: 'name' },
  { label: '最近更新', value: 'updated' },
  { label: '占用大小', value: 'size' },
];

function formatBytes(bytes: number | null): string {
  if (bytes === null || bytes <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function formatDate(ms: number | null): string {
  return ms === null ? '—' : new Date(ms).toLocaleString();
}

/** 首字母头像：没有图标来源时不引外部服务，用稳定的色相区分应用。 */
function avatarColor(name: string): string {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.codePointAt(0)!) % 360;
  return `hsl(${hash} 45% 48%)`;
}

/** 应用管理页：列出、搜索、启动/停止、安装/卸载/清除数据。 */
export function AppsPage({ api, device }: AppsPageProps) {
  const serial = device?.state === 'device' ? device.serial : null;
  const [apps, setApps] = useState<AppInfo[]>([]);
  // 初值就是「加载中」：首次渲染直接显示加载态，避免在 effect 里同步 setState
  const [status, setStatus] = useState<Status>('loading');
  const [error, setError] = useState<string | null>(null);
  const [keyword, setKeyword] = useState('');
  const [showSystem, setShowSystem] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [detail, setDetail] = useState<AppInfo | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [pending, setPending] = useState<{ kind: 'uninstall' | 'clear'; app: AppInfo } | null>(
    null,
  );

  const refresh = useCallback(async () => {
    if (!api || !serial) return;
    try {
      setApps(await api.listApps(serial, { showSystemApps: showSystem }));
      setStatus('ready');
    } catch (cause) {
      setError(toMessage(cause, '读取应用列表失败'));
      setStatus('error');
    }
  }, [api, serial, showSystem]);

  // 设备切换由父组件用 `key` 强制重挂载，因此这里只负责首次加载；
  // `refresh` 内部不做同步 setState，避免触发级联渲染。
  useEffect(() => {
    if (!serial) return;
    void refresh();
  }, [serial, refresh]);

  /** 用户主动刷新：先显示加载态，再重新拉取 */
  const reload = useCallback(async () => {
    setStatus('loading');
    await refresh();
  }, [refresh]);

  const run = useCallback(
    async (packageName: string, label: string, action: () => Promise<unknown>) => {
      setBusy(packageName);
      setError(null);
      try {
        await action();
      } catch (cause) {
        setError(`${label}失败：${toMessage(cause)}`);
      } finally {
        setBusy(null);
      }
    },
    [],
  );

  /** 卸载与清除数据都会丢数据，先确认再执行。 */
  const confirmPending = useCallback(async () => {
    const target = pending;
    setPending(null);
    if (!api || !serial || !target) return;
    const { app } = target;
    if (target.kind === 'uninstall') {
      await run(app.packageName, '卸载', async () => {
        await api.uninstallApp(serial, app.packageName);
        await refresh();
      });
    } else {
      await run(app.packageName, '清除数据', async () => {
        await api.clearAppData(serial, app.packageName);
      });
    }
  }, [api, serial, pending, run, refresh]);

  const installApk = useCallback(async () => {
    if (!api || !serial) return;
    const picked = await open({
      multiple: false,
      filters: [{ name: 'Android 安装包', extensions: ['apk'] }],
    });
    if (typeof picked !== 'string') return;
    await run(picked, '安装', async () => {
      const result = await api.installApk(serial, picked);
      if (!result.success) throw new Error(result.rawOutput);
      await refresh();
    });
  }, [api, serial, run, refresh]);

  /** 列表里的 AppInfo 已是完整行；仍再取一次详情，保证后续版本/权限字段最新。 */
  const openDetails = useCallback(
    async (row: AppInfo) => {
      setDetail(row);
      if (!api || !serial) return;
      setDetailLoading(true);
      try {
        setDetail(await api.appDetails(serial, row.packageName));
      } catch {
        // 详情失败时保留列表里的行数据，至少能看到基础信息
      } finally {
        setDetailLoading(false);
      }
    },
    [api, serial],
  );

  /**
   * 把应用导出到本机的「下载」目录。
   *
   * 一个包可能有多个安装文件（base + split，AAB 应用装到设备上就是这样），
   * 平铺还是建子目录由后端决定，这里不选目录。
   */
  const exportApp = useCallback(
    async (row: AppInfo) => {
      if (!api || !serial) return;

      const suggested = row.versionName
        ? `${row.label ?? row.packageName}_${row.versionName}`
        : undefined;

      await run(row.packageName, '导出', async () => {
        const result = await api.exportApp(serial, row.packageName, suggested);
        const one = result.files.length === 1 ? result.files[0] : undefined;
        await MessagePlugin.success(
          one
            ? `已导出到 ${one.localPath}`
            : `已导出 ${result.files.length} 个文件到 ${result.directory}`,
        );
      });
    },
    [api, serial, run],
  );

  const visible = useMemo(() => {
    const needle = keyword.trim().toLowerCase();
    const filtered = needle
      ? apps.filter(
          (app) =>
            app.packageName.toLowerCase().includes(needle) ||
            (app.label ?? '').toLowerCase().includes(needle),
        )
      : apps;
    return [...filtered].sort((a, b) => {
      if (sortKey === 'updated') {
        return (b.lastUpdateTime ?? 0) - (a.lastUpdateTime ?? 0);
      }
      if (sortKey === 'size') {
        return (b.apkSizeBytes ?? 0) - (a.apkSizeBytes ?? 0);
      }
      return (a.label ?? a.packageName).localeCompare(b.label ?? b.packageName, 'zh-CN');
    });
  }, [apps, keyword, sortKey]);

  if (!device) {
    return (
      <EmptyState description="请先在「设备」页选择一台已授权的设备。" title="没有选中的设备" />
    );
  }
  if (device.state !== 'device' || !serial) {
    return <EmptyState description={`设备当前状态为 ${device.state}。`} title="设备未就绪" />;
  }

  return (
    <div className="ac-page">
      <div className="ac-page__toolbar">
        <Space breakLine size="small">
          <Input
            clearable
            placeholder="搜索包名或应用名"
            size="small"
            style={{ width: 200 }}
            value={keyword}
            onChange={(value) => setKeyword(value)}
          />
          <span className="ac-page__inline-switch">
            <Switch size="small" value={showSystem} onChange={setShowSystem} />
            <span>显示系统应用</span>
          </span>
          <Button
            loading={status === 'loading'}
            size="small"
            variant="outline"
            onClick={() => void reload()}
          >
            刷新
          </Button>
          <Button size="small" theme="primary" onClick={() => void installApk()}>
            安装 APK
          </Button>
          <Select
            options={SORT_OPTIONS}
            size="small"
            style={{ width: 120 }}
            value={sortKey}
            onChange={(value) => setSortKey(value as SortKey)}
          />
          <Tag variant="light-outline">共 {visible.length} 个</Tag>
        </Space>
      </div>

      {error ? (
        <div role="alert">
          <Tag theme="danger" variant="light-outline">
            {error}
          </Tag>
        </div>
      ) : null}

      {status === 'loading' ? <Loading loading size="small" text="正在读取应用列表…" /> : null}

      {status === 'ready' && visible.length === 0 ? (
        <EmptyState description="换个关键字，或打开「显示系统应用」。" title="没有匹配的应用" />
      ) : null}

      {visible.length > 0 ? (
        <div className="ac-page__scroll">
          <Table
            columns={[
              {
                colKey: 'label',
                title: '应用',
                cell: ({ row }: { row: AppInfo }) => {
                  const primary = row.label ?? row.packageName;
                  const meta = [
                    row.label ? row.packageName : null,
                    row.versionName ? `v${row.versionName}` : null,
                    formatBytes(row.apkSizeBytes),
                  ]
                    .filter(Boolean)
                    .join(' · ');
                  return (
                    <button
                      className="ac-app-cell ac-app-cell--button"
                      title="查看应用详情"
                      type="button"
                      onClick={() => void openDetails(row)}
                    >
                      <span
                        aria-hidden="true"
                        className="ac-app-avatar"
                        style={{ background: avatarColor(primary) }}
                      >
                        {primary.slice(0, 1).toUpperCase()}
                      </span>
                      <span className="ac-app-cell__text">
                        <span className="ac-app-cell__name">
                          {primary}
                          <Tag
                            size="small"
                            theme={row.isSystem ? 'default' : 'primary'}
                            variant="light-outline"
                          >
                            {row.isSystem ? '系统' : '第三方'}
                          </Tag>
                        </span>
                        <span className="ac-app-cell__package">{meta}</span>
                      </span>
                    </button>
                  );
                },
              },
              {
                colKey: 'actions',
                title: '操作',
                width: 280,
                cell: ({ row }: { row: AppInfo }) => (
                  <Space size="small">
                    <Button
                      disabled={busy === row.packageName}
                      size="small"
                      variant="text"
                      onClick={() =>
                        void run(row.packageName, '启动', () =>
                          api!.launchApp(serial, row.packageName),
                        )
                      }
                    >
                      启动
                    </Button>
                    <Button
                      disabled={busy === row.packageName}
                      size="small"
                      variant="text"
                      onClick={() =>
                        void run(row.packageName, '停止', () =>
                          api!.stopApp(serial, row.packageName),
                        )
                      }
                    >
                      停止
                    </Button>
                    <Button
                      disabled={busy === row.packageName}
                      size="small"
                      variant="text"
                      onClick={() => setPending({ kind: 'clear', app: row })}
                    >
                      清除数据
                    </Button>
                    <Button
                      disabled={busy === row.packageName || row.isSystem}
                      size="small"
                      theme="danger"
                      variant="text"
                      onClick={() => setPending({ kind: 'uninstall', app: row })}
                    >
                      卸载
                    </Button>
                    <Button
                      disabled={busy === row.packageName}
                      size="small"
                      variant="text"
                      onClick={() => void exportApp(row)}
                    >
                      导出
                    </Button>
                  </Space>
                ),
              },
            ]}
            data={visible}
            rowKey="packageName"
            size="small"
          />
        </div>
      ) : null}

      <Dialog
        attach="body"
        cancelBtn="关闭"
        confirmBtn={null}
        header="应用详情"
        visible={detail !== null}
        width={520}
        onCancel={() => setDetail(null)}
        onClose={() => setDetail(null)}
      >
        {detailLoading ? <Loading loading size="small" text="正在读取详情…" /> : null}
        {detail ? (
          <div className="ac-app-detail">
            <div className="ac-app-detail__head">
              <span
                aria-hidden="true"
                className="ac-app-avatar ac-app-avatar--large"
                style={{ background: avatarColor(detail.label ?? detail.packageName) }}
              >
                {(detail.label ?? detail.packageName).slice(0, 1).toUpperCase()}
              </span>
              <div>
                <strong>{detail.label ?? detail.packageName}</strong>
                <div className="ac-app-detail__muted">{detail.packageName}</div>
              </div>
            </div>
            <dl className="ac-app-detail__rows">
              <DetailRow
                label="版本"
                value={`${detail.versionName ?? '—'}${
                  detail.versionCode === null ? '' : `（${detail.versionCode}）`
                }`}
              />
              <DetailRow label="大小" value={formatBytes(detail.apkSizeBytes)} />
              <DetailRow label="首次安装" value={formatDate(detail.firstInstallTime)} />
              <DetailRow label="最近更新" value={formatDate(detail.lastUpdateTime)} />
              <DetailRow
                label="已授权权限"
                value={detail.grantedPermissions === null ? '—' : `${detail.grantedPermissions} 项`}
              />
              <DetailRow label="类型" value={detail.isSystem ? '系统应用' : '第三方应用'} />
              <DetailRow label="状态" value={detail.enabled ? '已启用' : '已停用'} />
              <DetailRow mono label="APK 路径" value={detail.apkPath ?? '—'} />
            </dl>
          </div>
        ) : null}
      </Dialog>

      <Dialog
        attach="body"
        cancelBtn="取消"
        confirmBtn={pending?.kind === 'uninstall' ? '卸载' : '清除数据'}
        header={pending?.kind === 'uninstall' ? '卸载应用' : '清除应用数据'}
        theme="warning"
        visible={pending !== null}
        onCancel={() => setPending(null)}
        onClose={() => setPending(null)}
        onConfirm={() => void confirmPending()}
      >
        <p>
          {pending?.kind === 'uninstall'
            ? `将卸载「${pending.app.label ?? pending.app.packageName}」，应用数据会被一并删除。`
            : `将清除「${pending?.app.label ?? pending?.app.packageName ?? ''}」的全部数据，无法恢复。`}
        </p>
      </Dialog>
    </div>
  );
}

function DetailRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="ac-app-detail__row">
      <dt>{label}</dt>
      <dd className={mono ? 'ac-app-detail__mono' : undefined}>{value}</dd>
    </div>
  );
}
