import JSZip from 'jszip';
import { readFile } from 'node:fs/promises';
import type { BrowserContext, Page } from '@playwright/test';
import {
  activateBrowserTab,
  expect,
  readState,
  readStoredEvidence,
  sendCommand,
  test,
  type RuntimeState,
  type StoredEvidence,
} from './extension.fixture';

const LONG_RECORDING_THRESHOLD_MS = 15 * 60 * 1_000;

interface StoredRecorderSession {
  id?: string;
  state?: {
    eventCount?: number;
    gapCount?: number;
    recorder?: {
      activeDurationMs?: number;
      scope?: {
        rootTabId?: number;
        tabs?: Array<{
          tabId?: number;
          parentTabId?: number | null;
          closedAtMs?: number | null;
        }>;
      };
    };
  };
}

interface ExportedTrace {
  session: { durationMs: number };
  tabs: Array<{ id: string; openerTabId?: string }>;
  steps: Array<{ tabId: string; input?: unknown; key?: string }>;
  rrweb: { segments: Array<{ tabId: string; eventCount: number }> };
  captureGaps: unknown[];
}

function sessionEvents(evidence: StoredEvidence, sessionId: string) {
  return evidence.events.filter((event) => event.sessionId === sessionId);
}

function requireStoredSession(
  evidence: StoredEvidence,
  sessionId: string,
): StoredRecorderSession {
  const session = (evidence.sessions as StoredRecorderSession[]).find(
    (candidate) => candidate.id === sessionId,
  );
  expect(session, `IndexedDB did not retain session ${sessionId}`).toBeDefined();
  return session!;
}

async function waitForRecorderState(
  controlPage: Page,
  predicate: (state: RuntimeState) => boolean,
): Promise<RuntimeState> {
  await expect.poll(async () => {
    const response = await readState(controlPage);
    return response.ok && response.state !== undefined && predicate(response.state);
  }).toBe(true);

  const response = await readState(controlPage);
  expect(response.ok, response.error).toBe(true);
  expect(response.state).toBeDefined();
  return response.state!;
}

async function expectShortGaplessRecording(
  controlPage: Page,
  expectedScopedTabs: number,
): Promise<RuntimeState> {
  const state = await waitForRecorderState(
    controlPage,
    (candidate) =>
      candidate.status === 'recording' &&
      candidate.scopedTabCount === expectedScopedTabs &&
      candidate.gapCount === 0,
  );
  expect(state.activeDurationMs).toBeLessThan(LONG_RECORDING_THRESHOLD_MS);
  expect(state.warnings).toEqual([]);
  expect(state.warning ?? null).toBeNull();
  await expect(controlPage.getByText('Long recording', { exact: true })).toHaveCount(0);
  await expect(
    controlPage.getByText('This session is over 15 minutes.', { exact: false }),
  ).toHaveCount(0);
  return state;
}

async function stopAndOpenResults(
  controlPage: Page,
  extensionContext: BrowserContext,
): Promise<{ resultsPage: Page; stoppedState: RuntimeState }> {
  const resultsPagePromise = extensionContext.waitForEvent('page', {
    predicate: (candidate) => candidate.url().includes('/results.html?session='),
  });
  const stopped = await sendCommand(controlPage, 'stop');
  expect(stopped.ok, stopped.error).toBe(true);
  expect(stopped.state?.status).toBe('completed');
  expect(stopped.state).toBeDefined();
  const resultsPage = await resultsPagePromise;
  await expect(resultsPage.getByRole('heading', { name: 'Evidence review' })).toBeVisible();
  return { resultsPage, stoppedState: stopped.state! };
}

async function downloadTrace(resultsPage: Page): Promise<ExportedTrace> {
  const downloadButton = resultsPage.getByRole('button', {
    name: 'Download .bugtrace.zip',
    exact: true,
  });
  await expect(downloadButton).toBeEnabled();
  const [download] = await Promise.all([
    resultsPage.waitForEvent('download'),
    downloadButton.click(),
  ]);
  expect(await download.failure()).toBeNull();
  const downloadPath = await download.path();
  expect(downloadPath).not.toBeNull();
  if (downloadPath === null) throw new Error('Playwright did not retain the Bugtrace ZIP.');
  const zip = await JSZip.loadAsync(await readFile(downloadPath));
  const traceText = await zip.file('trace.json')?.async('string');
  expect(traceText, 'The Bugtrace ZIP omitted trace.json').toBeTruthy();
  return JSON.parse(traceText!) as ExportedTrace;
}

test('records a pre-existing tab activated after recording starts', async ({
  baseURL,
  controlPage,
  extensionContext,
  extensionWorker,
}) => {
  const marker = 'BUGTRACE_CROSS_TAB_B_20260818';
  const tabB = await extensionContext.newPage();
  await tabB.goto(`${baseURL}/sensitive?case=preexisting&tab=B`);
  const tabA = await extensionContext.newPage();
  await tabA.goto(`${baseURL}/sensitive?case=preexisting&tab=A`);
  await expect(tabA.getByRole('heading', { name: 'Controlled privacy fixture' })).toBeVisible();
  await expect(tabB.getByRole('heading', { name: 'Controlled privacy fixture' })).toBeVisible();

  const tabAId = await activateBrowserTab(controlPage, tabA);
  const started = await sendCommand(controlPage, 'record');
  expect(started.ok, started.error).toBe(true);
  expect(started.state).toMatchObject({
    status: 'recording',
    scopedTabCount: 1,
    gapCount: 0,
    warnings: [],
  });
  const sessionId = started.state?.sessionId;
  expect(sessionId).toBeTruthy();
  if (!sessionId) throw new Error('Recording did not return a session id.');

  const tabBId = await activateBrowserTab(controlPage, tabB);
  expect(tabBId).not.toBe(tabAId);
  await expectShortGaplessRecording(controlPage, 2);

  await tabB.getByRole('textbox', { name: 'Editable notes' }).fill(marker);
  await tabB.getByLabel('Choice').check();

  const beforeStop = await expectShortGaplessRecording(controlPage, 2);
  expect(beforeStop.activeDurationMs).toBeLessThan(LONG_RECORDING_THRESHOLD_MS);
  const { resultsPage, stoppedState } = await stopAndOpenResults(controlPage, extensionContext);
  expect(stoppedState).toMatchObject({ scopedTabCount: 2, gapCount: 0, warnings: [] });
  expect(stoppedState.activeDurationMs).toBeLessThan(LONG_RECORDING_THRESHOLD_MS);

  const evidence = await readStoredEvidence(extensionWorker);
  const storedSession = requireStoredSession(evidence, sessionId);
  expect(storedSession.state?.gapCount).toBe(0);
  expect(storedSession.state?.recorder?.activeDurationMs).toBeLessThan(
    LONG_RECORDING_THRESHOLD_MS,
  );
  const scopedTabs = storedSession.state?.recorder?.scope?.tabs ?? [];
  expect(scopedTabs).toHaveLength(2);
  expect(scopedTabs).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ tabId: tabAId, parentTabId: null }),
      expect.objectContaining({ tabId: tabBId, parentTabId: null }),
    ]),
  );

  const persisted = sessionEvents(evidence, sessionId);
  const storedTabBId = `tab-${tabBId}`;
  const tabBSemantic = persisted.filter(
    (event) => event.tabId === storedTabBId && event.kind === 'semantic',
  );
  const tabBRrweb = persisted.filter(
    (event) =>
      event.tabId === storedTabBId &&
      event.frameId === 'frame-0' &&
      event.kind === 'rrweb',
  );
  expect(tabBSemantic.length).toBeGreaterThan(0);
  expect(JSON.stringify(tabBSemantic)).toContain(marker);
  expect(tabBRrweb.length).toBeGreaterThan(0);
  expect(JSON.stringify(tabBRrweb)).toContain(marker);
  expect(persisted.filter((event) => event.kind === 'gap')).toHaveLength(0);

  await expect(resultsPage.getByRole('tab')).toHaveCount(2);
  const trace = await downloadTrace(resultsPage);
  expect(trace.session.durationMs).toBeLessThan(LONG_RECORDING_THRESHOLD_MS);
  expect(trace.captureGaps).toEqual([]);
  expect(trace.tabs).toHaveLength(2);
  expect(trace.tabs).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: `tab-${tabAId}` }),
      expect.objectContaining({ id: storedTabBId }),
    ]),
  );
  expect(
    trace.steps.some(
      (step) => step.tabId === storedTabBId && JSON.stringify(step.input).includes(marker),
    ),
  ).toBe(true);
  expect(
    trace.rrweb.segments.some(
      (segment) => segment.tabId === storedTabBId && segment.eventCount > 0,
    ),
  ).toBe(true);
});

test('a newly opened descendant joins without a transient capture gap', async ({
  baseURL,
  controlPage,
  extensionContext,
  extensionWorker,
}) => {
  const marker = 'BUGTRACE_DESCENDANT_TAB_20260818';
  const parentPage = await extensionContext.newPage();
  await parentPage.goto(`${baseURL}/sensitive?case=descendant&tab=parent`);
  const childUrl = `${baseURL}/sensitive?case=descendant&tab=child`;
  await parentPage.evaluate((url) => {
    const link = document.querySelector<HTMLAnchorElement>('a');
    if (!link) throw new Error('Fixture link is unavailable.');
    link.href = '#open-descendant';
    link.addEventListener('click', (event) => {
      event.preventDefault();
      window.open(url, '_blank');
    }, { once: true });
  }, childUrl);

  const parentTabId = await activateBrowserTab(controlPage, parentPage);
  const started = await sendCommand(controlPage, 'record');
  expect(started.ok, started.error).toBe(true);
  expect(started.state).toMatchObject({
    status: 'recording',
    scopedTabCount: 1,
    gapCount: 0,
    warnings: [],
  });
  const sessionId = started.state?.sessionId;
  expect(sessionId).toBeTruthy();
  if (!sessionId) throw new Error('Recording did not return a session id.');

  const childPagePromise = extensionContext.waitForEvent('page');
  await parentPage.getByRole('link', { name: 'Fixture link' }).click();
  const childPage = await childPagePromise;
  await childPage.waitForLoadState('domcontentloaded');
  await expect(childPage).toHaveURL(childUrl);
  await expect(childPage.getByRole('heading', { name: 'Controlled privacy fixture' })).toBeVisible();
  const childTabId = await activateBrowserTab(controlPage, childPage);
  const browserIdentity = await controlPage.evaluate(async (tabId) => {
    const tab = await chrome.tabs.get(tabId);
    return { id: tab.id, openerTabId: tab.openerTabId };
  }, childTabId);
  expect(browserIdentity).toEqual({ id: childTabId, openerTabId: parentTabId });

  await expectShortGaplessRecording(controlPage, 2);
  await childPage.getByRole('textbox', { name: 'Editable notes' }).fill(marker);
  const { resultsPage, stoppedState } = await stopAndOpenResults(controlPage, extensionContext);
  expect(stoppedState).toMatchObject({ scopedTabCount: 2, gapCount: 0, warnings: [] });

  const evidence = await readStoredEvidence(extensionWorker);
  const storedSession = requireStoredSession(evidence, sessionId);
  expect(storedSession.state?.gapCount).toBe(0);
  expect(storedSession.state?.recorder?.scope?.tabs).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ tabId: parentTabId, parentTabId: null }),
      expect.objectContaining({ tabId: childTabId, parentTabId: parentTabId }),
    ]),
  );
  const persisted = sessionEvents(evidence, sessionId);
  const storedChildTabId = `tab-${childTabId}`;
  expect(persisted.filter((event) => event.kind === 'gap')).toHaveLength(0);
  expect(
    persisted.some(
      (event) =>
        event.tabId === storedChildTabId &&
        event.kind === 'semantic' &&
        JSON.stringify(event.data).includes(marker),
    ),
  ).toBe(true);
  expect(
    persisted.some(
      (event) =>
        event.tabId === storedChildTabId &&
        event.frameId === 'frame-0' &&
        event.kind === 'rrweb',
    ),
  ).toBe(true);

  const trace = await downloadTrace(resultsPage);
  expect(trace.captureGaps).toEqual([]);
  expect(trace.tabs).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: storedChildTabId, openerTabId: `tab-${parentTabId}` }),
    ]),
  );
  expect(
    trace.steps.some(
      (step) => step.tabId === storedChildTabId && JSON.stringify(step.input).includes(marker),
    ),
  ).toBe(true);
  expect(trace.rrweb.segments.some((segment) => segment.tabId === storedChildTabId)).toBe(true);
});
