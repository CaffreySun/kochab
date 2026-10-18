import type { CommandName, EventName } from '@kochab/ipc-contract';

/** 取消事件订阅 */
export type UnlistenFn = () => void;

/**
 * 前后端通信的抽象。
 *
 * 之所以不直接把 `@tauri-apps/api` 散落在各页面，是因为：
 * 1. 让组件可以在纯浏览器中渲染与测试（UI 迭代不需要启动 Tauri 运行时）；
 * 2. 把「命令名 + 载荷」的类型约束集中到一处，编译期即可发现契约漂移。
 */
export interface Transport {
  invoke<TResult, TArgs extends object = Record<string, never>>(
    command: CommandName,
    args?: TArgs,
  ): Promise<TResult>;

  listen<TPayload>(event: EventName, handler: (payload: TPayload) => void): Promise<UnlistenFn>;

  /** 传输实现名称，用于诊断面板与错误提示 */
  readonly kind: 'tauri' | 'mock';
}
