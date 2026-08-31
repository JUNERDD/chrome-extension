import { expect, test } from './extension.fixture';

const imageUrl = 'https://recorded.test/replay-image.svg';
const stylesheetUrl = 'https://recorded.test/replay.css';
const scriptUrl = 'https://recorded.test/replay.js';

function replayEvents(): unknown[] {
  return [
    {
      type: 4,
      timestamp: 1_000,
      data: {
        href: 'https://recorded.test/page',
        width: 320,
        height: 240,
      },
    },
    {
      type: 2,
      timestamp: 1_020,
      data: {
        node: {
          type: 0,
          id: 1,
          childNodes: [
            {
              type: 1,
              id: 2,
              name: 'html',
              publicId: '',
              systemId: '',
            },
            {
              type: 2,
              id: 3,
              tagName: 'html',
              attributes: {},
              childNodes: [
                {
                  type: 2,
                  id: 4,
                  tagName: 'head',
                  attributes: {},
                  childNodes: [
                    {
                      type: 2,
                      id: 5,
                      tagName: 'link',
                      attributes: { href: stylesheetUrl, rel: 'stylesheet' },
                      childNodes: [],
                    },
                    {
                      type: 2,
                      id: 6,
                      tagName: 'style',
                      attributes: {},
                      childNodes: [
                        {
                          type: 3,
                          id: 7,
                          isStyle: true,
                          textContent: '.inline-style { border-top: 7px solid black; }',
                        },
                      ],
                    },
                    {
                      type: 2,
                      id: 15,
                      tagName: 'script',
                      attributes: {},
                      childNodes: [
                        {
                          type: 3,
                          id: 16,
                          textContent: "window.top.__replayEscaped = 'inline-script'",
                        },
                      ],
                    },
                    {
                      type: 2,
                      id: 17,
                      tagName: 'script',
                      attributes: { src: scriptUrl },
                      childNodes: [],
                    },
                  ],
                },
                {
                  type: 2,
                  id: 8,
                  tagName: 'body',
                  attributes: {},
                  childNodes: [
                    {
                      type: 2,
                      id: 9,
                      tagName: 'div',
                      attributes: {
                        class: 'external-style inline-style',
                        id: 'recorded-style',
                      },
                      childNodes: [{ type: 3, id: 10, textContent: 'Recorded style' }],
                    },
                    {
                      type: 2,
                      id: 11,
                      tagName: 'img',
                      attributes: {
                        id: 'recorded-image',
                        onload: "window.top.__replayEscaped = 'event-handler'",
                        src: imageUrl,
                      },
                      childNodes: [],
                    },
                    {
                      type: 2,
                      id: 12,
                      tagName: 'canvas',
                      attributes: { height: '2', id: 'recorded-canvas', width: '2' },
                      childNodes: [],
                    },
                    {
                      type: 2,
                      id: 13,
                      tagName: 'button',
                      attributes: { id: 'recorded-button', type: 'button' },
                      childNodes: [{ type: 3, id: 14, textContent: 'Recorded button' }],
                    },
                  ],
                },
              ],
            },
          ],
        },
        initialOffset: { left: 0, top: 0 },
      },
    },
    {
      type: 3,
      timestamp: 2_000,
      data: {
        source: 9,
        id: 12,
        type: 0,
        commands: [
          { args: ['rgb(201, 17, 29)'], property: 'fillStyle', setter: true },
          { args: [0, 0, 2, 2], property: 'fillRect' },
        ],
      },
    },
    {
      type: 3,
      timestamp: 3_000,
      data: { source: 2, type: 5, id: 13, x: 0, y: 0 },
    },
  ];
}

test('generated sandbox replays external and inline styles, images, canvas, and focus', async ({
  extensionContext,
  extensionId,
}) => {
  const requestedResources: string[] = [];
  await extensionContext.route('https://recorded.test/**', async (route) => {
    const url = route.request().url();
    requestedResources.push(url);
    if (url === stylesheetUrl) {
      await route.fulfill({
        body: '.external-style { color: rgb(12, 34, 56); }',
        contentType: 'text/css',
      });
      return;
    }
    await route.fulfill({
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="3" height="2"><rect width="3" height="2" fill="#147bc1"/></svg>',
      contentType: 'image/svg+xml',
    });
  });

  const page = await extensionContext.newPage();
  await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await page.evaluate(async ({ replayUrl }) => {
    const statuses: unknown[] = [];
    Object.assign(window, { __replayStatuses: statuses });
    const frame = document.createElement('iframe');
    frame.id = 'replay-host';
    frame.style.border = '0';
    frame.style.display = 'block';
    frame.style.height = '450px';
    frame.style.width = '800px';
    frame.setAttribute('sandbox', 'allow-same-origin allow-scripts');
    window.addEventListener('message', (event) => {
      if (event.source === frame.contentWindow) statuses.push(event.data);
    });
    const loaded = new Promise<void>((resolve, reject) => {
      frame.addEventListener('load', () => resolve(), { once: true });
      frame.addEventListener('error', () => reject(new Error('Replay host failed to load.')), {
        once: true,
      });
    });
    frame.src = replayUrl;
    document.body.replaceChildren(frame);
    await loaded;
  }, { replayUrl: `chrome-extension://${extensionId}/replay-sandbox.html` });
  expect(
    await page.evaluate(() => {
      const host = document.querySelector<HTMLIFrameElement>('#replay-host');
      const hostWindow = host?.contentWindow as (Window & {
        browser?: unknown;
        chrome?: unknown;
      }) | null;
      return {
        browser: typeof hostWindow?.browser,
        chrome: typeof hostWindow?.chrome,
        sandbox: Array.from(host?.sandbox ?? []).sort(),
      };
    }),
  ).toEqual({
    browser: 'undefined',
    chrome: 'undefined',
    sandbox: ['allow-same-origin', 'allow-scripts'],
  });
  const channel = crypto.randomUUID();
  await page.evaluate(
    ({ replayChannel, events }) => {
      document
        .querySelector<HTMLIFrameElement>('#replay-host')
        ?.contentWindow?.postMessage({ channel: replayChannel, events, type: 'mount' }, '*');
    },
    { events: replayEvents(), replayChannel: channel },
  );

  await expect
    .poll(() =>
      page.evaluate(
        ({ replayChannel }) =>
          (window as typeof window & { __replayStatuses?: unknown[] }).__replayStatuses
            ?.filter(
              (status) =>
                typeof status === 'object' &&
                status !== null &&
                'channel' in status &&
                status.channel === replayChannel &&
                'type' in status,
            )
            .map((status) => {
              const event = status as { reason?: string; type: string };
              return event.reason ? `${event.type}:${event.reason}` : event.type;
            }) ?? [],
        { replayChannel: channel },
      ),
    )
    .toContain('ready');

  type PlaybackStatus = {
    channel: string;
    currentTimeMs: number;
    durationMs: number;
    ended: boolean;
    playing: boolean;
    type: 'progress' | 'ready' | 'state';
  };
  const readPlaybackStatuses = () =>
    page.evaluate(
      ({ replayChannel }) =>
        ((window as typeof window & { __replayStatuses?: unknown[] }).__replayStatuses ?? [])
          .filter(
            (status): status is PlaybackStatus =>
              typeof status === 'object' &&
              status !== null &&
              'channel' in status &&
              status.channel === replayChannel &&
              'type' in status &&
              ['progress', 'ready', 'state'].includes(String(status.type)),
          ),
      { replayChannel: channel },
    );
  const postControl = (command: { timeMs?: number; type: 'pause' | 'play' | 'seek' }) =>
    page.evaluate(
      ({ replayChannel, replayCommand }) => {
        document
          .querySelector<HTMLIFrameElement>('#replay-host')
          ?.contentWindow?.postMessage({ channel: replayChannel, ...replayCommand }, '*');
      },
      { replayChannel: channel, replayCommand: command },
    );

  await expect
    .poll(async () => (await readPlaybackStatuses()).find((status) => status.type === 'ready'))
    .toEqual({
      channel,
      currentTimeMs: 0,
      durationMs: 2_000,
      ended: false,
      playing: false,
      type: 'ready',
    });

  const readReplayGeometry = () =>
    page.evaluate(() => {
      const host = document.querySelector<HTMLIFrameElement>('#replay-host');
      const replayRoot = host?.contentDocument?.querySelector<HTMLElement>('#replay-root');
      const wrapper = replayRoot?.querySelector<HTMLElement>('.replayer-wrapper');
      const replayFrame = wrapper?.querySelector<HTMLIFrameElement>('iframe');
      if (!replayRoot || !wrapper || !replayFrame) return null;
      const rootRect = replayRoot.getBoundingClientRect();
      const wrapperRect = wrapper.getBoundingClientRect();
      return {
        frameHeight: replayFrame.getAttribute('height'),
        frameWidth: replayFrame.getAttribute('width'),
        rootHeight: Math.round(rootRect.height),
        rootScrollHeight: replayRoot.scrollHeight,
        rootScrollWidth: replayRoot.scrollWidth,
        rootWidth: Math.round(rootRect.width),
        wrapperHeight: Math.round(wrapperRect.height),
        wrapperLeft: Math.round(wrapperRect.left - rootRect.left),
        wrapperTop: Math.round(wrapperRect.top - rootRect.top),
        wrapperWidth: Math.round(wrapperRect.width),
      };
    });

  await expect.poll(readReplayGeometry).toEqual({
    frameHeight: '240',
    frameWidth: '320',
    rootHeight: 450,
    rootScrollHeight: 450,
    rootScrollWidth: 800,
    rootWidth: 800,
    wrapperHeight: 450,
    wrapperLeft: 100,
    wrapperTop: 0,
    wrapperWidth: 600,
  });

  await page.locator('#replay-host').evaluate((host) => {
    host.style.height = '400px';
    host.style.width = '400px';
  });
  await expect.poll(readReplayGeometry).toEqual({
    frameHeight: '240',
    frameWidth: '320',
    rootHeight: 400,
    rootScrollHeight: 400,
    rootScrollWidth: 400,
    rootWidth: 400,
    wrapperHeight: 300,
    wrapperLeft: 0,
    wrapperTop: 50,
    wrapperWidth: 400,
  });

  await postControl({ type: 'play' });
  await expect
    .poll(async () => {
      const statuses = await readPlaybackStatuses();
      return statuses.findLast(
        (status) => status.type === 'progress' && status.currentTimeMs >= 100,
      );
    })
    .toMatchObject({ durationMs: 2_000, ended: false, playing: true });

  await postControl({ type: 'pause' });
  await expect
    .poll(async () => (await readPlaybackStatuses()).findLast((status) => status.type === 'state'))
    .toMatchObject({ ended: false, playing: false });
  const pausedTime =
    (await readPlaybackStatuses()).findLast((status) => status.type === 'state')
      ?.currentTimeMs ?? 0;
  expect(pausedTime).toBeGreaterThanOrEqual(100);
  const progressCountWhilePaused = (await readPlaybackStatuses()).filter(
    (status) => status.type === 'progress',
  ).length;
  await page.waitForTimeout(250);
  expect(
    (await readPlaybackStatuses()).filter((status) => status.type === 'progress'),
  ).toHaveLength(progressCountWhilePaused);

  await postControl({ type: 'play' });
  await expect
    .poll(async () => {
      const statuses = await readPlaybackStatuses();
      return statuses.findLast(
        (status) => status.type === 'progress' && status.currentTimeMs > pausedTime,
      );
    })
    .toMatchObject({ ended: false, playing: true });
  await postControl({ type: 'pause' });
  await expect
    .poll(async () => (await readPlaybackStatuses()).findLast((status) => status.type === 'state'))
    .toMatchObject({ ended: false, playing: false });

  await postControl({ timeMs: 1_600, type: 'seek' });
  await expect
    .poll(async () => (await readPlaybackStatuses()).findLast((status) => status.type === 'state'))
    .toMatchObject({
      currentTimeMs: 1_600,
      durationMs: 2_000,
      ended: false,
      playing: false,
    });
  await postControl({ type: 'play' });
  await expect
    .poll(async () => (await readPlaybackStatuses()).findLast((status) => status.type === 'state'))
    .toMatchObject({
      currentTimeMs: 2_000,
      durationMs: 2_000,
      ended: true,
      playing: false,
    });
  const progressCountAtEnd = (await readPlaybackStatuses()).filter(
    (status) => status.type === 'progress',
  ).length;
  await page.waitForTimeout(250);
  expect(
    (await readPlaybackStatuses()).filter((status) => status.type === 'progress'),
  ).toHaveLength(progressCountAtEnd);

  await expect
    .poll(() =>
      page.evaluate(() => {
        const host = document.querySelector<HTMLIFrameElement>('#replay-host');
        const frame = host?.contentDocument?.querySelector<HTMLIFrameElement>(
          '#replay-root iframe',
        );
        const replayDocument = frame?.contentDocument;
        const styled = replayDocument?.getElementById('recorded-style');
        const image = replayDocument?.querySelector<HTMLImageElement>('#recorded-image');
        const canvas = replayDocument?.querySelector<HTMLCanvasElement>('#recorded-canvas');
        if (!frame || !replayDocument || !styled || !image || !canvas) return null;
        return {
          activeElement: replayDocument.activeElement?.id,
          canvasPixel: Array.from(
            canvas.getContext('2d')?.getImageData(0, 0, 1, 1).data ?? [],
          ),
          color: replayDocument.defaultView?.getComputedStyle(styled).color,
          imageHeight: image.naturalHeight,
          imageWidth: image.naturalWidth,
          inlineBorderWidth:
            replayDocument.defaultView?.getComputedStyle(styled).borderTopWidth,
          replayChrome: typeof (
            frame.contentWindow as (Window & { chrome?: unknown }) | null
          )?.chrome,
          replaySandbox: Array.from(frame.sandbox).sort(),
          escaped: (window as typeof window & { __replayEscaped?: string })
            .__replayEscaped,
        };
      }),
    )
    .toEqual({
      activeElement: 'recorded-button',
      canvasPixel: [201, 17, 29, 255],
      color: 'rgb(12, 34, 56)',
      imageHeight: 2,
      imageWidth: 3,
      inlineBorderWidth: '7px',
      replayChrome: 'undefined',
      replaySandbox: ['allow-same-origin', 'allow-scripts'],
      escaped: undefined,
    });

  expect([...new Set(requestedResources)].sort()).toEqual([imageUrl, stylesheetUrl].sort());
  expect(requestedResources).not.toContain(scriptUrl);
});

test('sandbox replays every keyboard operation on the fitted recording surface', async ({
  extensionContext,
  extensionId,
}) => {
  const page = await extensionContext.newPage();
  await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await page.evaluate(async ({ replayUrl }) => {
    const statuses: unknown[] = [];
    Object.assign(window, { __keyboardReplayStatuses: statuses });
    const frame = document.createElement('iframe');
    frame.id = 'keyboard-replay-host';
    frame.style.height = '360px';
    frame.style.width = '640px';
    frame.setAttribute('sandbox', 'allow-same-origin allow-scripts');
    window.addEventListener('message', (event) => {
      if (event.source === frame.contentWindow) statuses.push(event.data);
    });
    const loaded = new Promise<void>((resolve, reject) => {
      frame.addEventListener('load', () => resolve(), { once: true });
      frame.addEventListener('error', () => reject(new Error('Replay host failed to load.')), {
        once: true,
      });
    });
    frame.src = replayUrl;
    document.body.replaceChildren(frame);
    await loaded;
  }, { replayUrl: `chrome-extension://${extensionId}/replay-sandbox.html` });

  const channel = crypto.randomUUID();
  const nativeEvents = replayEvents().slice(0, 2);
  const post = (command: Record<string, unknown>) =>
    page.evaluate(
      ({ replayChannel, replayCommand }) => {
        document
          .querySelector<HTMLIFrameElement>('#keyboard-replay-host')
          ?.contentWindow?.postMessage({ channel: replayChannel, ...replayCommand }, '*');
      },
      { replayChannel: channel, replayCommand: command },
    );
  const readReplayEnded = () =>
    page.evaluate(
      ({ replayChannel }) => {
        const statuses = (window as typeof window & { __keyboardReplayStatuses?: unknown[] })
          .__keyboardReplayStatuses ?? [];
        const latest = statuses.findLast(
          (status) =>
            typeof status === 'object' &&
            status !== null &&
            'channel' in status &&
            status.channel === replayChannel &&
            'ended' in status,
        );
        return typeof latest === 'object' && latest !== null && 'ended' in latest
          ? latest.ended
          : null;
      },
      { replayChannel: channel },
    );
  const readKeyboardToasts = () =>
    page.evaluate(() => {
      const host = document.querySelector<HTMLIFrameElement>('#keyboard-replay-host');
      const stack = host?.contentDocument?.querySelector<HTMLElement>(
        '.replay-keyboard-toast-stack',
      );
      return stack
        ? {
            toastCount: stack.dataset.toastCount ?? null,
            toasts: Array.from(
              stack.querySelectorAll<HTMLElement>('.replay-keyboard-indicator'),
              (toast) => ({
                cueId: toast.dataset.cueId ?? null,
                occurrenceIndex: toast.dataset.occurrenceIndex ?? null,
                text: toast.textContent,
              }),
            ),
            visible: stack.dataset.visible === 'true',
          }
        : null;
    });

  await post({
    events: nativeEvents,
    keyboardEvents: [
      { id: 'keyboard-4', key: '4', modifiers: [], timeMs: 120 },
      { id: 'keyboard-5', key: '5', modifiers: [], timeMs: 320 },
      { id: 'keyboard-6', key: '6', modifiers: [], timeMs: 520 },
      { id: 'keyboard-shortcut', key: 'k', modifiers: ['Shift', 'Control'], timeMs: 900 },
      { id: 'keyboard-shortcut-repeat', key: 'k', modifiers: ['Shift', 'Control'], timeMs: 900 },
    ],
    type: 'mount',
  });
  await expect
    .poll(() =>
      page.evaluate(
        ({ replayChannel }) =>
          (window as typeof window & { __keyboardReplayStatuses?: unknown[] })
            .__keyboardReplayStatuses?.some(
              (status) =>
                typeof status === 'object' &&
                status !== null &&
                'channel' in status &&
                status.channel === replayChannel &&
                'type' in status &&
                status.type === 'ready',
            ) ?? false,
        { replayChannel: channel },
      ),
    )
    .toBe(true);
  await expect
    .poll(() =>
      page.evaluate(
        ({ replayChannel }) => {
          const statuses = (window as typeof window & { __keyboardReplayStatuses?: unknown[] })
            .__keyboardReplayStatuses ?? [];
          return statuses.findLast(
            (status) =>
              typeof status === 'object' &&
              status !== null &&
              'channel' in status &&
              status.channel === replayChannel &&
              'type' in status &&
              status.type === 'ready',
          );
        },
        { replayChannel: channel },
      ),
    )
    .toMatchObject({ durationMs: 900 });
  await expect.poll(readKeyboardToasts).toEqual({
    toastCount: '0',
    toasts: [],
    visible: false,
  });
  await expect.poll(() =>
    page.evaluate(() => {
      const host = document.querySelector<HTMLIFrameElement>('#keyboard-replay-host');
      const stack = host?.contentDocument?.querySelector<HTMLElement>(
        '.replay-keyboard-toast-stack',
      );
      return stack
        ? {
            ariaHidden: stack.getAttribute('aria-hidden'),
            ariaLive: stack.getAttribute('aria-live'),
            role: stack.getAttribute('role'),
          }
        : null;
    }),
  ).toEqual({ ariaHidden: null, ariaLive: 'polite', role: 'log' });
  await page.evaluate(() => {
    const host = document.querySelector<HTMLIFrameElement>('#keyboard-replay-host');
    const stack = host?.contentDocument?.querySelector<HTMLElement>(
      '.replay-keyboard-toast-stack',
    );
    if (!stack) throw new Error('Keyboard toast stack was not mounted.');
    const additions: string[] = [];
    const removals: string[] = [];
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          const toast = node as HTMLElement;
          if (toast.dataset.cueId) additions.push(toast.dataset.cueId);
        }
        for (const node of record.removedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          const toast = node as HTMLElement;
          if (toast.dataset.cueId) removals.push(toast.dataset.cueId);
        }
      }
    });
    observer.observe(stack, { childList: true });
    Object.assign(window, {
      __keyboardToastAdditions: additions,
      __keyboardToastRemovals: removals,
    });
  });

  await post({ type: 'play' });
  await expect.poll(readReplayEnded, { intervals: [25], timeout: 3_000 }).toBe(true);
  await expect.poll(readKeyboardToasts).toEqual({
    toastCount: '5',
    toasts: [
      { cueId: 'keyboard-4', occurrenceIndex: '0', text: '4' },
      { cueId: 'keyboard-5', occurrenceIndex: '1', text: '5' },
      { cueId: 'keyboard-6', occurrenceIndex: '2', text: '6' },
      { cueId: 'keyboard-shortcut', occurrenceIndex: '3', text: 'Ctrl + Shift + k' },
      {
        cueId: 'keyboard-shortcut-repeat',
        occurrenceIndex: '4',
        text: 'Ctrl + Shift + k',
      },
    ],
    visible: true,
  });
  await expect
    .poll(() =>
      page.evaluate(() => (
        window as typeof window & { __keyboardToastAdditions?: string[] }
      ).__keyboardToastAdditions ?? []),
    )
    .toEqual([
      'keyboard-4',
      'keyboard-5',
      'keyboard-6',
      'keyboard-shortcut',
      'keyboard-shortcut-repeat',
    ]);
  await expect
    .poll(() =>
      page.evaluate(() => (
        window as typeof window & { __keyboardToastRemovals?: string[] }
      ).__keyboardToastRemovals ?? []),
    )
    .toEqual([
      'keyboard-4',
      'keyboard-5',
      'keyboard-6',
      'keyboard-shortcut',
      'keyboard-shortcut-repeat',
    ]);
  await expect.poll(readKeyboardToasts).toEqual({
    toastCount: '0',
    toasts: [],
    visible: false,
  });

  await post({ timeMs: 520, type: 'seek' });
  await expect.poll(readKeyboardToasts).toEqual({
    toastCount: '3',
    toasts: [
      { cueId: 'keyboard-4', occurrenceIndex: '0', text: '4' },
      { cueId: 'keyboard-5', occurrenceIndex: '1', text: '5' },
      { cueId: 'keyboard-6', occurrenceIndex: '2', text: '6' },
    ],
    visible: true,
  });
  await page.waitForTimeout(1_700);
  await expect(readKeyboardToasts()).resolves.toEqual({
    toastCount: '3',
    toasts: [
      { cueId: 'keyboard-4', occurrenceIndex: '0', text: '4' },
      { cueId: 'keyboard-5', occurrenceIndex: '1', text: '5' },
      { cueId: 'keyboard-6', occurrenceIndex: '2', text: '6' },
    ],
    visible: true,
  });

  const readGeometry = () =>
    page.evaluate(() => {
      const host = document.querySelector<HTMLIFrameElement>('#keyboard-replay-host');
      const replayRoot = host?.contentDocument?.getElementById('replay-root');
      const wrapper = replayRoot?.querySelector<HTMLElement>('.replayer-wrapper');
      const stack = replayRoot?.querySelector<HTMLElement>('.replay-keyboard-toast-stack');
      if (!replayRoot || !wrapper || !stack) return null;
      const rootRect = replayRoot.getBoundingClientRect();
      const wrapperRect = wrapper.getBoundingClientRect();
      const stackRect = stack.getBoundingClientRect();
      const relative = (rect: DOMRect) => ({
        bottom: Math.round(rect.bottom - rootRect.top),
        left: Math.round(rect.left - rootRect.left),
        right: Math.round(rect.right - rootRect.left),
        top: Math.round(rect.top - rootRect.top),
      });
      return {
        bottomInset: Math.round(wrapperRect.bottom - stackRect.bottom),
        contained:
          stackRect.left >= wrapperRect.left - 1 &&
          stackRect.top >= wrapperRect.top - 1 &&
          stackRect.right <= wrapperRect.right + 1 &&
          stackRect.bottom <= wrapperRect.bottom + 1,
        rightInset: Math.round(wrapperRect.right - stackRect.right),
        root: { height: Math.round(rootRect.height), width: Math.round(rootRect.width) },
        stack: relative(stackRect),
        wrapper: relative(wrapperRect),
      };
    });

  await expect.poll(readGeometry).toMatchObject({
    bottomInset: 16,
    contained: true,
    rightInset: 16,
    root: { height: 360, width: 640 },
    wrapper: { bottom: 360, left: 80, right: 560, top: 0 },
  });

  await page.evaluate(() => {
    const host = document.querySelector<HTMLIFrameElement>('#keyboard-replay-host');
    if (!host) throw new Error('Replay host is missing.');
    host.style.height = '360px';
    host.style.width = '360px';
  });
  await expect.poll(readGeometry).toMatchObject({
    bottomInset: 16,
    contained: true,
    rightInset: 16,
    root: { height: 360, width: 360 },
    wrapper: { bottom: 315, left: 0, right: 360, top: 45 },
  });

  await post({ timeMs: 0, type: 'seek' });
  await expect.poll(readKeyboardToasts).toEqual({
    toastCount: '0',
    toasts: [],
    visible: false,
  });

  await post({ timeMs: 520, type: 'seek' });
  await expect.poll(readKeyboardToasts).toMatchObject({ toastCount: '3', visible: true });
  await post({ type: 'restart' });
  await post({ type: 'pause' });
  await expect.poll(readKeyboardToasts).toEqual({
    toastCount: '0',
    toasts: [],
    visible: false,
  });
  await post({ type: 'play' });
  await expect.poll(readReplayEnded, { intervals: [25], timeout: 3_000 }).toBe(true);
  await expect.poll(readKeyboardToasts).toEqual({
    toastCount: '5',
    toasts: [
      { cueId: 'keyboard-4', occurrenceIndex: '0', text: '4' },
      { cueId: 'keyboard-5', occurrenceIndex: '1', text: '5' },
      { cueId: 'keyboard-6', occurrenceIndex: '2', text: '6' },
      { cueId: 'keyboard-shortcut', occurrenceIndex: '3', text: 'Ctrl + Shift + k' },
      {
        cueId: 'keyboard-shortcut-repeat',
        occurrenceIndex: '4',
        text: 'Ctrl + Shift + k',
      },
    ],
    visible: true,
  });

  await post({ events: nativeEvents, keyboardEvents: [], type: 'mount' });
  await expect.poll(readKeyboardToasts).toEqual({
    toastCount: '0',
    toasts: [],
    visible: false,
  });
  await page.waitForTimeout(1_600);
  await expect(readKeyboardToasts()).resolves.toEqual({
    toastCount: '0',
    toasts: [],
    visible: false,
  });

  const readyCountBeforeDenseMount = await page.evaluate(
    ({ replayChannel }) => (
      (window as typeof window & { __keyboardReplayStatuses?: unknown[] })
        .__keyboardReplayStatuses ?? []
    ).filter(
      (status) =>
        typeof status === 'object' &&
        status !== null &&
        'channel' in status &&
        status.channel === replayChannel &&
        'type' in status &&
        status.type === 'ready',
    ).length,
    { replayChannel: channel },
  );
  await post({
    events: nativeEvents,
    keyboardEvents: Array.from({ length: 10 }, (_, index) => ({
      id: `dense-${index}`,
      key: String(index),
      modifiers: [],
      timeMs: index * 100,
    })),
    type: 'mount',
  });
  await expect.poll(() =>
    page.evaluate(
      ({ replayChannel }) => (
        (window as typeof window & { __keyboardReplayStatuses?: unknown[] })
          .__keyboardReplayStatuses ?? []
      ).filter(
        (status) =>
          typeof status === 'object' &&
          status !== null &&
          'channel' in status &&
          status.channel === replayChannel &&
          'type' in status &&
          status.type === 'ready',
      ).length,
      { replayChannel: channel },
    ),
  ).toBe(readyCountBeforeDenseMount + 1);
  await expect.poll(readKeyboardToasts).toEqual({
    toastCount: '0',
    toasts: [],
    visible: false,
  });
  await page.evaluate(() => {
    const host = document.querySelector<HTMLIFrameElement>('#keyboard-replay-host');
    const stack = host?.contentDocument?.querySelector<HTMLElement>(
      '.replay-keyboard-toast-stack',
    );
    if (!stack) throw new Error('Dense keyboard toast stack was not mounted.');
    const additions: string[] = [];
    const animationStarts: string[] = [];
    new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          const cueId = (node as HTMLElement).dataset.cueId;
          if (cueId) additions.push(cueId);
        }
      }
    }).observe(stack, { childList: true });
    stack.addEventListener('animationstart', (event) => {
      const cueId = (event.target as HTMLElement).dataset.cueId;
      if (cueId) animationStarts.push(cueId);
    });
    Object.assign(window, {
      __denseKeyboardAdditions: additions,
      __denseKeyboardAnimationStarts: animationStarts,
    });
  });
  await post({ type: 'play' });
  await expect.poll(readReplayEnded, { intervals: [25], timeout: 3_000 }).toBe(true);
  await expect.poll(readKeyboardToasts).toEqual({
    toastCount: '6',
    toasts: [
      { cueId: 'dense-4', occurrenceIndex: '4', text: '4' },
      { cueId: 'dense-5', occurrenceIndex: '5', text: '5' },
      { cueId: 'dense-6', occurrenceIndex: '6', text: '6' },
      { cueId: 'dense-7', occurrenceIndex: '7', text: '7' },
      { cueId: 'dense-8', occurrenceIndex: '8', text: '8' },
      { cueId: 'dense-9', occurrenceIndex: '9', text: '9' },
    ],
    visible: true,
  });
  await expect.poll(() =>
    page.evaluate(() => ({
      additions: (
        window as typeof window & { __denseKeyboardAdditions?: string[] }
      ).__denseKeyboardAdditions ?? [],
      animationStarts: (
        window as typeof window & { __denseKeyboardAnimationStarts?: string[] }
      ).__denseKeyboardAnimationStarts ?? [],
    })),
  ).toEqual({
    additions: Array.from({ length: 10 }, (_, index) => `dense-${index}`),
    animationStarts: Array.from({ length: 10 }, (_, index) => `dense-${index}`),
  });
  await expect.poll(() =>
    page.evaluate(() => {
      const host = document.querySelector<HTMLIFrameElement>('#keyboard-replay-host');
      const root = host?.contentDocument?.getElementById('replay-root');
      const wrapper = root?.querySelector<HTMLElement>('.replayer-wrapper');
      const stack = root?.querySelector<HTMLElement>('.replay-keyboard-toast-stack');
      if (!wrapper || !stack) return null;
      const wrapperRect = wrapper.getBoundingClientRect();
      const toasts = [...stack.querySelectorAll<HTMLElement>('.replay-keyboard-indicator')];
      return {
        clipped: toasts.some((toast) => {
          const rect = toast.getBoundingClientRect();
          return (
            rect.left < wrapperRect.left - 1 ||
            rect.top < wrapperRect.top - 1 ||
            rect.right > wrapperRect.right + 1 ||
            rect.bottom > wrapperRect.bottom + 1
          );
        }),
        domCount: toasts.length,
        reportedCount: Number(stack.dataset.toastCount),
      };
    }),
  ).toEqual({ clipped: false, domCount: 6, reportedCount: 6 });

  await post({ type: 'destroy' });
  await expect.poll(readKeyboardToasts).toBeNull();
  await page.waitForTimeout(1_600);
  await expect(readKeyboardToasts()).resolves.toBeNull();
});
