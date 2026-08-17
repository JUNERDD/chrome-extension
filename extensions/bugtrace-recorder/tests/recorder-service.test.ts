import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  activeTab: { id: 7, windowId: 3, url: 'https://example.test/repro' },
  assets: [] as Array<{ id: string; sessionId: string }>,
  events: [] as Array<{ id: string; sessionId: string; kind: string; data: Record<string, unknown> }>,
  persisted: null as unknown,
  runtimeRestarted: true,
  sentTabMessages: [] as Array<{ tabId: number; message: Record<string, unknown> }>,
  appendEvents: vi.fn(),
  captureRedactedScreenshot: vi.fn(),
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
  captureRedactedScreenshot: mocks.captureRedactedScreenshot,
}));

import { RecorderService } from '../src/background/recorder-service';
import { createIdleState, record } from '../src/session';

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
  mocks.captureRedactedScreenshot.mockReset().mockResolvedValue({
    bytes: new ArrayBuffer(8),
    mimeType: 'image/webp',
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
  mocks.tabsSendMessage.mockReset().mockImplementation(async (tabId, message) => {
    mocks.sentTabMessages.push({ tabId, message });
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
  it('binds final flush to token/frame/doc/client and seals completed sessions', async () => {
    const service = new RecorderService();
    let finalFlushToken = '';
    let sessionId = '';
    let rejectedForgedCompletion = false;
    mocks.tabsSendMessage.mockImplementation(async (tabId, message) => {
      mocks.sentTabMessages.push({ tabId, message });
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
    mocks.tabsSendMessage.mockResolvedValue({ error: 'content rejected state' });
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
});
