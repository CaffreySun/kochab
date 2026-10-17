import { useState } from 'react';
import { Button, Dialog, Dropdown, Input, MessagePlugin, Tag, Textarea } from 'tdesign-react';
import { MoreIcon } from 'tdesign-icons-react';
import type { DeviceInfo, ShellOutput } from '@ac/ipc-contract';
import type { Api } from '../../ipc';
import { toMessage } from '../../ipc';
import { fileStamp, RecordDialog } from './RecordDialog';
import { readShellHistory, rememberShellCommand } from './shellHistory';

/** 重启设备。 */
const REBOOT = 'reboot';

/** 常用命令：把最常查的几项做成按钮，省得每次敲。 */
const QUICK_COMMANDS = [
  { label: '电池', command: 'dumpsys battery' },
  { label: '分辨率', command: 'wm size' },
  { label: '密度', command: 'wm density' },
  { label: '前台窗口', command: 'dumpsys window | grep mCurrentFocus' },
  { label: 'Wi-Fi 地址', command: 'ip -4 addr show wlan0' },
  { label: '第三方应用', command: 'pm list packages -3' },
];

export interface DeviceMoreMenuProps {
  api: Api | null;
  device: DeviceInfo;
  /** 用户自定义名称 */
  alias?: string;
  /** 是否置顶 */
  pinned?: boolean;
  /** 无线调试开启/关闭后通知上层刷新设备列表 */
  onDeviceListStale?: () => void;
  /** 保存自定义名称；空串表示恢复默认 */
  onRename?: (name: string) => void;
  onTogglePin?: () => void;
}

/**
 * 设备卡片上「更多」按钮的菜单。
 *
 * 重启与命令行走通用的 `shell_exec`；截屏、录屏、无线调试、恢复分辨率
 * 都有独立命令——它们要么需要处理设备端进程，要么需要解析 `wm` 输出，
 * 不能靠一行 shell 文本糊过去。
 */
export function DeviceMoreMenu({
  api,
  device,
  alias,
  pinned = false,
  onDeviceListStale,
  onRename,
  onTogglePin,
}: DeviceMoreMenuProps) {
  const [shellOpen, setShellOpen] = useState(false);
  const [recordOpen, setRecordOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [draftName, setDraftName] = useState('');
  const [command, setCommand] = useState('');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<ShellOutput | null>(null);
  const [shellHistory, setShellHistory] = useState<string[]>(readShellHistory);

  const runShell = async (serial: string, cmd: string, label: string): Promise<boolean> => {
    if (!api || !cmd.trim()) return false;
    setRunning(true);
    try {
      const out = await api.shellExec(serial, cmd);
      if (out.exitCode !== 0) {
        void MessagePlugin.error(`${label}失败（退出码 ${out.exitCode}）`);
        return false;
      }
      void MessagePlugin.success(`${label}成功`);
      return true;
    } catch (cause) {
      void MessagePlugin.error(`${label}失败：${toMessage(cause)}`);
      return false;
    } finally {
      setRunning(false);
    }
  };

  /**
   * 命令行与上面的快捷动作不同：把输出留在弹层里。
   *
   * 只弹一条「执行成功」的 toast 等于把 stdout 丢掉，用户看不到任何命令结果，
   * 那这个功能就没有意义。
   */
  const runCommand = async () => {
    if (!api || !command.trim()) return;
    const trimmed = command.trim();
    setRunning(true);
    setResult(null);
    setShellHistory(rememberShellCommand(trimmed));
    try {
      setResult(await api.shellExec(device.serial, trimmed));
    } catch (cause) {
      void MessagePlugin.error(`执行失败：${toMessage(cause)}`);
    } finally {
      setRunning(false);
    }
  };

  /** 关掉命令行弹层：同时清掉上一次的输出，避免下次打开看到过期结果。 */
  const closeShell = () => {
    setShellOpen(false);
    setResult(null);
  };

  const options = [
    { content: '截屏', value: 'screenshot' },
    { content: '录屏', value: 'record' },
    {
      content: device.transport === 'wifi' ? '关闭无线端口' : '无线调试',
      value: 'wireless',
    },
    { content: '命令行', value: 'shell' },
    { content: alias ? `重命名设备（${alias}）` : '重命名设备', value: 'rename' },
    { content: pinned ? '取消置顶' : '置顶', value: 'pin' },
    { content: '恢复分辨率', value: 'reset-resolution' },
    { content: '重启设备', value: 'reboot' },
  ];

  const takeScreenshot = async () => {
    if (!api) return;
    setRunning(true);
    try {
      const saved = await api.screenshot(device.serial, `截屏_${fileStamp()}`);
      void MessagePlugin.success(`已保存到 ${saved.path}`);
    } catch (cause) {
      void MessagePlugin.error(`截屏失败：${toMessage(cause)}`);
    } finally {
      setRunning(false);
    }
  };

  const resetDisplay = async () => {
    if (!api) return;
    setRunning(true);
    try {
      const result = await api.resetDisplay(device.serial);
      if (result.overridden) {
        void MessagePlugin.success(result.message);
      } else {
        void MessagePlugin.info(result.message);
      }
    } catch (cause) {
      void MessagePlugin.error(`恢复分辨率失败：${toMessage(cause)}`);
    } finally {
      setRunning(false);
    }
  };

  const toggleWireless = async () => {
    if (!api) return;
    setRunning(true);
    try {
      if (device.transport === 'wifi') {
        const message = await api.disableWireless(device.serial);
        void MessagePlugin.success(message);
      } else {
        const result = await api.enableWireless(device.serial);
        void MessagePlugin.success(`无线调试已开启：${result.address}`);
      }
      onDeviceListStale?.();
    } catch (cause) {
      void MessagePlugin.error(
        `${device.transport === 'wifi' ? '关闭无线端口' : '开启无线调试'}失败：${toMessage(cause)}`,
      );
    } finally {
      setRunning(false);
    }
  };

  return (
    <>
      <Dropdown
        maxColumnWidth={160}
        options={options}
        placement="bottom-right"
        trigger="click"
        onClick={(option) => {
          // options 由本文件定义，value 一定是字符串；content 可能是 TNode，不能直接字符串化
          const picked = typeof option.value === 'string' ? option.value : '';
          switch (picked) {
            case 'screenshot':
              void takeScreenshot();
              break;
            case 'record':
              setRecordOpen(true);
              break;
            case 'reset-resolution':
              void resetDisplay();
              break;
            case 'reboot':
              void runShell(device.serial, REBOOT, '重启设备');
              break;
            case 'wireless':
              void toggleWireless();
              break;
            case 'shell':
              setShellOpen(true);
              break;
            case 'rename':
              setDraftName(alias ?? '');
              setRenameOpen(true);
              break;
            case 'pin':
              onTogglePin?.();
              void MessagePlugin.success(pinned ? '已取消置顶' : '已置顶');
              break;
            default:
              break;
          }
        }}
      >
        <button aria-label="更多" className="ac-device-card__rail-button" type="button">
          <MoreIcon size="18px" />
        </button>
      </Dropdown>

      {/* 用 Dialog 而不是 Popup：卡片祖先链上有 `overflow: hidden`，
          而 Popup 没有触发元素时无法定位（会被丢到窗口左上角）。
          Dialog 挂到 body 上居中显示，既不会被裁切也无需关心锚点。 */}
      {shellOpen ? (
        <Dialog
          visible
          attach="body"
          cancelBtn={null}
          confirmBtn={null}
          header={`命令行 · ${device.serial}`}
          onCancel={() => closeShell()}
          onClose={() => closeShell()}
        >
          <div className="ac-shell-popup">
            <div className="ac-shell-popup__quick">
              {QUICK_COMMANDS.map((item) => (
                <Button
                  key={item.label}
                  size="small"
                  variant="text"
                  onClick={() => setCommand(item.command)}
                >
                  {item.label}
                </Button>
              ))}
            </div>
            <Textarea
              autosize={{ minRows: 3, maxRows: 8 }}
              placeholder="例如：dumpsys battery"
              value={command}
              onChange={(value) => setCommand(value)}
            />
            <div className="ac-shell-popup__actions">
              <Button
                disabled={!command.trim()}
                loading={running}
                size="small"
                theme="primary"
                onClick={() => void runCommand()}
              >
                执行
              </Button>
              <Button size="small" variant="outline" onClick={() => closeShell()}>
                关闭
              </Button>
            </div>
            {shellHistory.length > 0 ? (
              <div className="ac-shell-popup__history">
                <span className="ac-shell-popup__history-label">最近</span>
                {shellHistory.slice(0, 6).map((item) => (
                  <Button
                    key={item}
                    size="small"
                    title={item}
                    variant="outline"
                    onClick={() => setCommand(item)}
                  >
                    {item}
                  </Button>
                ))}
              </div>
            ) : null}
            {result ? (
              <div className="ac-shell-popup__result">
                <div className="ac-shell-popup__result-head">
                  <span>输出</span>
                  <Tag
                    size="small"
                    theme={result.exitCode === 0 ? 'success' : 'danger'}
                    variant="light-outline"
                  >
                    退出码 {result.exitCode}
                  </Tag>
                </div>
                <pre className="ac-shell-popup__output" data-testid="shell-output">
                  {result.stdout.trim() || '（命令没有产生输出）'}
                </pre>
              </div>
            ) : null}
          </div>
        </Dialog>
      ) : null}

      <Dialog
        attach="body"
        cancelBtn="取消"
        confirmBtn="保存"
        header={`重命名设备 · ${device.serial}`}
        visible={renameOpen}
        onCancel={() => setRenameOpen(false)}
        onClose={() => setRenameOpen(false)}
        onConfirm={() => {
          onRename?.(draftName);
          setRenameOpen(false);
        }}
      >
        <div className="ac-rename">
          <p className="ac-rename__hint">只影响本机列表里的显示；留空则恢复序列号。</p>
          <Input
            autofocus
            clearable
            placeholder={device.model ?? device.serial}
            value={draftName}
            onChange={(value) => setDraftName(String(value))}
            onEnter={() => {
              onRename?.(draftName);
              setRenameOpen(false);
            }}
          />
        </div>
      </Dialog>

      <RecordDialog
        api={api}
        open={recordOpen}
        serial={device.serial}
        onClose={() => setRecordOpen(false)}
      />
    </>
  );
}
