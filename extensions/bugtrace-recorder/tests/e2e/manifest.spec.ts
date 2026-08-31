import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from '@playwright/test';

interface ProductionManifest {
  action?: { default_popup?: string; default_title?: string };
  default_locale?: string;
  description?: string;
  manifest_version: number;
  name?: string;
  permissions?: string[];
  host_permissions?: string[];
  commands?: Record<string, { description?: string }>;
  content_scripts?: Array<{ matches?: string[]; all_frames?: boolean }>;
  content_security_policy?: { extension_pages?: string };
  externally_connectable?: unknown;
  options_ui?: { open_in_tab?: boolean; page?: string };
  side_panel?: { default_path?: string };
}

test('production manifest keeps the reviewed permission boundary', async () => {
  const manifestPath = path.resolve(process.cwd(), '.output/chrome-mv3/manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as ProductionManifest;

  expect(manifest.manifest_version).toBe(3);
  expect([...(manifest.permissions ?? [])].sort()).toEqual([
    'activeTab',
    'sidePanel',
    'storage',
    'webNavigation',
    'webRequest',
  ]);
  expect([...(manifest.host_permissions ?? [])].sort()).toEqual(['<all_urls>']);
  expect(Object.keys(manifest.commands ?? {}).sort()).toEqual(['pause', 'record', 'resume', 'stop']);
  expect(manifest.commands).toMatchObject({
    pause: { description: '__MSG_commandPause__' },
    record: { description: '__MSG_commandRecord__' },
    resume: { description: '__MSG_commandResume__' },
    stop: { description: '__MSG_commandStop__' },
  });
  expect(manifest.default_locale).toBe('en');
  expect(manifest.name).toBe('__MSG_appName__');
  expect(manifest.description).toBe('__MSG_appDescription__');
  expect(manifest.action?.default_title).toBe('__MSG_actionTitle__');
  expect(manifest.side_panel?.default_path).toBe('sidepanel.html');
  expect(manifest.options_ui).toEqual({
    open_in_tab: true,
    page: 'options.html',
  });
  expect(manifest.action?.default_popup).toBeUndefined();

  const forbidden = ['cookies', 'debugger', 'downloads', 'history', 'scripting', 'tabs', 'unlimitedStorage'];
  expect(manifest.permissions ?? []).not.toEqual(expect.arrayContaining(forbidden));
  expect(manifest.externally_connectable).toBeUndefined();
  expect(manifest.content_security_policy?.extension_pages).toContain("object-src 'none'");
  expect(manifest.content_security_policy?.extension_pages).toContain("connect-src 'self' data: blob:");
  expect(manifest.content_security_policy?.extension_pages).toContain(
    "img-src 'self' data: blob: https: http:",
  );
  expect(manifest.content_security_policy?.extension_pages).toContain(
    "style-src 'self' 'unsafe-inline' https: http:",
  );
  expect(manifest.content_security_policy?.extension_pages).toContain(
    "font-src 'self' data: blob: https: http:",
  );
  expect(manifest.content_security_policy?.extension_pages).toContain("form-action 'none'");
  expect(manifest.content_scripts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        all_frames: true,
        matches: ['http://*/*', 'https://*/*'],
      }),
    ]),
  );
});
