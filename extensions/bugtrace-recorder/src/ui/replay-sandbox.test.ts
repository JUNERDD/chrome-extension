import { describe, expect, it } from 'vitest';
import {
  FULL_FIDELITY_REPLAY_OPTIONS,
  hasFullFidelityRrwebSandbox,
  isReplaySandboxCommand,
  isReplaySandboxEvent,
  formatReplayKeyLabel,
  isReplayKeyboardCustomEvent,
  prepareReplayKeyboardEvents,
  prepareReplayTimeline,
  prepareRrwebEventsForReplay,
  replayKeyboardToastExpirationsAfter,
  replayKeyboardToastStatesAt,
  REPLAY_HOST_SANDBOX,
  REPLAY_KEYBOARD_MAX_VISIBLE_TOASTS,
  RRWEB_FULL_REPLAY_SANDBOX_TOKENS,
} from './replay-sandbox';

describe('full-fidelity replay events', () => {
  it('preserves styles, images, canvas, scripts, fonts, and replay interactions byte-for-byte', () => {
    const events = [
      {
        type: 2,
        timestamp: 1,
        data: {
          node: {
            type: 0,
            id: 1,
            childNodes: [
              {
                type: 2,
                id: 2,
                tagName: 'link',
                attributes: {
                  rel: 'stylesheet',
                  href: 'https://assets.example.test/page.css',
                  _cssText:
                    '@import "https://assets.example.test/theme.css"; .hero{background:url(https://assets.example.test/hero.png);animation:pulse 1s infinite}',
                },
                childNodes: [],
              },
              {
                type: 2,
                id: 3,
                tagName: 'img',
                attributes: {
                  src: 'https://assets.example.test/photo.png',
                  srcset: 'https://assets.example.test/photo@2x.png 2x',
                },
                childNodes: [],
              },
              {
                type: 2,
                id: 4,
                tagName: 'canvas',
                attributes: { rr_dataURL: 'data:image/png;base64,canvas-snapshot' },
                childNodes: [],
              },
              {
                type: 2,
                id: 5,
                tagName: 'script',
                attributes: { src: 'https://assets.example.test/app.js' },
                childNodes: [{ type: 3, id: 6, textContent: 'window.recordedScript = true' }],
              },
            ],
          },
          initialOffset: { top: 0, left: 0 },
        },
      },
      {
        type: 3,
        timestamp: 2,
        data: {
          source: 9,
          id: 4,
          type: 0,
          commands: [{ property: 'fillRect', args: [0, 0, 32, 32] }],
        },
      },
      {
        type: 3,
        timestamp: 3,
        data: {
          source: 10,
          family: 'Recorded Font',
          fontSource: 'url(https://assets.example.test/font.woff2)',
          buffer: false,
        },
      },
      {
        type: 3,
        timestamp: 4,
        data: { source: 2, type: 2, id: 3, x: 12, y: 18 },
      },
    ] as const;

    const replayEvents = prepareRrwebEventsForReplay(events);

    expect(replayEvents).toHaveLength(events.length);
    expect(replayEvents).toEqual(events);
    for (const [index, event] of events.entries()) {
      expect(replayEvents[index]).toBe(event);
    }
  });

  it('adds scheduled keyboard cues without rewriting native rrweb events', () => {
    const events = [
      { type: 4, timestamp: 1_000, data: {} },
      { type: 2, timestamp: 1_020, data: {} },
    ];

    const timeline = prepareReplayTimeline(events, [
      { id: 'key-1', key: 'k', modifiers: ['Control'], timeMs: 120 },
    ]);

    expect(timeline).toHaveLength(3);
    expect(timeline[0]).toBe(events[0]);
    expect(timeline[1]).toBe(events[1]);
    expect(timeline[2]?.timestamp).toBe(1_120);
    expect(isReplayKeyboardCustomEvent(timeline[2])).toBe(true);
  });

  it('retains every keyboard occurrence with stable replay timestamps', () => {
    const events = [
      { type: 4, timestamp: 1_000, data: {} },
      { type: 2, timestamp: 1_020, data: {} },
    ];
    const timeline = prepareReplayTimeline(events, [
      { id: 'key-b', key: 'b', modifiers: [], timeMs: 500 },
      { id: 'key-a', key: 'a', modifiers: [], timeMs: 300 },
      { id: 'key-c', key: 'c', modifiers: [], timeMs: 700 },
      { id: 'key-k', key: 'k', modifiers: ['Shift', 'Control'], timeMs: 900 },
      { id: 'key-repeat', key: 'k', modifiers: ['Shift', 'Control'], timeMs: 900 },
    ]);
    const keyboardTimeline = timeline.filter(isReplayKeyboardCustomEvent);

    expect(keyboardTimeline.map((event) => event.timestamp)).toEqual([
      1_300,
      1_500,
      1_700,
      1_900,
      1_900,
    ]);
    expect(keyboardTimeline.map((event) => event.data.payload.id)).toEqual([
      'key-a',
      'key-b',
      'key-c',
      'key-k',
      'key-repeat',
    ]);
    expect(timeline[0]).toBe(events[0]);
    expect(timeline[1]).toBe(events[1]);
  });

  it('projects every keydown as an independent replay-time toast', () => {
    const keyboardEvents = prepareReplayKeyboardEvents([
      { id: 'key-4', key: '4', modifiers: [], timeMs: 100 },
      { id: 'key-5', key: '5', modifiers: [], timeMs: 300 },
      { id: 'key-6', key: '6', modifiers: [], timeMs: 500 },
      { id: 'key-shortcut', key: 'k', modifiers: ['Shift', 'Control'], timeMs: 900 },
      { id: 'key-shortcut-repeat', key: 'k', modifiers: ['Shift', 'Control'], timeMs: 900 },
      { id: 'key-enter', key: 'Enter', modifiers: [], timeMs: 2_000 },
    ]);

    expect(replayKeyboardToastStatesAt(keyboardEvents, 99)).toEqual([]);
    expect(replayKeyboardToastStatesAt(keyboardEvents, 100)).toEqual([
      { cueId: 'key-4', occurrenceIndex: 0, text: '4' },
    ]);
    expect(replayKeyboardToastStatesAt(keyboardEvents, 500)).toEqual([
      { cueId: 'key-4', occurrenceIndex: 0, text: '4' },
      { cueId: 'key-5', occurrenceIndex: 1, text: '5' },
      { cueId: 'key-6', occurrenceIndex: 2, text: '6' },
    ]);
    expect(replayKeyboardToastStatesAt(keyboardEvents, 900)).toEqual([
      { cueId: 'key-4', occurrenceIndex: 0, text: '4' },
      { cueId: 'key-5', occurrenceIndex: 1, text: '5' },
      { cueId: 'key-6', occurrenceIndex: 2, text: '6' },
      { cueId: 'key-shortcut', occurrenceIndex: 3, text: 'Ctrl + Shift + k' },
      { cueId: 'key-shortcut-repeat', occurrenceIndex: 4, text: 'Ctrl + Shift + k' },
    ]);
    expect(replayKeyboardToastStatesAt(keyboardEvents, 1_601).map(({ cueId }) => cueId)).toEqual([
      'key-5',
      'key-6',
      'key-shortcut',
      'key-shortcut-repeat',
    ]);
    expect(replayKeyboardToastStatesAt(keyboardEvents, 3_501)).toEqual([]);
  });

  it('bounds a dense stack to the six most recent independent occurrences', () => {
    const keyboardEvents = prepareReplayKeyboardEvents(
      Array.from({ length: 10 }, (_, index) => ({
        id: `key-${index}`,
        key: String(index),
        modifiers: [],
        timeMs: index * 100,
      })),
    );

    const toasts = replayKeyboardToastStatesAt(keyboardEvents, 900);
    expect(REPLAY_KEYBOARD_MAX_VISIBLE_TOASTS).toBe(6);
    expect(toasts).toHaveLength(6);
    expect(toasts.map(({ cueId, occurrenceIndex }) => ({ cueId, occurrenceIndex }))).toEqual([
      { cueId: 'key-4', occurrenceIndex: 4 },
      { cueId: 'key-5', occurrenceIndex: 5 },
      { cueId: 'key-6', occurrenceIndex: 6 },
      { cueId: 'key-7', occurrenceIndex: 7 },
      { cueId: 'key-8', occurrenceIndex: 8 },
      { cueId: 'key-9', occurrenceIndex: 9 },
    ]);
  });

  it('schedules each remaining finished toast at its own replay-time expiry', () => {
    const keyboardEvents = prepareReplayKeyboardEvents([
      { id: 'key-1', key: '1', modifiers: [], timeMs: 100 },
      { id: 'key-2', key: '2', modifiers: [], timeMs: 300 },
      { id: 'key-3', key: '3', modifiers: [], timeMs: 500 },
      { id: 'key-k', key: 'k', modifiers: ['Control'], timeMs: 900 },
      { id: 'key-k-repeat', key: 'k', modifiers: ['Control'], timeMs: 900 },
    ]);

    expect(replayKeyboardToastExpirationsAfter(keyboardEvents, 900)).toEqual([
      { delayMs: 701, occurrenceIndex: 0, replayTimeMs: 1_601 },
      { delayMs: 901, occurrenceIndex: 1, replayTimeMs: 1_801 },
      { delayMs: 1_101, occurrenceIndex: 2, replayTimeMs: 2_001 },
      { delayMs: 1_501, occurrenceIndex: 3, replayTimeMs: 2_401 },
      { delayMs: 1_501, occurrenceIndex: 4, replayTimeMs: 2_401 },
    ]);
  });

  it('formats plain, special, arrow, and modifier keys without duplicate modifiers', () => {
    expect(formatReplayKeyLabel('a', [])).toBe('a');
    expect(formatReplayKeyLabel(' ', [])).toBe('Space');
    expect(formatReplayKeyLabel('Escape', [])).toBe('Esc');
    expect(formatReplayKeyLabel('ArrowDown', [])).toBe('↓');
    expect(formatReplayKeyLabel('k', ['Shift', 'Control'])).toBe('Ctrl + Shift + k');
    expect(formatReplayKeyLabel('Control', ['Control'])).toBe('Ctrl');
  });

  it('rejects malformed values without rewriting valid events', () => {
    const valid = { type: 1, timestamp: 42, data: { href: 'https://example.test/' } };

    expect(
      prepareRrwebEventsForReplay([
        null,
        {},
        { type: '1', timestamp: 1 },
        { type: 1, timestamp: '1' },
        valid,
      ]),
    ).toEqual([valid]);
  });
});

describe('full-fidelity rrweb policy', () => {
  it('enables canvas and recorded focus/timing without injecting visual suppression', () => {
    expect(FULL_FIDELITY_REPLAY_OPTIONS).toMatchObject({
      UNSAFE_replayCanvas: true,
      insertStyleRules: [],
      pauseAnimation: false,
      skipInactive: false,
      triggerFocus: true,
    });
  });

  it('allows only the script capability required by each sandbox layer', () => {
    expect(REPLAY_HOST_SANDBOX).toBe('allow-same-origin allow-scripts');
    expect(RRWEB_FULL_REPLAY_SANDBOX_TOKENS).toEqual([
      'allow-same-origin',
      'allow-scripts',
    ]);
    expect(hasFullFidelityRrwebSandbox(['allow-scripts', 'allow-same-origin'])).toBe(true);
    expect(hasFullFidelityRrwebSandbox(['allow-scripts'])).toBe(false);
    expect(
      hasFullFidelityRrwebSandbox([
        'allow-same-origin',
        'allow-scripts',
        'allow-forms',
      ]),
    ).toBe(false);
  });
});

describe('replay sandbox messaging', () => {
  it('accepts the bounded command and status protocol and rejects malformed messages', () => {
    const events = [
      { type: 1, timestamp: 1, data: {} },
      { type: 2, timestamp: 2, data: {} },
    ];

    expect(
      isReplaySandboxCommand({
        channel: 'abc',
        events,
        keyboardEvents: [
          { id: 'key-1', key: 'k', modifiers: ['Control'], timeMs: 250 },
        ],
        type: 'mount',
      }),
    ).toBe(true);
    expect(isReplaySandboxCommand({ channel: 'abc', type: 'play' })).toBe(true);
    expect(isReplaySandboxCommand({ channel: 'abc', timeMs: 250, type: 'seek' })).toBe(true);
    expect(isReplaySandboxCommand({ channel: 'abc', timeMs: Number.NaN, type: 'seek' })).toBe(
      false,
    );
    expect(isReplaySandboxCommand({ channel: 'abc', timeMs: -1, type: 'seek' })).toBe(false);
    expect(isReplaySandboxCommand({ channel: '', type: 'play' })).toBe(false);
    expect(
      isReplaySandboxCommand({ channel: 'abc', events: [{ type: 'bad' }], type: 'mount' }),
    ).toBe(false);
    expect(
      isReplaySandboxCommand({
        channel: 'abc',
        events,
        keyboardEvents: [{ id: 'key-1', key: 'k', modifiers: ['Control'], timeMs: -1 }],
        type: 'mount',
      }),
    ).toBe(false);

    const pausedSnapshot = {
      channel: 'abc',
      currentTimeMs: 250,
      durationMs: 1_000,
      ended: false,
      playing: false,
    };
    expect(isReplaySandboxEvent({ ...pausedSnapshot, type: 'ready' })).toBe(true);
    expect(isReplaySandboxEvent({ ...pausedSnapshot, playing: true, type: 'state' })).toBe(true);
    expect(isReplaySandboxEvent({ ...pausedSnapshot, type: 'progress' })).toBe(true);
    expect(isReplaySandboxEvent({ channel: 'abc', type: 'ready' })).toBe(false);
    expect(
      isReplaySandboxEvent({
        ...pausedSnapshot,
        currentTimeMs: 1_001,
        type: 'state',
      }),
    ).toBe(false);
    expect(
      isReplaySandboxEvent({
        ...pausedSnapshot,
        currentTimeMs: 1_000,
        ended: true,
        playing: true,
        type: 'state',
      }),
    ).toBe(false);
    expect(
      isReplaySandboxEvent({
        ...pausedSnapshot,
        currentTimeMs: 999,
        ended: true,
        type: 'state',
      }),
    ).toBe(false);
    expect(
      isReplaySandboxEvent({ channel: 'abc', reason: 'sandbox', type: 'error' }),
    ).toBe(true);
    expect(
      isReplaySandboxEvent({ channel: 'abc', reason: 'arbitrary', type: 'error' }),
    ).toBe(false);
  });
});
