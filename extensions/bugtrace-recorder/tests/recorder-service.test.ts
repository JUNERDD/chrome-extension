import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  activeTab: { id: 7, windowId: 3, url: 'https://example.test/repro' },
  assets: [] as Array<{ id: string; sessionId: string }>,
  events: [] as Array<{ id: string; sessionId: string; kind: string; data: Record<string, unknown> }>,
  persisted: null as unknown,
  runtimeRestarted: true,
  sentTabMessages: [] as Array<{
    tabId: number;
    message: Record<string, unknown>;
    options?: Record<string, unknown>;
  }>,
  appendEvents: vi.fn(),
  captureScreenshot: vi.fn(),
  cleanupExpiredSessions: vi.fn(),
  clearCurrentSessionState: vi.fn(),
  consumeBrowserRuntimeRestart: vi.fn(),
  deleteAsset: vi.fn(),
  deleteEvent: vi.fn(),
  deleteSession: vi.fn(),
  listAssets: vi.fn(),
  listEvents: vi.fn(),
  loadCurrentSessionState: vi.fn(),
  putAsset: vi.fn(),
  putSession: vi.fn(),
  saveCurrentSessionState: vi.fn(),
  tabsCreate: vi.fn(),
  tabsGet: vi.fn(),
  tabsQuery: vi.fn(),
  tabsSendMessage: vi.fn(),
  getAllFrames: vi.fn(),
  runtimeSendMessage: vi.fn(),
}));

vi.mock('wxt/browser', () => ({
  browser: {
    action: {
      setBadgeText: vi.fn().mockResolvedValue(undefined),
      setBadgeBackgroundColor: vi.fn().mockResolvedValue(undefined),
      setTitle: vi.fn().mockResolvedValue(undefined),
    },
    runtime: {
      getManifest: () => ({ version: '0.2.0' }),
      getURL: (path: string) => `chrome-extension://bugtrace${path}`,
      sendMessage: mocks.runtimeSendMessage,
    },
    tabs: {
      create: mocks.tabsCreate,
      get: mocks.tabsGet,
      query: mocks.tabsQuery,
      sendMessage: mocks.tabsSendMessage,
    },
    webNavigation: { getAllFrames: mocks.getAllFrames },
    windows: { WINDOW_ID_NONE: -1 },
  },
}));

vi.mock('../src/storage', () => ({
  appendEvents: mocks.appendEvents,
  cleanupExpiredSessions: mocks.cleanupExpiredSessions,
  clearCurrentSessionState: mocks.clearCurrentSessionState,
  consumeBrowserRuntimeRestart: mocks.consumeBrowserRuntimeRestart,
  deleteAsset: mocks.deleteAsset,
  deleteEvent: mocks.deleteEvent,
  deleteSession: mocks.deleteSession,
  listAssets: mocks.listAssets,
  listEvents: mocks.listEvents,
  loadCurrentSessionState: mocks.loadCurrentSessionState,
  putAsset: mocks.putAsset,
  putSession: mocks.putSession,
  saveCurrentSessionState: mocks.saveCurrentSessionState,
}));

vi.mock('../src/background/screenshot', () => ({
  captureScreenshot: mocks.captureScreenshot,
}));

import { RecorderService } from '../src/background/recorder-service';
import {
  CAPTURE_PROTOCOL_VERSION,
  CURRENT_RUNTIME_METADATA,
  LONG_RECORDING_WARNING_THRESHOLD_MS,
} from '../src/messaging';
import { createIdleState, finalize, interrupt, pause, record, stop } from '../src/session';

const chromeSender = {
  tabId: 7,
  windowId: 3,
  frameId: 0,
  documentId: 'chrome-document',
  url: 'https://example.test/repro',
};

beforeEach(() => {
  mocks.activeTab = { id: 7, windowId: 3, url: 'https://example.test/repro' };
  mocks.assets = [];
  mocks.events = [];
  mocks.persisted = null;
  mocks.runtimeRestarted = true;
  mocks.sentTabMessages = [];

  mocks.appendEvents.mockReset().mockImplementation(async (events) => {
    mocks.events.push(...events);
  });
  mocks.cleanupExpiredSessions.mockReset().mockResolvedValue(undefined);
  mocks.clearCurrentSessionState.mockReset().mockImplementation(async () => {
    mocks.persisted = null;
  });
  mocks.consumeBrowserRuntimeRestart.mockReset().mockImplementation(async () => mocks.runtimeRestarted);
  mocks.deleteAsset.mockReset().mockImplementation(async (id: string) => {
    mocks.assets = mocks.assets.filter((asset) => asset.id !== id);
  });
  mocks.deleteEvent.mockReset().mockImplementation(async (id: string) => {
    mocks.events = mocks.events.filter((event) => event.id !== id);
  });
  mocks.deleteSession.mockReset().mockImplementation(async (sessionId: string) => {
    mocks.assets = mocks.assets.filter((asset) => asset.sessionId !== sessionId);
    mocks.events = mocks.events.filter((event) => event.sessionId !== sessionId);
  });
  mocks.listAssets.mockReset().mockImplementation(async (sessionId: string) =>
    mocks.assets.filter((asset) => asset.sessionId === sessionId));
  mocks.listEvents.mockReset().mockImplementation(async (sessionId: string) =>
    mocks.events.filter((event) => event.sessionId === sessionId));
  mocks.loadCurrentSessionState.mockReset().mockImplementation(async () => mocks.persisted);
  mocks.putAsset.mockReset().mockImplementation(async (asset) => {
    mocks.assets.push(asset);
  });
  mocks.putSession.mockReset().mockResolvedValue(undefined);
  mocks.saveCurrentSessionState.mockReset().mockImplementation(async (state) => {
    mocks.persisted = state;
  });
  mocks.captureScreenshot.mockReset().mockResolvedValue({
    bytes: new ArrayBuffer(8),
    mimeType: 'image/png',
    width: 100,
    height: 80,
    redactedRectCount: 0,
  });
  mocks.tabsCreate.mockReset().mockResolvedValue({ id: 99 });
  mocks.tabsGet.mockReset().mockImplementation(async (tabId: number) => ({
    id: tabId,
    windowId: mocks.activeTab.windowId,
    url: mocks.activeTab.url,
  }));
  mocks.tabsQuery.mockReset().mockImplementation(async () => [mocks.activeTab]);
  mocks.getAllFrames.mockReset().mockResolvedValue([
    { frameId: 0, documentId: 'chrome-document' },
  ]);
  mocks.runtimeSendMessage.mockReset().mockResolvedValue(undefined);
  mocks.tabsSendMessage.mockReset().mockImplementation(async (tabId, message, options) => {
    mocks.sentTabMessages.push({ tabId, message, options });
    if (message.type === 'CAPTURE_READY') {
      return {
        ready: true,
        protocolVersion: CAPTURE_PROTOCOL_VERSION,
        clientId: `client-${tabId}`,
        documentId: `content-document-${tabId}`,
      };
    }
    if (message.type === 'STATE_CHANGED') {
      return {
        appliedRevision: message.state.revision,
        sessionId: message.state.sessionId,
        transitionedAtMs: message.state.transitionedAtMs,
        clientId: `client-${tabId}`,
        documentId: `content-document-${tabId}`,
      };
    }
    throw new Error(`Unexpected tab message ${String(message.type)}`);
  });
});

describe('RecorderService lifecycle transport', () => {
  it('reports a 14-second recording with gaps only as capture gaps', async () => {
    const startedAt = 1_000;
    const service = new RecorderService();
    await service.ensureInitialized();
    Reflect.set(service, 'state', record(
      createIdleState(0),
      {
        sessionId: 'warning-gap-only',
        rootTabId: 7,
        rootWindowId: 3,
      },
      startedAt,
    ));
    Reflect.set(service, 'gapCount', 2);

    const view = service.getViewState(startedAt + 14_000);

    expect(view.activeDurationMs).toBe(14_000);
    expect(view.warnings).toEqual([{ code: 'capture_gaps', count: 2 }]);
    expect(view.warning).toBeNull();
  });

  it.each([
    [LONG_RECORDING_WARNING_THRESHOLD_MS - 1, false],
    [LONG_RECORDING_WARNING_THRESHOLD_MS, true],
  ] as const)(
    'projects the long-recording warning at the exact %i ms boundary',
    async (activeDurationMs, expected) => {
      const startedAt = 1_000;
      const service = new RecorderService();
      await service.ensureInitialized();
      Reflect.set(service, 'state', record(
        createIdleState(0),
        {
          sessionId: `warning-boundary-${activeDurationMs}`,
          rootTabId: 7,
          rootWindowId: 3,
        },
        startedAt,
      ));

      const view = service.getViewState(startedAt + activeDurationMs);

      expect(view.warnings.some((warning) => warning.code === 'long_recording')).toBe(expected);
      expect(Boolean(view.warning)).toBe(expected);
    },
  );

  it('keeps interruption, capture-gap, and long-recording warnings non-exclusive', async () => {
    const startedAt = 1_000;
    const service = new RecorderService();
    await service.ensureInitialized();
    const recording = record(
      createIdleState(0),
      {
        sessionId: 'warning-coexistence',
        rootTabId: 7,
        rootWindowId: 3,
      },
      startedAt,
    );
    const interruptedAt = startedAt + LONG_RECORDING_WARNING_THRESHOLD_MS;
    Reflect.set(service, 'state', interrupt(recording, interruptedAt, 'runtime-restarted'));
    Reflect.set(service, 'gapCount', 3);

    const view = service.getViewState(interruptedAt);

    expect(view.warnings).toEqual([
      { code: 'runtime_interrupted' },
      { code: 'capture_gaps', count: 3 },
      {
        code: 'long_recording',
        thresholdMs: LONG_RECORDING_WARNING_THRESHOLD_MS,
      },
    ]);
    expect(view.warning).toContain('Browser restarted');
  });

  it('deletes the current completed session and resets every retained-state counter', async () => {
    const sessionId = '12677126-2b8d-4fac-9e89-605f9e840bcb';
    const now = Date.now();
    const completed = finalize(
      stop(
        record(
          createIdleState(now - 300),
          { sessionId, rootTabId: 7, rootWindowId: 3 },
          now - 200,
        ),
        now - 100,
      ),
      now - 50,
    );
    const service = new RecorderService();
    await service.ensureInitialized();
    Reflect.set(service, 'state', completed);
    Reflect.set(service, 'eventCount', 9);
    Reflect.set(service, 'gapCount', 2);
    Reflect.set(service, 'screenshotCount', 3);
    Reflect.set(service, 'networkCount', 4);
    Reflect.set(service, 'consoleCount', 5);
    Reflect.set(service, 'semanticCount', 6);
    mocks.events.push({ id: `${sessionId}:event`, sessionId, kind: 'semantic', data: {} });
    mocks.assets.push({ id: `${sessionId}:asset`, sessionId });

    const response = await service.handleRequest(
      { type: 'DELETE_SESSION', sessionId },
      chromeSender,
    );

    expect(response).toMatchObject({
      ok: true,
      state: {
        status: 'idle',
        sessionId: null,
        eventCount: 0,
        gapCount: 0,
      },
    });
    expect(mocks.deleteSession).toHaveBeenCalledWith(sessionId);
    expect(mocks.events).toHaveLength(0);
    expect(mocks.assets).toHaveLength(0);
    expect(mocks.clearCurrentSessionState).toHaveBeenCalled();
    expect(mocks.runtimeSendMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'STATE_CHANGED',
      state: expect.objectContaining({ status: 'idle', sessionId: null }),
    }));
    expect(Reflect.get(service, 'screenshotCount')).toBe(0);
    expect(Reflect.get(service, 'networkCount')).toBe(0);
    expect(Reflect.get(service, 'consoleCount')).toBe(0);
    expect(Reflect.get(service, 'semanticCount')).toBe(0);
    expect(Reflect.get(service, 'contentClients')).toHaveProperty('size', 0);
  });

  it.each(['recording', 'paused', 'interrupted', 'finalizing'] as const)(
    'rejects deleting the current %s session',
    async (status) => {
      const sessionId = '22677126-2b8d-4fac-9e89-605f9e840bcb';
      const now = Date.now();
      const recording = record(
        createIdleState(now - 300),
        { sessionId, rootTabId: 7, rootWindowId: 3 },
        now - 200,
      );
      const state = status === 'recording'
        ? recording
        : status === 'paused'
          ? pause(recording, now - 100)
          : status === 'interrupted'
            ? interrupt(recording, now - 100, 'runtime-restarted')
            : stop(recording, now - 100);
      const service = new RecorderService();
      await service.ensureInitialized();
      Reflect.set(service, 'state', state);

      const response = await service.handleRequest(
        { type: 'DELETE_SESSION', sessionId },
        chromeSender,
      );

      expect(response).toMatchObject({
        ok: false,
        errorCode: 'operation_rejected',
        state: { status, sessionId },
      });
      expect(mocks.deleteSession).not.toHaveBeenCalled();
      expect(service.getViewState()).toMatchObject({ status, sessionId });
    },
  );

  it('deletes an old session without affecting a newly queued recording', async () => {
    const oldSessionId = '32677126-2b8d-4fac-9e89-605f9e840bcb';
    const now = Date.now();
    const completed = finalize(
      stop(
        record(
          createIdleState(now - 300),
          { sessionId: oldSessionId, rootTabId: 7, rootWindowId: 3 },
          now - 200,
        ),
        now - 100,
      ),
      now - 50,
    );
    const service = new RecorderService();
    await service.ensureInitialized();
    Reflect.set(service, 'state', completed);

    const startNextSession = service.executeCommand('record');
    const deleteOldSession = service.handleRequest(
      { type: 'DELETE_SESSION', sessionId: oldSessionId },
      chromeSender,
    );
    await Promise.all([startNextSession, deleteOldSession]);

    const current = service.getViewState();
    expect(current).toMatchObject({ status: 'recording' });
    expect(current.sessionId).not.toBe(oldSessionId);
    expect(mocks.deleteSession).toHaveBeenCalledWith(oldSessionId);
    expect(mocks.deleteSession).not.toHaveBeenCalledWith(current.sessionId);
  });

  it('requires a versioned acknowledgement from the current top-frame document before recording', async () => {
    const service = new RecorderService();
    const response = await service.handleRequest(
      { type: 'SESSION_COMMAND', command: 'record' },
      chromeSender,
    );

    expect(response).toMatchObject({
      ok: true,
      ...CURRENT_RUNTIME_METADATA,
      state: { status: 'recording' },
    });
    expect(mocks.sentTabMessages[0]).toEqual({
      tabId: 7,
      message: { type: 'CAPTURE_READY', protocolVersion: CAPTURE_PROTOCOL_VERSION },
      options: { frameId: 0, documentId: 'chrome-document' },
    });
  });

  it.each(['no receiver', 'protocol mismatch'] as const)(
    'atomically rejects record when the top-frame capture client has %s',
    async (failure) => {
      mocks.tabsSendMessage.mockImplementation(async (_tabId, message) => {
        if (message.type !== 'CAPTURE_READY') {
          throw new Error(`Unexpected tab message ${String(message.type)}`);
        }
        if (failure === 'no receiver') {
          throw new Error('Could not establish connection. Receiving end does not exist.');
        }
        return {
          ready: true,
          protocolVersion: 0,
          clientId: 'stale-client',
          documentId: 'stale-content-document',
        };
      });
      const service = new RecorderService();

      const response = await service.handleRequest(
        { type: 'SESSION_COMMAND', command: 'record' },
        chromeSender,
      );

      expect(response).toMatchObject({
        ok: false,
        errorCode: 'capture_client_unavailable',
        state: { status: 'idle', sessionId: null, revision: 0 },
      });
      expect(service.getViewState()).toMatchObject({ status: 'idle', sessionId: null, revision: 0 });
      expect(mocks.persisted).toBeNull();
      expect(mocks.saveCurrentSessionState).not.toHaveBeenCalled();
      expect(mocks.putSession).not.toHaveBeenCalled();
      expect(mocks.events).toHaveLength(0);
    },
  );

  it('admits an activated supported tab as a second top-level scope and accepts its capture batch', async () => {
    const service = new RecorderService();
    await service.executeCommand('record');
    const sessionId = service.getViewState().sessionId;
    expect(sessionId).not.toBeNull();

    mocks.sentTabMessages = [];
    mocks.activeTab = { id: 8, windowId: 4, url: 'https://second.example.test/repro' };
    mocks.tabsGet.mockImplementation(async (tabId: number) => tabId === 8
      ? { id: 8, windowId: 4, url: 'https://second.example.test/repro' }
      : { id: 7, windowId: 3, url: 'https://example.test/repro' });
    mocks.getAllFrames.mockImplementation(async ({ tabId }) => [
      { frameId: 0, documentId: `chrome-document-${tabId}` },
    ]);

    await service.handleTabActivated(8);

    expect(service.getViewState()).toMatchObject({ scopedTabCount: 2, gapCount: 0 });
    expect(mocks.persisted).toMatchObject({
      scope: {
        rootTabId: 7,
        tabs: expect.arrayContaining([
          expect.objectContaining({
            tabId: 8,
            parentTabId: null,
            windowId: 4,
            closedAtMs: null,
          }),
        ]),
      },
    });
    expect(mocks.sentTabMessages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        tabId: 8,
        message: expect.objectContaining({ type: 'CAPTURE_READY' }),
      }),
      expect.objectContaining({
        tabId: 8,
        message: expect.objectContaining({ type: 'STATE_CHANGED', captureEnabled: true }),
      }),
    ]));

    const response = await service.handleRequest({
      type: 'CAPTURE_BATCH',
      sessionId: sessionId!,
      documentId: 'content-document-8',
      events: [{
        clientId: 'client-8',
        localSeq: 1,
        observedAt: Date.now(),
        kind: 'semantic',
        data: { action: 'keydown', key: 'K', marker: 'second-tab-batch' },
      }],
    }, {
      tabId: 8,
      windowId: 4,
      frameId: 0,
      documentId: 'chrome-document-8',
      url: 'https://second.example.test/repro',
    });

    expect(response).toMatchObject({ ok: true, accepted: 1 });
    expect(mocks.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'semantic',
        data: expect.objectContaining({ marker: 'second-tab-batch' }),
      }),
    ]));
    expect(service.getViewState().gapCount).toBe(0);
  });

  it('excludes a newly scoped descendant from its first broadcast until HELLO starts capture', async () => {
    const service = new RecorderService();
    await service.executeCommand('record');
    mocks.sentTabMessages = [];

    await service.handleTabCreated({ id: 8, openerTabId: 7, windowId: 3 });

    expect(service.getViewState()).toMatchObject({ scopedTabCount: 2, gapCount: 0 });
    expect(mocks.persisted).toMatchObject({
      scope: {
        tabs: expect.arrayContaining([
          expect.objectContaining({ tabId: 8, parentTabId: 7, closedAtMs: null }),
        ]),
      },
    });
    expect(mocks.sentTabMessages.some(({ tabId }) => tabId === 8)).toBe(false);
    expect(mocks.sentTabMessages).toEqual([]);

    const hello = await service.handleRequest({
      type: 'HELLO',
      clientId: 'client-8',
      documentId: 'content-document-8',
      url: 'https://child.example.test/repro',
    }, {
      tabId: 8,
      windowId: 3,
      frameId: 0,
      documentId: 'chrome-document-8',
      url: 'https://child.example.test/repro',
    });

    expect(hello).toMatchObject({
      ok: true,
      captureEnabled: true,
      state: { scopedTabCount: 2, gapCount: 0 },
    });
  });

  it('enables a descendant client that sends HELLO before its tab-created scope event', async () => {
    const service = new RecorderService();
    await service.executeCommand('record');
    mocks.sentTabMessages = [];

    const earlyHello = await service.handleRequest({
      type: 'HELLO',
      clientId: 'early-child-client',
      documentId: 'early-child-content-document',
      url: 'https://child.example.test/early-hello',
    }, {
      tabId: 10,
      windowId: 3,
      frameId: 0,
      documentId: 'early-child-chrome-document',
      url: 'https://child.example.test/early-hello',
    });
    expect(earlyHello).toMatchObject({ ok: true, captureEnabled: false });

    await service.handleTabCreated({ id: 10, openerTabId: 7, windowId: 3 });

    expect(service.getViewState()).toMatchObject({ scopedTabCount: 2, gapCount: 0 });
    expect(mocks.persisted).toMatchObject({
      scope: {
        tabs: expect.arrayContaining([
          expect.objectContaining({ tabId: 10, parentTabId: 7, closedAtMs: null }),
        ]),
      },
    });
    expect(mocks.sentTabMessages).toEqual([
      expect.objectContaining({
        tabId: 10,
        options: { frameId: 0, documentId: 'early-child-chrome-document' },
        message: expect.objectContaining({ type: 'STATE_CHANGED', captureEnabled: true }),
      }),
    ]);
  });

  it('recovers a known descendant client against its current document before reporting a gap', async () => {
    const service = new RecorderService();
    await service.executeCommand('record');
    await service.handleRequest({
      type: 'HELLO',
      clientId: 'early-child-client',
      documentId: 'early-child-content-document',
      url: 'https://child.example.test/recovery',
    }, {
      tabId: 10,
      windowId: 3,
      frameId: 0,
      documentId: 'stale-child-chrome-document',
      url: 'https://child.example.test/recovery',
    });
    mocks.getAllFrames.mockResolvedValue([
      { frameId: 0, documentId: 'current-child-chrome-document' },
    ]);
    mocks.sentTabMessages = [];
    let deliveryAttempt = 0;
    mocks.tabsSendMessage.mockImplementation(async (tabId, message, options) => {
      mocks.sentTabMessages.push({ tabId, message, options });
      if (tabId !== 10 || message.type !== 'STATE_CHANGED') {
        throw new Error(`Unexpected tab message ${String(message.type)}`);
      }
      deliveryAttempt += 1;
      if (deliveryAttempt === 1) {
        throw new Error('The original document was replaced.');
      }
      return {
        appliedRevision: message.state.revision,
        sessionId: message.state.sessionId,
        transitionedAtMs: message.state.transitionedAtMs,
        clientId: 'current-child-client',
        documentId: 'current-child-content-document',
      };
    });

    await service.handleTabCreated({ id: 10, openerTabId: 7, windowId: 3 });

    expect(deliveryAttempt).toBe(2);
    expect(mocks.sentTabMessages.at(-1)).toMatchObject({
      tabId: 10,
      options: { frameId: 0, documentId: 'current-child-chrome-document' },
    });
    expect(service.getViewState()).toMatchObject({ scopedTabCount: 2, gapCount: 0 });
  });

  it('records one lifecycle gap when a known descendant client fails bounded recovery', async () => {
    const service = new RecorderService();
    await service.executeCommand('record');
    await service.handleRequest({
      type: 'HELLO',
      clientId: 'early-child-client',
      documentId: 'early-child-content-document',
      url: 'https://child.example.test/recovery-failure',
    }, {
      tabId: 10,
      windowId: 3,
      frameId: 0,
      documentId: 'stale-child-chrome-document',
      url: 'https://child.example.test/recovery-failure',
    });
    mocks.getAllFrames.mockResolvedValue([
      { frameId: 0, documentId: 'current-child-chrome-document' },
    ]);
    mocks.tabsSendMessage.mockRejectedValue(new Error('No compatible receiver.'));

    await service.handleTabCreated({ id: 10, openerTabId: 7, windowId: 3 });

    const admissionGaps = mocks.events.filter((event) =>
      event.kind === 'gap' &&
      String(event.data.reason).includes('scope admission after a bounded retry'));
    expect(admissionGaps).toHaveLength(1);
    expect(service.getViewState()).toMatchObject({ scopedTabCount: 2, gapCount: 1 });
  });

  it('waits for an in-flight tab admission before pausing the recording', async () => {
    const service = new RecorderService();
    await service.executeCommand('record');
    mocks.activeTab = { id: 8, windowId: 4, url: 'https://second.example.test/deferred-ready' };
    mocks.tabsGet.mockImplementation(async (tabId: number) => tabId === 8
      ? { id: 8, active: true, windowId: 4, url: mocks.activeTab.url }
      : { id: 7, active: false, windowId: 3, url: 'https://example.test/repro' });
    mocks.getAllFrames.mockImplementation(async ({ tabId }) => [
      { frameId: 0, documentId: `chrome-document-${tabId}` },
    ]);

    let resolveReadiness!: (value: {
      ready: true;
      protocolVersion: typeof CAPTURE_PROTOCOL_VERSION;
      clientId: string;
      documentId: string;
    }) => void;
    const readiness = new Promise<{
      ready: true;
      protocolVersion: typeof CAPTURE_PROTOCOL_VERSION;
      clientId: string;
      documentId: string;
    }>((resolve) => {
      resolveReadiness = resolve;
    });
    let markProbeStarted!: () => void;
    const probeStarted = new Promise<void>((resolve) => {
      markProbeStarted = resolve;
    });
    mocks.tabsSendMessage.mockImplementation(async (tabId, message, options) => {
      mocks.sentTabMessages.push({ tabId, message, options });
      if (tabId === 8 && message.type === 'CAPTURE_READY') {
        markProbeStarted();
        return readiness;
      }
      if (message.type === 'CAPTURE_READY') {
        return {
          ready: true,
          protocolVersion: CAPTURE_PROTOCOL_VERSION,
          clientId: `client-${tabId}`,
          documentId: `content-document-${tabId}`,
        };
      }
      if (message.type === 'STATE_CHANGED') {
        return {
          appliedRevision: message.state.revision,
          sessionId: message.state.sessionId,
          transitionedAtMs: message.state.transitionedAtMs,
          clientId: `client-${tabId}`,
          documentId: `content-document-${tabId}`,
        };
      }
      throw new Error(`Unexpected tab message ${String(message.type)}`);
    });

    const admission = service.handleTabActivated(8);
    await probeStarted;
    let pauseSettled = false;
    const pauseCommand = service.executeCommand('pause').then(() => {
      pauseSettled = true;
    });
    await Promise.resolve();

    expect(pauseSettled).toBe(false);
    expect(service.getViewState()).toMatchObject({ status: 'recording', scopedTabCount: 1 });

    resolveReadiness({
      ready: true,
      protocolVersion: CAPTURE_PROTOCOL_VERSION,
      clientId: 'client-8',
      documentId: 'content-document-8',
    });
    await Promise.all([admission, pauseCommand]);

    expect(service.getViewState()).toMatchObject({ status: 'paused', scopedTabCount: 2, gapCount: 0 });
    expect(mocks.persisted).toMatchObject({
      status: 'paused',
      scope: {
        tabs: expect.arrayContaining([
          expect.objectContaining({ tabId: 8, parentTabId: null, closedAtMs: null }),
        ]),
      },
    });
  });

  it('reports a queued lifecycle failure once and keeps the per-tab queue usable', async () => {
    const service = new RecorderService();
    await service.executeCommand('record');
    mocks.activeTab = { id: 8, windowId: 4, url: 'https://second.example.test/queue-recovery' };
    mocks.tabsGet.mockImplementation(async (tabId: number) => tabId === 8
      ? { id: 8, active: true, windowId: 4, url: mocks.activeTab.url }
      : { id: 7, active: false, windowId: 3, url: 'https://example.test/repro' });
    mocks.tabsQuery.mockRejectedValueOnce(new Error('Visibility lookup failed.'));

    await service.handleTabActivated(8);

    mocks.tabsQuery.mockImplementation(async () => [mocks.activeTab]);
    await service.handleTabActivated(8);
    await service.executeCommand('pause');

    const lifecycleGaps = mocks.events.filter((event) =>
      event.kind === 'gap' &&
      String(event.data.reason).includes('queued tab lifecycle operation(s) failed'));
    expect(lifecycleGaps).toHaveLength(1);
    expect(service.getViewState()).toMatchObject({
      status: 'paused',
      scopedTabCount: 2,
      gapCount: 1,
    });
  });

  it('times out a fixed lifecycle snapshot and prevents late admission from mutating paused state', async () => {
    const service = new RecorderService();
    await service.executeCommand('record');
    vi.useFakeTimers();
    try {
      const deferredTab = { id: 8, active: true, windowId: 4, url: 'https://second.example.test/stuck' };
      mocks.activeTab = deferredTab;
      let resolveTab!: (tab: typeof deferredTab) => void;
      const tabLookup = new Promise<typeof deferredTab>((resolve) => {
        resolveTab = resolve;
      });
      mocks.tabsGet.mockImplementation(async (tabId: number) => tabId === 8
        ? tabLookup
        : { id: 7, active: false, windowId: 3, url: 'https://example.test/repro' });

      const lateAdmission = service.handleTabActivated(8);
      await vi.advanceTimersByTimeAsync(0);
      const pauseCommand = service.executeCommand('pause');
      await vi.advanceTimersByTimeAsync(6_001);
      await pauseCommand;

      expect(service.getViewState()).toMatchObject({
        status: 'paused',
        scopedTabCount: 1,
        gapCount: 1,
      });
      expect(mocks.events.filter((event) =>
        event.kind === 'gap' &&
        String(event.data.reason).includes('tab lifecycle barrier reached'))).toHaveLength(1);

      resolveTab(deferredTab);
      await lateAdmission;
      expect(service.getViewState()).toMatchObject({ status: 'paused', scopedTabCount: 1 });

      mocks.tabsGet.mockResolvedValue(deferredTab);
      await service.executeCommand('resume');
      await service.handleTabActivated(8);
      expect(service.getViewState()).toMatchObject({ status: 'recording', scopedTabCount: 2 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('defers a background-window active tab until that window becomes user-visible', async () => {
    const service = new RecorderService();
    await service.executeCommand('record');
    const tabs = {
      3: { id: 7, active: true, windowId: 3, url: 'https://example.test/repro' },
      4: { id: 8, active: true, windowId: 4, url: 'https://second.example.test/background' },
    } as const;
    let lastFocusedWindowId: keyof typeof tabs = 3;
    mocks.tabsGet.mockImplementation(async (tabId: number) => tabId === 8 ? tabs[4] : tabs[3]);
    mocks.tabsQuery.mockImplementation(async (query: {
      lastFocusedWindow?: boolean;
      windowId?: number;
    }) => {
      if (query.lastFocusedWindow) return [tabs[lastFocusedWindowId]];
      if (query.windowId === 4) return [tabs[4]];
      return [tabs[3]];
    });
    mocks.getAllFrames.mockImplementation(async ({ tabId }) => [
      { frameId: 0, documentId: `chrome-document-${tabId}` },
    ]);
    mocks.sentTabMessages = [];

    await service.handleTabActivated(8);

    expect(service.getViewState()).toMatchObject({ scopedTabCount: 1, gapCount: 0 });
    expect(mocks.sentTabMessages.some(({ tabId }) => tabId === 8)).toBe(false);

    lastFocusedWindowId = 4;
    await service.handleWindowFocused(4);

    expect(service.getViewState()).toMatchObject({ scopedTabCount: 2, gapCount: 0 });
    expect(mocks.sentTabMessages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        tabId: 8,
        message: expect.objectContaining({ type: 'CAPTURE_READY' }),
      }),
      expect.objectContaining({
        tabId: 8,
        message: expect.objectContaining({ type: 'STATE_CHANGED', captureEnabled: true }),
      }),
    ]));
    expect(mocks.events.some((event) =>
      event.kind === 'window' && event.data.action === 'focused'),
    ).toBe(true);
  });

  it('reports one capture gap when a deferred new tab settles on chrome settings', async () => {
    const service = new RecorderService();
    await service.executeCommand('record');
    let currentUrl = 'chrome://newtab/';
    mocks.activeTab = { id: 11, windowId: 3, url: currentUrl };
    mocks.tabsGet.mockImplementation(async (tabId: number) => tabId === 11
      ? { id: 11, active: true, windowId: 3, url: currentUrl }
      : { id: 7, active: false, windowId: 3, url: 'https://example.test/repro' });

    await service.handleTabActivated(11);
    expect(service.getViewState()).toMatchObject({ scopedTabCount: 1, gapCount: 0 });

    currentUrl = 'chrome://settings/';
    mocks.activeTab = { id: 11, windowId: 3, url: currentUrl };
    const settledTab = { id: 11, active: true, windowId: 3, url: currentUrl };
    await service.handleTabUpdated(11, settledTab);
    await service.handleTabUpdated(11, settledTab);
    await service.handleTabActivated(11);

    const coverageGaps = mocks.events.filter((event) =>
      event.kind === 'gap' &&
      String(event.data.reason).includes('restricted or unsupported URL'));
    const view = service.getViewState();
    expect(coverageGaps).toHaveLength(1);
    expect(view).toMatchObject({ scopedTabCount: 1, gapCount: 1, warning: null });
    expect(view.warnings).toEqual([{ code: 'capture_gaps', count: 1 }]);
    expect(view.warnings.some((warning) => warning.code === 'long_recording')).toBe(false);
  });

  it('reports a coverage gap when Chrome new-tab reaches complete without a capturable URL', async () => {
    const service = new RecorderService();
    await service.executeCommand('record');
    const newTab = { id: 12, active: true, windowId: 3, url: 'chrome://newtab/' };
    mocks.activeTab = newTab;
    mocks.tabsGet.mockImplementation(async (tabId: number) => tabId === 12
      ? newTab
      : { id: 7, active: false, windowId: 3, url: 'https://example.test/repro' });

    await service.handleTabActivated(12);
    await service.handleTabUpdated(12, newTab, 'complete');

    expect(mocks.events.filter((event) =>
      event.kind === 'gap' &&
      String(event.data.reason).includes('restricted or unsupported URL'))).toHaveLength(1);
    expect(service.getViewState()).toMatchObject({ scopedTabCount: 1, gapCount: 1 });
  });

  it('accepts a same-session state acknowledgement that is ahead of the delivered view', async () => {
    mocks.tabsSendMessage.mockImplementation(async (tabId, message, options) => {
      mocks.sentTabMessages.push({ tabId, message, options });
      if (message.type === 'CAPTURE_READY') {
        return {
          ready: true,
          protocolVersion: CAPTURE_PROTOCOL_VERSION,
          clientId: `client-${tabId}`,
          documentId: `content-document-${tabId}`,
        };
      }
      if (message.type === 'STATE_CHANGED') {
        return {
          appliedRevision: message.state.revision + 1,
          sessionId: message.state.sessionId,
          transitionedAtMs: message.state.transitionedAtMs + 1,
          clientId: `client-${tabId}`,
          documentId: `content-document-${tabId}`,
        };
      }
      throw new Error(`Unexpected tab message ${String(message.type)}`);
    });
    const service = new RecorderService();

    await service.executeCommand('record');

    expect(service.getViewState()).toMatchObject({ status: 'recording', gapCount: 0 });
    expect(mocks.events.some((event) => event.kind === 'gap')).toBe(false);
    expect(mocks.sentTabMessages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        tabId: 7,
        message: expect.objectContaining({ type: 'STATE_CHANGED', captureEnabled: true }),
      }),
    ]));
  });

  it('admits an active new tab after it transitions from Chrome new-tab to HTTP', async () => {
    const service = new RecorderService();
    await service.executeCommand('record');
    let pendingUrl = 'chrome://newtab/';
    mocks.activeTab = { id: 9, windowId: 3, url: pendingUrl };
    mocks.tabsGet.mockImplementation(async (tabId: number) => tabId === 9
      ? { id: 9, active: true, windowId: 3, url: pendingUrl }
      : { id: 7, active: false, windowId: 3, url: 'https://example.test/repro' });
    mocks.getAllFrames.mockImplementation(async ({ tabId }) => [
      { frameId: 0, documentId: `chrome-document-${tabId}` },
    ]);

    await service.handleTabActivated(9);
    expect(service.getViewState()).toMatchObject({ scopedTabCount: 1, gapCount: 0 });
    await service.handleTabUpdated(9, {
      id: 9,
      active: true,
      windowId: 3,
      url: pendingUrl,
    }, 'loading');
    expect(service.getViewState()).toMatchObject({ scopedTabCount: 1, gapCount: 0 });

    pendingUrl = 'http://127.0.0.1:4177/sensitive.html#new-tab-transition';
    mocks.sentTabMessages = [];
    await service.handleTabUpdated(9, {
      id: 9,
      active: true,
      windowId: 3,
      url: pendingUrl,
    }, 'loading');

    expect(service.getViewState()).toMatchObject({ scopedTabCount: 2, gapCount: 0 });
    expect(mocks.persisted).toMatchObject({
      scope: {
        tabs: expect.arrayContaining([
          expect.objectContaining({
            tabId: 9,
            parentTabId: null,
            windowId: 3,
            closedAtMs: null,
          }),
        ]),
      },
    });
    expect(mocks.sentTabMessages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        tabId: 9,
        message: expect.objectContaining({ type: 'CAPTURE_READY' }),
      }),
      expect.objectContaining({
        tabId: 9,
        message: expect.objectContaining({ type: 'STATE_CHANGED', captureEnabled: true }),
      }),
    ]));
  });

  it('binds final flush to token/frame/doc/client and seals completed sessions', async () => {
    const service = new RecorderService();
    let finalFlushToken = '';
    let sessionId = '';
    let rejectedForgedCompletion = false;
    mocks.tabsSendMessage.mockImplementation(async (tabId, message, options) => {
      mocks.sentTabMessages.push({ tabId, message, options });
      if (message.type === 'CAPTURE_READY') {
        return {
          ready: true,
          protocolVersion: CAPTURE_PROTOCOL_VERSION,
          clientId: `client-${tabId}`,
          documentId: `content-document-${tabId}`,
        };
      }
      if (message.type === 'STATE_CHANGED') {
        sessionId = message.state.sessionId ?? sessionId;
        return {
          appliedRevision: message.state.revision,
          sessionId: message.state.sessionId,
          transitionedAtMs: message.state.transitionedAtMs,
          clientId: 'client-7',
          documentId: 'content-document-7',
        };
      }
      if (message.type === 'FLUSH_CAPTURE') {
        finalFlushToken = message.flushToken;
        const forged = await service.handleRequest({
          type: 'FLUSH_COMPLETE',
          sessionId: message.sessionId,
          flushToken: message.flushToken,
          clientId: 'client-7',
          documentId: 'forged-content-document',
          droppedCount: 0,
          droppedBySource: { semantic: 0, rrweb: 0, console: 0, lifecycle: 0 },
        }, chromeSender);
        rejectedForgedCompletion = !forged.ok;
        const completion = await service.handleRequest({
          type: 'FLUSH_COMPLETE',
          sessionId: message.sessionId,
          flushToken: message.flushToken,
          clientId: 'client-7',
          documentId: 'content-document-7',
          droppedCount: 0,
          droppedBySource: { semantic: 0, rrweb: 0, console: 0, lifecycle: 0 },
        }, chromeSender);
        expect(completion.ok).toBe(true);
        return {
          flushed: true,
          sessionId: message.sessionId,
          flushToken: message.flushToken,
          clientId: 'client-7',
          documentId: 'content-document-7',
          droppedCount: 0,
          droppedBySource: { semantic: 0, rrweb: 0, console: 0, lifecycle: 0 },
        };
      }
      throw new Error(`Unexpected tab message ${String(message.type)}`);
    });

    await service.executeCommand('record');
    await service.executeCommand('stop');
    expect(rejectedForgedCompletion).toBe(true);
    expect(service.getViewState().status).toBe('completed');

    const eventCount = mocks.events.length;
    const viewBeforeLateMessage = service.getViewState();
    const late = await service.handleRequest({
      type: 'FLUSH_COMPLETE',
      sessionId,
      flushToken: finalFlushToken,
      clientId: 'client-7',
      documentId: 'content-document-7',
      droppedCount: 3,
      droppedBySource: { semantic: 1, rrweb: 1, console: 1, lifecycle: 0 },
    }, chromeSender);

    expect(late.ok).toBe(false);
    expect(mocks.events).toHaveLength(eventCount);
    expect(service.getViewState()).toEqual(viewBeforeLateMessage);
  });

  it('treats fulfilled malformed state responses as delivery gaps', async () => {
    mocks.tabsSendMessage.mockImplementation(async (tabId, message) => {
      if (message.type === 'CAPTURE_READY') {
        return {
          ready: true,
          protocolVersion: CAPTURE_PROTOCOL_VERSION,
          clientId: `client-${tabId}`,
          documentId: `content-document-${tabId}`,
        };
      }
      return { error: 'content rejected state' };
    });
    const service = new RecorderService();

    await service.executeCommand('record');

    expect(service.getViewState().gapCount).toBe(1);
    expect(mocks.events.some((event) =>
      event.kind === 'gap' && String(event.data.reason).includes('did not acknowledge recorder state')),
    ).toBe(true);
  });

  it('persists identity-bound per-source transport losses reported during final flush', async () => {
    const service = new RecorderService();
    mocks.tabsSendMessage.mockImplementation(async (tabId, message) => {
      if (message.type === 'CAPTURE_READY') {
        return {
          ready: true,
          protocolVersion: CAPTURE_PROTOCOL_VERSION,
          clientId: `client-${tabId}`,
          documentId: `content-document-${tabId}`,
        };
      }
      if (message.type === 'STATE_CHANGED') {
        return {
          appliedRevision: message.state.revision,
          sessionId: message.state.sessionId,
          transitionedAtMs: message.state.transitionedAtMs,
          clientId: `client-${tabId}`,
          documentId: `content-document-${tabId}`,
        };
      }
      if (message.type === 'FLUSH_CAPTURE') {
        const droppedBySource = { semantic: 2, rrweb: 1, console: 3, lifecycle: 0 };
        const completion = await service.handleRequest({
          type: 'FLUSH_COMPLETE',
          sessionId: message.sessionId,
          flushToken: message.flushToken,
          clientId: `client-${tabId}`,
          documentId: `content-document-${tabId}`,
          droppedCount: 6,
          droppedBySource,
        }, chromeSender);
        expect(completion.ok).toBe(true);
        return {
          flushed: false,
          error: 'capture batch acknowledgement failed',
          sessionId: message.sessionId,
          flushToken: message.flushToken,
          clientId: `client-${tabId}`,
          documentId: `content-document-${tabId}`,
          droppedCount: 6,
          droppedBySource,
        };
      }
      throw new Error(`Unexpected tab message ${String(message.type)}`);
    });

    await service.executeCommand('record');
    await service.executeCommand('stop');

    const countedGaps = mocks.events.filter((event) => event.kind === 'gap')
      .map((event) => event.data.droppedCount)
      .filter((value) => typeof value === 'number');
    expect(countedGaps).toEqual(expect.arrayContaining([1, 2, 3]));
    expect(countedGaps.reduce((sum, count) => sum + Number(count), 0)).toBe(6);
  });

  it('rebinds an interrupted session to the current HTTP(S) tab and shuts down old scope', async () => {
    const sessionId = '12677126-2b8d-4fac-9e89-605f9e840bcb';
    const now = Date.now();
    mocks.persisted = record(
      createIdleState(now - 1_000),
      { sessionId, rootTabId: 1, rootWindowId: 1 },
      now - 500,
    );
    mocks.runtimeRestarted = true;
    mocks.activeTab = { id: 2, windowId: 9, url: 'https://example.test/rebound' };
    mocks.getAllFrames.mockImplementation(async ({ tabId }) => [
      { frameId: 0, documentId: `chrome-document-${tabId}` },
    ]);

    const service = new RecorderService();
    await service.ensureInitialized();
    expect(service.getViewState().status).toBe('interrupted');
    await service.executeCommand('resume');

    expect(service.getViewState()).toMatchObject({ status: 'recording', scopedTabCount: 1 });
    expect(mocks.persisted).toMatchObject({ scope: { rootTabId: 2 } });
    expect(mocks.events.some((event) => event.data.kind === 'lineage_rebound')).toBe(true);
    expect(mocks.sentTabMessages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        tabId: 1,
        message: expect.objectContaining({ type: 'STATE_CHANGED', captureEnabled: false }),
      }),
      expect.objectContaining({
        tabId: 2,
        message: expect.objectContaining({ type: 'STATE_CHANGED', captureEnabled: true }),
      }),
    ]));
  });

  it('keeps an interrupted session bound to its old scope when rebound readiness is stale', async () => {
    const sessionId = '32677126-2b8d-4fac-9e89-605f9e840bcb';
    const now = Date.now();
    mocks.persisted = record(
      createIdleState(now - 1_000),
      { sessionId, rootTabId: 1, rootWindowId: 1 },
      now - 500,
    );
    mocks.runtimeRestarted = true;
    mocks.activeTab = { id: 2, windowId: 9, url: 'https://example.test/rebound' };
    mocks.getAllFrames.mockResolvedValue([
      { frameId: 0, documentId: 'chrome-document-2' },
    ]);
    const service = new RecorderService();
    await service.ensureInitialized();
    const stateBeforeResume = service.getViewState();
    const persistedWritesBeforeResume = mocks.saveCurrentSessionState.mock.calls.length;
    const eventCountBeforeResume = mocks.events.length;
    mocks.tabsSendMessage.mockResolvedValue({
      ready: true,
      protocolVersion: 0,
      clientId: 'stale-client',
      documentId: 'stale-content-document',
    });

    const response = await service.handleRequest(
      { type: 'SESSION_COMMAND', command: 'resume' },
      chromeSender,
    );

    expect(response).toMatchObject({ ok: false, errorCode: 'capture_client_unavailable' });
    expect(service.getViewState()).toEqual(stateBeforeResume);
    expect(mocks.persisted).toMatchObject({
      status: 'interrupted',
      sessionId,
      scope: { rootTabId: 1 },
    });
    expect(mocks.saveCurrentSessionState).toHaveBeenCalledTimes(persistedWritesBeforeResume);
    expect(mocks.events).toHaveLength(eventCountBeforeResume);
    expect(mocks.events.some((event) => event.data.kind === 'lineage_rebound')).toBe(false);
  });

  it.each([
    [
      "Either the '<all_urls>' or 'activeTab' permission is required.",
      'screenshot_authorization_required',
    ],
    ['Screenshot skipped because no visible scoped tab is available.', 'screenshot_outside_scope'],
    ['Screenshot discarded because the document changed during capture.', 'screenshot_document_changed'],
    [
      'Could not establish connection. Receiving end does not exist.',
      'capture_client_unavailable',
    ],
    ['Canvas encoder failed unexpectedly.', 'screenshot_failed'],
  ] as const)('returns a structured screenshot error code for %s', async (message, errorCode) => {
    const service = new RecorderService();
    await service.executeCommand('record');
    mocks.captureScreenshot.mockRejectedValueOnce(new Error(message));

    const response = await service.handleRequest(
      { type: 'SESSION_COMMAND', command: 'screenshot' },
      chromeSender,
    );

    expect(response).toMatchObject({ ok: false, error: message, errorCode });
    expect(service.getViewState().status).toBe('recording');
  });

  it('fills nav-target window identity once and follows detach/attach/replacement scope changes', async () => {
    const service = new RecorderService();
    await service.executeCommand('record');

    await service.handleTabCreated({ id: 8, openerTabId: 7 });
    await service.handleTabCreated({ id: 8, openerTabId: 7, windowId: 4 });
    expect(mocks.events.filter((event) =>
      event.kind === 'tab' && event.data.action === 'created'),
    ).toHaveLength(1);
    expect(mocks.events.filter((event) =>
      event.kind === 'window' && event.data.action === 'created'),
    ).toHaveLength(1);

    await service.handleTabDetached(7, 3);
    await service.handleTabAttached(7, 9);
    await service.handleNetworkStart({
      requestId: 'replaced-pending',
      tabId: 7,
      method: 'GET',
      type: 'xmlhttprequest',
      url: 'https://example.test/api/replaced',
      timeStamp: Date.now(),
    });
    mocks.activeTab = { id: 12, windowId: 9, url: 'https://example.test/replaced' };
    await service.handleTabReplaced(12, 7);

    expect(mocks.persisted).toMatchObject({
      scope: {
        rootTabId: 12,
        tabs: expect.arrayContaining([
          expect.objectContaining({ tabId: 12, windowId: 9, closedAtMs: null }),
          expect.objectContaining({ tabId: 8, parentTabId: 12, windowId: 4 }),
        ]),
      },
    });
    expect(mocks.events.some((event) =>
      event.kind === 'tab' && event.data.action === 'detached'),
    ).toBe(true);
    expect(mocks.events.some((event) =>
      event.kind === 'tab' && event.data.action === 'attached'),
    ).toBe(true);
    expect(mocks.events.some((event) =>
      event.kind === 'tab' && event.data.action === 'replaced'),
    ).toBe(true);
    expect(mocks.events.some((event) =>
      event.kind === 'gap' && event.data.droppedCount === 1 &&
      String(event.data.reason).startsWith('Chrome replaced a scoped tab')),
    ).toBe(true);

    await service.handleNetworkStart({
      requestId: 'closed-pending',
      tabId: 8,
      method: 'GET',
      type: 'xmlhttprequest',
      url: 'https://example.test/api/closed',
      timeStamp: Date.now(),
    });
    await service.handleTabRemoved(8);
    expect(mocks.events.some((event) =>
      event.kind === 'gap' && event.data.droppedCount === 1 &&
      String(event.data.reason).startsWith('A scoped tab closed with')),
    ).toBe(true);
  });

  it('persists raw URLs, duplicate headers, request bodies, and request identity locally', async () => {
    const service = new RecorderService();
    await service.executeCommand('record');
    const startedAt = Date.now();
    await service.handleNetworkStart({
      requestId: 'request-full-fidelity',
      tabId: 7,
      method: 'POST',
      type: 'xmlhttprequest',
      url: 'https://example.test/api?token=raw-token#raw-fragment',
      timeStamp: startedAt,
      requestBody: {
        status: 'captured',
        encoding: 'form-data',
        value: { password: ['raw-password'] },
      },
    });
    await service.handleNetworkHeaders({
      requestId: 'request-full-fidelity',
      tabId: 7,
      method: 'POST',
      type: 'xmlhttprequest',
      url: 'https://example.test/api?token=raw-token#raw-fragment',
      timeStamp: startedAt + 1,
      requestHeaders: {
        authorization: ['Bearer raw-authorization'],
        cookie: ['session=raw-cookie', 'experiment=full'],
      },
    });
    await service.handleNetworkEnd({
      requestId: 'request-full-fidelity',
      tabId: 7,
      method: 'POST',
      type: 'xmlhttprequest',
      url: 'https://example.test/api?token=raw-token#raw-fragment',
      timeStamp: startedAt + 10,
      statusCode: 503,
      responseHeaders: {
        'set-cookie': ['server=raw-cookie'],
        'content-type': ['application/json; charset=utf-8'],
      },
    });

    const event = mocks.events.find((candidate) => candidate.kind === 'network');
    expect(event?.data).toMatchObject({
      requestId: 'request-full-fidelity',
      url: 'https://example.test/api?token=raw-token#raw-fragment',
      requestHeaders: {
        authorization: ['Bearer raw-authorization'],
        cookie: ['session=raw-cookie', 'experiment=full'],
      },
      responseHeaders: {
        'set-cookie': ['server=raw-cookie'],
        'content-type': ['application/json; charset=utf-8'],
      },
      requestBody: {
        status: 'captured',
        value: { password: ['raw-password'] },
      },
      responseBody: { status: 'unavailable' },
    });
  });

  it('persists every budget drop as an incremental counted gap across worker rehydration', async () => {
    const service = new RecorderService();
    await service.executeCommand('record');
    Reflect.set(service, 'networkCount', 5_000);

    await service.handleNetworkEnd({
      requestId: 'over-budget',
      tabId: 7,
      method: 'GET',
      type: 'xmlhttprequest',
      url: 'https://example.test/api',
      timeStamp: Date.now(),
      statusCode: 200,
    });
    expect(mocks.events.some((event) =>
      event.kind === 'gap' && event.data.droppedCount === 1 &&
      String(event.data.reason).includes('Network evidence budget reached')),
    ).toBe(true);

    mocks.runtimeRestarted = false;
    const rehydrated = new RecorderService();
    await rehydrated.ensureInitialized();
    expect(rehydrated.getViewState().gapCount).toBeGreaterThanOrEqual(1);
  });

  it('reserves network capacity before asynchronous persistence so concurrent completions cannot exceed the limit', async () => {
    const service = new RecorderService();
    await service.executeCommand('record');
    Reflect.set(service, 'networkCount', 4_999);

    let releaseFirstWrite!: () => void;
    const firstWriteGate = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    let firstNetworkWriteStarted = false;
    mocks.appendEvents.mockImplementation(async (events: typeof mocks.events) => {
      if (!firstNetworkWriteStarted && events.some((event) => event.kind === 'network')) {
        firstNetworkWriteStarted = true;
        await firstWriteGate;
      }
      mocks.events.push(...events);
    });

    const first = service.handleNetworkEnd({
      requestId: 'at-budget',
      tabId: 7,
      method: 'GET',
      type: 'xmlhttprequest',
      url: 'https://example.test/api/first',
      timeStamp: Date.now(),
      statusCode: 200,
    });
    await vi.waitFor(() => expect(firstNetworkWriteStarted).toBe(true));
    const second = service.handleNetworkEnd({
      requestId: 'over-budget-concurrent',
      tabId: 7,
      method: 'GET',
      type: 'xmlhttprequest',
      url: 'https://example.test/api/second',
      timeStamp: Date.now(),
      statusCode: 200,
    });

    releaseFirstWrite();
    await Promise.all([first, second]);

    expect(mocks.events.filter((event) => event.kind === 'network')).toHaveLength(1);
    expect(mocks.events.some((event) =>
      event.kind === 'gap' && event.data.droppedCount === 1 &&
      String(event.data.reason).includes('Network evidence budget reached')),
    ).toBe(true);
    expect(Reflect.get(service, 'networkCount')).toBe(5_000);
  });

  it('declares in-flight network outcomes lost at pause and stop boundaries', async () => {
    const service = new RecorderService();
    await service.executeCommand('record');
    await service.handleNetworkStart({
      requestId: 'pause-pending-1',
      tabId: 7,
      method: 'GET',
      type: 'xmlhttprequest',
      url: 'https://example.test/api/slow-1',
      timeStamp: Date.now(),
    });
    await service.handleNetworkStart({
      requestId: 'pause-pending-2',
      tabId: 7,
      method: 'GET',
      type: 'xmlhttprequest',
      url: 'https://example.test/api/slow-2',
      timeStamp: Date.now(),
    });
    await service.executeCommand('pause');

    expect(mocks.events.some((event) =>
      event.kind === 'gap' && event.data.droppedCount === 2 &&
      String(event.data.reason).startsWith('Pause ended correlation')),
    ).toBe(true);

    await service.executeCommand('resume');
    await service.handleNetworkStart({
      requestId: 'stop-pending',
      tabId: 7,
      method: 'GET',
      type: 'xmlhttprequest',
      url: 'https://example.test/api/slow-3',
      timeStamp: Date.now(),
    });
    await service.executeCommand('stop');

    expect(mocks.events.some((event) =>
      event.kind === 'gap' && event.data.droppedCount === 1 &&
      String(event.data.reason).startsWith('Stop ended correlation')),
    ).toBe(true);
  });

  it('seals an interrupted session without contacting or screenshotting stale browser scope', async () => {
    const sessionId = '62677126-2b8d-4fac-9e89-605f9e840bcb';
    const now = Date.now();
    mocks.persisted = record(
      createIdleState(now - 1_000),
      { sessionId, rootTabId: 1, rootWindowId: 1 },
      now - 500,
    );
    mocks.runtimeRestarted = true;
    mocks.activeTab = { id: 77, windowId: 9, url: 'https://unrelated.test/' };

    const service = new RecorderService();
    await service.ensureInitialized();
    expect(service.getViewState().status).toBe('interrupted');
    await service.executeCommand('stop');

    expect(service.getViewState().status).toBe('completed');
    expect(mocks.tabsSendMessage).not.toHaveBeenCalled();
    expect(mocks.captureScreenshot).not.toHaveBeenCalled();
    expect(mocks.events.some((event) =>
      event.kind === 'gap' && String(event.data.reason).includes('pre-restart tab scope')),
    ).toBe(true);
  });
});
