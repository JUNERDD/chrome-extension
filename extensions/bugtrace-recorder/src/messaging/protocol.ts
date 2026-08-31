import { z } from 'zod';

export const SESSION_COMMANDS = ['record', 'pause', 'resume', 'stop', 'discard', 'screenshot'] as const;
export type SessionCommand = (typeof SESSION_COMMANDS)[number];

export const CLIENT_EVENT_KINDS = ['semantic', 'rrweb', 'console', 'error', 'gap'] as const;
export type ClientEventKind = (typeof CLIENT_EVENT_KINDS)[number];

export const TRANSPORT_DROP_SOURCES = ['semantic', 'rrweb', 'console', 'lifecycle'] as const;
export type TransportDropSource = (typeof TRANSPORT_DROP_SOURCES)[number];
export type TransportDropCounts = Record<TransportDropSource, number>;

export const LONG_RECORDING_WARNING_THRESHOLD_MS = 15 * 60 * 1_000;

export const RECORDER_WARNING_CODES = [
  'runtime_interrupted',
  'capture_gaps',
  'long_recording',
] as const;
export type RecorderWarningCode = (typeof RECORDER_WARNING_CODES)[number];
export type RecorderWarning =
  | { code: 'runtime_interrupted' }
  | { code: 'capture_gaps'; count: number }
  | { code: 'long_recording'; thresholdMs: number };

export const CAPTURE_PROTOCOL_VERSION = 1 as const;

export const RUNTIME_PROTOCOL_VERSION = 2 as const;
export const RUNTIME_CAPABILITIES = ['deleteSession'] as const;
export type RuntimeCapability = (typeof RUNTIME_CAPABILITIES)[number];

export const CURRENT_RUNTIME_METADATA = {
  runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
  runtimeCapabilities: RUNTIME_CAPABILITIES,
} as const;

export function hasRuntimeCapability(
  value: unknown,
  capability: RuntimeCapability,
): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const metadata = value as {
    runtimeCapabilities?: unknown;
    runtimeProtocolVersion?: unknown;
  };
  return metadata.runtimeProtocolVersion === RUNTIME_PROTOCOL_VERSION &&
    Array.isArray(metadata.runtimeCapabilities) &&
    metadata.runtimeCapabilities.includes(capability);
}

export const RUNTIME_ERROR_CODES = [
  'capture_client_unavailable',
  'screenshot_authorization_required',
  'screenshot_outside_scope',
  'screenshot_document_changed',
  'screenshot_failed',
  'operation_rejected',
] as const;
export type RuntimeErrorCode = (typeof RUNTIME_ERROR_CODES)[number];

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
  warnings: RecorderWarning[];
  /** @deprecated Read `warnings` instead. Retained for stale runtime compatibility. */
  warning?: string | null;
}

export function findRecorderWarning<TCode extends RecorderWarningCode>(
  state: { warnings?: readonly RecorderWarning[] } | null | undefined,
  code: TCode,
): Extract<RecorderWarning, { code: TCode }> | undefined {
  if (!Array.isArray(state?.warnings)) return undefined;
  return state.warnings.find(
    (warning): warning is Extract<RecorderWarning, { code: TCode }> => warning.code === code,
  );
}

export function shouldShowLongRecordingWarning(
  state: { warnings?: readonly RecorderWarning[] } | null | undefined,
  liveDurationMs: number,
): boolean {
  return liveDurationMs >= LONG_RECORDING_WARNING_THRESHOLD_MS ||
    Boolean(findRecorderWarning(state, 'long_recording'));
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
    type: z.literal('DELETE_SESSION'),
    sessionId: z.string().uuid(),
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
  | ({ ok: true; state: RecorderViewState; captureEnabled?: boolean } &
      typeof CURRENT_RUNTIME_METADATA)
  | ({ ok: true; accepted: number; state: RecorderViewState } &
      typeof CURRENT_RUNTIME_METADATA)
  | ({
      ok: false;
      error: string;
      errorCode?: RuntimeErrorCode;
      state?: RecorderViewState;
    } & Partial<typeof CURRENT_RUNTIME_METADATA>);

export type BackgroundMessage =
  | { type: 'CAPTURE_READY'; protocolVersion: typeof CAPTURE_PROTOCOL_VERSION }
  | { type: 'STATE_CHANGED'; state: RecorderViewState; captureEnabled: boolean }
  | { type: 'FLUSH_CAPTURE'; sessionId: string; flushToken: string }
  | { type: 'CAPTURE_SCREENSHOT_RECTS' };

export interface CaptureReadyAck {
  ready: true;
  protocolVersion: typeof CAPTURE_PROTOCOL_VERSION;
  clientId: string;
  documentId: string;
}

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
  if (jsonUtf8ByteLength(value) > 64_000_000) {
    throw new Error('Runtime message exceeds the 64 MB capture limit.');
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

export function isCaptureReadyAck(value: unknown): value is CaptureReadyAck {
  if (!isRecord(value)) return false;
  return (
    value.ready === true &&
    value.protocolVersion === CAPTURE_PROTOCOL_VERSION &&
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
