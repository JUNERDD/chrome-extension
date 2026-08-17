import { describe, expect, it } from 'vitest';

import type { StoredEvent } from '../src/storage';
import {
  adaptNavigationEvent,
  adaptSemanticEvent,
  buildLifecycleAttachment,
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
