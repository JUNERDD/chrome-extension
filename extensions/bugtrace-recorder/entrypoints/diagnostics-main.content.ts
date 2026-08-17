const CHANNEL = 'bugtrace-recorder:v1';

export default defineContentScript({
  matches: ['http://*/*', 'https://*/*'],
  allFrames: true,
  matchOriginAsFallback: true,
  noScriptStartedPostMessage: true,
  runAt: 'document_start',
  world: 'MAIN',
  main() {
    let active = false;
    let previousWarn: typeof console.warn | null = null;
    let previousError: typeof console.error | null = null;
    let warnWrapper: typeof console.warn | null = null;
    let errorWrapper: typeof console.error | null = null;

    const post = (kind: 'console' | 'error', data: Record<string, unknown>): void => {
      if (!active) return;
      window.postMessage({ channel: CHANNEL, kind, data }, location.origin === 'null' ? '*' : location.origin);
    };

    const patchConsole = (): void => {
      if (active) return;
      active = true;
      previousWarn = console.warn;
      previousError = console.error;
      const capturedWarn = previousWarn;
      const capturedError = previousError;
      warnWrapper = function bugtraceWarn(this: Console, ...args: unknown[]) {
        capturedWarn.apply(this, args);
        post('console', { level: 'warn', arguments: args.map((value) => serialize(value)) });
      };
      errorWrapper = function bugtraceError(this: Console, ...args: unknown[]) {
        capturedError.apply(this, args);
        post('console', { level: 'error', arguments: args.map((value) => serialize(value)) });
      };
      console.warn = warnWrapper;
      console.error = errorWrapper;
    };

    const restoreConsole = (): void => {
      active = false;
      if (warnWrapper !== null && previousWarn !== null && console.warn === warnWrapper) {
        console.warn = previousWarn;
      }
      if (errorWrapper !== null && previousError !== null && console.error === errorWrapper) {
        console.error = previousError;
      }
      warnWrapper = null;
      errorWrapper = null;
      previousWarn = null;
      previousError = null;
    };

    window.addEventListener(`${CHANNEL}:diagnostics-start`, patchConsole);
    window.addEventListener(`${CHANNEL}:diagnostics-stop`, restoreConsole);
    window.addEventListener('error', (event) => {
      post('error', {
        type: 'window.error',
        message: truncate(event.message),
        source: redactUrl(event.filename),
        line: event.lineno,
        column: event.colno,
        details: serialize(event.error),
      });
    });
    window.addEventListener('unhandledrejection', (event) => {
      post('error', {
        type: 'unhandledrejection',
        reason: serialize(event.reason),
      });
    });
  },
});

function serialize(value: unknown): unknown {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return redactSecrets(truncate(value));
  if (typeof value === 'bigint') return `${value.toString()}n`;
  if (typeof value === 'undefined') return '[undefined]';
  if (typeof value === 'function') return '[Function]';
  // Any reflection on a page-owned object can execute Proxy traps or accessors and change the
  // application under test. Object diagnostics are deliberately opaque in safe mode.
  if (typeof value === 'object') return '[Object]';
  return truncate(String(value));
}

function truncate(value: string, maxLength = 2_000): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}

function redactUrl(value: string): string {
  try {
    const url = new URL(value, location.href);
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return '[unavailable]';
  }
}

function redactSecrets(value: string): string {
  return value
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [REDACTED]')
    .replace(/\b(?:api[_-]?key|token|password|secret)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]');
}
