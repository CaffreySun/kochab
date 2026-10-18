import type { ReactNode } from 'react';
import { MobileIcon, OrderListIcon, SettingIcon } from 'tdesign-icons-react';
import { Tooltip } from 'tdesign-react';
import logoUrl from '../../../../assets/app-icon.svg';

/** 左侧栏可切换的顶层视图。 */
export type ShellView = 'devices' | 'tasks' | 'settings';

export interface AppShellProps {
  active: ShellView;
  onChange: (view: ShellView) => void;
  /** 右侧内容区标题，例如「设备」 */
  title: string;
  /** 标题右侧的操作区（刷新、连接设备等） */
  toolbar?: ReactNode;
  /** 进行中的任务数，在导航项上显示角标 */
  runningCount?: number;
  children: ReactNode;
}

const NAV: Array<{ key: ShellView; label: string; icon: ReactNode }> = [
  { key: 'devices', label: '设备', icon: <MobileIcon size="22px" /> },
  { key: 'tasks', label: '记录', icon: <OrderListIcon size="22px" /> },
  { key: 'settings', label: '设置', icon: <SettingIcon size="22px" /> },
];

/**
 * 应用外壳：左侧固定导航栏 + 右侧内容区。
 *
 * 导航栏只负责「切换内容区显示哪一块」，不承载业务状态；
 * 内容的选中态（哪台设备、哪个标签）由各页面自己管理。
 */
export function AppShell({
  active,
  onChange,
  title,
  toolbar,
  runningCount = 0,
  children,
}: AppShellProps) {
  return (
    <div className="kochab-shell">
      <aside className="kochab-shell__sidebar">
        <div className="kochab-shell__brand">
          <img alt="Kochab" className="kochab-shell__logo" src={logoUrl} />
        </div>

        <nav className="kochab-shell__nav">
          {NAV.map((item) => (
            <Tooltip key={item.key} content={item.label} placement="right">
              <button
                aria-current={active === item.key ? 'page' : undefined}
                className={[
                  'kochab-shell__nav-item',
                  active === item.key ? 'kochab-shell__nav-item--active' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                data-testid={`nav-${item.key}`}
                type="button"
                onClick={() => onChange(item.key)}
              >
                {item.icon}
                <span className="kochab-shell__nav-label">{item.label}</span>
                {item.key === 'tasks' && runningCount > 0 ? (
                  <span className="kochab-shell__nav-badge">{runningCount}</span>
                ) : null}
              </button>
            </Tooltip>
          ))}
        </nav>
      </aside>

      <main className="kochab-shell__content">
        <header className="kochab-shell__header">
          <h1 className="kochab-shell__title">{title}</h1>
          {toolbar ? <div className="kochab-shell__toolbar">{toolbar}</div> : null}
        </header>
        <div className="kochab-shell__body">{children}</div>
      </main>
    </div>
  );
}
