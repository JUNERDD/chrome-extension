import { describe, expect, it } from 'vitest';

import type { StoredEvent } from '../src/storage';
import {
  adaptNavigationEvent,
  adaptSemanticEvent,
  buildLifecycleAttachment,
  buildRrwebEvidence,
} from '../src/ui/trace-adapter';

function event(kind: string, data: Record<string, unknown>): StoredEvent {
  return {
    id: `session-01:${kind}`,
    sessionId: 'session-01',
    seq: 7,
    offsetMs: 123,
    observedAt: '2026-08-17T08:00:00.123Z',
    kind,
    tabId: 'tab-81',
    windowId: 'window-17',
    frameId: 'frame-0',
    documentId: 'document-4',
    trust: kind === 'semantic' ? 'untrusted_observation' : 'extension',
    data,
  };
}

function storedEvent(
  kind: string,
  data: Record<string, unknown>,
  overrides: Partial<StoredEvent> = {},
): StoredEvent {
  const seq = overrides.seq ?? 1;
  return {
    ...event(kind, data),
    id: overrides.id ?? `session-01:${kind}:${seq}`,
    seq,
    offsetMs: overrides.offsetMs ?? seq * 10,
    ...overrides,
  };
}

function rrwebEvent(
  segmentId: string,
  seq: number,
  timestamp: number,
  overrides: Partial<StoredEvent> = {},
): StoredEvent {
  return storedEvent(
    'rrweb',
    { segmentId, event: { type: seq % 2 === 0 ? 2 : 4, timestamp, data: {} } },
    { seq, offsetMs: timestamp - 1_000, ...overrides },
  );
}

describe('stored trace adapter', () => {
  it('preserves typed semantic detail without inventing missing values', () => {
    const step = adaptSemanticEvent(
      event('semantic', {
        action: 'scroll',
        x: -72,
        y: 480,
        button: 2,
        modifiers: ['Control', 'Shift', 'Control', 'Unexpected'],
        files: [
          { mimeType: 'image/png', size: 2048 },
          { mimeType: 'text/plain' },
        ],
        input: { state: 'redacted', inputType: 'select', selectedCount: 3 },
      }),
      (value) => value,
    );

    expect(step).toMatchObject({
      action: 'scroll',
      modifiers: ['Control', 'Shift'],
      mouseButton: 2,
      scroll: { x: -72, y: 480 },
      files: [{ mimeType: 'image/png', size: 2048 }, { mimeType: 'text/plain' }],
      selectedCount: 3,
    });
    expect(step.files?.[1]).not.toHaveProperty('size');
    expect(step).not.toHaveProperty('observation');

    const incompleteScroll = adaptSemanticEvent(
      event('semantic', { action: 'scroll', x: -12 }),
      (value) => value,
    );
    expect(incompleteScroll).not.toHaveProperty('scroll');
  });

  it('keeps legacy child-frame evidence in exports without creating a second replay tab', () => {
    const evidence = buildRrwebEvidence([
      rrwebEvent('top-segment', 1, 1_000, { frameId: 'frame-0' }),
      rrwebEvent('top-segment', 2, 1_010, { frameId: 'frame-0' }),
      rrwebEvent('child-segment', 3, 1_000, { frameId: 'frame-7' }),
      rrwebEvent('child-segment', 4, 1_010, { frameId: 'frame-7' }),
    ]);

    expect(evidence.records).toHaveLength(2);
    expect(evidence.resources).toHaveLength(2);
    expect(evidence.replay.map((segment) => segment.id)).toEqual(['segment-top-segment']);
  });

  it('filters an exact redundant producer subset but preserves distinct top-frame segments', () => {
    const sharedMeta = { type: 4, timestamp: 1_000, data: { width: 320, height: 240 } };
    const sharedSnapshot = { type: 2, timestamp: 1_010, data: { node: { id: 1 } } };
    const events = [
      storedEvent('rrweb', { segmentId: 'primary', event: sharedMeta }, { seq: 1, offsetMs: 0 }),
      storedEvent('rrweb', { segmentId: 'duplicate', event: sharedMeta }, { seq: 2, offsetMs: 0 }),
      storedEvent('rrweb', { segmentId: 'primary', event: sharedSnapshot }, { seq: 3, offsetMs: 10 }),
      storedEvent('rrweb', { segmentId: 'duplicate', event: sharedSnapshot }, { seq: 4, offsetMs: 10 }),
      rrwebEvent('resumed', 5, 2_000, { offsetMs: 1_000 }),
      rrwebEvent('resumed', 6, 2_010, { offsetMs: 1_010 }),
    ];

    const evidence = buildRrwebEvidence(events);

    expect(evidence.records).toHaveLength(3);
    expect(evidence.resources).toHaveLength(3);
    expect(evidence.replay.map((segment) => segment.id)).toEqual([
      'segment-primary',
      'segment-resumed',
    ]);
  });

  it('maps plain and modified keys to segment-relative replay time, including tail keys', () => {
    const rrweb = [
      rrwebEvent('first', 1, 1_000, { offsetMs: 100 }),
      rrwebEvent('first', 2, 1_020, { offsetMs: 120 }),
      rrwebEvent('second', 5, 2_000, { offsetMs: 1_100 }),
      rrwebEvent('second', 6, 2_020, { offsetMs: 1_120 }),
    ];
    const steps = [
      adaptSemanticEvent(
        storedEvent('semantic', { action: 'key', key: 'a' }, { seq: 3, offsetMs: 250 }),
        (value) => value,
      ),
      adaptSemanticEvent(
        storedEvent(
          'semantic',
          { action: 'key', key: 'k', modifiers: ['Control'] },
          { seq: 7, offsetMs: 1_400 },
        ),
        (value) => value,
      ),
      adaptSemanticEvent(
        storedEvent('semantic', { action: 'key', key: 'x' }, {
          seq: 8,
          offsetMs: 1_500,
          tabId: 'tab-other',
        }),
        (value) => value,
      ),
    ];

    const evidence = buildRrwebEvidence(rrweb, steps);

    expect(evidence.replay[0]?.keyboardEvents).toEqual([
      expect.objectContaining({ key: 'a', modifiers: [], timeMs: 150 }),
    ]);
    expect(evidence.replay[1]?.keyboardEvents).toEqual([
      expect.objectContaining({ key: 'k', modifiers: ['Control'], timeMs: 300 }),
    ]);
  });

  it('retains every rapid keydown occurrence in replay order', () => {
    const rrweb = [
      rrwebEvent('typing', 1, 1_000, { offsetMs: 100 }),
      rrwebEvent('typing', 2, 1_020, { offsetMs: 120 }),
    ];
    const steps = [...'4564565'].map((key, index) =>
      adaptSemanticEvent(
        storedEvent(
          'semantic',
          { action: 'key', key },
          { seq: index + 3, offsetMs: 200 + index * 100 },
        ),
        (value) => value,
      ),
    );

    const evidence = buildRrwebEvidence(rrweb, steps);

    expect(evidence.replay[0]?.keyboardEvents.map((event) => event.key)).toEqual([
      '4',
      '5',
      '6',
      '4',
      '5',
      '6',
      '5',
    ]);
    expect(evidence.replay[0]?.keyboardEvents.map((event) => event.timeMs)).toEqual([
      100,
      200,
      300,
      400,
      500,
      600,
      700,
    ]);
  });

  it('keeps navigation phase, outcome and failure evidence distinct', () => {
    const committed = adaptNavigationEvent(
      event('navigation', {
        action: 'committed',
        kind: 'document',
        url: 'https://example.test/checkout',
      }),
      (value) => value,
      (value) => value,
    );
    const completed = adaptNavigationEvent(
      event('navigation', {
        action: 'completed',
        kind: 'document',
        url: 'https://example.test/checkout',
      }),
      (value) => value,
      (value) => value,
    );
    const failed = adaptNavigationEvent(
      event('navigation', {
        action: 'error',
        kind: 'document',
        url: 'https://example.test/checkout',
        error: 'net::ERR_CONNECTION_RESET',
      }),
      (value) => value,
      (value) => value,
    );

    expect(committed).toMatchObject({ phase: 'committed', outcome: 'pending' });
    expect(completed).toMatchObject({ phase: 'completed', outcome: 'completed' });
    expect(failed).toMatchObject({
      phase: 'failed',
      outcome: 'failed',
      error: {
        status: 'present',
        trust: 'untrusted_observation',
        value: 'net::ERR_CONNECTION_RESET',
      },
    });
  });

  it('exports replacement and previous-window lifecycle identities explicitly', () => {
    const replacement = event('tab', {
      action: 'replaced',
      replacedTabId: 'tab-80',
    });
    const detached = {
      ...event('tab', {
        action: 'detached',
        previousWindowId: 'window-16',
      }),
      seq: 8,
      tabId: 'tab-81',
      windowId: null,
    };
    const tabIds = new Map([
      ['tab-80', 'tab-1'],
      ['tab-81', 'tab-2'],
    ]);
    const windowIds = new Map([
      ['window-16', 'window-1'],
      ['window-17', 'window-2'],
    ]);
    const lifecycle = buildLifecycleAttachment(
      [replacement, detached],
      {
        tab: (rawId) => tabIds.get(rawId) ?? 'tab-unknown',
        window: (rawId) => windowIds.get(rawId) ?? 'window-unknown',
      },
      (value) => value,
    );

    expect(lifecycle).not.toBeNull();
    if (lifecycle === null || typeof lifecycle.resource.data !== 'string') {
      throw new Error('Expected a text lifecycle attachment.');
    }
    expect(JSON.parse(lifecycle.resource.data).records).toEqual([
      expect.objectContaining({
        action: 'replaced',
        tabId: 'tab-2',
        windowId: 'window-2',
        replacedTabId: 'tab-1',
      }),
      expect.objectContaining({
        action: 'detached',
        tabId: 'tab-2',
        previousWindowId: 'window-1',
      }),
    ]);
  });
});
