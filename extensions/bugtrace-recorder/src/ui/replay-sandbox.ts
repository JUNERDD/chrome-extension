import type { playerConfig } from '@rrweb/replay';
import {
  EventType,
  type customEvent,
  type eventWithTime,
} from '@rrweb/types';

type UnknownRecord = Record<string, unknown>;

export const REPLAY_SANDBOX_PAGE = 'replay-sandbox.html';
export const REPLAY_HOST_SANDBOX = 'allow-same-origin allow-scripts';
export const REPLAY_KEYBOARD_CUSTOM_EVENT_TAG = 'bugtrace:keyboard';
export const REPLAY_KEYBOARD_ACTIVE_WINDOW_MS = 1_500;
export const REPLAY_KEYBOARD_MAX_VISIBLE_TOASTS = 6;

const REPLAY_KEY_MODIFIERS = ['Control', 'Alt', 'Shift', 'Meta'] as const;

export type ReplayKeyModifier = (typeof REPLAY_KEY_MODIFIERS)[number];

export interface ReplayKeyboardEvent {
  id: string;
  timeMs: number;
  key: string;
  modifiers: ReplayKeyModifier[];
}

export interface ReplayKeyboardToastState {
  cueId: string;
  occurrenceIndex: number;
  text: string;
}

export interface ReplayKeyboardToastExpiration {
  delayMs: number;
  occurrenceIndex: number;
  replayTimeMs: number;
}

export type ReplayKeyboardCustomEvent = customEvent<ReplayKeyboardEvent> & {
  timestamp: number;
};

/**
 * rrweb requires allow-scripts for canvas/WebGL reconstruction. The replayer itself adds
 * allow-same-origin so it can rebuild and mutate its document; no other iframe capability is
 * needed for replay.
 */
export const RRWEB_FULL_REPLAY_SANDBOX_TOKENS = [
  'allow-same-origin',
  'allow-scripts',
] as const;

export const FULL_FIDELITY_REPLAY_OPTIONS = {
  skipInactive: false,
  showWarning: true,
  showDebug: false,
  triggerFocus: true,
  UNSAFE_replayCanvas: true,
  mouseTail: false,
  pauseAnimation: false,
  useVirtualDom: true,
  insertStyleRules: [],
} satisfies Partial<playerConfig>;

export type ReplaySandboxErrorReason =
  | 'load'
  | 'playback'
  | 'reconstruct'
  | 'restart'
  | 'sandbox';

export interface ReplayPlaybackSnapshot {
  currentTimeMs: number;
  durationMs: number;
  ended: boolean;
  playing: boolean;
}

export type ReplaySandboxCommand =
  | { channel: string; type: 'destroy' | 'pause' | 'play' | 'restart' }
  | { channel: string; timeMs: number; type: 'seek' }
  | {
      channel: string;
      events: eventWithTime[];
      keyboardEvents?: ReplayKeyboardEvent[];
      type: 'mount';
    };

export type ReplaySandboxEvent =
  | ({ channel: string; type: 'progress' | 'ready' | 'state' } & ReplayPlaybackSnapshot)
  | { channel: string; reason: ReplaySandboxErrorReason; type: 'error' };

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRrwebEvent(value: unknown): value is eventWithTime {
  return (
    isRecord(value) &&
    typeof value.timestamp === 'number' &&
    Number.isFinite(value.timestamp) &&
    typeof value.type === 'number'
  );
}

function isReplayKeyModifier(value: unknown): value is ReplayKeyModifier {
  return typeof value === 'string' && REPLAY_KEY_MODIFIERS.includes(value as ReplayKeyModifier);
}

function isReplayKeyboardEvent(value: unknown): value is ReplayKeyboardEvent {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    typeof value.key === 'string' &&
    value.key.length > 0 &&
    typeof value.timeMs === 'number' &&
    Number.isFinite(value.timeMs) &&
    value.timeMs >= 0 &&
    Array.isArray(value.modifiers) &&
    value.modifiers.length <= REPLAY_KEY_MODIFIERS.length &&
    value.modifiers.every(isReplayKeyModifier)
  );
}

/**
 * Retains every valid rrweb event as-is. In particular, this boundary must not rewrite page
 * resources, CSS, scripts, fonts, canvas commands, or recorded interactions.
 */
export function prepareRrwebEventsForReplay(values: readonly unknown[]): eventWithTime[] {
  return values.filter(isRrwebEvent);
}

/** Returns a defensive, stable time ordering without dropping equal-time key occurrences. */
export function prepareReplayKeyboardEvents(
  values: readonly unknown[],
): ReplayKeyboardEvent[] {
  return values
    .filter(isReplayKeyboardEvent)
    .map((cue, index) => ({ cue: { ...cue, modifiers: [...cue.modifiers] }, index }))
    .sort((left, right) => left.cue.timeMs - right.cue.timeMs || left.index - right.index)
    .map(({ cue }) => cue);
}

/**
 * Adds keyboard cues to the in-memory rrweb stream. The first native rrweb timestamp is the
 * segment-local origin because keyboard cue offsets are already relative to that segment.
 * Native events and their relative order are retained, while a cue after the final native event
 * deliberately extends rrweb's duration so it can still be displayed.
 */
export function prepareReplayTimeline(
  values: readonly unknown[],
  keyboardEvents: readonly unknown[],
): eventWithTime[] {
  const events = prepareRrwebEventsForReplay(values);
  const firstTimestamp = events[0]?.timestamp;
  if (firstTimestamp === undefined) return events;

  const cues = prepareReplayKeyboardEvents(keyboardEvents).map((cue) => ({
    type: EventType.Custom,
    data: {
      tag: REPLAY_KEYBOARD_CUSTOM_EVENT_TAG,
      payload: cue,
    },
    timestamp: firstTimestamp + cue.timeMs,
  }) satisfies ReplayKeyboardCustomEvent);

  if (cues.length === 0) return events;

  const timeline: eventWithTime[] = [];
  let cueIndex = 0;
  for (const event of events) {
    while ((cues[cueIndex]?.timestamp ?? Number.POSITIVE_INFINITY) < event.timestamp) {
      timeline.push(cues[cueIndex] as ReplayKeyboardCustomEvent);
      cueIndex += 1;
    }
    timeline.push(event);
    while ((cues[cueIndex]?.timestamp ?? Number.POSITIVE_INFINITY) === event.timestamp) {
      timeline.push(cues[cueIndex] as ReplayKeyboardCustomEvent);
      cueIndex += 1;
    }
  }
  timeline.push(...cues.slice(cueIndex));
  return timeline;
}

export function isReplayKeyboardCustomEvent(
  value: unknown,
): value is ReplayKeyboardCustomEvent {
  if (!isRrwebEvent(value) || value.type !== EventType.Custom) return false;
  const data = isRecord(value.data) ? value.data : null;
  return (
    data?.tag === REPLAY_KEYBOARD_CUSTOM_EVENT_TAG &&
    isReplayKeyboardEvent(data.payload)
  );
}

const REPLAY_KEY_LABELS: Readonly<Record<string, string>> = {
  ' ': 'Space',
  Alt: 'Alt',
  AltGraph: 'AltGr',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  ArrowUp: '↑',
  Backspace: 'Backspace',
  CapsLock: 'Caps Lock',
  Control: 'Ctrl',
  Dead: 'Dead key',
  Delete: 'Delete',
  End: 'End',
  Enter: 'Enter',
  Escape: 'Esc',
  Home: 'Home',
  Insert: 'Insert',
  Meta: 'Meta',
  NumLock: 'Num Lock',
  OS: 'Meta',
  PageDown: 'PgDn',
  PageUp: 'PgUp',
  Pause: 'Pause',
  PrintScreen: 'Print Screen',
  Process: 'IME',
  ScrollLock: 'Scroll Lock',
  Shift: 'Shift',
  Spacebar: 'Space',
  Tab: 'Tab',
  Unidentified: 'Unknown',
};

function modifierForKey(key: string): ReplayKeyModifier | undefined {
  if (key === 'Control') return 'Control';
  if (key === 'Alt') return 'Alt';
  if (key === 'Shift') return 'Shift';
  if (key === 'Meta' || key === 'OS') return 'Meta';
  return undefined;
}

function replayKeyLabel(key: string): string {
  return Object.prototype.hasOwnProperty.call(REPLAY_KEY_LABELS, key)
    ? (REPLAY_KEY_LABELS[key] ?? key)
    : key;
}

/** Formats raw KeyboardEvent.key values without altering printable user input. */
export function formatReplayKeyLabel(
  key: string,
  modifiers: readonly ReplayKeyModifier[],
): string {
  const activeModifiers = new Set(modifiers);
  const keyModifier = modifierForKey(key);
  if (keyModifier) activeModifiers.add(keyModifier);

  const parts = REPLAY_KEY_MODIFIERS.filter((modifier) => activeModifiers.has(modifier)).map(
    replayKeyLabel,
  );
  if (!keyModifier) parts.push(replayKeyLabel(key));
  return parts.join(' + ');
}

/**
 * Projects active keyboard occurrences from replay time instead of wall-clock timers. Each
 * keydown remains an independent toast, including repeated keys and events with equal timestamps.
 * The visible stack is explicitly bounded to its most recent entries so layout never silently
 * clips nodes while reporting a larger toast count.
 */
export function replayKeyboardToastStatesAt(
  keyboardEvents: readonly ReplayKeyboardEvent[],
  timeMs: number,
): ReplayKeyboardToastState[] {
  if (!Number.isFinite(timeMs) || timeMs < 0 || keyboardEvents.length === 0) return [];

  let low = 0;
  let high = keyboardEvents.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((keyboardEvents[middle]?.timeMs ?? Number.POSITIVE_INFINITY) <= timeMs) low = middle + 1;
    else high = middle;
  }
  const lastIndex = low - 1;
  const lastCue = keyboardEvents[lastIndex];
  if (!lastCue || timeMs - lastCue.timeMs > REPLAY_KEYBOARD_ACTIVE_WINDOW_MS) return [];

  let firstIndex = lastIndex;
  while (
    firstIndex > 0 &&
    timeMs - (keyboardEvents[firstIndex - 1]?.timeMs ?? Number.NEGATIVE_INFINITY) <=
      REPLAY_KEYBOARD_ACTIVE_WINDOW_MS
  ) {
    firstIndex -= 1;
  }

  const firstVisibleIndex = Math.max(
    firstIndex,
    lastIndex - REPLAY_KEYBOARD_MAX_VISIBLE_TOASTS + 1,
  );
  const toasts: ReplayKeyboardToastState[] = [];
  for (let index = firstVisibleIndex; index <= lastIndex; index += 1) {
    const cue = keyboardEvents[index];
    if (!cue) continue;
    toasts.push({
      cueId: cue.id,
      occurrenceIndex: index,
      text: formatReplayKeyLabel(cue.key, cue.modifiers),
    });
  }
  return toasts;
}

/**
 * Converts the remaining replay-time lifetime of visible toasts into bounded wall-clock cleanup
 * steps for a finished replay. The extra millisecond crosses the inclusive active-window edge.
 */
export function replayKeyboardToastExpirationsAfter(
  keyboardEvents: readonly ReplayKeyboardEvent[],
  timeMs: number,
): ReplayKeyboardToastExpiration[] {
  return replayKeyboardToastStatesAt(keyboardEvents, timeMs).flatMap((state) => {
    const cue = keyboardEvents[state.occurrenceIndex];
    if (!cue) return [];
    const replayTimeMs = cue.timeMs + REPLAY_KEYBOARD_ACTIVE_WINDOW_MS + 1;
    return [{
      delayMs: Math.max(1, replayTimeMs - timeMs),
      occurrenceIndex: state.occurrenceIndex,
      replayTimeMs,
    }];
  });
}

export function hasExactSandboxTokens(
  actual: Iterable<string>,
  expected: readonly string[],
): boolean {
  const actualTokens = new Set(actual);
  return (
    actualTokens.size === expected.length &&
    expected.every((token) => actualTokens.has(token))
  );
}

export function hasFullFidelityRrwebSandbox(actual: Iterable<string>): boolean {
  return hasExactSandboxTokens(actual, RRWEB_FULL_REPLAY_SANDBOX_TOKENS);
}

function hasChannelAndType(value: unknown): value is UnknownRecord & {
  channel: string;
  type: string;
} {
  return (
    isRecord(value) &&
    typeof value.channel === 'string' &&
    value.channel.length > 0 &&
    typeof value.type === 'string'
  );
}

export function isReplaySandboxCommand(value: unknown): value is ReplaySandboxCommand {
  if (!hasChannelAndType(value)) return false;
  if (value.type === 'mount') {
    return (
      Array.isArray(value.events) &&
      value.events.every(isRrwebEvent) &&
      (value.keyboardEvents === undefined ||
        (Array.isArray(value.keyboardEvents) &&
          value.keyboardEvents.every(isReplayKeyboardEvent)))
    );
  }
  if (value.type === 'seek') {
    return (
      typeof value.timeMs === 'number' &&
      Number.isFinite(value.timeMs) &&
      value.timeMs >= 0
    );
  }
  return ['destroy', 'pause', 'play', 'restart'].includes(value.type);
}

function hasPlaybackSnapshot(value: UnknownRecord): value is UnknownRecord & ReplayPlaybackSnapshot {
  if (
    typeof value.currentTimeMs !== 'number' ||
    !Number.isFinite(value.currentTimeMs) ||
    value.currentTimeMs < 0 ||
    typeof value.durationMs !== 'number' ||
    !Number.isFinite(value.durationMs) ||
    value.durationMs < 0 ||
    value.currentTimeMs > value.durationMs ||
    typeof value.ended !== 'boolean' ||
    typeof value.playing !== 'boolean' ||
    (value.ended && value.playing)
  ) {
    return false;
  }
  return !value.ended || value.currentTimeMs === value.durationMs;
}

export function isReplaySandboxEvent(value: unknown): value is ReplaySandboxEvent {
  if (!hasChannelAndType(value)) return false;
  if (['progress', 'ready', 'state'].includes(value.type)) {
    return hasPlaybackSnapshot(value);
  }
  return (
    value.type === 'error' &&
    ['load', 'playback', 'reconstruct', 'restart', 'sandbox'].includes(
      String(value.reason),
    )
  );
}
