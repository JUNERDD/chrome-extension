import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from '@playwright/test';

interface ProductionManifest {
  manifest_version: number;
  permissions?: string[];
  host_permissions?: string[];
  commands?: Record<string, unknown>;
  content_scripts?: Array<{ matches?: string[]; all_frames?: boolean }>;
  content_security_policy?: { extension_pages?: string };
  externally_connectable?: unknown;
}

test('production manifest keeps the reviewed permission boundary', async () => {
  const manifestPath = path.resolve(process.cwd(), '.output/chrome-mv3/manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as ProductionManifest;

  expect(manifest.manifest_version).toBe(3);
  expect([...(manifest.permissions ?? [])].sort()).toEqual([
    'activeTab',
    'storage',
    'webNavigation',
    'webRequest',
  ]);
  expect([...(manifest.host_permissions ?? [])].sort()).toEqual([
    'http://*/*',
    'https://*/*',
  ]);
  expect(Object.keys(manifest.commands ?? {}).sort()).toEqual(['pause', 'record', 'resume', 'stop']);

  const forbidden = ['cookies', 'debugger', 'downloads', 'history', 'scripting', 'tabs', 'unlimitedStorage'];
  expect(manifest.permissions ?? []).not.toEqual(expect.arrayContaining(forbidden));
  expect(manifest.externally_connectable).toBeUndefined();
  expect(manifest.content_security_policy?.extension_pages).toContain("object-src 'none'");
  expect(manifest.content_security_policy?.extension_pages).toContain("connect-src 'self' data: blob:");
  expect(manifest.content_security_policy?.extension_pages).toContain("img-src 'self' data: blob:");
  expect(manifest.content_security_policy?.extension_pages).not.toMatch(/https?:/u);
  expect(manifest.content_scripts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        all_frames: true,
        matches: ['http://*/*', 'https://*/*'],
      }),
    ]),
  );
});
