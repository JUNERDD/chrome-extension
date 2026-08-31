import { test as base, chromium, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

interface ExtensionFixtures {
  controlPage: Page;
  extensionContext: BrowserContext;
  extensionId: string;
  extensionWorker: Worker;
}

export const extensionPath = path.resolve(process.cwd(), '.output/chrome-mv3');

export async function launchExtensionContext(
  profileDirectory: string,
  loadedExtensionPath = extensionPath,
): Promise<BrowserContext> {
  return chromium.launchPersistentContext(profileDirectory, {
    channel: 'chromium',
    headless: process.env.PW_HEADED !== '1',
    locale: 'en-US',
    args: [
      `--disable-extensions-except=${loadedExtensionPath}`,
      `--load-extension=${loadedExtensionPath}`,
    ],
  });
}

export async function waitForExtensionWorker(context: BrowserContext): Promise<Worker> {
  return context.serviceWorkers()[0] ?? context.waitForEvent('serviceworker');
}

export const test = base.extend<ExtensionFixtures>({
  extensionContext: async ({ browserName }, run) => {
    if (browserName !== 'chromium') throw new Error('Extension E2E requires Playwright Chromium.');
    const profileDirectory = await mkdtemp(path.join(tmpdir(), 'bugtrace-playwright-'));
    const context = await launchExtensionContext(profileDirectory);

    try {
      await run(context);
    } finally {
      await context.close();
      await rm(profileDirectory, { recursive: true, force: true });
    }
  },

  extensionWorker: async ({ extensionContext }, run) => {
    const worker = await waitForExtensionWorker(extensionContext);
    await run(worker);
  },

  extensionId: async ({ extensionWorker }, run) => {
    const extensionId = new URL(extensionWorker.url()).hostname;
    await run(extensionId);
  },

  controlPage: async ({ extensionContext, extensionId, extensionWorker }, run) => {
    await setLanguagePreference(extensionWorker, 'en');
    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await run(page);
  },
});

export { expect } from '@playwright/test';

export type RecorderCommand = 'record' | 'pause' | 'resume' | 'stop' | 'discard' | 'screenshot';

export interface RuntimeWarning {
  code: 'runtime_interrupted' | 'capture_gaps' | 'long_recording';
  count?: number;
  thresholdMs?: number;
}

export interface RuntimeState {
  status: 'idle' | 'recording' | 'paused' | 'finalizing' | 'completed' | 'interrupted';
  sessionId: string | null;
  activeDurationMs: number;
  scopedTabCount: number;
  eventCount: number;
  gapCount: number;
  warnings: RuntimeWarning[];
  /** Compatibility field exposed by stale extension builds. */
  warning?: string | null;
}

interface RuntimeResponse {
  ok: boolean;
  error?: string;
  errorCode?: string;
  state?: RuntimeState;
}

export async function sendCommand(page: Page, command: RecorderCommand): Promise<RuntimeResponse> {
  return page.evaluate(async (nextCommand) => {
    return chrome.runtime.sendMessage({ type: 'SESSION_COMMAND', command: nextCommand }) as Promise<RuntimeResponse>;
  }, command);
}

export async function readState(page: Page): Promise<RuntimeResponse> {
  return page.evaluate(async () => {
    return chrome.runtime.sendMessage({ type: 'GET_STATE' }) as Promise<RuntimeResponse>;
  });
}

/**
 * Activates a real Chromium tab through the extension API. `Page.bringToFront()` only changes
 * Playwright's target focus and does not reliably exercise `chrome.tabs.onActivated`.
 */
export async function activateBrowserTab(controlPage: Page, targetPage: Page): Promise<number> {
  const targetUrl = targetPage.url();
  return controlPage.evaluate(async (url) => {
    const tabs = await chrome.tabs.query({});
    const target = tabs.find((tab) => tab.url === url || tab.pendingUrl === url);
    if (target?.id === undefined) {
      throw new Error(`Unable to resolve a Chromium tab for ${url}`);
    }
    await chrome.tabs.update(target.id, { active: true });
    return target.id;
  }, targetUrl);
}

export interface StoredEvidence {
  sessions: unknown[];
  events: Array<{
    id?: string;
    sessionId?: string;
    seq?: number;
    kind?: string;
    tabId?: string | null;
    frameId?: string | null;
    data?: unknown;
  }>;
  assets: Array<{ metadata?: unknown; mimeType: string | undefined; byteLength: number }>;
}

export type LanguagePreference = 'system' | 'en' | 'zh-CN';

export async function setLanguagePreference(
  worker: Worker,
  preference: LanguagePreference,
): Promise<void> {
  await worker.evaluate(async (nextPreference) => {
    await chrome.storage.local.set({ 'bugtrace.language-preference': nextPreference });
  }, preference);
}

export async function readStoredEvidence(worker: Worker): Promise<StoredEvidence> {
  return worker.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('bugtrace-recorder');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('Unable to open recorder database'));
    });

    const readStore = <T>(name: string): Promise<T[]> => new Promise((resolve, reject) => {
      const transaction = database.transaction(name, 'readonly');
      const request = transaction.objectStore(name).getAll();
      request.onsuccess = () => resolve(request.result as T[]);
      request.onerror = () => reject(request.error ?? new Error(`Unable to read ${name}`));
    });

    try {
      const [sessions, events, rawAssets] = await Promise.all([
        readStore<unknown>('sessions'),
        readStore<{
          id?: string;
          sessionId?: string;
          seq?: number;
          kind?: string;
          tabId?: string | null;
          frameId?: string | null;
          data?: unknown;
        }>('events'),
        readStore<{ metadata?: unknown; mimeType?: string; bytes?: ArrayBuffer }>('assets'),
      ]);
      return {
        sessions,
        events,
        assets: rawAssets.map((asset) => ({
          metadata: asset.metadata,
          mimeType: asset.mimeType,
          byteLength: asset.bytes?.byteLength ?? 0,
        })),
      };
    } finally {
      database.close();
    }
  });
}
