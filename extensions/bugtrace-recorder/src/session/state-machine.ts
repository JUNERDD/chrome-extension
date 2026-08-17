import { createTabScope, type SessionTabScope } from './tab-scope';

export type RecorderSessionStatus =
  | 'idle'
  | 'recording'
  | 'paused'
  | 'finalizing'
  | 'completed'
  | 'interrupted';

export interface PauseInterval {
  readonly startedAtMs: number;
  readonly endedAtMs: number | null;
}

export interface InterruptionInterval {
  readonly startedAtMs: number;
  readonly endedAtMs: number | null;
  readonly reason: string;
}

export interface RecorderSessionState {
  readonly status: RecorderSessionStatus;
  readonly revision: number;
  readonly sessionId: string | null;
  readonly startedAtMs: number | null;
  readonly endedAtMs: number | null;
  readonly lastTransitionAtMs: number;
  /** Active time committed at the last transition; use getActiveDurationMs for a live value. */
  readonly activeDurationMs: number;
  readonly activeStartedAtMs: number | null;
  readonly pauseIntervals: readonly PauseInterval[];
  readonly interruptionIntervals: readonly InterruptionInterval[];
  readonly scope: SessionTabScope | null;
  readonly stopReason: string | null;
}

export type RecorderCommand =
  | {
      readonly type: 'record';
      readonly sessionId: string;
      readonly rootTabId: number;
      readonly rootWindowId?: number | null;
    }
  | { readonly type: 'pause' }
  | { readonly type: 'resume' }
  | { readonly type: 'stop'; readonly reason?: string }
  | { readonly type: 'finalize' }
  | { readonly type: 'interrupt'; readonly reason?: string };

export type SessionTransitionErrorCode =
  | 'invalid_transition'
  | 'invalid_command'
  | 'invalid_state'
  | 'non_monotonic_time';

export class SessionTransitionError extends Error {
  readonly code: SessionTransitionErrorCode;
  readonly from: RecorderSessionStatus;
  readonly command: RecorderCommand['type'];

  constructor(
    code: SessionTransitionErrorCode,
    from: RecorderSessionStatus,
    command: RecorderCommand['type'],
    message: string,
  ) {
    super(message);
    this.name = 'SessionTransitionError';
    this.code = code;
    this.from = from;
    this.command = command;
  }
}

export function createIdleState(now = 0): RecorderSessionState {
  assertTimestamp(now, 'now');
  return {
    status: 'idle',
    revision: 0,
    sessionId: null,
    startedAtMs: null,
    endedAtMs: null,
    lastTransitionAtMs: now,
    activeDurationMs: 0,
    activeStartedAtMs: null,
    pauseIntervals: [],
    interruptionIntervals: [],
    scope: null,
    stopReason: null,
  };
}

function assertTimestamp(timestamp: number, label: string): void {
  if (!Number.isFinite(timestamp) || timestamp < 0) {
    throw new RangeError(`${label} must be a non-negative finite number.`);
  }
}

function invalidTransition(
  state: RecorderSessionState,
  command: RecorderCommand,
): never {
  throw new SessionTransitionError(
    'invalid_transition',
    state.status,
    command.type,
    `Cannot ${command.type} while recorder is ${state.status}.`,
  );
}

function assertStateInvariant(state: RecorderSessionState, command: RecorderCommand): void {
  const hasAnySessionMetadata =
    state.sessionId !== null || state.startedAtMs !== null || state.scope !== null;
  const hasAllSessionMetadata =
    state.sessionId !== null && state.startedAtMs !== null && state.scope !== null;
  if (state.status === 'idle' ? hasAnySessionMetadata : !hasAllSessionMetadata) {
    throw new SessionTransitionError(
      'invalid_state',
      state.status,
      command.type,
      'Recorder state has inconsistent session metadata.',
    );
  }
  if (
    !Number.isSafeInteger(state.revision) ||
    state.revision < 0 ||
    !Number.isFinite(state.activeDurationMs) ||
    state.activeDurationMs < 0 ||
    (state.startedAtMs !== null && state.startedAtMs > state.lastTransitionAtMs)
  ) {
    throw new SessionTransitionError(
      'invalid_state',
      state.status,
      command.type,
      'Recorder state has invalid revision, duration, or timestamp metadata.',
    );
  }
  if ((state.status === 'recording') !== (state.activeStartedAtMs !== null)) {
    throw new SessionTransitionError(
      'invalid_state',
      state.status,
      command.type,
      'Only a recording state may have a live active-time interval.',
    );
  }
  if (
    state.activeStartedAtMs !== null &&
    (state.activeStartedAtMs < (state.startedAtMs ?? 0) ||
      state.activeStartedAtMs > state.lastTransitionAtMs)
  ) {
    throw new SessionTransitionError(
      'invalid_state',
      state.status,
      command.type,
      'The live active-time interval is outside the session timeline.',
    );
  }

  const openPauses = state.pauseIntervals.filter((interval) => interval.endedAtMs === null).length;
  const openInterruptions = state.interruptionIntervals.filter(
    (interval) => interval.endedAtMs === null,
  ).length;
  if ((state.status === 'paused' ? openPauses !== 1 : openPauses !== 0)) {
    throw new SessionTransitionError(
      'invalid_state',
      state.status,
      command.type,
      'Pause intervals do not agree with recorder status.',
    );
  }
  if ((state.status === 'interrupted' ? openInterruptions !== 1 : openInterruptions !== 0)) {
    throw new SessionTransitionError(
      'invalid_state',
      state.status,
      command.type,
      'Interruption intervals do not agree with recorder status.',
    );
  }
  if ((state.status === 'completed') !== (state.endedAtMs !== null)) {
    throw new SessionTransitionError(
      'invalid_state',
      state.status,
      command.type,
      'Only a completed session may have an end timestamp.',
    );
  }
}

function commitActiveDuration(state: RecorderSessionState, now: number): number {
  return state.activeStartedAtMs === null
    ? state.activeDurationMs
    : state.activeDurationMs + (now - state.activeStartedAtMs);
}

function closeLastPause(
  intervals: readonly PauseInterval[],
  now: number,
): readonly PauseInterval[] {
  const last = intervals.at(-1);
  if (last?.endedAtMs !== null) return intervals;
  return intervals.map((interval, index) =>
    index === intervals.length - 1 ? { ...interval, endedAtMs: now } : interval,
  );
}

function closeLastInterruption(
  intervals: readonly InterruptionInterval[],
  now: number,
): readonly InterruptionInterval[] {
  const last = intervals.at(-1);
  if (last?.endedAtMs !== null) return intervals;
  return intervals.map((interval, index) =>
    index === intervals.length - 1 ? { ...interval, endedAtMs: now } : interval,
  );
}

export function transition(
  state: RecorderSessionState,
  command: RecorderCommand,
  now = Date.now(),
): RecorderSessionState {
  assertTimestamp(now, 'now');
  assertStateInvariant(state, command);
  if (now < state.lastTransitionAtMs) {
    throw new SessionTransitionError(
      'non_monotonic_time',
      state.status,
      command.type,
      'Transition time cannot move backwards.',
    );
  }

  const common = {
    revision: state.revision + 1,
    lastTransitionAtMs: now,
  };

  switch (command.type) {
    case 'record': {
      if (state.status !== 'idle') return invalidTransition(state, command);
      const sessionId = command.sessionId.trim();
      if (sessionId.length === 0 || sessionId.length > 128) {
        throw new SessionTransitionError(
          'invalid_command',
          state.status,
          command.type,
          'sessionId must contain between 1 and 128 characters.',
        );
      }
      return {
        ...state,
        ...common,
        status: 'recording',
        sessionId,
        startedAtMs: now,
        endedAtMs: null,
        activeDurationMs: 0,
        activeStartedAtMs: now,
        pauseIntervals: [],
        interruptionIntervals: [],
        scope: createTabScope(command.rootTabId, {
          addedAtMs: now,
          windowId: command.rootWindowId ?? null,
        }),
        stopReason: null,
      };
    }
    case 'pause': {
      if (state.status !== 'recording') return invalidTransition(state, command);
      return {
        ...state,
        ...common,
        status: 'paused',
        activeDurationMs: commitActiveDuration(state, now),
        activeStartedAtMs: null,
        pauseIntervals: [...state.pauseIntervals, { startedAtMs: now, endedAtMs: null }],
      };
    }
    case 'resume': {
      if (state.status !== 'paused' && state.status !== 'interrupted') {
        return invalidTransition(state, command);
      }
      return {
        ...state,
        ...common,
        status: 'recording',
        activeStartedAtMs: now,
        pauseIntervals:
          state.status === 'paused' ? closeLastPause(state.pauseIntervals, now) : state.pauseIntervals,
        interruptionIntervals:
          state.status === 'interrupted'
            ? closeLastInterruption(state.interruptionIntervals, now)
            : state.interruptionIntervals,
      };
    }
    case 'stop': {
      if (
        state.status !== 'recording' &&
        state.status !== 'paused' &&
        state.status !== 'interrupted'
      ) {
        return invalidTransition(state, command);
      }
      return {
        ...state,
        ...common,
        status: 'finalizing',
        activeDurationMs: commitActiveDuration(state, now),
        activeStartedAtMs: null,
        pauseIntervals:
          state.status === 'paused' ? closeLastPause(state.pauseIntervals, now) : state.pauseIntervals,
        interruptionIntervals:
          state.status === 'interrupted'
            ? closeLastInterruption(state.interruptionIntervals, now)
            : state.interruptionIntervals,
        stopReason: command.reason?.trim() || 'user',
      };
    }
    case 'finalize': {
      if (state.status !== 'finalizing') return invalidTransition(state, command);
      return {
        ...state,
        ...common,
        status: 'completed',
        endedAtMs: now,
      };
    }
    case 'interrupt': {
      if (state.status !== 'recording') return invalidTransition(state, command);
      return {
        ...state,
        ...common,
        status: 'interrupted',
        activeDurationMs: commitActiveDuration(state, now),
        activeStartedAtMs: null,
        interruptionIntervals: [
          ...state.interruptionIntervals,
          {
            startedAtMs: now,
            endedAtMs: null,
            reason: command.reason?.trim() || 'runtime-restarted',
          },
        ],
      };
    }
  }
}

export function getActiveDurationMs(state: RecorderSessionState, now = Date.now()): number {
  assertTimestamp(now, 'now');
  if (now < state.lastTransitionAtMs) {
    throw new RangeError('now cannot be earlier than the last transition.');
  }
  return commitActiveDuration(state, now);
}

export function record(
  state: RecorderSessionState,
  command: Omit<Extract<RecorderCommand, { type: 'record' }>, 'type'>,
  now = Date.now(),
): RecorderSessionState {
  return transition(state, { type: 'record', ...command }, now);
}

export function pause(state: RecorderSessionState, now = Date.now()): RecorderSessionState {
  return transition(state, { type: 'pause' }, now);
}

export function resume(state: RecorderSessionState, now = Date.now()): RecorderSessionState {
  return transition(state, { type: 'resume' }, now);
}

export function stop(
  state: RecorderSessionState,
  now = Date.now(),
  reason?: string,
): RecorderSessionState {
  const command: RecorderCommand =
    reason === undefined ? { type: 'stop' } : { type: 'stop', reason };
  return transition(state, command, now);
}

export function finalize(state: RecorderSessionState, now = Date.now()): RecorderSessionState {
  return transition(state, { type: 'finalize' }, now);
}

export function interrupt(
  state: RecorderSessionState,
  now = Date.now(),
  reason?: string,
): RecorderSessionState {
  const command: RecorderCommand =
    reason === undefined ? { type: 'interrupt' } : { type: 'interrupt', reason };
  return transition(state, command, now);
}
