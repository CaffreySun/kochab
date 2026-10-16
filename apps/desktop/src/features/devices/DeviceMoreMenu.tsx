import { useState } from 'react';
import { Button, Dropdown, MessagePlugin, Popup, Textarea } from 'tdesign-react';
import { MoreIcon } from 'tdesign-icons-react';
import type { DeviceInfo } from '@ac/ipc-contract';
import type { Api } from '../../ipc';
import { toMessage } from '../../ipc';

/** 恢复被开发者选项改过的屏幕尺寸。 */
const RESET_RESOLUTION = 'wm size reset';
/** 重启设备。 */
const REBOOT = 'reboot';

/** 从 `ip route` 输出里捞出 wlan0 的 IPv4 地址。 */
function parseWlanAddress(output: string): string | null {
  const line = output.split('\n').find((row) => row.includes('wlan0'));
  const match = line?.match(/src\s+(\d+\.\d+\.\d+\.\d+)/);
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

  /** 读出手机 Wi-Fi 地址：只能如实报告，连接要用户自己在工具栏确认。 */
  const readWirelessAddress = async () => {
    if (!api) return;
    setRunning(true);
    try {
      const out = await api.shellExec(device.serial, 'ip -4 route show wlan0');
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

      {/* 受控挂载：不要用 trigger="click"。
          没有触发元素时 trigger 会让弹层就地渲染，把卡片撑变形。 */}
      {shellOpen ? (
        <Popup visible attach="body" onVisibleChange={(value) => setShellOpen(value)}>
          <div className="ac-shell-popup">
            <h3 className="ac-shell-popup__title">命令行 · {device.serial}</h3>
            <Textarea
              autosize={{ minRows: 3, maxRows: 8 }}
              placeholder="例如：dumpsys battery"
              value={command}
              onChange={(value) => setCommand(value)}
            />
            <div className="ac-shell-popup__actions">
              <Button
                loading={running}
                size="small"
                theme="primary"
                onClick={() => {
                  void runShell(device.serial, command, '执行').then((ok) => {
                    if (ok) setShellOpen(false);
                  });
                }}
              >
                执行
              </Button>
              <Button size="small" variant="outline" onClick={() => setShellOpen(false)}>
                取消
              </Button>
            </div>
          </div>
        </Popup>
      ) : null}
    </>
  );
}
