import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

export type TaskStatus = 'running' | 'done' | 'failed' | 'partial';

export interface TaskItem {
  serial: string;
  ok: boolean;
  detail?: string;
}

export interface Task {
  id: string;
  /** 任务标题，如「重启设备」 */
  label: string;
  status: TaskStatus;
  items: TaskItem[];
  /** 提交时的设备总数，用于显示 `3/8` 这样的进度 */
  total: number;
  startedAt: number;
  finishedAt?: number;
}

/** 历史保留条数，避免 localStorage 无限增长。 */
const HISTORY_LIMIT = 50;
const STORAGE_KEY = 'ac.tasks';

export function taskSummary(task: Task): string {
  if (task.status === 'running') return `进行中 ${task.items.length}/${task.items.length || '…'}`;
  const failed = task.items.filter((item) => !item.ok).length;
  if (task.items.length === 0) return '无设备';
  if (failed === 0) return `${task.items.length} 台全部成功`;
  if (failed === task.items.length) return `${failed} 台全部失败`;
  return `${task.items.length - failed} 台成功，${failed} 台失败`;
}

export interface TasksApi {
  tasks: Task[];
  /** 是否有正在跑的任务（批量按钮据此禁用） */
  busy: boolean;
  /**
   * 提交一个批量任务。
   *
   * 逐台串行执行：重启这类命令没有原子性，并发只会让失败原因更难定位。
   * `run` 返回值会作为「结果摘要」展示；抛错则记为该台失败。
   */
  submit: (
    label: string,
    serials: string[],
    run: (serial: string) => Promise<string | undefined>,
  ) => Promise<void>;
  clearFinished: () => void;
  dismiss: (id: string) => void;
}

const TasksContext = createContext<TasksApi | null>(null);

function readHistory(): Task[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Task[]).slice(0, HISTORY_LIMIT) : [];
  } catch {
    return [];
  }
}

/**
 * 批量任务队列。
 *
 * 重启一台设备动辄十几秒，界面不能只是「按钮转圈」：用户需要看到
 * 哪几台成功、哪几台失败。所以做成全局 store，让设备列表的工具栏、
 * 任务页看到的是同一份状态。
 */
export function TasksProvider({ children }: { children: ReactNode }) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [busy, setBusy] = useState(false);
  // 用 ref 串行化：busy 是异步的，靠它判断会漏掉连续两次点击。
  const runningRef = useRef(false);

  useEffect(() => {
    setTasks(readHistory());
  }, []);

  useEffect(() => {
    try {
      // 进行中的任务不落盘：刷新页面后它已经不存在了，留着会误导。
      window.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify(tasks.filter((task) => task.status !== 'running')),
      );
    } catch {
      // 存不下就算了，内存里的状态仍然可用
    }
  }, [tasks]);

  const submit = useCallback<TasksApi['submit']>(async (label, serials, run) => {
    if (serials.length === 0 || runningRef.current) return;
    runningRef.current = true;
    setBusy(true);

    const id = `task-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const total = serials.length;
    setTasks((prev) => [
      { id, label, status: 'running', items: [], total, startedAt: Date.now() },
      ...prev.slice(0, HISTORY_LIMIT - 1),
    ]);

    const items: TaskItem[] = [];
    for (const serial of serials) {
      try {
        const detail = await run(serial);
        items.push({ serial, ok: true, detail });
      } catch (cause) {
        items.push({
          serial,
          ok: false,
          detail: cause instanceof Error ? cause.message : String(cause),
        });
      }
      const snapshot = items.map((item) => ({ ...item }));
      setTasks((prev) =>
        prev.map((task) => (task.id === id ? { ...task, items: snapshot, total } : task)),
      );
    }

    const failed = items.filter((item) => !item.ok).length;
    const status: TaskStatus =
      failed === 0 ? 'done' : failed === items.length ? 'failed' : 'partial';
    setTasks((prev) =>
      prev.map((task) => (task.id === id ? { ...task, status, finishedAt: Date.now() } : task)),
    );
    runningRef.current = false;
    setBusy(false);
  }, []);

  const clearFinished = useCallback(() => {
    setTasks((prev) => prev.filter((task) => task.status === 'running'));
  }, []);

  const dismiss = useCallback((id: string) => {
    setTasks((prev) => prev.filter((task) => task.id !== id));
  }, []);

  const api = useMemo<TasksApi>(
    () => ({ tasks, busy, submit, clearFinished, dismiss }),
    [tasks, busy, submit, clearFinished, dismiss],
  );

  return <TasksContext.Provider value={api}>{children}</TasksContext.Provider>;
}

/** 必须在 `TasksProvider` 内使用；否则批量页与任务页会各持一份状态。 */
export function useTasks(): TasksApi {
  const api = useContext(TasksContext);
  if (!api) throw new Error('useTasks 必须在 <TasksProvider> 内使用');
  return api;
}
