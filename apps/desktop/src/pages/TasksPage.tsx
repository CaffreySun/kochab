import { Button, Progress, Space, Tag } from 'tdesign-react';
import { EmptyState } from '@kochab/ui';
import { useTasks, taskSummary, type Task } from '../features/tasks/TasksProvider';

const STATUS_TAG: Record<
  Task['status'],
  { theme: 'success' | 'danger' | 'warning' | 'primary'; label: string }
> = {
  running: { theme: 'primary', label: '进行中' },
  done: { theme: 'success', label: '成功' },
  partial: { theme: 'warning', label: '部分失败' },
  failed: { theme: 'danger', label: '失败' },
};

function formatTime(ms: number): string {
  const date = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/**
 * 任务页：批量操作的历史与进度。
 *
 * 批量重启这类动作动辄十几秒，必须留下「哪台成功、哪台失败」的痕迹，
 * 否则用户只能反复点刷新去猜。
 */
export function TasksPage() {
  const { tasks, clearFinished, dismiss } = useTasks();
  const finished = tasks.filter((task) => task.status !== 'running').length;

  return (
    <div className="kochab-tasks">
      <p className="kochab-tasks__intro">
        这里记录批量操作（重启、恢复分辨率）的逐台结果；单台设备的操作不会出现在这里。
        批量命令没有原子性，所以成功与失败都按设备分别保留。
      </p>
      <div className="kochab-tasks__toolbar">
        <Tag variant="light-outline">共 {tasks.length} 条</Tag>
        {finished > 0 ? (
          <Button size="small" variant="outline" onClick={clearFinished}>
            清除已完成（{finished}）
          </Button>
        ) : null}
      </div>

      {tasks.length === 0 ? (
        <EmptyState
          description="在设备列表中勾选多台设备后执行批量重启或恢复分辨率，结果会留在这里。"
          title="还没有批量记录"
        />
      ) : null}

      {tasks.map((task) => {
        const meta = STATUS_TAG[task.status];
        const percent = task.total === 0 ? 0 : Math.round((task.items.length / task.total) * 100);
        return (
          <section key={task.id} className="kochab-task">
            <header className="kochab-task__head">
              <Space size="small">
                <strong>{task.label}</strong>
                <Tag size="small" theme={meta.theme} variant="light-outline">
                  {meta.label}
                </Tag>
                <span className="kochab-task__summary">{taskSummary(task)}</span>
              </Space>
              <Space size="small">
                <span className="kochab-task__time">{formatTime(task.startedAt)}</span>
                {task.status !== 'running' ? (
                  <Button size="small" variant="text" onClick={() => dismiss(task.id)}>
                    移除
                  </Button>
                ) : null}
              </Space>
            </header>

            {task.status === 'running' ? (
              <Progress
                label={[`${task.items.length}/${task.total}`]}
                percentage={percent}
                theme="line"
              />
            ) : null}

            {task.items.length > 0 ? (
              <ul className="kochab-task__items">
                {task.items.map((item) => (
                  <li
                    key={item.serial}
                    className={
                      item.ok ? 'kochab-task__item' : 'kochab-task__item kochab-task__item--bad'
                    }
                  >
                    <span className="kochab-task__serial">{item.serial}</span>
                    <span className="kochab-task__detail">
                      {item.detail ?? (item.ok ? '成功' : '失败')}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}
