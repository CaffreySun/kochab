import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Breadcrumb,
  Button,
  Dialog,
  Input,
  Loading,
  MessagePlugin,
  Select,
  Space,
  Table,
  Tag,
} from 'tdesign-react';
import { open } from '@tauri-apps/plugin-dialog';
import type { DeviceInfo, FileEntry } from '@kochab/ipc-contract';
import { EmptyState } from '@kochab/ui';
import type { Api } from '../ipc';
import { toMessage } from '../ipc';

export interface FilesPageProps {
  api: Api | null;
  device: DeviceInfo | null;
}

type Status = 'idle' | 'loading' | 'ready' | 'error';
type SortKey = 'name-asc' | 'name-desc' | 'time-desc' | 'time-asc' | 'size-desc' | 'size-asc';

const ROOT = '/sdcard';
const QUICK_PATHS = ['/sdcard', '/sdcard/Download', '/sdcard/DCIM', '/data/local/tmp'];

const SORT_OPTIONS: Array<{ label: string; value: SortKey }> = [
  { label: '名称 ↑', value: 'name-asc' },
  { label: '名称 ↓', value: 'name-desc' },
  { label: '时间 新→旧', value: 'time-desc' },
  { label: '时间 旧→新', value: 'time-asc' },
  { label: '大小 大→小', value: 'size-desc' },
  { label: '大小 小→大', value: 'size-asc' },
];

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}

/** 目录始终在前，组内按用户选择的字段排序。 */
function sortEntries(entries: FileEntry[], key: SortKey): FileEntry[] {
  const [field, order] = key.split('-') as ['name' | 'time' | 'size', 'asc' | 'desc'];
  const direction = order === 'asc' ? 1 : -1;
  return [...entries].sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    if (field === 'time') {
      return ((a.modifiedAt ?? 0) - (b.modifiedAt ?? 0)) * direction;
    }
    if (field === 'size') {
      return ((a.sizeBytes ?? 0) - (b.sizeBytes ?? 0)) * direction;
    }
    return a.name.localeCompare(b.name, 'zh-CN') * direction;
  });
}

/** 文件管理页：路径即状态，可前进后退；支持多选批量下载与删除。 */
export function FilesPage({ api, device }: FilesPageProps) {
  const serial = device?.state === 'device' ? device.serial : null;
  const [path, setPath] = useState(ROOT);
  const [history, setHistory] = useState<string[]>([ROOT]);
  const [entries, setEntries] = useState<FileEntry[]>([]);
  // 初值就是「加载中」：首次渲染直接显示加载态，避免在 effect 里同步 setState
  const [status, setStatus] = useState<Status>('loading');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [sortKey, setSortKey] = useState<SortKey>('name-asc');
  const [pathEditing, setPathEditing] = useState(false);
  const [draftPath, setDraftPath] = useState(ROOT);
  const [deleteTargets, setDeleteTargets] = useState<FileEntry[] | null>(null);

  const load = useCallback(
    async (target: string) => {
      if (!api || !serial) return;
      setStatus('loading');
      setError(null);
      try {
        const list = await api.listFiles(serial, target);
        setEntries(list);
        setSelectedKeys([]);
        setPath(target);
        setStatus('ready');
      } catch (cause) {
        setError(toMessage(cause, '读取目录失败'));
        setStatus('error');
      }
    },
    [api, serial],
  );

  // 设备切换由父组件用 `key` 强制重挂载，因此这里只负责首次加载。
  // `load` 内不做同步 setState，避免触发级联渲染。
  useEffect(() => {
    if (!serial) return;
    void load(ROOT);
  }, [serial, load]);

  const navigate = useCallback(
    (target: string) => {
      const normalized = target.trim() || '/';
      setHistory((prev) => [...prev, normalized]);
      void load(normalized);
    },
    [load],
  );

  const goBack = useCallback(() => {
    setHistory((prev) => {
      if (prev.length <= 1) return prev;
      const next = prev.slice(0, -1);
      const target = next[next.length - 1] ?? ROOT;
      void load(target);
      return next;
    });
  }, [load]);

  /** 当前路径的各级，供面包屑展示 */
  const crumbs = useMemo(() => {
    const parts = path.split('/').filter(Boolean);
    const items = [{ label: '/', path: '/' }];
    let acc = '';
    for (const part of parts) {
      acc += `/${part}`;
      items.push({ label: part, path: acc });
    }
    return items;
  }, [path]);

  const sorted = useMemo(() => sortEntries(entries, sortKey), [entries, sortKey]);
  const selected = useMemo(
    () => entries.filter((entry) => selectedKeys.includes(entry.path)),
    [entries, selectedKeys],
  );

  const withBusy = useCallback(async (label: string, action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(`${label}失败：${toMessage(cause)}`);
    } finally {
      setBusy(false);
    }
  }, []);

  const download = useCallback(
    async (targets: FileEntry[]) => {
      if (!api || !serial || targets.length === 0) return;
      const directory = await open({ directory: true, multiple: false });
      if (typeof directory !== 'string') return;

      await withBusy('下载', async () => {
        let total = 0;
        for (const entry of targets) {
          if (entry.isDirectory) {
            const result = await api.pullDir(serial, entry.path, directory);
            total += result.bytes;
          } else {
            const result = await api.pullFile(serial, entry.path, `${directory}/${entry.name}`);
            total += result.bytes;
          }
        }
        await MessagePlugin.success(
          `已下载 ${targets.length} 项（${formatBytes(total)}）到 ${directory}`,
        );
      });
    },
    [api, serial, withBusy],
  );

  const upload = useCallback(async () => {
    if (!api || !serial) return;
    const picked = await open({ multiple: true });
    if (picked === null) return;
    const paths = Array.isArray(picked) ? picked : [picked];
    if (paths.length === 0) return;

    await withBusy('上传', async () => {
      for (const source of paths) {
        const name = source.split(/[\\/]/).pop() ?? 'upload.bin';
        await api.pushFile(serial, source, `${path}/${name}`);
      }
      await MessagePlugin.success(`已上传 ${paths.length} 个文件`);
      await load(path);
    });
  }, [api, serial, path, withBusy, load]);

  const remove = useCallback(
    async (targets: FileEntry[]) => {
      if (!api || !serial || targets.length === 0) return;
      await withBusy('删除', async () => {
        for (const entry of targets) {
          await api.deletePath(serial, entry.path);
        }
        await MessagePlugin.success(`已删除 ${targets.length} 项`);
        await load(path);
      });
    },
    [api, serial, path, withBusy, load],
  );

  const createDir = useCallback(async () => {
    if (!api || !serial) return;
    const name = globalThis.prompt('新目录名称');
    if (!name) return;
    await withBusy('新建目录', async () => {
      await api.createDir(serial, `${path}/${name}`);
      await load(path);
    });
  }, [api, serial, path, withBusy, load]);

  const rename = useCallback(
    async (entry: FileEntry) => {
      if (!api || !serial) return;
      const name = globalThis.prompt('新名称', entry.name);
      if (!name || name === entry.name) return;
      await withBusy('重命名', async () => {
        await api.renamePath(serial, entry.path, `${path}/${name}`);
        await load(path);
      });
    },
    [api, serial, path, withBusy, load],
  );

  const commitPath = useCallback(() => {
    if (!pathEditing) return;
    setPathEditing(false);
    const target = draftPath.trim() || '/';
    if (target !== path) navigate(target);
  }, [draftPath, navigate, path, pathEditing]);

  const confirmDelete = useCallback(async () => {
    const targets = deleteTargets;
    setDeleteTargets(null);
    if (targets) await remove(targets);
  }, [deleteTargets, remove]);

  if (!device) {
    return (
      <EmptyState description="请先在「设备」页选择一台已授权的设备。" title="没有选中的设备" />
    );
  }
  if (device.state !== 'device' || !serial) {
    return <EmptyState description={`设备当前状态为 ${device.state}。`} title="设备未就绪" />;
  }

  return (
    <div className="kochab-page">
      <div className="kochab-page__toolbar">
        <Space breakLine size="small">
          <Button disabled={history.length <= 1} size="small" variant="outline" onClick={goBack}>
            返回上级
          </Button>
          {QUICK_PATHS.map((quick) => (
            <Button key={quick} size="small" variant="text" onClick={() => navigate(quick)}>
              {quick}
            </Button>
          ))}
          <Button loading={busy} size="small" variant="outline" onClick={() => void upload()}>
            上传
          </Button>
          <Button disabled={busy} size="small" variant="outline" onClick={() => void createDir()}>
            新建目录
          </Button>
          <Button
            disabled={busy || selected.length === 0}
            size="small"
            variant="outline"
            onClick={() => void download(selected)}
          >
            下载所选（{selected.length}）
          </Button>
          <Button
            disabled={busy || selected.length === 0}
            size="small"
            theme="danger"
            variant="outline"
            onClick={() => setDeleteTargets(selected)}
          >
            删除所选（{selected.length}）
          </Button>
          <Button disabled={busy} size="small" variant="outline" onClick={() => void load(path)}>
            刷新
          </Button>
          <Select
            options={SORT_OPTIONS}
            size="small"
            style={{ width: 132 }}
            value={sortKey}
            onChange={(value) => setSortKey(value as SortKey)}
          />
        </Space>
      </div>

      <div className="kochab-files__path">
        {pathEditing ? (
          <Space size="small">
            <Input
              autofocus
              size="small"
              style={{ width: 360 }}
              value={draftPath}
              onBlur={commitPath}
              onChange={(value) => setDraftPath(value)}
              onEnter={commitPath}
            />
            <Button size="small" theme="primary" onClick={commitPath}>
              转到
            </Button>
            <Button size="small" variant="text" onClick={() => setPathEditing(false)}>
              取消
            </Button>
          </Space>
        ) : (
          <>
            <Breadcrumb className="kochab-files__breadcrumb" maxItemWidth="160px">
              {crumbs.map((crumb, index) => (
                <Breadcrumb.BreadcrumbItem
                  key={crumb.path}
                  onClick={index === crumbs.length - 1 ? undefined : () => navigate(crumb.path)}
                >
                  {crumb.label}
                </Breadcrumb.BreadcrumbItem>
              ))}
            </Breadcrumb>
            <Button
              size="small"
              variant="text"
              onClick={() => {
                setDraftPath(path);
                setPathEditing(true);
              }}
            >
              编辑路径
            </Button>
          </>
        )}
      </div>

      {error ? (
        <div role="alert">
          <Tag theme="danger" variant="light-outline">
            {error}
          </Tag>
        </div>
      ) : null}

      {status === 'loading' ? <Loading loading size="small" text="正在读取目录…" /> : null}

      {status === 'ready' && entries.length === 0 ? (
        <EmptyState description="这个目录是空的，或当前权限无法读取。" title="没有内容" />
      ) : null}

      {entries.length > 0 ? (
        <div className="kochab-page__scroll">
          <Table
            columns={[
              { colKey: 'row-select', type: 'multiple', width: 48 },
              {
                colKey: 'name',
                title: '名称',
                cell: ({ row }: { row: FileEntry }) => (
                  <button
                    className="kochab-files__entry"
                    disabled={!row.isDirectory}
                    type="button"
                    onClick={() => (row.isDirectory ? navigate(row.path) : undefined)}
                  >
                    {row.isDirectory ? '📁' : '📄'} {row.name}
                  </button>
                ),
              },
              {
                colKey: 'sizeBytes',
                title: '大小',
                width: 100,
                cell: ({ row }: { row: FileEntry }) =>
                  row.isDirectory || row.sizeBytes === null ? '—' : formatBytes(row.sizeBytes),
              },
              {
                colKey: 'modifiedAt',
                title: '修改时间',
                width: 156,
                cell: ({ row }: { row: FileEntry }) =>
                  row.modifiedAt === null ? '—' : new Date(row.modifiedAt).toLocaleString(),
              },
              {
                colKey: 'actions',
                title: '操作',
                width: 190,
                cell: ({ row }: { row: FileEntry }) => (
                  <Space size="small">
                    <Button
                      disabled={busy}
                      size="small"
                      variant="text"
                      onClick={() => void download([row])}
                    >
                      下载
                    </Button>
                    <Button
                      disabled={busy}
                      size="small"
                      variant="text"
                      onClick={() => void rename(row)}
                    >
                      重命名
                    </Button>
                    <Button
                      disabled={busy}
                      size="small"
                      theme="danger"
                      variant="text"
                      onClick={() => setDeleteTargets([row])}
                    >
                      删除
                    </Button>
                  </Space>
                ),
              },
            ]}
            data={sorted}
            rowKey="path"
            selectedRowKeys={selectedKeys}
            size="small"
            onSelectChange={(keys) => setSelectedKeys(keys.map(String))}
          />
        </div>
      ) : null}

      <Dialog
        attach="body"
        cancelBtn="取消"
        confirmBtn="删除"
        header="删除确认"
        theme="warning"
        visible={deleteTargets !== null}
        onCancel={() => setDeleteTargets(null)}
        onClose={() => setDeleteTargets(null)}
        onConfirm={() => void confirmDelete()}
      >
        <p>
          将删除 {deleteTargets?.length ?? 0} 项：
          {deleteTargets
            ?.slice(0, 5)
            .map((entry) => entry.name)
            .join('、')}
          {(deleteTargets?.length ?? 0) > 5 ? ' 等' : ''}
          。目录会连同内容一起删除，无法恢复。
        </p>
      </Dialog>
    </div>
  );
}
