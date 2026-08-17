import { transition, type RecorderSessionState } from './state-machine';

export interface RuntimeRecoveryResult {
  readonly state: RecorderSessionState;
  readonly recovered: boolean;
}

/**
 * A persisted recording cannot silently continue after the MV3 runtime marker is lost.
 * Paused/finalized states are already quiescent and are returned unchanged.
 */
export function recoverAfterRuntimeRestart(
  state: RecorderSessionState,
  runtimeMarkerPresent: boolean,
  now = Date.now(),
): RuntimeRecoveryResult {
  if (runtimeMarkerPresent || state.status !== 'recording') {
    return { state, recovered: false };
  }
  return {
    state: transition(
      state,
      { type: 'interrupt', reason: 'service-worker-runtime-marker-missing' },
      now,
    ),
    recovered: true,
  };
}
