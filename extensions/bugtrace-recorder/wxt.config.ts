import { readFileSync } from 'node:fs';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'wxt';

const packageJson = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
) as { version: string };

export default defineConfig({
  manifestVersion: 3,
  modules: ['@wxt-dev/module-react'],
  vite: () => ({
    plugins: [tailwindcss()],
  }),
  zip: {
    name: 'bugtrace-recorder',
    zipSources: false,
  },
  dev: {
    reloadCommand: false,
  },
  manifest: {
    default_locale: 'en',
    name: '__MSG_appName__',
    description: '__MSG_appDescription__',
    version: packageJson.version,
    minimum_chrome_version: '114',
    permissions: ['activeTab', 'storage', 'webNavigation', 'webRequest'],
    // Chrome's captureVisibleTab API requires the exact <all_urls> host grant (or a
    // transient activeTab grant). The Side Panel can outlive the gesture that opened
    // it, so the internal full-fidelity build uses the persistent grant; runtime
    // capture scope remains restricted to normal HTTP(S) pages.
    host_permissions: ['<all_urls>'],
    content_security_policy: {
      extension_pages:
        "script-src 'self'; object-src 'none'; connect-src 'self' data: blob:; img-src 'self' data: blob: https: http:; media-src 'self' data: blob: https: http:; frame-src 'self' data: blob:; style-src 'self' 'unsafe-inline' https: http:; font-src 'self' data: blob: https: http:; form-action 'none'; base-uri 'none';",
    },
    commands: {
      record: {
        suggested_key: {
          default: 'Alt+Shift+R',
          mac: 'MacCtrl+Shift+R',
        },
        description: '__MSG_commandRecord__',
      },
      pause: {
        suggested_key: {
          default: 'Alt+Shift+P',
          mac: 'MacCtrl+Shift+P',
        },
        description: '__MSG_commandPause__',
      },
      resume: {
        suggested_key: {
          default: 'Alt+Shift+C',
          mac: 'MacCtrl+Shift+C',
        },
        description: '__MSG_commandResume__',
      },
      stop: {
        suggested_key: {
          default: 'Alt+Shift+S',
          mac: 'MacCtrl+Shift+S',
        },
        description: '__MSG_commandStop__',
      },
    },
    action: {
      default_title: '__MSG_actionTitle__',
    },
  },
});
