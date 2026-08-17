import { defineConfig } from 'wxt';

export default defineConfig({
  manifestVersion: 3,
  modules: ['@wxt-dev/module-react'],
  dev: {
    reloadCommand: false,
  },
  manifest: {
    name: 'Bugtrace Recorder',
    description: 'Capture privacy-conscious browser reproduction evidence for bug reports and agents.',
    version: '0.1.0',
    permissions: ['activeTab', 'storage', 'webNavigation', 'webRequest'],
    host_permissions: ['http://*/*', 'https://*/*'],
    content_security_policy: {
      extension_pages:
        "script-src 'self'; object-src 'none'; connect-src 'self' data: blob:; img-src 'self' data: blob:; media-src 'none'; frame-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; font-src 'self' data:;",
    },
    commands: {
      record: {
        suggested_key: {
          default: 'Alt+Shift+R',
          mac: 'MacCtrl+Shift+R',
        },
        description: 'Start recording the current tab',
      },
      pause: {
        suggested_key: {
          default: 'Alt+Shift+P',
          mac: 'MacCtrl+Shift+P',
        },
        description: 'Pause the active recording',
      },
      resume: {
        suggested_key: {
          default: 'Alt+Shift+C',
          mac: 'MacCtrl+Shift+C',
        },
        description: 'Resume the paused recording',
      },
      stop: {
        suggested_key: {
          default: 'Alt+Shift+S',
          mac: 'MacCtrl+Shift+S',
        },
        description: 'Stop and review the recording',
      },
    },
    action: {
      default_title: 'Bugtrace Recorder',
    },
  },
});
