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
        source: truncate(event.filename, 8_192),
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

function serialize(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return truncate(value, 16_384);
  if (typeof value === 'bigint') return `${value.toString()}n`;
  if (typeof value === 'undefined') return '[undefined]';
  if (typeof value === 'function') return '[Function]';
  if (typeof value === 'object') {
    if (depth >= 5) return '[MaxDepth]';
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    let descriptors: Record<string, PropertyDescriptor>;
    try {
      descriptors = Object.getOwnPropertyDescriptors(value);
    } catch {
      return '[Uninspectable]';
    }
    if (Array.isArray(value)) {
      const declaredLength = typeof descriptors.length?.value === 'number'
        ? descriptors.length.value
        : 0;
      const result: unknown[] = [];
      for (let index = 0; index < Math.min(declaredLength, 200); index += 1) {
        const descriptor = descriptors[String(index)];
        result.push(descriptor && 'value' in descriptor
          ? serialize(descriptor.value, depth + 1, seen)
          : '[Accessor]');
      }
      if (declaredLength > result.length) result.push(`[${declaredLength - result.length} more items]`);
      return result;
    }
    const result: Record<string, unknown> = {};
    for (const [key, descriptor] of Object.entries(descriptors)
      .filter(([name, item]) => name !== '__proto__' && item.enumerable)
      .slice(0, 100)) {
      result[truncate(key, 1_000)] = 'value' in descriptor
        ? serialize(descriptor.value, depth + 1, seen)
        : '[Accessor]';
    }
    return result;
  }
  return truncate(String(value));
}

function truncate(value: string, maxLength = 2_000): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}
