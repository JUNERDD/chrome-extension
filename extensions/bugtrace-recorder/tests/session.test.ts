import { describe, expect, it } from 'vitest';

import {
  SessionTransitionError,
  TabScopeError,
  addDescendantTab,
  createIdleState,
  createTabScope,
  getActiveDurationMs,
  getTabLineage,
  isOpenTabInScope,
  isSupportedCaptureUrl,
  isTabInScope,
  markTabClosed,
  recoverAfterRuntimeRestart,
  replaceScopedTab,
  transition,
  updateScopedTabWindow,
} from '../src/session';

describe('recorder session state machine', () => {
  it('records, pauses, resumes, stops and finalizes with monotonic revisions and active time', () => {
    const idle = createIdleState(100);
    const recording = transition(
      idle,
      { type: 'record', sessionId: 'session-a', rootTabId: 7, rootWindowId: 2 },
      1_000,
    );
    expect(getActiveDurationMs(recording, 2_500)).toBe(1_500);

    const paused = transition(recording, { type: 'pause' }, 2_500);
    expect(paused).toMatchObject({ status: 'paused', revision: 2, activeDurationMs: 1_500 });
    expect(getActiveDurationMs(paused, 5_000)).toBe(1_500);

    const resumed = transition(paused, { type: 'resume' }, 5_000);
    const finalizing = transition(resumed, { type: 'stop', reason: 'toolbar' }, 7_000);
    const completed = transition(finalizing, { type: 'finalize' }, 7_100);

    expect(completed).toMatchObject({
      status: 'completed',
      revision: 5,
      sessionId: 'session-a',
      activeDurationMs: 3_500,
      endedAtMs: 7_100,
      stopReason: 'toolbar',
    });
    expect(completed.pauseIntervals).toEqual([{ startedAtMs: 2_500, endedAtMs: 5_000 }]);
    expect(completed.scope?.tabs).toEqual([
      {
        tabId: 7,
        parentTabId: null,
        windowId: 2,
        addedAtMs: 1_000,
        closedAtMs: null,
      },
    ]);
  });

  it('closes a pause interval when stopped without first resuming', () => {
    const recording = transition(
      createIdleState(),
      { type: 'record', sessionId: 'session-b', rootTabId: 1 },
      10,
    );
    const paused = transition(recording, { type: 'pause' }, 20);
    const stopped = transition(paused, { type: 'stop' }, 50);
    expect(stopped.pauseIntervals).toEqual([{ startedAtMs: 20, endedAtMs: 50 }]);
    expect(stopped.activeDurationMs).toBe(10);
  });

  it('rejects illegal transitions and non-monotonic clocks with typed errors', () => {
    const idle = createIdleState(10);
    expect(() => transition(idle, { type: 'pause' }, 11)).toThrowError(SessionTransitionError);
    try {
      transition(idle, { type: 'resume' }, 11);
    } catch (error) {
      expect(error).toMatchObject({
        code: 'invalid_transition',
        from: 'idle',
        command: 'resume',
      });
    }

    const recording = transition(
      idle,
      { type: 'record', sessionId: 'session-c', rootTabId: 1 },
      20,
    );
    expect(() => transition(recording, { type: 'finalize' }, 21)).toThrow(
      'Cannot finalize while recorder is recording',
    );
    try {
      transition(recording, { type: 'pause' }, 19);
      throw new Error('Expected a non-monotonic transition to fail.');
    } catch (error) {
      expect(error).toMatchObject({ code: 'non_monotonic_time' });
    }
  });

  it('does not mutate prior snapshots', () => {
    const idle = Object.freeze(createIdleState());
    const recording = transition(
      idle,
      { type: 'record', sessionId: 'immutable', rootTabId: 9 },
      100,
    );
    Object.freeze(recording.pauseIntervals);
    const paused = transition(recording, { type: 'pause' }, 200);

    expect(idle.status).toBe('idle');
    expect(recording.status).toBe('recording');
    expect(recording.pauseIntervals).toEqual([]);
    expect(paused.pauseIntervals).toHaveLength(1);
  });
});

describe('runtime recovery', () => {
  it('turns an unmarked persisted recording into an explicit interruption', () => {
    const recording = transition(
      createIdleState(),
      { type: 'record', sessionId: 'recover-me', rootTabId: 4 },
      1_000,
    );
    const recovered = recoverAfterRuntimeRestart(recording, false, 3_000);

    expect(recovered.recovered).toBe(true);
    expect(recovered.state).toMatchObject({
      status: 'interrupted',
      activeDurationMs: 2_000,
      revision: 2,
    });
    expect(recovered.state.interruptionIntervals).toEqual([
      {
        startedAtMs: 3_000,
        endedAtMs: null,
        reason: 'service-worker-runtime-marker-missing',
      },
    ]);

    const resumed = transition(recovered.state, { type: 'resume' }, 4_000);
    expect(resumed.interruptionIntervals[0]?.endedAtMs).toBe(4_000);
    expect(getActiveDurationMs(resumed, 4_500)).toBe(2_500);
  });

  it('leaves marked and already-paused states untouched', () => {
    const recording = transition(
      createIdleState(),
      { type: 'record', sessionId: 'still-live', rootTabId: 1 },
      10,
    );
    expect(recoverAfterRuntimeRestart(recording, true, 20)).toEqual({
      state: recording,
      recovered: false,
    });
    const paused = transition(recording, { type: 'pause' }, 20);
    expect(recoverAfterRuntimeRestart(paused, false, 30)).toEqual({
      state: paused,
      recovered: false,
    });
  });
});

describe('tab scope lineage', () => {
  it('contains only the starting tab and transitive opener descendants', () => {
    const root = createTabScope(10, { windowId: 1, addedAtMs: 100 });
    const child = addDescendantTab(root, {
      tabId: 11,
      openerTabId: 10,
      windowId: 2,
      addedAtMs: 200,
    });
    const grandchild = addDescendantTab(child, 12, 11, 300);

    expect(isTabInScope(grandchild, 10)).toBe(true);
    expect(isTabInScope(grandchild, 12)).toBe(true);
    expect(isTabInScope(grandchild, 99)).toBe(false);
    expect(getTabLineage(grandchild, 12)).toEqual([10, 11, 12]);
    expect(getTabLineage(grandchild, 99)).toEqual([]);
    expect(root.tabs).toHaveLength(1);
  });

  it('rejects unrelated opener tabs and conflicting attribution', () => {
    const root = createTabScope(10);
    expect(() => addDescendantTab(root, 20, 99)).toThrowError(TabScopeError);
    const child = addDescendantTab(root, 20, 10);
    expect(addDescendantTab(child, 20, 10)).toBe(child);
    expect(() => addDescendantTab(child, 20, 20)).toThrow('different opener');
  });

  it('enriches a navigation-discovered child with its later tab window identity', () => {
    const root = createTabScope(10, { windowId: 1 });
    const discovered = addDescendantTab(root, { tabId: 20, openerTabId: 10 });
    const enriched = addDescendantTab(discovered, {
      tabId: 20,
      openerTabId: 10,
      windowId: 3,
    });

    expect(enriched).not.toBe(discovered);
    expect(enriched.tabs.find((tab) => tab.tabId === 20)?.windowId).toBe(3);
    expect(addDescendantTab(enriched, { tabId: 20, openerTabId: 10, windowId: 3 })).toBe(
      enriched,
    );
  });

  it('retains closed tabs for attribution while identifying them as inactive', () => {
    const scope = addDescendantTab(createTabScope(10, { addedAtMs: 10 }), 11, 10, 20);
    const closed = markTabClosed(scope, 11, 30);
    expect(isTabInScope(closed, 11)).toBe(true);
    expect(isOpenTabInScope(closed, 11)).toBe(false);
    expect(() => addDescendantTab(closed, 12, 11, 31)).toThrow('after opener');
  });

  it('tracks detach/attach window changes without changing lineage', () => {
    const scope = addDescendantTab(
      createTabScope(10, { windowId: 1 }),
      { tabId: 11, openerTabId: 10, windowId: 1 },
    );
    const detached = updateScopedTabWindow(scope, 11, null);
    const attached = updateScopedTabWindow(detached, 11, 9);

    expect(detached.tabs.find((tab) => tab.tabId === 11)?.windowId).toBeNull();
    expect(attached.tabs.find((tab) => tab.tabId === 11)?.windowId).toBe(9);
    expect(getTabLineage(attached, 11)).toEqual([10, 11]);
    expect(updateScopedTabWindow(attached, 11, 9)).toBe(attached);
  });

  it('preserves both identities and replacement lineage when Chrome replaces a scoped tab id', () => {
    const scope = addDescendantTab(
      createTabScope(10, { windowId: 1, addedAtMs: 5 }),
      { tabId: 11, openerTabId: 10, windowId: 1, addedAtMs: 6 },
    );
    const replaced = replaceScopedTab(scope, {
      removedTabId: 10,
      addedTabId: 20,
      windowId: 3,
      addedAtMs: 7,
    });

    expect(replaced.rootTabId).toBe(20);
    expect(isTabInScope(replaced, 10)).toBe(true);
    expect(isOpenTabInScope(replaced, 10)).toBe(false);
    expect(isOpenTabInScope(replaced, 20)).toBe(true);
    expect(getTabLineage(replaced, 11)).toEqual([20, 11]);
    expect(replaced.tabs.find((tab) => tab.tabId === 10)).toMatchObject({
      windowId: 1,
      addedAtMs: 5,
      closedAtMs: 7,
      replacedByTabId: 20,
    });
    expect(replaced.tabs.find((tab) => tab.tabId === 20)).toMatchObject({
      windowId: 3,
      addedAtMs: 7,
      closedAtMs: null,
      replacesTabId: 10,
    });
  });

  it('accepts only HTTP(S) pages for capture', () => {
    expect(isSupportedCaptureUrl('https://example.test/path')).toBe(true);
    expect(isSupportedCaptureUrl('http://localhost:3000')).toBe(true);
    expect(isSupportedCaptureUrl('chrome://settings')).toBe(false);
    expect(isSupportedCaptureUrl('not a url')).toBe(false);
  });
});
