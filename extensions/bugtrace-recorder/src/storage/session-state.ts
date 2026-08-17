import { browser } from 'wxt/browser';

const CURRENT_SESSION_KEY = 'bugtrace.current-session';
const RUNTIME_MARKER_KEY = 'bugtrace.runtime-marker';

export async function loadCurrentSessionState<TState>(): Promise<TState | null> {
  const stored = await browser.storage.local.get(CURRENT_SESSION_KEY);
  return (stored[CURRENT_SESSION_KEY] as TState | undefined) ?? null;
}

export async function saveCurrentSessionState<TState>(state: TState): Promise<void> {
  await browser.storage.local.set({ [CURRENT_SESSION_KEY]: state });
}

export async function clearCurrentSessionState(): Promise<void> {
  await browser.storage.local.remove(CURRENT_SESSION_KEY);
}

export async function consumeBrowserRuntimeRestart(): Promise<boolean> {
  const stored = await browser.storage.session.get(RUNTIME_MARKER_KEY);
  const restarted = stored[RUNTIME_MARKER_KEY] !== true;
  await browser.storage.session.set({ [RUNTIME_MARKER_KEY]: true });
  return restarted;
}
