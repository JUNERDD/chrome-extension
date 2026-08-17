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

export async function launchExtensionContext(profileDirectory: string): Promise<BrowserContext> {
  return chromium.launchPersistentContext(profileDirectory, {
    channel: 'chromium',
    headless: process.env.PW_HEADED !== '1',
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
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

  controlPage: async ({ extensionContext, extensionId }, run) => {
    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup.html`);
    await run(page);
  },
});

export { expect } from '@playwright/test';

export type RecorderCommand = 'record' | 'pause' | 'resume' | 'stop' | 'discard' | 'screenshot';

interface RuntimeState {
  status: 'idle' | 'recording' | 'paused' | 'finalizing' | 'completed' | 'interrupted';
  sessionId: string | null;
  eventCount: number;
  gapCount: number;
}

interface RuntimeResponse {
  ok: boolean;
  error?: string;
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

export interface StoredEvidence {
  sessions: unknown[];
  events: Array<{ sessionId?: string; kind?: string; data?: unknown }>;
  assets: Array<{ metadata?: unknown; byteLength: number }>;
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
        readStore<{ sessionId?: string; kind?: string; data?: unknown }>('events'),
        readStore<{ metadata?: unknown; bytes?: ArrayBuffer }>('assets'),
      ]);
      return {
        sessions,
        events,
        assets: rawAssets.map((asset) => ({
          metadata: asset.metadata,
          byteLength: asset.bytes?.byteLength ?? 0,
        })),
      };
    } finally {
      database.close();
    }
  });
}
