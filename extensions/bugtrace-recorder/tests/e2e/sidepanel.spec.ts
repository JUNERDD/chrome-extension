import type { Locator, Page } from '@playwright/test';
import { expect, sendCommand, test } from './extension.fixture';

async function expectCentered(page: Page, dialog: Locator) {
  const [box, viewport] = await Promise.all([dialog.boundingBox(), Promise.resolve(page.viewportSize())]);
  expect(box).not.toBeNull();
  expect(viewport).not.toBeNull();
  expect(Math.abs(box!.x + box!.width / 2 - viewport!.width / 2)).toBeLessThanOrEqual(2);
  expect(Math.abs(box!.y + box!.height / 2 - viewport!.height / 2)).toBeLessThanOrEqual(2);
}

async function seedCascadeDeletionPayload(page: Page, sessionId: string): Promise<void> {
  await page.evaluate(async (targetSessionId) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('bugtrace-recorder');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('Unable to open test database'));
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction(['events', 'assets'], 'readwrite');
        const events = transaction.objectStore('events');
        const assets = transaction.objectStore('assets');
        for (let index = 0; index < 64; index += 1) {
          events.put({
            id: `delete-regression-event-${index}`,
            sessionId: targetSessionId,
            seq: 10_000 + index,
          });
        }
        for (let index = 0; index < 8; index += 1) {
          assets.put({
            id: `delete-regression-asset-${index}`,
            sessionId: targetSessionId,
            bytes: new ArrayBuffer(32),
          });
        }
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error ?? new Error('Unable to seed deletion payload'));
        transaction.onabort = () => reject(transaction.error ?? new Error('Deletion payload transaction aborted'));
      });
    } finally {
      database.close();
    }
  }, sessionId);
}

async function readCascadePayloadCounts(
  page: Page,
  sessionId: string,
): Promise<{ assets: number; events: number }> {
  return page.evaluate(async (targetSessionId) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('bugtrace-recorder');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('Unable to open test database'));
    });
    const readCount = (storeName: 'events' | 'assets') => new Promise<number>((resolve, reject) => {
      const transaction = database.transaction(storeName, 'readonly');
      const request = transaction.objectStore(storeName).index('by-session').count(targetSessionId);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error(`Unable to count ${storeName}`));
    });
    try {
      const [events, assets] = await Promise.all([readCount('events'), readCount('assets')]);
      return { assets, events };
    } finally {
      database.close();
    }
  }, sessionId);
}

test('a short session with capture gaps never renders the long-recording alert', async ({
  controlPage,
  extensionContext,
}) => {
  const warningPage = await extensionContext.newPage();
  await warningPage.addInitScript(() => {
    const runtime = chrome.runtime as typeof chrome.runtime & {
      sendMessage: (...arguments_: unknown[]) => Promise<unknown>;
    };
    const originalSendMessage = runtime.sendMessage.bind(runtime);
    runtime.sendMessage = async (...arguments_: unknown[]) => {
      const request = arguments_[0] as { type?: unknown } | undefined;
      if (request?.type !== 'GET_STATE') return originalSendMessage(...arguments_);
      return {
        ok: true,
        runtimeProtocolVersion: 2,
        runtimeCapabilities: ['deleteSession'],
        state: {
          status: 'paused',
          sessionId: '12677126-2b8d-4fac-9e89-605f9e840bcb',
          revision: 2,
          transitionedAtMs: Date.now(),
          startedAt: new Date(Date.now() - 14_000).toISOString(),
          activeDurationMs: 14_000,
          scopedTabCount: 2,
          eventCount: 12,
          gapCount: 1,
          warnings: [{ code: 'capture_gaps', count: 1 }],
          warning: '1 capture gap recorded.',
        },
      };
    };
  });
  await warningPage.goto(controlPage.url());

  await expect(warningPage.getByText('Coverage warning', { exact: true })).toBeVisible();
  await expect(warningPage.getByText(
    'Evidence capture gaps recorded: 1. Review the coverage audit after stopping.',
    { exact: true },
  )).toBeVisible();
  await expect(warningPage.getByText('Long recording', { exact: true })).toHaveCount(0);
});

test('side panel keeps the recorder primary and moves quick actions to the header', async ({ controlPage }) => {
  await expect(controlPage.getByLabel('Bugtrace Recorder')).toBeVisible();
  await expect(controlPage.getByRole('heading', { name: '00:00:00' })).toBeVisible();
  await expect(controlPage.getByText('Ready', { exact: true })).toBeVisible();
  await expect(controlPage.getByRole('button', { name: /Start recording/u })).toBeVisible();

  const quickActions = controlPage.getByRole('navigation', { name: 'Quick actions' });
  const latestButton = quickActions.getByRole('button', { name: 'Open latest recording' });
  const settingsButton = quickActions.getByRole('button', { name: 'Open recorder settings' });
  await expect(latestButton).toBeDisabled();
  await expect(settingsButton).toBeVisible();
  expect(await latestButton.evaluate((element) => element.tagName)).toBe('BUTTON');
  expect(await settingsButton.evaluate((element) => element.tagName)).toBe('BUTTON');

  await settingsButton.hover();
  const settingsTooltip = controlPage.getByRole('tooltip', { name: 'Open recorder settings' });
  await expect(settingsTooltip).toBeVisible();
  await expect(settingsTooltip).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  await expect(settingsTooltip).toHaveCSS('color', 'rgb(0, 0, 0)');

  await latestButton.focus();
  await expect(controlPage.getByRole('tooltip', { name: 'No completed recording yet' })).toBeVisible();
  await expect(settingsTooltip).toBeHidden();

  await settingsButton.focus();
  await expect(settingsTooltip).toBeVisible();

  const history = controlPage.getByRole('region', { name: 'Recent recordings' });
  await expect(history).toBeVisible();
  await expect(history.getByText('Completed recordings will appear here.')).toBeVisible();
  await expect(history.getByRole('button', { name: 'Clear all' })).toBeDisabled();
  await expect(history.getByRole('list')).toHaveCount(0);
});

test('stale recorder background fails closed before history deletion', async ({
  baseURL,
  controlPage,
  extensionContext,
}) => {
  const capturedPage = await extensionContext.newPage();
  await capturedPage.goto(`${baseURL}/sensitive`);
  await capturedPage.bringToFront();

  const started = await sendCommand(controlPage, 'record');
  expect(started.ok, started.error).toBe(true);
  const stopped = await sendCommand(controlPage, 'stop');
  expect(stopped.ok, stopped.error).toBe(true);

  const stalePage = await extensionContext.newPage();
  await stalePage.addInitScript(() => {
    const runtime = chrome.runtime as typeof chrome.runtime & {
      sendMessage: (...arguments_: unknown[]) => Promise<unknown>;
    };
    const originalSendMessage = runtime.sendMessage.bind(runtime);
    const testState = globalThis as typeof globalThis & { __deleteSessionCalls?: number };
    testState.__deleteSessionCalls = 0;
    runtime.sendMessage = async (...arguments_: unknown[]) => {
      const request = arguments_[0] as { type?: unknown } | undefined;
      if (request?.type === 'DELETE_SESSION') testState.__deleteSessionCalls! += 1;
      const response = await originalSendMessage(...arguments_);
      if (request?.type !== 'GET_STATE' || typeof response !== 'object' || response === null) {
        return response;
      }
      const legacyResponse = { ...response } as Record<string, unknown>;
      delete legacyResponse.runtimeProtocolVersion;
      delete legacyResponse.runtimeCapabilities;
      return legacyResponse;
    };
  });
  await stalePage.goto(controlPage.url());

  await expect(stalePage.getByText('Reload extension to manage recordings')).toBeVisible();
  await expect(stalePage.getByRole('button', { name: 'Reload extension' })).toBeVisible();
  await expect(stalePage.getByRole('button', { name: 'Clear all' })).toBeDisabled();

  const history = stalePage.getByRole('region', { name: 'Recent recordings' });
  await history.getByRole('button', { name: /Recording actions/u }).click();
  await expect(stalePage.getByRole('menuitem', { name: 'Delete' })).toHaveAttribute(
    'aria-disabled',
    'true',
  );
  expect(await stalePage.evaluate(() => (
    globalThis as typeof globalThis & { __deleteSessionCalls?: number }
  ).__deleteSessionCalls)).toBe(0);
});

test('stopping resets the recorder and appends a persistent history row', async ({
  baseURL,
  controlPage,
  extensionContext,
}) => {
  const capturedPage = await extensionContext.newPage();
  await capturedPage.goto(`${baseURL}/sensitive`);
  await capturedPage.bringToFront();

  const started = await sendCommand(controlPage, 'record');
  expect(started.ok, started.error).toBe(true);
  const sessionId = started.state?.sessionId;
  expect(sessionId).toBeTruthy();
  if (!sessionId) throw new Error('Recording did not return a session id.');
  await expect(controlPage.getByText('Recording', { exact: true })).toBeVisible();

  const resultsPagePromise = extensionContext.waitForEvent('page', {
    predicate: (candidate) => candidate.url().includes('/results.html?session='),
  });
  const stopped = await sendCommand(controlPage, 'stop');
  expect(stopped.ok, stopped.error).toBe(true);
  expect(stopped.state?.status).toBe('completed');
  const automaticResultsPage = await resultsPagePromise;
  await expect(automaticResultsPage).toHaveURL(new RegExp(`session=${sessionId}$`, 'u'));

  await expect(controlPage.getByText('Ready', { exact: true })).toBeVisible();
  await expect(controlPage.getByRole('heading', { name: '00:00:00' })).toBeVisible();
  await expect(controlPage.getByRole('button', { name: /Start recording/u })).toBeVisible();

  const history = controlPage.getByRole('region', { name: 'Recent recordings' });
  const historyEntry = history.getByRole('button', { name: /Review recording/u });
  await expect(historyEntry).toHaveCount(1);
  await expect(history.getByRole('button', { name: 'Clear all' })).toBeEnabled();
  const historyScroll = history.getByTestId('history-scroll');
  await expect(historyScroll).toBeVisible();
  expect(await historyScroll.evaluate((element) => getComputedStyle(element).overflowY)).toBe('auto');
  await expect(history.getByText(`#${sessionId?.slice(0, 6).toUpperCase()}`, { exact: true })).toBeVisible();
  await expect(
    controlPage.getByRole('navigation', { name: 'Quick actions' })
      .getByRole('button', { name: 'Open latest recording' }),
  ).toBeEnabled();

  await controlPage.reload();
  await expect(controlPage.getByText('Ready', { exact: true })).toBeVisible();
  const reloadedHistory = controlPage.getByRole('region', { name: 'Recent recordings' });
  await expect(reloadedHistory.getByRole('button', { name: /Review recording/u })).toHaveCount(1);

  let menuTrigger = reloadedHistory.getByRole('button', { name: /Recording actions/u });
  await menuTrigger.focus();
  const menuTooltip = controlPage.getByRole('tooltip', { name: 'Recording actions' });
  await expect(menuTooltip).toBeVisible();
  await expect(menuTooltip).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  await expect(menuTooltip).toHaveCSS('color', 'rgb(0, 0, 0)');
  await menuTrigger.press('Enter');
  const renameItem = controlPage.getByRole('menuitem', { name: 'Rename' });
  await expect(renameItem).toBeFocused();
  await renameItem.press('Enter');
  const renameDialog = controlPage.getByRole('dialog', { name: 'Rename' });
  await expectCentered(controlPage, renameDialog);
  const nameInput = renameDialog.getByRole('textbox', { name: 'Recording name' });
  const renamedSession = 'Checkout failure on a constrained side panel with a long recording name';
  await nameInput.fill(renamedSession);
  await renameDialog.getByRole('button', { name: 'Save' }).click();
  await expect(reloadedHistory.getByRole('button', { name: new RegExp(`Review recording · ${renamedSession}`, 'u') })).toBeVisible();
  menuTrigger = reloadedHistory.getByRole('button', { name: new RegExp(`Recording actions · ${renamedSession}`, 'u') });
  await expect(menuTrigger).toBeFocused();

  await controlPage.setViewportSize({ width: 320, height: 800 });
  const historyItem = reloadedHistory.getByRole('listitem').first();
  const durationBox = await historyItem.locator('[data-slot="chip"]').boundingBox();
  const actionBox = await menuTrigger.boundingBox();
  expect(durationBox).not.toBeNull();
  expect(actionBox).not.toBeNull();
  const durationOverlapsAction = !(
    durationBox!.x + durationBox!.width <= actionBox!.x ||
    actionBox!.x + actionBox!.width <= durationBox!.x ||
    durationBox!.y + durationBox!.height <= actionBox!.y ||
    actionBox!.y + actionBox!.height <= durationBox!.y
  );
  expect(durationOverlapsAction).toBe(false);
  expect(await controlPage.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(await controlPage.evaluate(() => document.documentElement.clientWidth));

  await controlPage.reload();
  const persistentHistory = controlPage.getByRole('region', { name: 'Recent recordings' });
  const cardAction = persistentHistory.getByRole('button', {
    name: new RegExp(`Review recording · ${renamedSession}`, 'u'),
  });
  await expect(cardAction).toBeVisible();
  await expect(persistentHistory.getByText('Review recording', { exact: true })).toHaveCount(0);

  const persistentCard = persistentHistory.getByRole('listitem').locator('[data-slot="card"]');
  const [cardBox, cardActionBox] = await Promise.all([
    persistentCard.boundingBox(),
    cardAction.boundingBox(),
  ]);
  expect(cardBox).not.toBeNull();
  expect(cardActionBox).not.toBeNull();
  expect(cardActionBox!.width).toBeCloseTo(cardBox!.width, 0);
  expect(cardActionBox!.height).toBeCloseTo(cardBox!.height, 0);

  const historyResultsPromise = extensionContext.waitForEvent('page', {
    predicate: (candidate) => candidate !== automaticResultsPage && candidate.url().includes('/results.html?session='),
  });
  await persistentHistory.getByRole('listitem').click({
    position: { x: cardBox!.width - 56, y: cardBox!.height - 20 },
  });
  await expect(await historyResultsPromise).toHaveURL(new RegExp(`session=${sessionId}$`, 'u'));

  await seedCascadeDeletionPayload(controlPage, sessionId);
  const seededPayload = await readCascadePayloadCounts(controlPage, sessionId);
  expect(seededPayload.assets).toBeGreaterThanOrEqual(8);
  expect(seededPayload.events).toBeGreaterThanOrEqual(64);

  const persistentMenuTrigger = persistentHistory.getByRole('button', { name: /Recording actions/u });
  await persistentMenuTrigger.click();
  const menu = controlPage.getByRole('menu', { name: new RegExp(`Recording actions · ${renamedSession}`, 'u') });
  await controlPage.keyboard.press('ArrowDown');
  await expect(menu.getByRole('menuitem', { name: 'Rename' })).toBeFocused();
  await controlPage.keyboard.press('ArrowDown');
  const deleteItem = menu.getByRole('menuitem', { name: 'Delete' });
  await expect(deleteItem).toBeFocused();
  await deleteItem.press('Enter');
  const deleteDialog = controlPage.getByRole('alertdialog', { name: 'Confirm deletion' });
  await expectCentered(controlPage, deleteDialog);
  await expect(deleteDialog).toContainText(renamedSession);
  await expect(deleteDialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await deleteDialog.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(persistentHistory.getByRole('button', { name: /Review recording/u })).toHaveCount(0);
  await expect(persistentHistory.getByRole('heading', { name: 'Recent recordings' })).toBeFocused();
  expect(await readCascadePayloadCounts(controlPage, sessionId)).toEqual({ assets: 0, events: 0 });

  await controlPage.reload();
  await expect(controlPage.getByRole('region', { name: 'Recent recordings' })
    .getByText('Completed recordings will appear here.')).toBeVisible();
});

test('clear all removes every completed recording from the side panel', async ({
  baseURL,
  controlPage,
  extensionContext,
}) => {
  const capturedPage = await extensionContext.newPage();
  await capturedPage.goto(`${baseURL}/sensitive`);
  await capturedPage.bringToFront();

  const started = await sendCommand(controlPage, 'record');
  expect(started.ok, started.error).toBe(true);
  const resultsPagePromise = extensionContext.waitForEvent('page', {
    predicate: (candidate) => candidate.url().includes('/results.html?session='),
  });
  const stopped = await sendCommand(controlPage, 'stop');
  expect(stopped.ok, stopped.error).toBe(true);
  const resultsPage = await resultsPagePromise;
  await resultsPage.close();

  const history = controlPage.getByRole('region', { name: 'Recent recordings' });
  const clearAllButton = history.getByRole('button', { name: 'Clear all' });
  await expect(history.getByRole('listitem')).toHaveCount(1);
  await clearAllButton.click();

  let clearDialog = controlPage.getByRole('alertdialog', { name: 'Clear all recordings?' });
  await expectCentered(controlPage, clearDialog);
  await expect(clearDialog).toContainText('Delete all 1 completed recordings');
  await expect(clearDialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await clearDialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(clearAllButton).toBeFocused();

  await clearAllButton.click();
  clearDialog = controlPage.getByRole('alertdialog', { name: 'Clear all recordings?' });
  await clearDialog.getByRole('button', { name: 'Delete all' }).click();
  await expect(history.getByRole('listitem')).toHaveCount(0);
  await expect(history.getByText('Completed recordings will appear here.')).toBeVisible();
  await expect(history.getByRole('heading', { name: 'Recent recordings' })).toBeFocused();
  await expect(clearAllButton).toBeDisabled();

  await controlPage.reload();
  await expect(controlPage.getByRole('region', { name: 'Recent recordings' })
    .getByText('Completed recordings will appear here.')).toBeVisible();
});

test('recording history scrolls independently from the recorder card', async ({
  baseURL,
  controlPage,
  extensionContext,
}) => {
  await controlPage.setViewportSize({ width: 360, height: 720 });
  const capturedPage = await extensionContext.newPage();
  await capturedPage.goto(`${baseURL}/sensitive`);

  for (let index = 0; index < 5; index += 1) {
    await capturedPage.bringToFront();
    const started = await sendCommand(controlPage, 'record');
    expect(started.ok, started.error).toBe(true);
    const resultsPagePromise = extensionContext.waitForEvent('page', {
      predicate: (candidate) => candidate.url().includes('/results.html?session='),
    });
    const stopped = await sendCommand(controlPage, 'stop');
    expect(stopped.ok, stopped.error).toBe(true);
    await (await resultsPagePromise).close();
  }

  const recorderCard = controlPage.locator('[aria-labelledby="recorder-state-heading"]');
  const recorderBefore = await recorderCard.boundingBox();
  const history = controlPage.getByRole('region', { name: 'Recent recordings' });
  const historyScroll = history.getByTestId('history-scroll');
  await expect(history.getByRole('listitem')).toHaveCount(5);
  const scrollMetrics = await historyScroll.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }));
  expect(scrollMetrics.scrollHeight).toBeGreaterThan(scrollMetrics.clientHeight);
  await historyScroll.evaluate((element) => element.scrollTo({ top: element.scrollHeight }));
  await expect.poll(() => historyScroll.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  expect(await recorderCard.boundingBox()).toEqual(recorderBefore);
  expect(await controlPage.evaluate(() => document.documentElement.scrollHeight))
    .toBeLessThanOrEqual(await controlPage.evaluate(() => document.documentElement.clientHeight));
});
