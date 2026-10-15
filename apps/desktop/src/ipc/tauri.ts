import type { CommandName, EventName } from '@ac/ipc-contract';
import type { Transport } from './transport';

/** 是否运行在 Tauri 运行时中 */
export function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/**
 * 基于 `@tauri-apps/api` 的真实传输实现。
 * 采用动态 import，使得在纯浏览器环境下构建/测试时不会加载原生模块。
 */
export async function createTauriTransport(): Promise<Transport> {
  const [{ invoke }, { listen }] = await Promise.all([
    import('@tauri-apps/api/core'),
    import('@tauri-apps/api/event'),
  ]);

  return {
    kind: 'tauri',
    async invoke<TResult, TArgs extends object>(command: CommandName, args?: TArgs) {
      return invoke<TResult>(command, args ?? {});
    },
    async listen<TPayload>(event: EventName, handler: (payload: TPayload) => void) {
      const unlisten = await listen<TPayload>(event, (e) => handler(e.payload));
      return unlisten;
    },
  };
}
