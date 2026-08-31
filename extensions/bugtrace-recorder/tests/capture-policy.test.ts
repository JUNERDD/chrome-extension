import { describe, expect, it } from 'vitest';

import type { eventWithTime } from '@rrweb/types';
import { claimDocumentRecorderOwnership } from '../src/capture/document-owner';
import { sanitizeRrwebEventsForCapture } from '../src/capture/rrweb-segment';
import { shouldRecordKeyObservation } from '../src/capture/semantic-recorder';

describe('semantic full-fidelity keyboard policy', () => {
  const base = {
    key: 'q',
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    isComposing: false,
    altGraph: false,
    sensitiveTextContext: true,
  };

  it('retains character, modifier, AltGraph, and composition occurrences', () => {
    expect(shouldRecordKeyObservation(base)).toBe(true);
    expect(shouldRecordKeyObservation({ ...base, key: 'Control', ctrlKey: true })).toBe(true);
    expect(shouldRecordKeyObservation({ ...base, altKey: true })).toBe(true);
    expect(shouldRecordKeyObservation({ ...base, altKey: true, ctrlKey: true, altGraph: true })).toBe(true);
    expect(shouldRecordKeyObservation({ ...base, isComposing: true })).toBe(true);
  });
});

describe('content recorder document ownership', () => {
  it('allows one recorder per document realm and keeps separate realms independent', () => {
    const firstDocument = {};
    const secondDocument = {};

    expect(claimDocumentRecorderOwnership(firstDocument)).toBe(true);
    expect(claimDocumentRecorderOwnership(firstDocument)).toBe(false);
    expect(claimDocumentRecorderOwnership(secondDocument)).toBe(true);
  });
});

describe('rrweb full-fidelity capture policy', () => {
  it('preserves input values, attributes, CSS resources, canvas commands, and text', () => {
    const events = [
      {
        type: 2,
        timestamp: 1,
        data: {
          node: {
            id: 1,
            type: 0,
            childNodes: [
              {
                id: 2,
                type: 2,
                tagName: 'input',
                attributes: { type: 'password', value: 'full-fidelity-password' },
                childNodes: [],
              },
              {
                id: 3,
                type: 2,
                tagName: 'style',
                attributes: {
                  _cssText: '.hero{background:url(https://assets.example.test/raw.png?token=raw-token)}',
                },
                childNodes: [],
              },
              {
                id: 4,
                type: 2,
                tagName: 'p',
                attributes: { 'data-private': 'retained-attribute' },
                childNodes: [{ id: 5, type: 3, textContent: 'retained page text' }],
              },
            ],
          },
        },
      },
      {
        type: 3,
        timestamp: 2,
        data: { source: 5, id: 2, text: 'updated-password' },
      },
      {
        type: 3,
        timestamp: 3,
        data: {
          source: 9,
          id: 6,
          type: 0,
          commands: [{ property: 'fillRect', args: [0, 0, 50, 50] }],
        },
      },
    ] as unknown as eventWithTime[];

    const captured = sanitizeRrwebEventsForCapture(events);
    expect(captured).toEqual(events);
    expect(captured).not.toBe(events);
    expect(captured[0]).not.toBe(events[0]);
    const serialized = JSON.stringify(captured);
    expect(serialized).toContain('full-fidelity-password');
    expect(serialized).toContain('updated-password');
    expect(serialized).toContain('raw-token');
    expect(serialized).toContain('retained-attribute');
    expect(serialized).toContain('retained page text');
    expect(serialized).toContain('fillRect');
  });
});
