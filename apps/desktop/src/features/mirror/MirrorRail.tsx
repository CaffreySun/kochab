import { Button, Dropdown, Tooltip } from 'tdesign-react';
import {
  AddIcon,
  AppIcon,
  ArrowLeftIcon,
  DashboardIcon,
  FolderIcon,
  HomeIcon,
  KeyboardIcon,
  MinusIcon,
  MoreIcon,
  ScreenshotIcon,
  VideoCameraIcon,
  ViewModuleIcon,
} from 'tdesign-icons-react';
import { ANDROID_KEY, KEYCODE_BACK } from '@ac/scrcpy-web';
import type { SessionInfo, SessionStats } from '@ac/ipc-contract';
import type { DetailPanel } from '../../windowMode';
import { formatDuration } from '../recording/useRecording';
import type { MirrorStatus } from './useMirror';

export interface MirrorRailProps {
  status: MirrorStatus;
  /** 当前打开的面板；点已打开的那个按钮表示关闭 */
  panel: DetailPanel | null;
  onKey: (keycode: number) => void;
  onStop: () => void;
  onRestart: () => void;
  onOpenText: () => void;
  onTogglePanel: (panel: DetailPanel) => void;
  /** 截屏并保存；不传时不显示截图按钮 */
  onScreenshot?: () => void;
  /** 正在录屏 */
  recordingActive?: boolean;
  recordingElapsed?: number;
  /** 开始/停止录屏；不传时不显示录屏按钮 */
  onRecordToggle?: () => void;
  /** 会话信息与统计；只在「更多」菜单里展示，不覆盖画面 */
  sessionInfo?: SessionInfo | null;
  stats?: SessionStats | null;
}

/**
 * 投屏右侧的竖排按钮栏。
 *
 * 把原来铺在画面底部的按钮改成竖排：画面是竖屏的，右边这条窄栏几乎不占空间，
 * 而底部横排会实打实吃掉一条高度。应用 / 概览 / 文件也作为按钮放在这里——
 * 点了只是把窗口向右变宽，投屏本身不消失。
 */
export function MirrorRail({
  status,
  panel,
  onKey,
  onStop,
  onRestart,
  onOpenText,
  onTogglePanel,
  onScreenshot,
  recordingActive = false,
  recordingElapsed = 0,
  onRecordToggle,
  sessionInfo = null,
  stats = null,
}: MirrorRailProps) {
  const streaming = status === 'streaming';
  const key = (keycode: number) => () => onKey(keycode);

  const panels: Array<{ key: DetailPanel; label: string; icon: React.ReactElement }> = [
    { key: 'apps', label: '应用', icon: <AppIcon /> },
    { key: 'overview', label: '概览', icon: <DashboardIcon /> },
    { key: 'files', label: '文件', icon: <FolderIcon /> },
  ];

  return (
    <nav aria-label="投屏操作" className="ac-mirror-rail">
      <Tooltip content="返回" placement="left">
        <Button
          aria-label="返回键"
          disabled={!streaming}
          icon={<ArrowLeftIcon />}
          size="small"
          variant="outline"
          onClick={key(KEYCODE_BACK)}
        />
      </Tooltip>
      <Tooltip content="主页" placement="left">
        <Button
          aria-label="主页键"
          disabled={!streaming}
          icon={<HomeIcon />}
          size="small"
          variant="outline"
          onClick={key(ANDROID_KEY.KEYCODE_HOME)}
        />
      </Tooltip>
      <Tooltip content="多任务" placement="left">
        <Button
          aria-label="多任务键"
          disabled={!streaming}
          icon={<ViewModuleIcon />}
          size="small"
          variant="outline"
          onClick={key(ANDROID_KEY.KEYCODE_APP_SWITCH)}
        />
      </Tooltip>
      <Tooltip content="音量 −" placement="left">
        <Button
          aria-label="音量减"
          disabled={!streaming}
          icon={<MinusIcon />}
          size="small"
          variant="outline"
          onClick={key(ANDROID_KEY.KEYCODE_VOLUME_DOWN)}
        />
      </Tooltip>
      <Tooltip content="音量 +" placement="left">
        <Button
          aria-label="音量加"
          disabled={!streaming}
          icon={<AddIcon />}
          size="small"
          variant="outline"
          onClick={key(ANDROID_KEY.KEYCODE_VOLUME_UP)}
        />
      </Tooltip>
      <Tooltip content="注入文字" placement="left">
        <Button
          aria-label="注入文字"
          disabled={!streaming}
          icon={<KeyboardIcon />}
          size="small"
          variant="outline"
          onClick={onOpenText}
        />
      </Tooltip>
      {onScreenshot ? (
        <Tooltip content="截屏" placement="left">
          <Button
            aria-label="截屏"
            icon={<ScreenshotIcon />}
            size="small"
            variant="outline"
            onClick={onScreenshot}
          />
        </Tooltip>
      ) : null}
      {onRecordToggle ? (
        <Tooltip
          content={recordingActive ? `停止录屏（${formatDuration(recordingElapsed)}）` : '开始录屏'}
          placement="left"
        >
          <Button
            aria-label={recordingActive ? '停止录屏' : '开始录屏'}
            icon={<VideoCameraIcon />}
            size="small"
            theme={recordingActive ? 'danger' : 'default'}
            variant={recordingActive ? 'base' : 'outline'}
            onClick={onRecordToggle}
          />
        </Tooltip>
      ) : null}
      <Dropdown
        maxColumnWidth={140}
        options={[
          ...(sessionInfo
            ? [
                {
                  content: `分辨率 ${sessionInfo.width}×${sessionInfo.height}`,
                  value: 'size',
                  disabled: true,
                },
              ]
            : []),
          ...(stats
            ? [
                {
                  content: `帧率 ${stats.fps.toFixed(0)} fps`,
                  value: 'fps',
                  disabled: true,
                },
              ]
            : []),
          { content: '停止投屏', value: 'stop', disabled: !streaming },
          { content: '重新开始', value: 'restart', disabled: !streaming },
        ]}
        placement="left-top"
        trigger="click"
        onClick={(option) => {
          if (option.value === 'stop') onStop();
          if (option.value === 'restart') onRestart();
        }}
      >
        <Button aria-label="更多投屏操作" icon={<MoreIcon />} size="small" variant="outline" />
      </Dropdown>

      <div className="ac-mirror-rail__divider" role="presentation" />

      {panels.map((item) => (
        <Tooltip key={item.key} content={item.label} placement="left">
          <Button
            aria-label={item.label}
            icon={item.icon}
            size="small"
            theme={panel === item.key ? 'primary' : 'default'}
            variant={panel === item.key ? 'base' : 'outline'}
            onClick={() => onTogglePanel(item.key)}
          />
        </Tooltip>
      ))}
    </nav>
  );
}
