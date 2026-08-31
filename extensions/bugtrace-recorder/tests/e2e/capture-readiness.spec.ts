import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  expect,
  extensionPath,
  launchExtensionContext,
  readState,
  readStoredEvidence,
  sendCommand,
  test,
  waitForExtensionWorker,
} from './extension.fixture';

test('record rejects an HTTP page without a capture client before creating a session', async ({
  baseURL,
}) => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'bugtrace-no-content-client-'));
  const isolatedExtensionPath = path.join(temporaryRoot, 'extension');
  await cp(extensionPath, isolatedExtensionPath, { recursive: true });

  const manifestPath = path.join(isolatedExtensionPath, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
    content_scripts?: Array<{ matches?: string[] }>;
  };
  for (const contentScript of manifest.content_scripts ?? []) {
    contentScript.matches = ['https://no-capture-client.invalid/*'];
  }
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  const extensionContext = await launchExtensionContext(
    path.join(temporaryRoot, 'profile'),
    isolatedExtensionPath,
  );
  try {
    const extensionWorker = await waitForExtensionWorker(extensionContext);
    const extensionId = new URL(extensionWorker.url()).hostname;
    const controlPage = await extensionContext.newPage();
    await controlPage.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    const targetPage = await extensionContext.newPage();
    await targetPage.goto(`${baseURL}/sensitive`);
    await expect(targetPage.getByRole('heading', { name: 'Controlled privacy fixture' })).toBeVisible();

    const rejected = await sendCommand(controlPage, 'record');
    expect(rejected).toMatchObject({
      ok: false,
      errorCode: 'capture_client_unavailable',
      state: { status: 'idle', sessionId: null, eventCount: 0, gapCount: 0 },
    });
    expect(await readState(controlPage)).toMatchObject({
      ok: true,
      state: { status: 'idle', sessionId: null, eventCount: 0, gapCount: 0 },
    });

    const evidence = await readStoredEvidence(extensionWorker);
    expect(evidence.sessions).toHaveLength(0);
    expect(evidence.events).toHaveLength(0);
    expect(evidence.assets).toHaveLength(0);

    await targetPage.bringToFront();
    // The test hosts sidepanel.html in a normal tab; a DOM click keeps the HTTP fixture active,
    // matching Chrome's real Side Panel behavior while still exercising the React command handler.
    await controlPage.getByRole('button', { name: /Start recording/u }).evaluate((button) => {
      (button as HTMLButtonElement).click();
    });
    await expect(controlPage.getByText('Refresh the page to enable capture', { exact: true })).toBeVisible();
    await expect(
      controlPage.getByText(
        'The Bugtrace capture client is unavailable in this tab. Refresh the current HTTP(S) page, then retry the operation.',
        { exact: true },
      ),
    ).toBeVisible();
  } finally {
    await extensionContext.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
