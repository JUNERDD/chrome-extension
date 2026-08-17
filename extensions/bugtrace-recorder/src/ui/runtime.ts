import { useCallback, useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import type {
  BackgroundMessage,
  RecorderViewState,
  RuntimeRequest,
  RuntimeResponse,
  SessionCommand,
} from '../messaging';

export async function sendRuntimeRequest(request: RuntimeRequest): Promise<RuntimeResponse> {
  try {
    const response = (await browser.runtime.sendMessage(request)) as RuntimeResponse | undefined;
    return response ?? { ok: false, error: 'Recorder background did not answer.' };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Recorder background is unavailable.',
    };
  }
}

function isStateMessage(message: unknown): message is Extract<BackgroundMessage, { type: 'STATE_CHANGED' }> {
  if (typeof message !== 'object' || message === null) return false;
  return (message as { type?: unknown }).type === 'STATE_CHANGED';
}

export function useRecorderState() {
  const [state, setState] = useState<RecorderViewState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyCommand, setBusyCommand] = useState<SessionCommand | null>(null);
  const [receivedAt, setReceivedAt] = useState(0);

  const applyState = useCallback((nextState: RecorderViewState) => {
    setReceivedAt(Date.now());
    setState(nextState);
    setError(null);
  }, []);

  const refresh = useCallback(async () => {
    const response = await sendRuntimeRequest({ type: 'GET_STATE' });
    if (response.ok && 'state' in response) {
      applyState(response.state);
    } else if (!response.ok) {
      setError(response.error);
    }
  }, [applyState]);

  useEffect(() => {
    queueMicrotask(() => void refresh());
    const listener = (message: unknown): void => {
      if (isStateMessage(message)) applyState(message.state);
    };
    browser.runtime.onMessage.addListener(listener);
    return () => browser.runtime.onMessage.removeListener(listener);
  }, [applyState, refresh]);

  const command = useCallback(
    async (nextCommand: SessionCommand) => {
      setBusyCommand(nextCommand);
      setError(null);
      const response = await sendRuntimeRequest({ type: 'SESSION_COMMAND', command: nextCommand });
      setBusyCommand(null);
      if (response.ok && 'state' in response) {
        applyState(response.state);
        return true;
      }
      if (!response.ok) setError(response.error);
      return false;
    },
    [applyState],
  );

  return { state, error, busyCommand, command, refresh, receivedAt };
}

export function useLiveDuration(
  state: RecorderViewState | null,
  receivedAt: number,
): number {
  const [now, setNow] = useState(0);
  useEffect(() => {
    if (state?.status !== 'recording') return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [state?.status]);

  if (!state) return 0;
  const liveDelta = state.status === 'recording' ? Math.max(0, now - receivedAt) : 0;
  return state.activeDurationMs + liveDelta;
}

export async function openExtensionPage(path: string, params?: URLSearchParams): Promise<void> {
  const url = new URL(chrome.runtime.getURL(path));
  if (params) url.search = params.toString();
  await browser.tabs.create({ url: url.toString() });
}
