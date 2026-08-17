import { describe, expect, it } from 'vitest';

import {
  isFlushCaptureAck,
  isStateChangedAck,
  jsonUtf8ByteLength,
  parseRuntimeRequest,
} from '../src/messaging';

describe('runtime message boundary', () => {
  it('accepts the small, versioned control surface', () => {
    expect(parseRuntimeRequest({ type: 'GET_STATE' })).toEqual({ type: 'GET_STATE' });
    expect(parseRuntimeRequest({ type: 'SESSION_COMMAND', command: 'pause' })).toEqual({
      type: 'SESSION_COMMAND',
      command: 'pause',
    });
  });

  it('rejects forged capture identities and unknown commands', () => {
    expect(() =>
      parseRuntimeRequest({
        type: 'CAPTURE_BATCH',
        sessionId: 'not-a-session-id',
        documentId: 'document',
        tabId: 999,
        events: [],
      }),
    ).toThrow();
    expect(() =>
      parseRuntimeRequest({ type: 'SESSION_COMMAND', command: 'upload' }),
    ).toThrow();
  });

  it('enforces the four megabyte transport ceiling before validation', () => {
    const oversized = {
      type: 'HELLO',
      clientId: 'client',
      documentId: 'document',
      url: `https://example.test/${'x'.repeat(4_000_001)}`,
    };
    expect(() => parseRuntimeRequest(oversized)).toThrow(/4 MB/u);
  });

  it('measures message limits in UTF-8 bytes instead of UTF-16 code units', () => {
    const multibyte = {
      type: 'HELLO',
      clientId: 'client',
      documentId: 'document',
      url: `https://example.test/${'界'.repeat(1_340_000)}`,
    };
    expect(JSON.stringify(multibyte).length).toBeLessThan(4_000_000);
    expect(jsonUtf8ByteLength(multibyte)).toBeGreaterThan(4_000_000);
    expect(() => parseRuntimeRequest(multibyte)).toThrow(/4 MB/u);
  });

  it('accepts only complete state and flush acknowledgement shapes', () => {
    expect(isStateChangedAck({ appliedRevision: 4 })).toBe(false);
    expect(isStateChangedAck({ error: 'fulfilled but failed' })).toBe(false);
    expect(isStateChangedAck({
      appliedRevision: 4,
      sessionId: null,
      transitionedAtMs: 100,
      clientId: 'client',
      documentId: 'content-document',
    })).toBe(true);

    expect(isFlushCaptureAck({ flushed: false, error: 'failed' })).toBe(false);
    expect(isFlushCaptureAck({
      flushed: true,
      sessionId: 'session',
      flushToken: 'token',
      clientId: 'client',
      documentId: 'content-document',
      droppedCount: 2,
      droppedBySource: { semantic: 1, rrweb: 0, console: 1, lifecycle: 0 },
    })).toBe(true);
  });

  it('requires the final-flush token, document and per-source drop summary', () => {
    expect(parseRuntimeRequest({
      type: 'FLUSH_COMPLETE',
      sessionId: '12677126-2b8d-4fac-9e89-605f9e840bcb',
      flushToken: '4fc7869c-4dcb-43a9-823b-07fe99b1a1fd',
      clientId: 'client',
      documentId: 'content-document',
      droppedCount: 2,
      droppedBySource: { semantic: 1, rrweb: 0, console: 1, lifecycle: 0 },
    })).toMatchObject({ type: 'FLUSH_COMPLETE', droppedCount: 2 });
  });
});
