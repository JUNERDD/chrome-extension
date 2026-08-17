import JSZip from 'jszip';
import { readFile } from 'node:fs/promises';
import type { Worker } from '@playwright/test';
import {
  expect,
  readState,
  readStoredEvidence,
  sendCommand,
  test,
} from './extension.fixture';

const sentinels = {
  password: 'BUGTRACE_SENTINEL_PASSWORD_e97ea1',
  otp: 'BUGTRACE_SENTINEL_OTP_147258',
  token: 'BUGTRACE_SENTINEL_TOKEN_d8b639',
  paused: 'BUGTRACE_SENTINEL_PAUSED_c52748',
  query: 'BUGTRACE_SENTINEL_QUERY_263afa',
  console: 'BUGTRACE_SENTINEL_CONSOLE_5d93b6',
  network: 'BUGTRACE_SENTINEL_NETWORK_808b54',
  hidden: 'BUGTRACE_SENTINEL_HIDDEN_123456',
  checkbox: 'BUGTRACE_SENTINEL_CHECKBOX_lowsecret',
  optionValue: 'BUGTRACE_SENTINEL_OPTION_VALUE_f48b',
  optionText: 'BUGTRACE_SENTINEL_OPTION_TEXT_38ab',
  editable: 'shortsecret',
  privateTarget: 'BUGTRACE_SENTINEL_PRIVATE_BUTTON_7ce2',
  maskedTarget: 'BUGTRACE_SENTINEL_MASK_BUTTON_5ab4',
  dataToken: 'BUGTRACE_SENTINEL_DATA_TOKEN_12cd',
  dataUrl: 'BUGTRACE_SENTINEL_DATA_URL_91ef',
  attributeUrl: 'BUGTRACE_SENTINEL_ATTR_URL_48aa',
  handler: 'BUGTRACE_SENTINEL_HANDLER_d330',
  srcdoc: 'BUGTRACE_SENTINEL_SRCDOC_8bad',
  card: '4242 4242 4242 4242',
  unicodeCard: '4242\u00a04242\u22124242\u20094242',
  ariaEcho: 'echo7',
  objectData: 'BUGTRACE_SENTINEL_OBJECT_DATA_27ca',
  cssText: 'BUGTRACE_SENTINEL_CSS_TEXT_17bf',
  roleValue: 'BUGTRACE_SENTINEL_ROLE_VALUE_72bd',
  roleText: 'BUGTRACE_SENTINEL_ROLE_TEXT_83ce',
  zeroBox: 'BUGTRACE_SENTINEL_ZERO_BOX_3fd1',
  openShadow: 'BUGTRACE_SENTINEL_OPEN_SHADOW_4ac2',
} as const;

async function readSensitiveRects(
  worker: Worker,
  targetUrl: string,
): Promise<{ rects: Array<{ x: number; y: number; width: number; height: number }> }> {
  return worker.evaluate(async (url) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((candidate) => candidate.url === url);
    if (tab?.id === undefined) throw new Error(`Fixture tab not found for ${url}`);
    return chrome.tabs.sendMessage(
      tab.id,
      { type: 'CAPTURE_SCREENSHOT_RECTS' },
      { frameId: 0 },
    ) as Promise<{ rects: Array<{ x: number; y: number; width: number; height: number }> }>;
  }, targetUrl);
}

test('recording lifecycle stores redacted evidence and excludes paused input', async ({
  baseURL,
  controlPage,
  extensionContext,
  extensionWorker,
}) => {
  const page = await extensionContext.newPage();
  await page.goto(`${baseURL}/sensitive?token=${sentinels.query}`);
  await expect(page.getByRole('heading', { name: 'Controlled privacy fixture' })).toBeVisible();
  const sensitiveRects = await readSensitiveRects(extensionWorker, page.url());
  expect(sensitiveRects.rects.some((rect) => rect.width === 257 && rect.height === 61)).toBe(true);
  expect(sensitiveRects.rects.some((rect) => rect.width === 233 && rect.height === 53)).toBe(true);

  const started = await sendCommand(controlPage, 'record');
  expect(started.ok, started.error).toBe(true);
  expect(started.state?.status).toBe('recording');

  await page.getByLabel('Password').fill(sentinels.password);
  await page.getByLabel('One-time code').fill(sentinels.otp);
  await page.getByLabel('API token').fill(sentinels.token);
  await page.getByLabel('Choice').check();
  await page.getByLabel('Secret option').selectOption('safe');
  await page.getByRole('textbox', { name: 'Editable notes' }).fill(sentinels.editable);
  await page.locator('#aria-echo').fill(sentinels.ariaEcho);
  await page.getByRole('button', { name: sentinels.privateTarget }).click();
  await page.getByRole('button', { name: sentinels.maskedTarget }).click();
  await page.getByRole('button', { name: 'Emit controlled diagnostics' }).click();
  await expect(page.getByText('diagnostics emitted')).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __appWarnCount: number }).__appWarnCount)).toBe(1);
  await page.waitForTimeout(500);

  const paused = await sendCommand(controlPage, 'pause');
  expect(paused.ok, paused.error).toBe(true);
  expect(paused.state?.status).toBe('paused');
  const wrapperState = await page.evaluate(() => {
    const fixtureWindow = window as unknown as {
      __appWarnCount: number;
      __appWarnWrapper: typeof console.warn;
    };
    const restored = console.warn === fixtureWindow.__appWarnWrapper;
    console.warn('safe paused diagnostic');
    return { restored, count: fixtureWindow.__appWarnCount };
  });
  expect(wrapperState).toEqual({ restored: true, count: 2 });
  await page.getByLabel('Paused-only value').fill(sentinels.paused);
  await page.waitForTimeout(500);

  const resumed = await sendCommand(controlPage, 'resume');
  expect(resumed.ok, resumed.error).toBe(true);
  expect(resumed.state?.status).toBe('recording');
  await page.getByRole('button', { name: 'Submit fixture' }).click();
  await expect(page.getByText('submitted')).toBeVisible();

  const resultsPagePromise = extensionContext.waitForEvent('page', {
    predicate: (candidate) => candidate.url().includes('/results.html?session='),
  });
  const stopped = await sendCommand(controlPage, 'stop');
  expect(stopped.ok, stopped.error).toBe(true);
  expect(stopped.state?.status).toBe('completed');
  const resultsPage = await resultsPagePromise;
  await expect(resultsPage.getByRole('heading', { name: 'Evidence review' })).toBeVisible();

  const state = await readState(controlPage);
  expect(state.state?.status).toBe('completed');
  expect(state.state?.eventCount).toBeGreaterThan(4);

  const evidence = await readStoredEvidence(extensionWorker);
  expect(evidence.sessions).toHaveLength(1);
  expect(evidence.events.length).toBeGreaterThan(4);

  const semanticFills = evidence.events.filter((event) => {
    if (event.kind !== 'semantic' || typeof event.data !== 'object' || event.data === null) return false;
    return (event.data as { action?: unknown }).action === 'fill';
  });
  expect(JSON.stringify(semanticFills)).toContain('password');
  expect(JSON.stringify(semanticFills)).not.toContain('paused-value');

  const serializedEvidence = JSON.stringify(evidence);
  for (const sentinel of Object.values(sentinels)) {
    expect(serializedEvidence, `stored evidence leaked ${sentinel}`).not.toContain(sentinel);
  }

  expect(serializedEvidence).toContain('"state":"redacted"');
  expect(serializedEvidence).toContain('"requestBody":{"state":"omitted"}');
  expect(serializedEvidence).toContain('<redacted>');

  const downloadPromise = resultsPage.waitForEvent('download', { timeout: 20_000 });
  await resultsPage.getByRole('button', { name: 'Download .bugtrace.zip', exact: true }).click();
  const download = await downloadPromise;
  const downloadPath = await download.path();
  expect(downloadPath).not.toBeNull();
  if (downloadPath === null) throw new Error('Playwright did not retain the downloaded Bugtrace ZIP.');

  const zip = await JSZip.loadAsync(await readFile(downloadPath));
  expect(Object.keys(zip.files)).toEqual(
    expect.arrayContaining([
      'manifest.json',
      'report.md',
      'trace.json',
      'schema/bugtrace-v1.schema.json',
      'attachments/lifecycle.json',
    ]),
  );
  const exportedText = (
    await Promise.all(
      Object.values(zip.files)
        .filter((entry) => !entry.dir && !entry.name.startsWith('screenshots/'))
        .map((entry) => entry.async('string')),
    )
  ).join('\n');
  for (const sentinel of Object.values(sentinels)) {
    expect(exportedText, `exported ZIP leaked ${sentinel}`).not.toContain(sentinel);
  }
});

test('immediate stop flushes input and a new same-page session records before discard', async ({
  baseURL,
  controlPage,
  extensionContext,
  extensionWorker,
}) => {
  const page = await extensionContext.newPage();
  await page.goto(`${baseURL}/sensitive`);

  const first = await sendCommand(controlPage, 'record');
  expect(first.ok, first.error).toBe(true);
  const firstSessionId = first.state?.sessionId;
  expect(firstSessionId).toBeTruthy();
  await page.getByLabel('Paused-only value').fill('tail-value');

  const resultsPagePromise = extensionContext.waitForEvent('page', {
    predicate: (candidate) => candidate.url().includes('/results.html?session='),
  });
  const stopped = await sendCommand(controlPage, 'stop');
  expect(stopped.ok, stopped.error).toBe(true);
  const firstResultsPage = await resultsPagePromise;

  const afterFirstStop = await readStoredEvidence(extensionWorker);
  expect(
    afterFirstStop.events.some(
      (event) =>
        event.sessionId === firstSessionId &&
        event.kind === 'semantic' &&
        (event.data as { action?: unknown } | undefined)?.action === 'fill',
    ),
  ).toBe(true);

  await firstResultsPage.bringToFront();
  const rejected = await sendCommand(controlPage, 'record');
  expect(rejected.ok).toBe(false);
  expect(rejected.state?.status).toBe('completed');
  expect(rejected.state?.sessionId).toBe(firstSessionId);
  const afterRejected = await readState(controlPage);
  expect(afterRejected.state?.status).toBe('completed');
  expect(afterRejected.state?.sessionId).toBe(firstSessionId);

  await page.bringToFront();
  const second = await sendCommand(controlPage, 'record');
  expect(second.ok, second.error).toBe(true);
  const secondSessionId = second.state?.sessionId;
  expect(secondSessionId).toBeTruthy();
  expect(secondSessionId).not.toBe(firstSessionId);
  await page.getByRole('button', { name: 'Submit fixture' }).click();
  const paused = await sendCommand(controlPage, 'pause');
  expect(paused.ok, paused.error).toBe(true);

  const beforeDiscard = await readStoredEvidence(extensionWorker);
  expect(
    beforeDiscard.events.some(
      (event) =>
        event.sessionId === secondSessionId &&
        event.kind === 'semantic' &&
        (event.data as { action?: unknown } | undefined)?.action === 'submit',
    ),
  ).toBe(true);

  const discarded = await sendCommand(controlPage, 'discard');
  expect(discarded.ok, discarded.error).toBe(true);
  expect(discarded.state?.status).toBe('idle');
  await page.getByRole('button', { name: 'Emit controlled diagnostics' }).click();
  await page.waitForTimeout(400);

  const afterDiscard = await readStoredEvidence(extensionWorker);
  expect(afterDiscard.sessions).toHaveLength(1);
  expect(afterDiscard.events.some((event) => event.sessionId === secondSessionId)).toBe(false);
});
