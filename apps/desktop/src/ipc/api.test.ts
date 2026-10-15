import { describe, expect, it, vi } from 'vitest';
import { COMMANDS, EVENTS } from '@ac/ipc-contract';
import { createApi, toCode, toMessage } from './index';
import { createMockTransport } from './mock';

function setup(overrides: Record<string, unknown> = {}) {
  const onInvoke = vi.fn();
  const transport = createMockTransport(overrides, { onInvoke });
  return { api: createApi(transport), onInvoke };
}

describe('createApi', () => {
  it('暴露传输实现类型', () => {
    expect(setup().api.transportKind).toBe('mock');
  });

  it('deviceList 使用 device_list 命令且不带参数', async () => {
    const { api, onInvoke } = setup();

    const devices = await api.deviceList();

    expect(onInvoke).toHaveBeenCalledExactlyOnceWith(COMMANDS.deviceList, undefined);
    expect(devices).toHaveLength(2);
  });

  it('deviceInfo 透传 serial', async () => {
    const { api, onInvoke } = setup();

    await api.deviceInfo('emulator-5554');

    expect(onInvoke).toHaveBeenCalledExactlyOnceWith(COMMANDS.deviceInfo, {
      serial: 'emulator-5554',
    });
  });

  it('deviceInfo 找不到时回退到第一台', async () => {
    const { api } = setup();

    await expect(api.deviceInfo('not-exist')).resolves.toMatchObject({ serial: 'd4535f72' });
  });

  it('connectWireless 透传 address', async () => {
    const { api, onInvoke } = setup();

    await api.connectWireless('192.168.1.10:5555');

    expect(onInvoke).toHaveBeenCalledExactlyOnceWith(COMMANDS.deviceConnectWireless, {
      address: '192.168.1.10:5555',
    });
  });

  it('listApps 默认不带筛选参数', async () => {
    const { api, onInvoke } = setup();

    await api.listApps('d4535f72');

    expect(onInvoke).toHaveBeenCalledExactlyOnceWith(COMMANDS.appList, { serial: 'd4535f72' });
  });

  it('listApps 透传筛选条件', async () => {
    const { api, onInvoke } = setup();

    const apps = await api.listApps('d4535f72', { filter: 'notes', showSystemApps: false });

    expect(onInvoke).toHaveBeenCalledExactlyOnceWith(COMMANDS.appList, {
      serial: 'd4535f72',
      filter: 'notes',
      showSystemApps: false,
    });
    expect(apps).toHaveLength(2);
  });

  it('安装默认不允许降级', async () => {
    const { api, onInvoke } = setup();

    await api.installApk('d4535f72', '/tmp/app.apk');

    expect(onInvoke).toHaveBeenCalledExactlyOnceWith(COMMANDS.appInstall, {
      serial: 'd4535f72',
      apkPath: '/tmp/app.apk',
      allowDowngrade: false,
    });
  });

  it('shellExec 只在给出超时时才带上该字段', async () => {
    const { api, onInvoke } = setup();

    await api.shellExec('d4535f72', 'ls');
    await api.shellExec('d4535f72', 'ls', 1000);

    expect(onInvoke).toHaveBeenNthCalledWith(1, COMMANDS.shellExec, {
      serial: 'd4535f72',
      command: 'ls',
    });
    expect(onInvoke).toHaveBeenNthCalledWith(2, COMMANDS.shellExec, {
      serial: 'd4535f72',
      command: 'ls',
      timeoutMs: 1000,
    });
  });

  it('listFiles 同时透传 serial 与 path', async () => {
    const { api, onInvoke } = setup();

    const files = await api.listFiles('d4535f72', '/sdcard');

    expect(onInvoke).toHaveBeenCalledExactlyOnceWith(COMMANDS.fileList, {
      serial: 'd4535f72',
      path: '/sdcard',
    });
    expect(files).toHaveLength(3);
  });

  it('startSession 透传 serial、sessionId 与选项', async () => {
    const { api, onInvoke } = setup();

    const info = await api.startSession('d4535f72', 'mirror-d4535f72', { maxSize: 720 });

    expect(onInvoke).toHaveBeenCalledExactlyOnceWith(COMMANDS.sessionStart, {
      serial: 'd4535f72',
      sessionId: 'mirror-d4535f72',
      options: { maxSize: 720 },
    });
    expect(info.codec).toBe('h264');
    expect(info.width).toBeGreaterThan(0);
  });

  it('startSession 缺省选项时传空对象而不是 undefined', async () => {
    const { api, onInvoke } = setup();

    await api.startSession('d4535f72', 'mirror-d4535f72');

    expect(onInvoke).toHaveBeenCalledExactlyOnceWith(COMMANDS.sessionStart, {
      serial: 'd4535f72',
      sessionId: 'mirror-d4535f72',
      options: {},
    });
  });

  it('sessionTouch 用设备像素坐标调用命令', async () => {
    const { api, onInvoke } = setup();

    await api.sessionTouch(7, 'down', 120, 340);

    expect(onInvoke).toHaveBeenCalledExactlyOnceWith(COMMANDS.sessionTouch, {
      sessionId: 7,
      action: 'down',
      x: 120,
      y: 340,
    });
  });

  it('sessionKey 区分按下与抬起', async () => {
    const { api, onInvoke } = setup();

    await api.sessionKey(7, 4, true);
    await api.sessionKey(7, 4, false);

    expect(onInvoke).toHaveBeenNthCalledWith(1, COMMANDS.sessionKey, {
      sessionId: 7,
      keycode: 4,
      pressed: true,
    });
    expect(onInvoke).toHaveBeenNthCalledWith(2, COMMANDS.sessionKey, {
      sessionId: 7,
      keycode: 4,
      pressed: false,
    });
  });

  it('sessionStop 允许重复调用（幂等）', async () => {
    const { api, onInvoke } = setup();

    await api.stopSession(7);
    await api.stopSession(7);

    expect(onInvoke).toHaveBeenCalledTimes(2);
  });

  it('toolchainDiagnostics 报告预览模式的限制', async () => {
    const { api } = setup();

    const status = await api.toolchainDiagnostics();

    expect(status.adbServerReachable).toBe(false);
    expect(status.problems.length).toBeGreaterThan(0);
  });

  it('can be overridden per-test', async () => {
    const { api } = setup({ device_list: [] });

    await expect(api.deviceList()).resolves.toEqual([]);
  });

  it('未实现的命令抛出明确错误', async () => {
    // 直接构造一个没有 fixture 的传输，验证「漏实现」会显式失败而不是静默返回 undefined
    const bare = createMockTransport({ device_list: undefined });

    await expect(bare.invoke(COMMANDS.deviceList)).rejects.toThrow(/Mock 传输未实现命令/);
  });

  it('事件订阅使用注册表中的事件名', async () => {
    const transport = createMockTransport();
    const seen: string[] = [];
    vi.spyOn(transport, 'listen').mockImplementation((event, handler) => {
      seen.push(event);
      handler([]);
      return Promise.resolve(() => {});
    });
    const api = createApi(transport);

    await api.onDeviceChanged(() => {});
    await api.onAdbServerLost(() => {});

    expect(seen).toEqual([EVENTS.deviceChanged, EVENTS.adbServerLost]);
  });

  it('会话事件订阅覆盖元信息、视频、统计与结束', async () => {
    const transport = createMockTransport();
    const seen: string[] = [];
    vi.spyOn(transport, 'listen').mockImplementation((event, handler) => {
      seen.push(event);
      handler({});
      return Promise.resolve(() => {});
    });
    const api = createApi(transport);

    await api.onSessionMeta(() => {});
    await api.onSessionVideo(() => {});
    await api.onSessionStats(() => {});
    await api.onSessionClosed(() => {});

    expect(seen).toEqual([
      EVENTS.sessionMeta,
      EVENTS.sessionVideo,
      EVENTS.sessionStats,
      EVENTS.sessionClosed,
    ]);
  });
});

describe('错误解析', () => {
  it('从结构化错误里取出文案与错误码', () => {
    const err = { code: 'device_not_found', message: '设备 x 不在连接列表中' };

    expect(toMessage(err)).toBe('设备 x 不在连接列表中');
    expect(toCode(err)).toBe('device_not_found');
  });

  it('字符串错误直接透传', () => {
    expect(toMessage('boom')).toBe('boom');
    expect(toCode('boom')).toBe('internal');
  });

  it('无法识别的错误回退到默认值', () => {
    expect(toMessage(undefined, '未知')).toBe('未知');
    expect(toCode(undefined, 'x')).toBe('x');
  });
});
