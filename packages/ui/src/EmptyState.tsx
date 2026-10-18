import type { ReactElement, ReactNode } from 'react';
import { Empty } from 'tdesign-react';

export interface EmptyStateProps {
  title: ReactNode;
  description?: ReactNode;
  /** TDesign 的 action 槽位只接受单个元素 */
  action?: ReactElement;
  className?: string;
}

/** 统一的空态占位：设备为空、目录为空、搜索无结果都复用它 */
export function EmptyState({ title, description, action, className }: EmptyStateProps) {
  return (
    <div
      className={['kochab-empty-state', className].filter(Boolean).join(' ')}
      data-testid="empty-state"
    >
      <Empty action={action} description={description} title={title} />
    </div>
  );
}
