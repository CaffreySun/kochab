import { useState } from 'react';
import { Button, Dialog, Dropdown, MessagePlugin, Tag, Textarea } from 'tdesign-react';
import { MoreIcon } from 'tdesign-icons-react';
import type { DeviceInfo, ShellOutput } from '@ac/ipc-contract';
import type { Api } from '../../ipc';
import { toMessage } from '../../ipc';

/** 恢复被开发者选项改过的屏幕尺寸。 */
const RESET_RESOLUTION = 'wm size reset';
/** 重启设备。 */
const REBOOT = 'reboot';

/**
 * 从 `ip -4 addr show wlan0` 的输出里捞出 IPv4 地址。
 *
 * 不用 `ip -4 route show wlan0`：部分 Android 的 iproute2 不认这种省略 `dev` 的写法，
 * 会直接报 “inet prefix is expected rather than "wlan0"”，于是明明连着 Wi-Fi 也读不到地址。
 */
function parseWlanAddress(output: string): string | null {
  const match = output.match(/inet\s+(\d+\.\d+\.\d+\.\d+)/);
  return match?.[1] ?? null;
}

export interface DeviceMoreMenuProps {
  api: Api | null;
  device: DeviceInfo;
}

/**
 * 设备卡片上「更多」按钮的菜单。
 *
 * 里面的动作全部复用已有的 `shell_exec` / `connectWireless` 命令，
 * 不额外增加协议面——命令行是最通用的那个，剩下的只是常用命令的快捷方式。
 */
export function DeviceMoreMenu({ api, device }: DeviceMoreMenuProps) {
  const [shellOpen, setShellOpen] = useState(false);
  const [command, setCommand] = useState('');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<ShellOutput | null>(null);

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
    setRunning(true);
    setResult(null);
    try {
      setResult(await api.shellExec(device.serial, command.trim()));
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

  /** 读出手机 Wi-Fi 地址：只能如实报告，连接要用户自己在工具栏确认。 */
  const readWirelessAddress = async () => {
    if (!api) return;
    setRunning(true);
    try {
      const out = await api.shellExec(device.serial, 'ip -4 addr show wlan0');
      const address = out.exitCode === 0 ? parseWlanAddress(out.stdout) : null;
      if (address) {
        void MessagePlugin.info(`请在顶部「连接设备」里填入 ${address}:5555 并连接`);
      } else {
        void MessagePlugin.warning('读不到 Wi-Fi 地址：请确认手机已连上 Wi-Fi');
      }
    } catch (cause) {
      void MessagePlugin.error(`读取 Wi-Fi 地址失败：${toMessage(cause)}`);
    } finally {
      setRunning(false);
    }
  };

  const options = [
    { content: '无线连接', value: 'wireless' },
    { content: '命令行', value: 'shell' },
    { content: '恢复分辨率', value: 'reset-resolution' },
    { content: '重启设备', value: 'reboot' },
  ];

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
            case 'reset-resolution':
              void runShell(device.serial, RESET_RESOLUTION, '恢复分辨率');
              break;
            case 'reboot':
              void runShell(device.serial, REBOOT, '重启设备');
              break;
            case 'wireless':
              void readWirelessAddress();
              break;
            case 'shell':
              setShellOpen(true);
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
    </>
  );
}
