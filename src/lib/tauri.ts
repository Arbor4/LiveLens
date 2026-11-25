import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen, type EventCallback, type UnlistenFn } from "@tauri-apps/api/event";

declare global {
  interface Window {
    __TAURI__?: {
      core?: { invoke?: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T> };
      event?: { listen?: <T>(event: string, cb: EventCallback<T>) => Promise<UnlistenFn> };
    };
    __TAURI_INTERNALS__?: {
      invoke?: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
      event?: { listen?: <T>(event: string, cb: EventCallback<T>) => Promise<UnlistenFn> };
    };
  }
}

export function isTauriAvailable(): boolean {
  return Boolean(window.__TAURI_INTERNALS__?.invoke || window.__TAURI__?.core?.invoke);
}

export async function waitForTauriRuntime(timeoutMs = 2000): Promise<void> {
  if (isTauriAvailable()) return;
  const attempts = Math.ceil(timeoutMs / 20);
  for (let i = 0; i < attempts; i++) {
    if (isTauriAvailable()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Tauri runtime unavailable");
}

export async function invokeCommand<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  if (window.__TAURI_INTERNALS__?.invoke || window.__TAURI__?.core?.invoke) {
    return tauriInvoke<T>(command, args);
  }
  throw new Error("Tauri runtime unavailable");
}

export async function listenEvent<T>(
  eventName: string,
  handler: EventCallback<T>,
): Promise<UnlistenFn> {
  if (!isTauriAvailable()) {
    return () => {};
  }
  return tauriListen<T>(eventName, handler);
}
