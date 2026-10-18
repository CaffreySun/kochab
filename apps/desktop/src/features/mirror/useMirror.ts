import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  SessionClosedPayload,
  SessionInfo,
  SessionStartOptions,
  SessionStats,
  TouchAction,
} from '@kochab/ipc-contract';
import { VideoStreamDecoder, clientPointToDevice, decodeBase64 } from '@kochab/scrcpy-web';
import type { Api } from '../../ipc';
import { toCode, toMessage } from '../../ipc';

/**
 * 会话占用优先级。
 *
 * 同一台设备同时只能有一条 scrcpy 会话，缩略图与投屏窗口必然争抢。
 * 交互式投屏必须高于缩略图：否则缩略图重新挂载时会把用户正在看的投屏顶掉。
 */
export const PREVIEW_PRIORITY = 0;
export const MIRROR_PRIORITY = 10;
export type MirrorStatus = 'idle' | 'starting' | 'streaming' | 'stopped' | 'busy' | 'error';

export interface MirrorState {
  info: SessionInfo | null;
  stats: SessionStats | null;
  status: MirrorStatus;
  error: string | null;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  sendTouch: (action: TouchAction, clientX: number, clientY: number) => void;
  /**
   * 注入一次完整按键（按下 + 抬起）。
   *
   * 只发按下时 Android 只收到 ACTION_DOWN，返回 / 主页 / 多任务这类
   * 由按键抬起触发的动作不会发生，所以这里必须成对发送。
   */
  pressKey: (keycode: number) => Promise<void>;
  sendText: (text: string) => Promise<void>;
  sendScroll: (clientX: number, clientY: number, h: number, v: number) => void;
}

/**
 * 单台设备的投屏会话。
 *
 * 三件事必须协同：Rust 侧的会话、WebCodecs 解码器、画布绘制。
 *
 * `canvasRef` 由调用方持有并挂到 `<canvas>` 上，这里只在绘制回调里读它——
 * ref 不经过本 hook 的返回值，避免把「需要读 ref」这件事扩散到渲染路径。
 */
export function useMirror(
  api: Api | null,
  serial: string | null,
  canvasRef: React.RefObject<HTMLCanvasElement | null>,
  options: SessionStartOptions = {},
  /**
   * 会话归属名。同一个设备同时只能有一条 scrcpy 会话，Rust 侧据此判断
   * 「是同一个消费方重复启动（幂等复用）」还是「换了消费方（接管旧会话）」。
   *
   * 因此缩略图与投屏磁贴必须用不同的名字：它们是彼此独立的消费方，
   * 用同一个名字会让后端把缩略图那档低清参数直接复用给投屏窗口。
   */
  owner = 'mirror',
  /**
   * 占用优先级，必须与 `PREVIEW_PRIORITY` / `MIRROR_PRIORITY` 保持一致。
   * 低优先级的请求不能抢占高优先级的会话，否则缩略图会把投屏窗口顶掉。
   */
  priority = MIRROR_PRIORITY,
): MirrorState {
  const [info, setInfo] = useState<SessionInfo | null>(null);
  const [stats, setStats] = useState<SessionStats | null>(null);
  const [status, setStatus] = useState<MirrorStatus>('idle');
  const [error, setError] = useState<string | null>(null);

  // 回调里需要读到「最新值」，但渲染期不能碰 ref，所以统一在 effect 里同步。
  const decoderRef = useRef<VideoStreamDecoder | null>(null);
  const infoRef = useRef<SessionInfo | null>(null);
  const apiRef = useRef<Api | null>(null);
  const optionsRef = useRef<SessionStartOptions>(options);
  const ownerRef = useRef<string>(owner);
  const priorityRef = useRef<number>(priority);

  useEffect(() => {
    infoRef.current = info;
  }, [info]);

  useEffect(() => {
    apiRef.current = api;
  }, [api]);

  useEffect(() => {
    optionsRef.current = options;
  }, [options]);

  useEffect(() => {
    ownerRef.current = owner;
  }, [owner]);

  useEffect(() => {
    priorityRef.current = priority;
  }, [priority]);

  const teardown = useCallback(() => {
    decoderRef.current?.close();
    decoderRef.current = null;
  }, []);

  const drawFrame = useCallback(
    (frame: VideoFrame) => {
      const canvas = canvasRef.current;
      try {
        if (!canvas) return;
        // 分辨率会随设备旋转变化，采用视频帧的真实尺寸
        if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
          canvas.width = frame.displayWidth;
          canvas.height = frame.displayHeight;
        }
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.drawImage(frame, 0, 0, canvas.width, canvas.height);
        }
      } finally {
        // VideoFrame 持有 GPU 资源，必须显式释放，否则几秒内就会耗尽
        frame.close();
      }
    },
    [canvasRef],
  );

  const start = useCallback(async () => {
    const client = apiRef.current;
    if (!client || !serial) return;
    setStatus('starting');
    setError(null);
    teardown();

    try {
      const session = await client.startSession(serial, `${ownerRef.current}-${serial}`, {
        ...optionsRef.current,
        priority: priorityRef.current,
      });
      infoRef.current = session;
      setInfo(session);

      decoderRef.current = new VideoStreamDecoder({
        codec: session.codec,
        width: session.width,
        height: session.height,
        onFrame: drawFrame,
        onError: (cause) => setError(cause.message),
      });

      setStatus('streaming');
    } catch (cause) {
      // device_busy 不是故障：这台设备正被更高优先级的会话占用（例如投屏窗口）。
      // 单列一个状态，调用方可以据此退避重试，而不是弹一个红色错误。
      if (toCode(cause) === 'device_busy') {
        setStatus('busy');
        setError(null);
        return;
      }
      setStatus('error');
      setError(toMessage(cause, '启动投屏失败'));
    }
  }, [serial, teardown, drawFrame]);

  const stop = useCallback(async () => {
    const client = apiRef.current;
    const current = infoRef.current;
    teardown();
    infoRef.current = null;
    setInfo(null);
    setStats(null);
    if (!client || !current) {
      setStatus('idle');
      return;
    }
    try {
      await client.stopSession(current.sessionId);
    } catch (cause) {
      setError(toMessage(cause, '停止投屏失败'));
    }
    setStatus('stopped');
  }, [teardown]);

  // 订阅会话事件。放在 effect 里，组件卸载或换设备时自动退订。
  useEffect(() => {
    if (!api) return undefined;

    let disposed = false;
    const unlisteners: Array<() => void> = [];

    void api
      .onSessionVideo((frame) => {
        if (disposed) return;
        // 只处理当前会话：多设备时别的会话也会广播到同一条事件
        if (infoRef.current && frame.sessionId !== infoRef.current.sessionId) return;
        decoderRef.current?.push({
          config: frame.config,
          keyFrame: frame.keyFrame,
          ptsUs: frame.ptsUs,
          data: decodeBase64(frame.data),
        });
      })
      .then((un) => unlisteners.push(un));

    void api
      .onSessionSize((payload) => {
        if (disposed) return;
        if (infoRef.current && payload.sessionId !== infoRef.current.sessionId) return;
        // 旋转后画面宽高互换：布局、触摸换算、窗口比例都要跟着走
        const next = infoRef.current
          ? { ...infoRef.current, width: payload.width, height: payload.height }
          : null;
        decoderRef.current?.resize(payload.width, payload.height);
        if (!next) return;
        infoRef.current = next;
        setInfo(next);
      })
      .then((un) => unlisteners.push(un));

    void api
      .onSessionStats((next) => {
        if (disposed) return;
        setStats(next);
      })
      .then((un) => unlisteners.push(un));

    void api
      .onSessionClosed((payload: SessionClosedPayload) => {
        if (disposed) return;
        if (infoRef.current && payload.sessionId !== infoRef.current.sessionId) return;
        teardown();
        setInfo(null);
        setStatus(payload.requested ? 'stopped' : 'error');
        if (!payload.requested && payload.reason) setError(payload.reason);
      })
      .then((un) => unlisteners.push(un));

    return () => {
      disposed = true;
      for (const un of unlisteners) un();
    };
  }, [api, teardown]);

  // 卸载时释放解码器并结束 Rust 侧会话，避免泄漏硬件解码与设备端进程
  useEffect(
    () => () => {
      decoderRef.current?.close();
      decoderRef.current = null;
      const current = infoRef.current;
      if (current) {
        void apiRef.current?.stopSession(current.sessionId).catch(() => {
          // 会话可能已被设备侧断开，忽略
        });
      }
      infoRef.current = null;
    },
    [],
  );

  const devicePoint = useCallback(
    (clientX: number, clientY: number) => {
      const canvas = canvasRef.current;
      const current = infoRef.current;
      if (!canvas || !current) return null;
      const rect = canvas.getBoundingClientRect();
      return clientPointToDevice(
        { x: clientX, y: clientY },
        { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
        { width: current.width, height: current.height },
      );
    },
    [canvasRef],
  );

  const sendTouch = useCallback(
    (action: TouchAction, clientX: number, clientY: number) => {
      const current = infoRef.current;
      const point = devicePoint(clientX, clientY);
      const client = apiRef.current;
      if (!client || !current || !point) return;
      void client
        .sessionTouch(current.sessionId, action, point.x, point.y)
        .catch((cause: unknown) => {
          setError(toMessage(cause, '注入触摸失败'));
        });
    },
    [devicePoint],
  );

  const sendKey = useCallback(async (keycode: number, pressed: boolean) => {
    const current = infoRef.current;
    const client = apiRef.current;
    if (!client || !current) return;
    try {
      await client.sessionKey(current.sessionId, keycode, pressed);
    } catch (cause) {
      setError(toMessage(cause, '注入按键失败'));
    }
  }, []);

  // 顺序执行：两个 invoke 是独立的异步命令，并发下发不保证先按下再抬起
  const pressKey = useCallback(
    async (keycode: number) => {
      await sendKey(keycode, true);
      await sendKey(keycode, false);
    },
    [sendKey],
  );

  const sendText = useCallback(async (text: string) => {
    const current = infoRef.current;
    const client = apiRef.current;
    if (!client || !current) return;
    await client.sessionText(current.sessionId, text);
  }, []);

  const sendScroll = useCallback(
    (clientX: number, clientY: number, h: number, v: number) => {
      const current = infoRef.current;
      const point = devicePoint(clientX, clientY);
      const client = apiRef.current;
      if (!client || !current || !point) return;
      void client
        .sessionScroll(current.sessionId, point.x, point.y, h, v)
        .catch((cause: unknown) => setError(toMessage(cause, '注入滚轮失败')));
    },
    [devicePoint],
  );

  return {
    info,
    stats,
    status,
    error,
    start,
    stop,
    sendTouch,
    pressKey,
    sendText,
    sendScroll,
  };
}
