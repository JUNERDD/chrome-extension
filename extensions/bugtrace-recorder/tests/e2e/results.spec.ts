import JSZip from 'jszip';
import { readFile } from 'node:fs/promises';
import type { BrowserContext, Page } from '@playwright/test';
import {
  expect,
  sendCommand,
  setLanguagePreference,
  test,
} from './extension.fixture';

async function recordAndOpenResults(
  controlPage: Page,
  extensionContext: BrowserContext,
  targetUrl: string,
): Promise<Page> {
  const targetPage = await extensionContext.newPage();
  await targetPage.goto(targetUrl);
  await expect(targetPage.getByRole('heading', { name: 'Controlled privacy fixture' })).toBeVisible();

  const started = await sendCommand(controlPage, 'record');
  expect(started.ok, started.error).toBe(true);
  await targetPage.getByRole('button', { name: 'Submit fixture' }).click();

  const resultsPagePromise = extensionContext.waitForEvent('page', {
    predicate: (candidate) => candidate.url().includes('/results.html?session='),
  });
  const stopped = await sendCommand(controlPage, 'stop');
  expect(stopped.ok, stopped.error).toBe(true);

  const resultsPage = await resultsPagePromise;
  await resultsPage.waitForLoadState('domcontentloaded');
  return resultsPage;
}

async function expectNoHorizontalPageOverflow(page: Page): Promise<void> {
  const layout = await page.evaluate(() => {
    const root = document.documentElement;
    const viewportWidth = root.clientWidth;
    const overflowingElements = Array.from(document.querySelectorAll<HTMLElement>('*'))
      .map((element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return {
          element: [
            element.tagName.toLowerCase(),
            element.dataset.slot ? `[data-slot="${element.dataset.slot}"]` : '',
            element.id ? `#${element.id}` : '',
            element.className ? `.${String(element.className).replaceAll(' ', '.')}` : '',
          ].join(''),
          left: Math.round(rect.left),
          right: Math.round(rect.right),
          width: Math.round(rect.width),
          clientWidth: element.clientWidth,
          scrollWidth: element.scrollWidth,
          minWidth: style.minWidth,
          overflowX: style.overflowX,
        };
      })
      .filter((item) => item.left < -1 || item.right > viewportWidth + 1)
      .sort((left, right) => right.right - left.right)
      .slice(0, 12);
    return {
      viewportWidth,
      scrollWidth: root.scrollWidth,
      overflowingElements,
    };
  });

  expect(
    layout.scrollWidth,
    `Document overflowed its ${layout.viewportWidth}px viewport:\n${JSON.stringify(layout.overflowingElements, null, 2)}`,
  ).toBeLessThanOrEqual(layout.viewportWidth + 1);
}

async function injectFullFidelityRrwebEvidence(page: Page): Promise<string> {
  return page.evaluate(async () => {
    interface StoredRrwebEvent {
      id: string;
      kind: string;
      data: Record<string, unknown>;
    }

    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('bugtrace-recorder');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('Unable to open test database'));
    });
    try {
      const transaction = database.transaction('events', 'readwrite');
      const completed = new Promise<void>((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error ?? new Error('Test transaction failed'));
        transaction.onabort = () => reject(transaction.error ?? new Error('Test transaction aborted'));
      });
      const store = transaction.objectStore('events');
      const events = await new Promise<StoredRrwebEvent[]>((resolve, reject) => {
        const request = store.getAll();
        request.onsuccess = () => resolve(request.result as StoredRrwebEvent[]);
        request.onerror = () => reject(request.error ?? new Error('Unable to read test events'));
      });
      const rrweb = events.find((event) => event.kind === 'rrweb');
      if (!rrweb) throw new Error('The completed fixture session has no rrweb evidence.');
      const marker = 'Bearer BUGTRACE_E2E_RRWEB_SECRET_abcdef123456';
      rrweb.data = {
        ...rrweb.data,
        event: {
          type: 4,
          timestamp: 1,
          authorization: marker,
        },
      };
      store.put(rrweb);
      await completed;
      return marker;
    } finally {
      database.close();
    }
  });
}

test('results remains exportable and follows persisted language changes', async ({
  baseURL,
  controlPage,
  extensionContext,
  extensionWorker,
}) => {
  const resultsPage = await recordAndOpenResults(
    controlPage,
    extensionContext,
    `${baseURL}/sensitive`,
  );

  await expect(resultsPage).toHaveTitle('Bugtrace Recorder — Evidence review');
  await expect(resultsPage.locator('html')).toHaveAttribute('lang', 'en');
  await expect(resultsPage.getByRole('heading', { level: 1, name: 'Evidence review' })).toBeVisible();
  await expect(resultsPage.getByText('Reproduction brief', { exact: true })).toBeVisible();
  await resultsPage.getByRole('textbox', { name: 'Summary' }).fill(
    'The controlled submit flow produced reviewable local evidence.',
  );
  await expectNoHorizontalPageOverflow(resultsPage);

  const downloadButton = resultsPage.getByRole('button', {
    name: 'Download .bugtrace.zip',
    exact: true,
  });
  await expect(downloadButton).toHaveAttribute('data-slot', 'button');
  await expect(downloadButton).toBeEnabled();
  await expect(resultsPage.locator('[data-slot="card"]').first()).toBeVisible();

  await resultsPage.getByRole('button', { name: /Inspect: SHOT/u }).first().click();
  const closeScreenshot = resultsPage.getByRole('button', { name: 'Close screenshot' });
  await closeScreenshot.focus();
  const closeTooltip = resultsPage.getByRole('tooltip', { name: 'Close screenshot' });
  await expect(closeTooltip).toBeVisible();
  await expect(closeTooltip).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  await expect(closeTooltip).toHaveCSS('color', 'rgb(0, 0, 0)');
  await closeScreenshot.click();

  const [download] = await Promise.all([
    resultsPage.waitForEvent('download'),
    downloadButton.click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/\.bugtrace\.zip$/u);
  expect(await download.failure()).toBeNull();
  const downloadPath = await download.path();
  expect(downloadPath).not.toBeNull();
  if (downloadPath === null) throw new Error('Playwright did not retain the results ZIP.');
  const zip = await JSZip.loadAsync(await readFile(downloadPath));
  const report = await zip.file('report.md')?.async('string');
  expect(report).toContain(
    '## Summary\n\nThe controlled submit flow produced reviewable local evidence\\.',
  );

  await setLanguagePreference(extensionWorker, 'zh-CN');
  await expect(resultsPage).toHaveTitle('Bugtrace 录制器 — 证据审阅');
  await expect(resultsPage.locator('html')).toHaveAttribute('lang', 'zh-CN');
  await expect(resultsPage.getByRole('heading', { level: 1, name: '证据审阅' })).toBeVisible();
  await expect(resultsPage.getByRole('button', { name: '复制 Markdown', exact: true })).toBeVisible();

  await resultsPage.reload();
  await expect(resultsPage).toHaveTitle('Bugtrace 录制器 — 证据审阅');
  await expect(resultsPage.locator('html')).toHaveAttribute('lang', 'zh-CN');
  await expect(resultsPage.getByRole('heading', { level: 1, name: '证据审阅' })).toBeVisible();
  await expect(resultsPage.getByRole('button', { name: '下载 .bugtrace.zip', exact: true })).toBeVisible();
  await expect(resultsPage.getByRole('heading', { level: 3, name: '截图检查' })).toBeVisible();
  await expect(resultsPage.getByText('导出 1/1', { exact: true })).toBeVisible();
  await expect(resultsPage.getByText("Error: Either the '<all_urls>' or 'activeTab' permission is required.")).toHaveCount(0);

  await resultsPage.setViewportSize({ width: 320, height: 844 });
  await expectNoHorizontalPageOverflow(resultsPage);
});

test('single continuous recording with an iframe has one top-level replay segment', async ({
  baseURL,
  controlPage,
  extensionContext,
}) => {
  const resultsPage = await recordAndOpenResults(
    controlPage,
    extensionContext,
    `${baseURL}/sensitive`,
  );
  await expect(resultsPage.getByRole('heading', { level: 1, name: 'Evidence review' })).toBeVisible();

  await expect(resultsPage.getByRole('tab')).toHaveCount(1);
  const storedRrweb = await resultsPage.evaluate(async () => {
    const sessionId = new URL(location.href).searchParams.get('session');
    if (!sessionId) throw new Error('Results URL is missing its session identity.');
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('bugtrace-recorder');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('Unable to open test database'));
    });
    try {
      const transaction = database.transaction('events', 'readonly');
      const events = await new Promise<Array<{
        kind: string;
        frameId: string | null;
        data: Record<string, unknown>;
      }>>((resolve, reject) => {
        const request = transaction.objectStore('events').index('by-session').getAll(sessionId);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('Unable to read test events'));
      });
      return events
        .filter((event) => event.kind === 'rrweb')
        .map((event) => ({ frameId: event.frameId, segmentId: event.data.segmentId }));
    } finally {
      database.close();
    }
  });

  expect(storedRrweb.length).toBeGreaterThanOrEqual(2);
  expect(new Set(storedRrweb.map((event) => event.frameId))).toEqual(new Set(['frame-0']));
  expect(new Set(storedRrweb.map((event) => event.segmentId)).size).toBe(1);
});

test('bundle retains full-fidelity rrweb content without a stripping fallback', async ({
  baseURL,
  controlPage,
  extensionContext,
}) => {
  const resultsPage = await recordAndOpenResults(
    controlPage,
    extensionContext,
    `${baseURL}/sensitive`,
  );
  await expect(resultsPage.getByRole('heading', { level: 1, name: 'Evidence review' })).toBeVisible();

  const marker = await injectFullFidelityRrwebEvidence(resultsPage);
  await resultsPage.reload();
  await expect(resultsPage.getByRole('heading', { level: 1, name: 'Evidence review' })).toBeVisible();

  const downloadButton = resultsPage.getByRole('button', {
    name: 'Download .bugtrace.zip',
    exact: true,
  });
  await expect(downloadButton).toBeEnabled();
  const [download] = await Promise.all([
    resultsPage.waitForEvent('download'),
    downloadButton.click(),
  ]);
  const downloadPath = await download.path();
  expect(downloadPath).not.toBeNull();
  if (downloadPath === null) throw new Error('Playwright did not retain the full-fidelity ZIP.');
  const zip = await JSZip.loadAsync(await readFile(downloadPath));
  const rrweb = await zip.file('rrweb/segment-0001.json')?.async('string');
  expect(rrweb).toContain(marker);
  await expect(resultsPage.getByRole('alert').filter({ hasText: 'Artifact action failed' })).toHaveCount(0);
});
