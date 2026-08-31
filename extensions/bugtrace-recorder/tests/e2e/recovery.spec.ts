import { expect, test } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  launchExtensionContext,
  readState,
  sendCommand,
  setLanguagePreference,
  waitForExtensionWorker,
} from './extension.fixture';

test('browser restart exposes an active recording as interrupted', async ({ baseURL, browserName }) => {
  expect(browserName).toBe('chromium');
  const profileDirectory = await mkdtemp(path.join(tmpdir(), 'bugtrace-restart-'));
  let context = await launchExtensionContext(profileDirectory);

  try {
    let worker = await waitForExtensionWorker(context);
    await setLanguagePreference(worker, 'en');
    const extensionId = new URL(worker.url()).hostname;
    let controlPage = await context.newPage();
    await controlPage.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    const fixturePage = await context.newPage();
    await fixturePage.goto(`${baseURL}/sensitive`);

    const started = await sendCommand(controlPage, 'record');
    expect(started.ok, started.error).toBe(true);
    expect(started.state?.status).toBe('recording');
    await fixturePage.getByLabel('Password').fill('restart-boundary-value');
    await fixturePage.waitForTimeout(400);

    await context.close();
    context = await launchExtensionContext(profileDirectory);
    worker = await waitForExtensionWorker(context);
    controlPage = await context.newPage();
    await controlPage.goto(`chrome-extension://${new URL(worker.url()).hostname}/sidepanel.html`);

    const recovered = await readState(controlPage);
    expect(recovered.ok, recovered.error).toBe(true);
    expect(recovered.state?.status).toBe('interrupted');
    await expect(controlPage.getByText('Interrupted', { exact: true })).toBeVisible();
    await expect(controlPage.getByText('Recording did not silently resume.', { exact: false })).toBeVisible();
  } finally {
    await context.close().catch(() => undefined);
    await rm(profileDirectory, { recursive: true, force: true });
  }
});
