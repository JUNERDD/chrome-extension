import { z } from 'zod';

export const SESSION_COMMANDS = ['record', 'pause', 'resume', 'stop', 'discard', 'screenshot'] as const;
export type SessionCommand = (typeof SESSION_COMMANDS)[number];

export const CLIENT_EVENT_KINDS = ['semantic', 'rrweb', 'console', 'error', 'gap'] as const;
export type ClientEventKind = (typeof CLIENT_EVENT_KINDS)[number];

export const TRANSPORT_DROP_SOURCES = ['semantic', 'rrweb', 'console', 'lifecycle'] as const;
export type TransportDropSource = (typeof TRANSPORT_DROP_SOURCES)[number];
export type TransportDropCounts = Record<TransportDropSource, number>;

export interface ClientCaptureEvent {
  clientId: string;
  localSeq: number;
  observedAt: number;
  kind: ClientEventKind;
  data: Record<string, unknown>;
}

export interface RecorderViewState {
  status: 'idle' | 'recording' | 'paused' | 'finalizing' | 'completed' | 'interrupted';
  sessionId: string | null;
  revision: number;
  transitionedAtMs: number;
  startedAt: string | null;
  activeDurationMs: number;
  scopedTabCount: number;
  eventCount: number;
  gapCount: number;
  warning: string | null;
}

const ClientCaptureEventSchema = z.object({
  clientId: z.string().min(1).max(100),
  localSeq: z.number().int().nonnegative(),
  observedAt: z.number().finite().nonnegative(),
  kind: z.enum(CLIENT_EVENT_KINDS),
  data: z.record(z.string(), z.unknown()),
});

const TransportDropCountsSchema = z.object({
  semantic: z.number().int().nonnegative(),
  rrweb: z.number().int().nonnegative(),
  console: z.number().int().nonnegative(),
  lifecycle: z.number().int().nonnegative(),
});

export const RuntimeRequestSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('GET_STATE') }),
  z.object({
    type: z.literal('SESSION_COMMAND'),
    command: z.enum(SESSION_COMMANDS),
  }),
  z.object({
    type: z.literal('HELLO'),
    clientId: z.string().min(1).max(100),
    documentId: z.string().min(1).max(256),
    url: z.string().max(8_192),
  }),
  z.object({
    type: z.literal('CAPTURE_BATCH'),
    sessionId: z.string().uuid(),
    documentId: z.string().min(1).max(256),
    events: z.array(ClientCaptureEventSchema).min(1).max(200),
  }),
  z.object({
    type: z.literal('FLUSH_COMPLETE'),
    sessionId: z.string().uuid(),
    flushToken: z.string().uuid(),
    clientId: z.string().min(1).max(100),
    documentId: z.string().min(1).max(256),
    droppedCount: z.number().int().nonnegative(),
    droppedBySource: TransportDropCountsSchema,
  }),
]);

export type RuntimeRequest = z.infer<typeof RuntimeRequestSchema>;

export type RuntimeResponse =
  | { ok: true; state: RecorderViewState; captureEnabled?: boolean }
  | { ok: true; accepted: number; state: RecorderViewState }
  | { ok: false; error: string; state?: RecorderViewState };

export type BackgroundMessage =
  | { type: 'STATE_CHANGED'; state: RecorderViewState; captureEnabled: boolean }
  | { type: 'FLUSH_CAPTURE'; sessionId: string; flushToken: string }
  | { type: 'CAPTURE_SCREENSHOT_RECTS' };

export interface StateChangedAck {
  appliedRevision: number;
  sessionId: string | null;
  transitionedAtMs: number;
  clientId: string;
  documentId: string;
}

export interface FlushCaptureAck {
  flushed: boolean;
  sessionId: string;
  flushToken: string;
  clientId: string;
  documentId: string;
  droppedCount: number;
  droppedBySource: TransportDropCounts;
  error?: string;
}

export interface SensitiveRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function parseRuntimeRequest(value: unknown): RuntimeRequest {
  if (jsonUtf8ByteLength(value) > 4_000_000) {
    throw new Error('Runtime message exceeds the 4 MB safety limit.');
  }
  return RuntimeRequestSchema.parse(value);
}

export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function jsonUtf8ByteLength(value: unknown): number {
  const serialized = JSON.stringify(value);
  return serialized === undefined ? 0 : utf8ByteLength(serialized);
}

export function isStateChangedAck(value: unknown): value is StateChangedAck {
  if (!isRecord(value)) return false;
  return (
    Number.isSafeInteger(value.appliedRevision) &&
    (typeof value.sessionId === 'string' || value.sessionId === null) &&
    typeof value.transitionedAtMs === 'number' &&
    Number.isFinite(value.transitionedAtMs) &&
    typeof value.clientId === 'string' &&
    value.clientId.length > 0 &&
    typeof value.documentId === 'string' &&
    value.documentId.length > 0
  );
}

export function isFlushCaptureAck(value: unknown): value is FlushCaptureAck {
  if (!isRecord(value)) return false;
  return (
    typeof value.flushed === 'boolean' &&
    typeof value.sessionId === 'string' &&
    typeof value.flushToken === 'string' &&
    typeof value.clientId === 'string' &&
    value.clientId.length > 0 &&
    typeof value.documentId === 'string' &&
    value.documentId.length > 0 &&
    Number.isSafeInteger(value.droppedCount) &&
    isTransportDropCounts(value.droppedBySource) &&
    (value.error === undefined || typeof value.error === 'string')
  );
}

export function isTransportDropCounts(value: unknown): value is TransportDropCounts {
  if (!isRecord(value)) return false;
  return TRANSPORT_DROP_SOURCES.every(
    (source) => Number.isSafeInteger(value[source]) && (value[source] as number) >= 0,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
