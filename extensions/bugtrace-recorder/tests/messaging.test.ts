import { describe, expect, it } from 'vitest';

import {
  CAPTURE_PROTOCOL_VERSION,
  CURRENT_RUNTIME_METADATA,
  LONG_RECORDING_WARNING_THRESHOLD_MS,
  findRecorderWarning,
  hasRuntimeCapability,
  isCaptureReadyAck,
  isFlushCaptureAck,
  isStateChangedAck,
  jsonUtf8ByteLength,
  parseRuntimeRequest,
  shouldShowLongRecordingWarning,
} from '../src/messaging';

describe('runtime message boundary', () => {
  it('keeps recorder warnings structured, non-exclusive, and independently addressable', () => {
    const state = {
      status: 'interrupted',
      sessionId: '12677126-2b8d-4fac-9e89-605f9e840bcb',
      revision: 7,
      transitionedAtMs: 100,
      startedAt: '2026-08-18T12:00:00.000Z',
      activeDurationMs: LONG_RECORDING_WARNING_THRESHOLD_MS,
      scopedTabCount: 2,
      eventCount: 10,
      gapCount: 3,
      warnings: [
        { code: 'runtime_interrupted' },
        { code: 'capture_gaps', count: 3 },
        { code: 'long_recording', thresholdMs: LONG_RECORDING_WARNING_THRESHOLD_MS },
      ],
      warning: 'legacy warning text',
    } as const;

    expect(findRecorderWarning(state, 'runtime_interrupted')).toEqual({
      code: 'runtime_interrupted',
    });
    expect(findRecorderWarning(state, 'capture_gaps')).toEqual({
      code: 'capture_gaps',
      count: 3,
    });
    expect(findRecorderWarning(state, 'long_recording')).toEqual({
      code: 'long_recording',
      thresholdMs: LONG_RECORDING_WARNING_THRESHOLD_MS,
    });
    expect(findRecorderWarning({ warnings: [] }, 'long_recording')).toBeUndefined();
    expect(findRecorderWarning({} as { warnings: [] }, 'capture_gaps')).toBeUndefined();
  });

  it('never promotes a short capture-gap warning into a long-recording warning', () => {
    const shortGapState = {
      warnings: [{ code: 'capture_gaps', count: 1 }],
      warning: '1 capture gap recorded.',
    } as const;

    expect(shouldShowLongRecordingWarning(shortGapState, 14_000)).toBe(false);
    expect(shouldShowLongRecordingWarning(shortGapState, 899_999)).toBe(false);
    expect(shouldShowLongRecordingWarning(shortGapState, 900_000)).toBe(true);
    expect(shouldShowLongRecordingWarning({
      warnings: [{
        code: 'long_recording',
        thresholdMs: LONG_RECORDING_WARNING_THRESHOLD_MS,
      }],
    }, 14_000)).toBe(true);
  });

  it('accepts the small, versioned control surface', () => {
    expect(parseRuntimeRequest({ type: 'GET_STATE' })).toEqual({ type: 'GET_STATE' });
    expect(parseRuntimeRequest({ type: 'SESSION_COMMAND', command: 'pause' })).toEqual({
      type: 'SESSION_COMMAND',
      command: 'pause',
    });
    expect(parseRuntimeRequest({
      type: 'DELETE_SESSION',
      sessionId: '12677126-2b8d-4fac-9e89-605f9e840bcb',
    })).toEqual({
      type: 'DELETE_SESSION',
      sessionId: '12677126-2b8d-4fac-9e89-605f9e840bcb',
    });
  });

  it('detects stale runtime responses before using versioned history commands', () => {
    expect(hasRuntimeCapability(CURRENT_RUNTIME_METADATA, 'deleteSession')).toBe(true);
    expect(hasRuntimeCapability({ ok: true, state: {} }, 'deleteSession')).toBe(false);
    expect(hasRuntimeCapability({
      runtimeProtocolVersion: 1,
      runtimeCapabilities: ['deleteSession'],
    }, 'deleteSession')).toBe(false);
    expect(hasRuntimeCapability({
      runtimeProtocolVersion: CURRENT_RUNTIME_METADATA.runtimeProtocolVersion,
      runtimeCapabilities: [],
    }, 'deleteSession')).toBe(false);
    expect(hasRuntimeCapability(null, 'deleteSession')).toBe(false);
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
    expect(() =>
      parseRuntimeRequest({ type: 'DELETE_SESSION', sessionId: 'not-a-session-id' }),
    ).toThrow();
  });

  it('enforces the 64 megabyte full-fidelity transport ceiling before validation', () => {
    const oversized = {
      type: 'CAPTURE_BATCH',
      sessionId: '12677126-2b8d-4fac-9e89-605f9e840bcb',
      documentId: 'document',
      events: [{
        clientId: 'client',
        localSeq: 1,
        observedAt: 1,
        kind: 'rrweb',
        data: { payload: 'x'.repeat(64_000_001) },
      }],
    };
    expect(() => parseRuntimeRequest(oversized)).toThrow(/64 MB/u);
  });

  it('measures message limits in UTF-8 bytes instead of UTF-16 code units', () => {
    const multibyte = {
      type: 'CAPTURE_BATCH',
      sessionId: '12677126-2b8d-4fac-9e89-605f9e840bcb',
      documentId: 'document',
      events: [{
        clientId: 'client',
        localSeq: 1,
        observedAt: 1,
        kind: 'rrweb',
        data: { payload: '界'.repeat(21_333_334) },
      }],
    };
    expect(JSON.stringify(multibyte).length).toBeLessThan(64_000_000);
    expect(jsonUtf8ByteLength(multibyte)).toBeGreaterThan(64_000_000);
    expect(() => parseRuntimeRequest(multibyte)).toThrow(/64 MB/u);
  });

  it('accepts only complete state and flush acknowledgement shapes', () => {
    expect(isCaptureReadyAck({ ready: true, protocolVersion: 0 })).toBe(false);
    expect(isCaptureReadyAck({
      ready: true,
      protocolVersion: CAPTURE_PROTOCOL_VERSION,
      clientId: 'client',
      documentId: 'content-document',
    })).toBe(true);

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
