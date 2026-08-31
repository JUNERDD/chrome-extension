import { browser } from 'wxt/browser';
import type { MessageKey } from '../i18n/catalog';
import { resolveLocale, translateMessage } from '../i18n/core';
import { getSystemLanguage, loadLanguagePreference } from '../i18n/runtime';
import {
  CAPTURE_PROTOCOL_VERSION,
  CURRENT_RUNTIME_METADATA,
  LONG_RECORDING_WARNING_THRESHOLD_MS,
  isCaptureReadyAck,
  isFlushCaptureAck,
  isStateChangedAck,
  jsonUtf8ByteLength,
  type ClientCaptureEvent,
  type RecorderViewState,
  type RuntimeRequest,
  type RuntimeErrorCode,
  type RuntimeResponse,
  type StateChangedAck,
  type TransportDropCounts,
  type TransportDropSource,
} from '../messaging';
import {
  addDescendantTab,
  addTopLevelTab,
  createTabScope,
  createIdleState,
  finalize,
  getActiveDurationMs,
  isOpenTabInScope,
  isSupportedCaptureUrl,
  markTabClosed,
  pause,
  record,
  recoverAfterRuntimeRestart,
  replaceScopedTab,
  resume,
  stop,
  updateScopedTabWindow,
  type RecorderSessionState,
} from '../session';
import {
  appendEvents,
  cleanupExpiredSessions,
  clearCurrentSessionState,
  consumeBrowserRuntimeRestart,
  deleteAsset,
  deleteEvent,
  deleteSession,
  listEvents,
  listAssets,
  loadCurrentSessionState,
  putAsset,
  putSession,
  saveCurrentSessionState,
  type StoredEvent,
} from '../storage';
import { captureScreenshot } from './screenshot';
import type {
  NavigationObservation,
  NetworkObservation,
  PersistedRecorderSession,
  SenderContext,
} from './types';

const ACTIVE_STATUSES = new Set(['recording', 'paused', 'interrupted', 'finalizing']);
const SESSION_TTL_MS = 24 * 60 * 60 * 1_000;
const FLUSH_TIMEOUT_MS = 4_000;
const CAPTURE_READY_TIMEOUT_MS = 1_500;
const CAPTURE_READY_PROBE_TIMEOUT_MS = 250;
const CAPTURE_READY_POLL_INTERVAL_MS = 75;
const TAB_LIFECYCLE_BARRIER_TIMEOUT_MS =
  CAPTURE_READY_TIMEOUT_MS + FLUSH_TIMEOUT_MS + 500;
const MAX_SCREENSHOTS = 20;
const MAX_SCREENSHOT_BYTES = 128_000_000;
const MAX_PENDING_REQUESTS = 5_000;
const MAX_NETWORK_EVENTS = 5_000;
const MAX_NETWORK_BYTES = 64_000_000;
const MAX_CONSOLE_EVENTS = 1_000;
const MAX_CONSOLE_BYTES = 32_000_000;
const MAX_RRWEB_BYTES = 256_000_000;
const MAX_SEMANTIC_EVENTS = 50_000;
const MAX_SEMANTIC_BYTES = 64_000_000;

const STATUS_LABEL_KEYS = {
  idle: 'sidepanel.status.idle.label',
  recording: 'sidepanel.status.recording.label',
  paused: 'sidepanel.status.paused.label',
  finalizing: 'sidepanel.status.finalizing.label',
  completed: 'sidepanel.status.completed.label',
  interrupted: 'sidepanel.status.interrupted.label',
} as const satisfies Record<RecorderSessionState['status'], MessageKey>;

interface RequestStart {
  startedAt: number;
  method: string;
  type: string;
  url: string;
  tabId: number;
  requestHeaders?: Readonly<Record<string, readonly string[]>>;
  requestBody?: NetworkObservation['requestBody'];
}

interface ContentClientIdentity {
  tabId: number;
  frameId: number;
  chromeDocumentId: string | null;
  clientId: string;
  contentDocumentId: string;
}

interface ExpectedFlush {
  sessionId: string;
  flushToken: string;
  tabId: number;
  frameId: number;
  chromeDocumentId: string | null;
  clientId: string | null;
  contentDocumentId: string | null;
  completed: boolean;
  droppedCount: number;
  droppedBySource: TransportDropCounts;
}

export class RecorderService {
  private state: RecorderSessionState = createIdleState(0);
  private eventCount = 0;
  private gapCount = 0;
  private screenshotCount = 0;
  private screenshotBytes = 0;
  private networkCount = 0;
  private networkBytes = 0;
  private consoleCount = 0;
  private consoleBytes = 0;
  private rrwebBytes = 0;
  private semanticCount = 0;
  private semanticBytes = 0;
  private nextSeq = 1;
  private initialized: Promise<void> | null = null;
  private commandQueue: Promise<void> = Promise.resolve();
  private readonly requestStarts = new Map<string, RequestStart>();
  private readonly contentClients = new Map<string, ContentClientIdentity>();
  private readonly expectedFlushes = new Map<string, ExpectedFlush>();
  private readonly replacedTabIds = new Set<number>();
  private lastScreenshotAt = 0;
  private screenshotLimitReported = false;
  private screenshotQueue: Promise<void> = Promise.resolve();
  private screenshotEpoch = 0;
  private evidenceWriteQueue: Promise<void> = Promise.resolve();
  private persistenceQueue: Promise<void> = Promise.resolve();
  private stateDeliveryGapKey: string | null = null;
  private readonly tabLifecycleOperations = new Map<number, Promise<void>>();
  private readonly windowFocusOperations = new Set<Promise<void>>();
  private readonly lifecycleOperationEpochs = new Map<Promise<void>, number>();
  private readonly lifecycleFailures = new Map<
    number,
    { sessionId: string | null; message: string }
  >();
  private lifecycleEpoch = 0;
  private lifecycleFailuresHandledThroughEpoch = 0;
  private lifecycleCancelledThroughEpoch = 0;
  private readonly tabAdmissionFailureUrls = new Map<number, string>();
  private readonly reportedUnsupportedUrls = new Map<number, string>();

  ensureInitialized(): Promise<void> {
    this.initialized ??= this.initialize();
    return this.initialized;
  }

  async refreshActionTitle(): Promise<void> {
    await this.ensureInitialized();
    await this.updateBadge();
  }

  private async initialize(): Promise<void> {
    const now = Date.now();
    const [persisted, runtimeRestarted] = await Promise.all([
      loadCurrentSessionState<RecorderSessionState>(),
      consumeBrowserRuntimeRestart(),
      cleanupExpiredSessions(),
    ]);
    this.state = persisted ?? createIdleState(now);

    if (persisted) {
      if (now - persisted.lastTransitionAtMs >= SESSION_TTL_MS) {
        if (persisted.sessionId) await deleteSession(persisted.sessionId);
        await clearCurrentSessionState();
        this.state = createIdleState(now);
        await this.updateBadge();
        return;
      }

      const recovery = recoverAfterRuntimeRestart(persisted, !runtimeRestarted, now);
      this.state = recovery.state;
      if (this.state.sessionId) {
        const [events, assets] = await Promise.all([
          listEvents(this.state.sessionId),
          listAssets(this.state.sessionId),
        ]);
        this.eventCount = events.length;
        this.gapCount = events.filter((event) => event.kind === 'gap').length;
        this.screenshotCount = assets.length;
        this.screenshotBytes = assets.reduce((sum, asset) => sum + asset.bytes.byteLength, 0);
        this.networkCount = events.filter((event) => event.kind === 'network').length;
        this.networkBytes = events
          .filter((event) => event.kind === 'network')
          .reduce((sum, event) => sum + jsonSize(event.data), 0);
        this.consoleCount = events.filter((event) => ['console', 'error'].includes(event.kind)).length;
        this.consoleBytes = events
          .filter((event) => ['console', 'error'].includes(event.kind))
          .reduce((sum, event) => sum + jsonSize(event.data), 0);
        this.rrwebBytes = events
          .filter((event) => event.kind === 'rrweb')
          .reduce((sum, event) => sum + jsonSize(event.data), 0);
        this.semanticCount = events.filter((event) => event.kind === 'semantic').length;
        this.semanticBytes = events
          .filter((event) => event.kind === 'semantic')
          .reduce((sum, event) => sum + jsonSize(event.data), 0);
        this.nextSeq = (events.at(-1)?.seq ?? 0) + 1;
      }
      if (recovery.recovered) {
        await this.appendSystemEvent('gap', {
          kind: 'runtime_restarted',
          affected: ['semantic', 'rrweb', 'console', 'network'],
          reason: 'Browser runtime marker was missing; explicit resume is required.',
          recoverable: true,
        });
      } else if (this.state.status === 'recording' && !runtimeRestarted) {
        await this.appendSystemEvent('gap', {
          kind: 'service_worker_rehydrated',
          affected: ['network'],
          reason: 'In-flight network correlation was reset when the extension worker restarted.',
          recoverable: true,
        });
      }
      if (this.state.status === 'finalizing') {
        await this.appendSystemEvent('gap', {
          kind: 'finalization_recovered',
          affected: ['semantic', 'rrweb', 'console', 'network', 'screenshots'],
          reason: 'The extension runtime restarted during final flush; late frame evidence is unknown.',
          recoverable: false,
        });
        this.state = finalize(this.state, Math.max(Date.now(), this.state.lastTransitionAtMs));
        await this.appendSystemEvent('session', {
          action: 'finalize',
          phase: 'completed_after_runtime_restart',
        }, true);
      }
      await this.persist();
    }
    await this.updateBadge();
  }

  getViewState(now = Date.now()): RecorderViewState {
    const activeDurationMs =
      this.state.status === 'idle' || now < this.state.lastTransitionAtMs
        ? this.state.activeDurationMs
        : getActiveDurationMs(this.state, now);
    const warnings: RecorderViewState['warnings'] = [
      ...(this.state.status === 'interrupted'
        ? [{ code: 'runtime_interrupted' as const }]
        : []),
      ...(this.gapCount > 0
        ? [{ code: 'capture_gaps' as const, count: this.gapCount }]
        : []),
      ...(activeDurationMs >= LONG_RECORDING_WARNING_THRESHOLD_MS
        ? [{
            code: 'long_recording' as const,
            thresholdMs: LONG_RECORDING_WARNING_THRESHOLD_MS,
          }]
        : []),
    ];
    const warning = this.state.status === 'interrupted'
      ? 'Browser restarted. Resume explicitly or stop and export the partial session.'
      : activeDurationMs >= LONG_RECORDING_WARNING_THRESHOLD_MS
        ? 'This recording is over 15 minutes; review capacity and stop when the reproduction is complete.'
        : null;
    return {
      status: this.state.status,
      sessionId: this.state.sessionId,
      revision: this.state.revision,
      transitionedAtMs: this.state.lastTransitionAtMs,
      startedAt: this.state.startedAtMs === null ? null : new Date(this.state.startedAtMs).toISOString(),
      activeDurationMs,
      scopedTabCount: this.state.scope?.tabs.filter((tab) => tab.closedAtMs === null).length ?? 0,
      eventCount: this.eventCount,
      gapCount: this.gapCount,
      warnings,
      warning,
    };
  }

  async handleRequest(request: RuntimeRequest, sender: SenderContext): Promise<RuntimeResponse> {
    await this.ensureInitialized();
    try {
      switch (request.type) {
        case 'GET_STATE':
          return { ok: true, ...CURRENT_RUNTIME_METADATA, state: this.getViewState() };
        case 'SESSION_COMMAND':
          await this.executeCommand(request.command);
          return { ok: true, ...CURRENT_RUNTIME_METADATA, state: this.getViewState() };
        case 'DELETE_SESSION':
          await this.deleteRetainedSession(request.sessionId);
          return { ok: true, ...CURRENT_RUNTIME_METADATA, state: this.getViewState() };
        case 'HELLO': {
          this.rememberContentClient(sender, request.clientId, request.documentId);
          const captureEnabled =
            sender.tabId !== null &&
            isOpenTabInScope(this.state.scope, sender.tabId) &&
            ACTIVE_STATUSES.has(this.state.status);
          return {
            ok: true,
            ...CURRENT_RUNTIME_METADATA,
            state: this.getViewState(),
            captureEnabled,
          };
        }
        case 'CAPTURE_BATCH': {
          const accepted = await this.acceptCaptureBatch(
            request.sessionId,
            request.documentId,
            request.events,
            sender,
          );
          return { ok: true, ...CURRENT_RUNTIME_METADATA, accepted, state: this.getViewState() };
        }
        case 'FLUSH_COMPLETE':
          await this.handleFlushComplete(request, sender);
          return { ok: true, ...CURRENT_RUNTIME_METADATA, state: this.getViewState() };
      }
    } catch (error) {
      return {
        ok: false,
        ...CURRENT_RUNTIME_METADATA,
        error: error instanceof Error ? error.message : String(error),
        errorCode: classifyRuntimeError(error, request),
        state: this.getViewState(),
      };
    }
  }

  executeCommand(command: 'record' | 'pause' | 'resume' | 'stop' | 'discard' | 'screenshot'): Promise<void> {
    const operation = this.commandQueue.then(() => this.executeCommandNow(command));
    this.commandQueue = operation.catch(() => undefined);
    return operation;
  }

  deleteRetainedSession(sessionId: string): Promise<void> {
    const operation = this.commandQueue.then(() => this.deleteRetainedSessionNow(sessionId));
    this.commandQueue = operation.catch(() => undefined);
    return operation;
  }

  private async deleteRetainedSessionNow(sessionId: string): Promise<void> {
    await this.ensureInitialized();
    if (this.state.sessionId !== sessionId) {
      await deleteSession(sessionId);
      return;
    }
    if (this.state.status !== 'completed') {
      throw new Error(`Cannot delete the current session while recorder is ${this.state.status}.`);
    }

    const previousState = this.state;
    this.screenshotEpoch += 1;
    this.state = createIdleState(Date.now());
    await Promise.all([this.screenshotQueue, this.evidenceWriteQueue, this.persistenceQueue]);
    await deleteSession(sessionId);
    this.eventCount = 0;
    this.gapCount = 0;
    this.screenshotCount = 0;
    this.screenshotBytes = 0;
    this.networkCount = 0;
    this.networkBytes = 0;
    this.consoleCount = 0;
    this.consoleBytes = 0;
    this.rrwebBytes = 0;
    this.semanticCount = 0;
    this.semanticBytes = 0;
    this.nextSeq = 1;
    this.lastScreenshotAt = 0;
    this.screenshotLimitReported = false;
    this.requestStarts.clear();
    this.contentClients.clear();
    this.expectedFlushes.clear();
    this.replacedTabIds.clear();
    this.stateDeliveryGapKey = null;
    this.tabAdmissionFailureUrls.clear();
    this.reportedUnsupportedUrls.clear();
    await this.persist();
    const view = this.getViewState();
    await Promise.all([
      this.broadcastToScope(previousState, view),
      this.broadcastExtensionState(view),
      this.updateBadge(),
    ]);
    this.contentClients.clear();
  }

  private async executeCommandNow(
    command: 'record' | 'pause' | 'resume' | 'stop' | 'discard' | 'screenshot',
  ): Promise<void> {
    await this.ensureInitialized();
    if (command === 'pause' || command === 'stop') {
      await this.waitForPendingTabLifecycleOperations(command);
    }
    const now = Date.now();
    if (command === 'record') {
      if (!['idle', 'completed'].includes(this.state.status)) {
        throw new Error(`Cannot record while recorder is ${this.state.status}.`);
      }
      const [tab] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
      if (tab?.id === undefined || tab.windowId === undefined || !isSupportedCaptureUrl(tab.url ?? '')) {
        throw new Error('Start recording from a normal HTTP(S) tab. This page cannot be captured.');
      }
      await this.requireCaptureClientReady(tab.id);
      this.screenshotEpoch += 1;
      await this.screenshotQueue;
      if (this.state.status === 'completed') {
        this.state = createIdleState(now);
        await this.persist();
      }
      this.state = record(
        this.state,
        { sessionId: crypto.randomUUID(), rootTabId: tab.id, rootWindowId: tab.windowId },
        now,
      );
      this.eventCount = 0;
      this.gapCount = 0;
      this.screenshotCount = 0;
      this.screenshotBytes = 0;
      this.networkCount = 0;
      this.networkBytes = 0;
      this.consoleCount = 0;
      this.consoleBytes = 0;
      this.rrwebBytes = 0;
      this.semanticCount = 0;
      this.semanticBytes = 0;
      this.lastScreenshotAt = 0;
      this.screenshotLimitReported = false;
      this.nextSeq = 1;
      this.requestStarts.clear();
      this.contentClients.clear();
      this.expectedFlushes.clear();
      this.replacedTabIds.clear();
      this.stateDeliveryGapKey = null;
      this.tabAdmissionFailureUrls.clear();
      this.reportedUnsupportedUrls.clear();
      await this.appendSystemEvent('session', { action: 'record', rootTabId: 'tab-1' });
      await this.appendChromeEvent('navigation', tab.id, {
        action: 'record_start',
        kind: 'document',
        url: tab.url ?? '',
        transitionType: 'start',
      }, now);
      await this.persistAndBroadcast();
      return;
    }

    if (command === 'pause') {
      this.screenshotEpoch += 1;
      this.state = pause(this.state, now);
      const pendingNetworkCount = this.clearPendingNetworkRequests();
      await this.screenshotQueue;
      if (pendingNetworkCount > 0) {
        await this.appendGap(
          `Pause ended correlation for ${pendingNetworkCount} in-flight network request(s); their outcomes were not captured.`,
          ['network'],
          undefined,
          pendingNetworkCount,
        );
      }
      await this.appendSystemEvent('session', { action: 'pause' });
      await this.persistAndBroadcast();
      return;
    }
    if (command === 'resume') {
      let interruptedState: RecorderSessionState | null = null;
      let reboundTab: { id: number; windowId: number; url: string } | null = null;
      if (this.state.status === 'interrupted') {
        const [tab] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
        if (tab?.id === undefined || tab.windowId === undefined || !isSupportedCaptureUrl(tab.url ?? '')) {
          throw new Error(
            'Resume after a browser restart requires an active HTTP(S) tab, or stop to export the partial session.',
          );
        }
        await this.requireCaptureClientReady(tab.id);
        if (this.state.status !== 'interrupted') {
          throw new Error('Recorder state changed while the interrupted session was being rebound.');
        }
        interruptedState = this.state;
        reboundTab = { id: tab.id, windowId: tab.windowId, url: tab.url ?? '' };
      }
      this.screenshotEpoch += 1;
      this.state = resume(this.state, now);
      if (interruptedState && reboundTab) {
        this.state = {
          ...this.state,
          scope: createTabScope(reboundTab.id, {
            windowId: reboundTab.windowId,
            addedAtMs: now,
          }),
        };
        this.requestStarts.clear();
        await this.appendSystemEvent('gap', {
          kind: 'lineage_rebound',
          source: 'scope',
          status: 'truncated',
          affected: ['semantic', 'rrweb', 'console', 'network', 'screenshots', 'scope'],
          reason:
            'Browser restart made the previous tab lineage unverifiable; recording resumed from the current active HTTP(S) tab as a new root.',
          recoverable: false,
        });
        await this.appendSystemEvent('session', {
          action: 'resume',
          phase: 'lineage_rebound',
          rootTabId: 'rebound-root',
        });
        await this.appendChromeEvent('navigation', reboundTab.id, {
          action: 'lineage_rebound',
          kind: 'document',
          url: reboundTab.url,
          transitionType: 'resume_after_browser_restart',
        }, now);
        await this.persist();
        const reboundView = this.getViewState();
        const oldDeliveryFailures = await this.broadcastToScope(
          interruptedState,
          reboundView,
          false,
          new Set([reboundTab.id]),
        );
        for (const tab of interruptedState.scope?.tabs ?? []) {
          if (tab.tabId !== reboundTab.id) this.forgetContentClientsForTab(tab.tabId);
        }
        await this.persistAndBroadcast();
        if (oldDeliveryFailures > 0) {
          await this.appendGap(
            `${oldDeliveryFailures} previous-lineage frame(s) did not acknowledge capture shutdown after resume.`,
            ['lifecycle'],
          );
          await this.persist();
        }
        return;
      }
      await this.appendSystemEvent('session', { action: 'resume' });
      await this.persistAndBroadcast();
      return;
    }
    if (command === 'screenshot') {
      if (this.state.status !== 'recording') {
        throw new Error('Screenshots can only be captured while recording.');
      }
      try {
        await this.captureScreenshot('manual');
      } catch (error) {
        await this.appendGap(
          error instanceof Error ? error.message : String(error),
          ['screenshots'],
        );
        await this.persistAndBroadcast();
        throw error;
      }
      await this.persistAndBroadcast();
      return;
    }
    if (command === 'discard') {
      const previousState = this.state;
      this.screenshotEpoch += 1;
      this.state = createIdleState(now);
      await Promise.all([this.screenshotQueue, this.evidenceWriteQueue, this.persistenceQueue]);
      if (previousState.sessionId) await deleteSession(previousState.sessionId);
      this.eventCount = 0;
      this.gapCount = 0;
      this.screenshotCount = 0;
      this.screenshotBytes = 0;
      this.networkCount = 0;
      this.networkBytes = 0;
      this.consoleCount = 0;
      this.consoleBytes = 0;
      this.rrwebBytes = 0;
      this.semanticCount = 0;
      this.semanticBytes = 0;
      this.contentClients.clear();
      this.expectedFlushes.clear();
      this.replacedTabIds.clear();
      this.stateDeliveryGapKey = null;
      this.tabAdmissionFailureUrls.clear();
      this.reportedUnsupportedUrls.clear();
      this.requestStarts.clear();
      await this.persist();
      await this.broadcastToScope(previousState, this.getViewState());
      await this.updateBadge();
      return;
    }

    const stoppedFromInterrupted = this.state.status === 'interrupted';
    this.screenshotEpoch += 1;
    this.state = stop(this.state, now, 'user');
    const pendingNetworkCount = this.clearPendingNetworkRequests();
    await this.screenshotQueue;
    if (pendingNetworkCount > 0) {
      await this.appendGap(
        `Stop ended correlation for ${pendingNetworkCount} in-flight network request(s); their outcomes were not captured.`,
        ['network'],
        undefined,
        pendingNetworkCount,
      );
    }
    await this.appendSystemEvent('session', { action: 'stop', phase: 'finalizing' });
    if (stoppedFromInterrupted) {
      await this.appendGap(
        'The interrupted session was sealed without contacting its pre-restart tab scope; final frame transport and a stop screenshot were intentionally skipped because persisted Chrome tab identities are no longer trustworthy.',
        ['semantic', 'rrweb', 'console', 'network', 'screenshots', 'scope'],
      );
    }
    await this.persistAndBroadcast(!stoppedFromInterrupted);
    if (!stoppedFromInterrupted) {
      await this.flushScopedTabs();
      await this.captureScreenshot('stop').catch((error) => this.appendGap(String(error), ['screenshots']));
    }
    this.screenshotEpoch += 1;
    this.state = finalize(this.state, Date.now());
    await this.appendSystemEvent('session', { action: 'finalize', phase: 'completed' }, true);
    await this.persistAndBroadcast(!stoppedFromInterrupted);
    await this.openResults();
  }

  handleTabCreated(tab: {
    id?: number | undefined;
    openerTabId?: number | undefined;
    windowId?: number | undefined;
  }): Promise<void> {
    if (tab.id === undefined) return Promise.resolve();
    return this.queueTabLifecycleOperation(tab.id, (isCancelled) =>
      this.handleTabCreatedNow(tab, isCancelled));
  }

  private async handleTabCreatedNow(tab: {
    id?: number | undefined;
    openerTabId?: number | undefined;
    windowId?: number | undefined;
  }, isCancelled: () => boolean): Promise<void> {
    await this.ensureInitialized();
    if (isCancelled()) return;
    if (
      !['recording', 'paused', 'interrupted'].includes(this.state.status) ||
      !this.state.scope ||
      tab.id === undefined ||
      tab.openerTabId === undefined ||
      !isOpenTabInScope(this.state.scope, tab.openerTabId)
    ) {
      return;
    }
    const alreadyScoped = this.state.scope.tabs.some((candidate) => candidate.tabId === tab.id);
    const previousWindowId = this.state.scope.tabs.find(
      (candidate) => candidate.tabId === tab.id,
    )?.windowId;
    const windowAlreadyScoped =
      tab.windowId === undefined ||
      this.state.scope.tabs.some(
        (candidate) => candidate.tabId !== tab.id && candidate.windowId === tab.windowId,
      );
    const nextScope = addDescendantTab(this.state.scope, {
      tabId: tab.id,
      openerTabId: tab.openerTabId,
      windowId: tab.windowId ?? null,
      addedAtMs: Date.now(),
    });
    if (nextScope === this.state.scope) return;
    this.state = {
      ...this.state,
      revision: this.state.revision + 1,
      scope: nextScope,
    };
    if (
      this.state.status === 'recording' &&
      !windowAlreadyScoped &&
      tab.windowId !== undefined &&
      (!alreadyScoped || previousWindowId === null)
    ) {
      await this.appendChromeEvent('window', tab.id, { action: 'created' });
    }
    if (this.state.status === 'recording' && !alreadyScoped) {
      await this.appendChromeEvent('tab', tab.id, { action: 'created', openerTabId: tab.openerTabId });
    }
    if (isCancelled()) return;
    // Scope and HELLO can arrive in either order. Notify any client already known for this tab;
    // clients injected later receive the same state in their HELLO response.
    await this.persistScopeAdmission(tab.id);
  }

  async handleTabRemoved(tabId: number): Promise<void> {
    await this.ensureInitialized();
    if (this.replacedTabIds.delete(tabId)) return;
    if (
      !['recording', 'paused', 'interrupted'].includes(this.state.status) ||
      !this.state.scope ||
      !isOpenTabInScope(this.state.scope, tabId)
    ) return;
    this.state = {
      ...this.state,
      revision: this.state.revision + 1,
      scope: markTabClosed(this.state.scope, tabId, Date.now()),
    };
    const pendingNetworkCount = this.clearPendingNetworkRequestsForTab(tabId);
    this.forgetContentClientsForTab(tabId);
    if (this.state.status === 'recording') {
      await this.appendChromeEvent('tab', tabId, { action: 'closed' });
      await this.appendGap(
        'A scoped tab closed before its asynchronous pagehide tail could be fully acknowledged.',
        ['semantic', 'rrweb', 'console'],
        tabId,
      );
      if (pendingNetworkCount > 0) {
        await this.appendGap(
          `A scoped tab closed with ${pendingNetworkCount} in-flight network request(s); their outcomes were not captured.`,
          ['network'],
          tabId,
          pendingNetworkCount,
        );
      }
    }
    await this.persistAndBroadcast();
  }

  async handleTabDetached(tabId: number, oldWindowId: number): Promise<void> {
    await this.ensureInitialized();
    if (
      !['recording', 'paused', 'interrupted'].includes(this.state.status) ||
      !this.state.scope ||
      !isOpenTabInScope(this.state.scope, tabId)
    ) return;
    const nextScope = updateScopedTabWindow(this.state.scope, tabId, null);
    if (nextScope === this.state.scope) return;
    this.state = { ...this.state, revision: this.state.revision + 1, scope: nextScope };
    if (this.state.status === 'recording') {
      await this.appendChromeEvent('tab', tabId, {
        action: 'detached',
        previousWindowId: `window-${oldWindowId}`,
      });
    }
    await this.persistAndBroadcast();
  }

  async handleTabAttached(tabId: number, newWindowId: number): Promise<void> {
    await this.ensureInitialized();
    if (
      !['recording', 'paused', 'interrupted'].includes(this.state.status) ||
      !this.state.scope ||
      !isOpenTabInScope(this.state.scope, tabId)
    ) return;
    const windowAlreadyScoped = this.state.scope.tabs.some(
      (tab) => tab.tabId !== tabId && tab.closedAtMs === null && tab.windowId === newWindowId,
    );
    const nextScope = updateScopedTabWindow(this.state.scope, tabId, newWindowId);
    if (nextScope === this.state.scope) return;
    this.state = { ...this.state, revision: this.state.revision + 1, scope: nextScope };
    if (this.state.status === 'recording') {
      if (!windowAlreadyScoped) {
        await this.appendChromeEvent('window', tabId, { action: 'created' });
      }
      await this.appendChromeEvent('tab', tabId, {
        action: 'attached',
        windowId: `window-${newWindowId}`,
      });
    }
    await this.persistAndBroadcast();
  }

  async handleTabReplaced(addedTabId: number, removedTabId: number): Promise<void> {
    await this.ensureInitialized();
    if (
      !['recording', 'paused', 'interrupted'].includes(this.state.status) ||
      !this.state.scope ||
      !isOpenTabInScope(this.state.scope, removedTabId)
    ) return;
    this.replacedTabIds.add(removedTabId);
    try {
      const replacement = await browser.tabs.get(addedTabId).catch(() => null);
      if (
        !['recording', 'paused', 'interrupted'].includes(this.state.status) ||
        !this.state.scope ||
        !isOpenTabInScope(this.state.scope, removedTabId)
      ) return;
      const nextScope = replaceScopedTab(this.state.scope, {
        removedTabId,
        addedTabId,
        windowId: replacement?.windowId ?? null,
      });
      if (nextScope === this.state.scope) return;
      this.state = { ...this.state, revision: this.state.revision + 1, scope: nextScope };
      const pendingNetworkCount = this.clearPendingNetworkRequestsForTab(removedTabId);
      this.forgetContentClientsForTab(removedTabId);
      if (this.state.status === 'recording') {
        await this.appendChromeEvent('tab', addedTabId, {
          action: 'replaced',
          replacedTabId: `tab-${removedTabId}`,
        });
        if (pendingNetworkCount > 0) {
          await this.appendGap(
            `Chrome replaced a scoped tab with ${pendingNetworkCount} in-flight network request(s); their outcomes were not captured.`,
            ['network'],
            removedTabId,
            pendingNetworkCount,
          );
        }
      }
      await this.persistAndBroadcast();
    } finally {
      this.replacedTabIds.delete(removedTabId);
    }
  }

  handleTabActivated(tabId: number): Promise<void> {
    return this.queueTabLifecycleOperation(tabId, (isCancelled) =>
      this.handleTabActivatedNow(tabId, isCancelled));
  }

  private async handleTabActivatedNow(
    tabId: number,
    isCancelled: () => boolean,
  ): Promise<void> {
    await this.ensureInitialized();
    if (isCancelled()) return;
    if (!['recording', 'paused'].includes(this.state.status)) return;
    const wasInScope = isOpenTabInScope(this.state.scope, tabId);
    const currentTab = await browser.tabs.get(tabId).catch(() => null);
    if (isCancelled()) return;
    if (wasInScope) {
      if (this.state.status === 'recording') {
        await this.appendChromeEvent('tab', tabId, { action: 'activated' });
      }
      return;
    }

    if (!await this.isUserVisibleTab(tabId)) {
      return;
    }
    if (isCancelled()) return;

    const url = currentTab?.url ?? '';
    if (!currentTab || currentTab.windowId === undefined || !isSupportedCaptureUrl(url)) {
      if (isDeferredOrInternalUrl(url)) {
        return;
      }
      await this.reportUnsupportedVisibleTab(tabId, url);
      return;
    }

    await this.admitSupportedTopLevelTab(
      tabId,
      currentTab,
      'activation',
      isCancelled,
    );
  }

  handleTabUpdated(
    tabId: number,
    tab: {
      active?: boolean | undefined;
      id?: number | undefined;
      url?: string | undefined;
      windowId?: number | undefined;
    },
    status?: 'unloaded' | 'loading' | 'complete',
  ): Promise<void> {
    return this.queueTabLifecycleOperation(tabId, (isCancelled) =>
      this.handleTabUpdatedNow(tabId, tab, status, isCancelled));
  }

  private async handleTabUpdatedNow(
    tabId: number,
    tab: {
      active?: boolean | undefined;
      id?: number | undefined;
      url?: string | undefined;
      windowId?: number | undefined;
    },
    status: 'unloaded' | 'loading' | 'complete' | undefined,
    isCancelled: () => boolean,
  ): Promise<void> {
    await this.ensureInitialized();
    if (isCancelled()) return;
    if (
      !['recording', 'paused'].includes(this.state.status) ||
      !tab.active ||
      isOpenTabInScope(this.state.scope, tabId) ||
      tab.windowId === undefined
    ) return;
    if (!await this.isUserVisibleTab(tabId) || isCancelled()) return;
    const url = tab.url ?? '';
    if (!isSupportedCaptureUrl(url)) {
      if (!isDeferredOrInternalUrl(url, status)) {
        await this.reportUnsupportedVisibleTab(tabId, url);
      }
      return;
    }
    await this.admitSupportedTopLevelTab(tabId, tab, 'navigation', isCancelled);
  }

  handleWindowFocused(windowId: number): Promise<void> {
    const epoch = ++this.lifecycleEpoch;
    const run = this.handleWindowFocusedNow(
      windowId,
      () => epoch <= this.lifecycleCancelledThroughEpoch,
      epoch,
    );
    const tracked = run
      .catch((error: unknown) => {
        this.rememberLifecycleFailure(epoch, error);
      })
      .finally(() => {
        this.windowFocusOperations.delete(tracked);
        this.lifecycleOperationEpochs.delete(tracked);
      });
    this.windowFocusOperations.add(tracked);
    this.lifecycleOperationEpochs.set(tracked, epoch);
    return tracked;
  }

  private async handleWindowFocusedNow(
    windowId: number,
    isCancelled: () => boolean,
    epoch: number,
  ): Promise<void> {
    await this.ensureInitialized();
    if (isCancelled()) return;
    if (
      !['recording', 'paused'].includes(this.state.status) ||
      windowId === browser.windows.WINDOW_ID_NONE
    ) return;
    const [activeTab] = await browser.tabs.query({ active: true, windowId });
    if (isCancelled()) return;
    if (activeTab?.id === undefined) return;
    if (!isOpenTabInScope(this.state.scope, activeTab.id)) {
      await this.queueTabLifecycleOperation(
        activeTab.id,
        (tabCancelled) => this.handleTabActivatedNow(
          activeTab.id!,
          () => isCancelled() || tabCancelled(),
        ),
        epoch,
      );
    }
    if (isCancelled()) return;
    if (this.state.status === 'recording' && isOpenTabInScope(this.state.scope, activeTab.id)) {
      await this.appendChromeEvent('window', activeTab.id, { action: 'focused' });
    }
  }

  async handleWindowRemoved(windowId: number): Promise<void> {
    await this.ensureInitialized();
    if (this.state.status !== 'recording') return;
    const scopedTab = this.state.scope?.tabs.find((tab) => tab.windowId === windowId);
    if (!scopedTab) return;
    await this.appendChromeEvent('window', scopedTab.tabId, { action: 'closed' });
  }

  async handleNavigation(kind: string, observation: NavigationObservation): Promise<void> {
    await this.ensureInitialized();
    if (this.state.status !== 'recording' || !isOpenTabInScope(this.state.scope, observation.tabId)) return;
    if (
      kind === 'committed' &&
      observation.frameId === 0 &&
      !isSupportedCaptureUrl(observation.url)
    ) {
      await this.appendGap(
        'The scoped tab entered a restricted or unsupported page; page-level evidence is unavailable.',
        ['semantic', 'rrweb', 'console', 'screenshots'],
        observation.tabId,
      );
    }
    await this.appendChromeEvent('navigation', observation.tabId, {
      action: kind,
      frameId: observation.frameId,
      documentId: observation.documentId ?? null,
      parentDocumentId: observation.parentDocumentId ?? null,
      url: observation.url,
      transitionType: observation.transitionType ?? null,
      transitionQualifiers: observation.transitionQualifiers ?? [],
      error: observation.error ?? null,
    }, observation.timeStamp, {
      frameId: observation.frameId,
      documentId: observation.documentId ?? null,
    });
    if (kind === 'completed' && observation.frameId === 0) {
      const tab = await browser.tabs.get(observation.tabId).catch(() => null);
      if (!tab?.active) return;
      void this.captureScreenshot('navigation', observation.tabId)
        .then(() => this.persistAndBroadcast())
        .catch(async (error) => {
          await this.appendGap(
            error instanceof Error ? error.message : String(error),
            ['screenshots'],
            observation.tabId,
          );
          await this.persistAndBroadcast();
        });
    }
  }

  async handleNetworkStart(observation: NetworkObservation): Promise<void> {
    await this.ensureInitialized();
    if (this.state.status !== 'recording' || !isOpenTabInScope(this.state.scope, observation.tabId)) return;
    if (this.requestStarts.size >= MAX_PENDING_REQUESTS) {
      const oldestRequestId = this.requestStarts.keys().next().value as string | undefined;
      if (oldestRequestId) this.requestStarts.delete(oldestRequestId);
      await this.appendGap(
        'Network correlation limit reached; one oldest in-flight request was discarded.',
        ['network'],
        observation.tabId,
        1,
      );
    }
    if (this.state.status !== 'recording' || !isOpenTabInScope(this.state.scope, observation.tabId)) return;
    this.requestStarts.set(observation.requestId, {
      startedAt: observation.timeStamp,
      method: observation.method,
      type: observation.type,
      url: observation.url,
      tabId: observation.tabId,
      ...(observation.requestHeaders ? { requestHeaders: observation.requestHeaders } : {}),
      ...(observation.requestBody ? { requestBody: observation.requestBody } : {}),
    });
  }

  async handleNetworkHeaders(observation: NetworkObservation): Promise<void> {
    await this.ensureInitialized();
    const start = this.requestStarts.get(observation.requestId);
    if (!start || this.state.status !== 'recording') return;
    if (observation.requestHeaders) start.requestHeaders = observation.requestHeaders;
  }

  async handleNetworkEnd(observation: NetworkObservation): Promise<void> {
    await this.ensureInitialized();
    const start = this.requestStarts.get(observation.requestId);
    this.requestStarts.delete(observation.requestId);
    if (this.state.status !== 'recording' || !isOpenTabInScope(this.state.scope, observation.tabId)) return;
    const responseHeaders = observation.responseHeaders ?? {};
    const data: Record<string, unknown> = {
      requestId: observation.requestId,
      method: start?.method ?? observation.method,
      url: start?.url ?? observation.url,
      resourceType: start?.type ?? observation.type,
      status: observation.statusCode ?? null,
      durationMs: start ? Math.max(0, observation.timeStamp - start.startedAt) : null,
      fromCache: observation.fromCache ?? false,
      error: observation.error ?? null,
      requestHeaders: start?.requestHeaders ?? {},
      responseHeaders,
      requestBody: start?.requestBody ?? observation.requestBody ?? {
        status: 'unavailable',
        reason: 'Chrome did not expose a request body for this request.',
      },
      responseBody: {
        status: 'unavailable',
        reason: 'Chrome webRequest does not expose arbitrary response bodies.',
      },
    };
    const bytes = jsonSize(data);
    if (this.networkCount >= MAX_NETWORK_EVENTS || this.networkBytes + bytes > MAX_NETWORK_BYTES) {
      await this.appendGap(
        'Network evidence budget reached; one request was omitted while semantic capture continued.',
        ['network'],
        observation.tabId,
        1,
      );
      return;
    }
    this.networkCount += 1;
    this.networkBytes += bytes;
    try {
      const eventId = await this.appendChromeEvent(
        'network',
        observation.tabId,
        data,
        start?.startedAt ?? observation.timeStamp,
      );
      if (!eventId) throw new Error('Network evidence admission expired before persistence.');
    } catch (error) {
      this.networkCount = Math.max(0, this.networkCount - 1);
      this.networkBytes = Math.max(0, this.networkBytes - bytes);
      throw error;
    }
  }

  private async acceptCaptureBatch(
    sessionId: string,
    contentDocumentId: string,
    events: ClientCaptureEvent[],
    sender: SenderContext,
  ): Promise<number> {
    const sessionMatches = this.state.sessionId === sessionId;
    const inScope = sender.tabId !== null && isOpenTabInScope(this.state.scope, sender.tabId);
    const statusAcceptsBatch = ['recording', 'paused', 'finalizing'].includes(this.state.status);
    if (!sessionMatches || sender.tabId === null || !inScope || !statusAcceptsBatch) {
      throw new Error('Capture batch does not belong to the active recording scope.');
    }
    const clientIds = new Set(events.map((event) => event.clientId));
    if (clientIds.size !== 1) {
      throw new Error('Capture batch mixed multiple content client identities.');
    }
    const clientId = events[0]?.clientId;
    if (!clientId) throw new Error('Capture batch is missing a content client identity.');
    const registered = this.findContentClient(sender.tabId, sender.frameId, sender.documentId);
    if (
      registered &&
      (registered.clientId !== clientId || registered.contentDocumentId !== contentDocumentId)
    ) {
      throw new Error('Capture batch identity does not match the registered content document.');
    }
    if (!registered) this.rememberContentClient(sender, clientId, contentDocumentId);
    const acceptedEvents: ClientCaptureEvent[] = [];
    const droppedBySource = new Map<'console' | 'rrweb' | 'semantic', number>();
    for (const event of events) {
      const bytes = jsonSize(event.data);
      const consoleLike = event.kind === 'console' || event.kind === 'error';
      if (
        consoleLike &&
        (this.consoleCount >= MAX_CONSOLE_EVENTS || this.consoleBytes + bytes > MAX_CONSOLE_BYTES)
      ) {
        droppedBySource.set('console', (droppedBySource.get('console') ?? 0) + 1);
        continue;
      }
      if (event.kind === 'rrweb' && this.rrwebBytes + bytes > MAX_RRWEB_BYTES) {
        droppedBySource.set('rrweb', (droppedBySource.get('rrweb') ?? 0) + 1);
        continue;
      }
      if (
        event.kind === 'semantic' &&
        (this.semanticCount >= MAX_SEMANTIC_EVENTS ||
          this.semanticBytes + bytes > MAX_SEMANTIC_BYTES)
      ) {
        droppedBySource.set('semantic', (droppedBySource.get('semantic') ?? 0) + 1);
        continue;
      }
      acceptedEvents.push(event);
      if (consoleLike) {
        this.consoleCount += 1;
        this.consoleBytes += bytes;
      }
      if (event.kind === 'rrweb') this.rrwebBytes += bytes;
      if (event.kind === 'semantic') {
        this.semanticCount += 1;
        this.semanticBytes += bytes;
      }
    }

    const stored = acceptedEvents.map((event) => this.toStoredClientEvent(event, sender));
    await this.writeEvents(stored);
    this.eventCount += stored.length;
    this.gapCount += stored.filter((event) => event.kind === 'gap').length;
    for (const [source, droppedCount] of droppedBySource) {
      await this.appendGap(
        `${source === 'rrweb' ? 'rrweb' : source === 'console' ? 'Console/error' : 'Semantic'} evidence budget reached; ${droppedCount} event(s) in this batch were omitted.`,
        [source],
        sender.tabId ?? undefined,
        droppedCount,
      );
    }
    await this.persist();
    if (this.state.status === 'recording' && acceptedEvents.some((event) => event.kind === 'error')) {
      void this.captureScreenshot('error', sender.tabId)
        .then(() => this.persistAndBroadcast())
        .catch(async (error) => {
          await this.appendGap(
            error instanceof Error ? error.message : String(error),
            ['screenshots'],
            sender.tabId ?? undefined,
          );
          await this.persistAndBroadcast();
        });
    }
    return stored.length;
  }

  private async handleFlushComplete(
    request: Extract<RuntimeRequest, { type: 'FLUSH_COMPLETE' }>,
    sender: SenderContext,
  ): Promise<void> {
    if (this.state.status !== 'finalizing' || request.sessionId !== this.state.sessionId) {
      throw new Error('Final flush completion is only accepted for the current finalizing session.');
    }
    const expected = this.expectedFlushes.get(request.flushToken);
    if (!expected || expected.completed) {
      throw new Error('Final flush token is unknown, expired, or already completed.');
    }
    if (
      sender.tabId !== expected.tabId ||
      sender.frameId !== expected.frameId ||
      (expected.chromeDocumentId !== null && sender.documentId !== expected.chromeDocumentId) ||
      (expected.clientId !== null && request.clientId !== expected.clientId) ||
      (expected.contentDocumentId !== null && request.documentId !== expected.contentDocumentId)
    ) {
      throw new Error('Final flush completion identity does not match the requested frame.');
    }
    const droppedCount = sumTransportDrops(request.droppedBySource);
    if (request.droppedCount !== droppedCount) {
      throw new Error('Final flush dropped-count summary is inconsistent.');
    }
    expected.clientId = request.clientId;
    expected.contentDocumentId = request.documentId;
    expected.completed = true;
    expected.droppedCount = droppedCount;
    expected.droppedBySource = { ...request.droppedBySource };
  }

  private queueTabLifecycleOperation(
    tabId: number,
    work: (isCancelled: () => boolean) => Promise<void>,
    inheritedEpoch?: number,
  ): Promise<void> {
    const epoch = inheritedEpoch ?? ++this.lifecycleEpoch;
    const previous = this.tabLifecycleOperations.get(tabId) ?? Promise.resolve();
    const run = previous.then(() => work(
      () => epoch <= this.lifecycleCancelledThroughEpoch,
    ));
    const tracked = run
      .catch((error: unknown) => {
        this.rememberLifecycleFailure(epoch, error);
      })
      .finally(() => {
        if (this.tabLifecycleOperations.get(tabId) === tracked) {
          this.tabLifecycleOperations.delete(tabId);
        }
        this.lifecycleOperationEpochs.delete(tracked);
      });
    this.tabLifecycleOperations.set(tabId, tracked);
    this.lifecycleOperationEpochs.set(tracked, epoch);
    return tracked;
  }

  private rememberLifecycleFailure(epoch: number, error: unknown): void {
    if (epoch <= this.lifecycleFailuresHandledThroughEpoch) return;
    this.lifecycleFailures.set(epoch, {
      sessionId: this.state.sessionId,
      message: error instanceof Error ? error.message : String(error),
    });
  }

  private async waitForPendingTabLifecycleOperations(
    command: 'pause' | 'stop',
  ): Promise<void> {
    const cutoffEpoch = this.lifecycleEpoch;
    const tabSnapshot = [...this.tabLifecycleOperations.entries()].filter(([, operation]) =>
      (this.lifecycleOperationEpochs.get(operation) ?? Number.POSITIVE_INFINITY) <= cutoffEpoch);
    const windowSnapshot = [...this.windowFocusOperations].filter((operation) =>
      (this.lifecycleOperationEpochs.get(operation) ?? Number.POSITIVE_INFINITY) <= cutoffEpoch);
    const pending = [...new Set([
      ...tabSnapshot.map(([, operation]) => operation),
      ...windowSnapshot,
    ])];
    let timedOut = false;
    if (pending.length > 0) {
      timedOut = !await withTimeout(
        Promise.all(pending).then(() => true),
        TAB_LIFECYCLE_BARRIER_TIMEOUT_MS,
      ).catch(() => false);
    }

    if (timedOut) {
      this.lifecycleCancelledThroughEpoch = Math.max(
        this.lifecycleCancelledThroughEpoch,
        cutoffEpoch,
      );
      for (const [tabId, operation] of this.tabLifecycleOperations) {
        if (
          (this.lifecycleOperationEpochs.get(operation) ?? Number.POSITIVE_INFINITY) <= cutoffEpoch &&
          this.tabLifecycleOperations.get(tabId) === operation
        ) {
          this.tabLifecycleOperations.delete(tabId);
        }
      }
      for (const operation of this.windowFocusOperations) {
        if (
          (this.lifecycleOperationEpochs.get(operation) ?? Number.POSITIVE_INFINITY) <= cutoffEpoch
        ) {
          this.windowFocusOperations.delete(operation);
        }
      }
    }

    const sessionId = this.state.sessionId;
    const failed = [...this.lifecycleFailures.entries()].filter(
      ([epoch, failure]) => epoch <= cutoffEpoch && failure.sessionId === sessionId,
    );
    for (const epoch of [...this.lifecycleFailures.keys()]) {
      if (epoch <= cutoffEpoch) this.lifecycleFailures.delete(epoch);
    }
    this.lifecycleFailuresHandledThroughEpoch = Math.max(
      this.lifecycleFailuresHandledThroughEpoch,
      cutoffEpoch,
    );

    if (failed.length === 0 && !timedOut) return;
    const failureDetails = [...new Set(failed.map(([, failure]) => failure.message))]
      .slice(0, 2)
      .join('; ')
      .slice(0, 500);
    const reasons = [
      ...(failed.length > 0
        ? [
            `${failed.length} queued tab lifecycle operation(s) failed before ${command}: ${failureDetails}`,
          ]
        : []),
      ...(timedOut
        ? [`The tab lifecycle barrier reached its ${TAB_LIFECYCLE_BARRIER_TIMEOUT_MS} ms deadline before ${command}.`]
        : []),
    ];
    await this.appendGap(reasons.join(' '), [
      'lifecycle',
      'scope',
      'semantic',
      'rrweb',
      'console',
    ]);
  }

  private async isUserVisibleTab(tabId: number): Promise<boolean> {
    const [visibleTab] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
    return visibleTab?.id === tabId;
  }

  private async reportUnsupportedVisibleTab(tabId: number, url: string): Promise<void> {
    if (this.reportedUnsupportedUrls.get(tabId) === url) return;
    this.reportedUnsupportedUrls.set(tabId, url);
    await this.appendGap(
      'The active tab uses a restricted or unsupported URL; page-level evidence is unavailable.',
      ['semantic', 'rrweb', 'console', 'screenshots'],
    );
    await this.persistAndBroadcast(false);
  }

  private async persistScopeAdmission(tabId: number): Promise<void> {
    await this.persist();
    const view = this.getViewState();
    const knownClients = [...this.contentClients.values()].filter(
      (client) => client.tabId === tabId,
    );
    const deliveryResults = await Promise.all(
      knownClients.map((client) => this.deliverScopeAdmissionState(client, view)),
    );
    const deliveryFailures = deliveryResults.filter((delivered) => !delivered).length;
    if (deliveryFailures > 0) {
      await this.appendGap(
        `${deliveryFailures} known content client(s) did not acknowledge scope admission after a bounded retry.`,
        ['lifecycle', 'semantic', 'rrweb', 'console'],
        tabId,
      );
      await this.persist();
    }
    await Promise.all([
      this.updateBadge(),
      this.broadcastExtensionState(this.getViewState()),
    ]);
  }

  private async deliverScopeAdmissionState(
    client: ContentClientIdentity,
    view: RecorderViewState,
  ): Promise<boolean> {
    if (
      await this.tryDeliverScopeAdmissionState(
        client.tabId,
        client.frameId,
        client.chromeDocumentId,
        view,
      )
    ) return true;

    const frames = await withTimeout(
      browser.webNavigation.getAllFrames({ tabId: client.tabId }),
      CAPTURE_READY_PROBE_TIMEOUT_MS,
    ).catch(() => null);
    const currentFrame = frames?.find((frame) => frame.frameId === client.frameId);
    if (!currentFrame) return false;
    return this.tryDeliverScopeAdmissionState(
      client.tabId,
      client.frameId,
      currentFrame.documentId ?? null,
      view,
    );
  }

  private async tryDeliverScopeAdmissionState(
    tabId: number,
    frameId: number,
    chromeDocumentId: string | null,
    view: RecorderViewState,
  ): Promise<boolean> {
    try {
      const response = await withTimeout(
        browser.tabs.sendMessage(
          tabId,
          { type: 'STATE_CHANGED', state: view, captureEnabled: true },
          messageTargetOptions(frameId, chromeDocumentId),
        ),
        CAPTURE_READY_TIMEOUT_MS,
      );
      if (!isStateAckAtLeast(response, view)) return false;
      this.rememberContentClientForFrame(
        tabId,
        frameId,
        chromeDocumentId,
        response.clientId,
        response.documentId,
      );
      return true;
    } catch {
      return false;
    }
  }

  private async admitSupportedTopLevelTab(
    tabId: number,
    tab: { url?: string | undefined; windowId?: number | undefined },
    admission: 'activation' | 'navigation',
    isCancelled: () => boolean,
  ): Promise<boolean> {
    if (isCancelled()) return false;
    const sessionId = this.state.sessionId;
    if (
      !sessionId ||
      !['recording', 'paused'].includes(this.state.status) ||
      !this.state.scope ||
      isOpenTabInScope(this.state.scope, tabId) ||
      tab.windowId === undefined ||
      !isSupportedCaptureUrl(tab.url ?? '')
    ) return isOpenTabInScope(this.state.scope, tabId);

    const ready = await this.waitForCaptureClientReady(tabId);
    if (isCancelled()) return false;
    const currentTab = await browser.tabs.get(tabId).catch(() => null);
    if (isCancelled()) return false;
    if (
      !ready ||
      !currentTab ||
      currentTab.windowId === undefined ||
      !isSupportedCaptureUrl(currentTab.url ?? '')
    ) {
      if (
        this.state.sessionId === sessionId &&
        ['recording', 'paused'].includes(this.state.status) &&
        this.tabAdmissionFailureUrls.get(tabId) !== (currentTab?.url ?? tab.url ?? '')
      ) {
        this.tabAdmissionFailureUrls.set(tabId, currentTab?.url ?? tab.url ?? '');
        await this.appendGap(
          'A supported active tab did not expose a compatible capture client before the readiness deadline.',
          ['semantic', 'rrweb', 'console'],
        );
        await this.persistAndBroadcast(false);
      }
      return false;
    }
    if (
      this.state.sessionId !== sessionId ||
      !['recording', 'paused'].includes(this.state.status) ||
      !this.state.scope
    ) return false;
    if (isOpenTabInScope(this.state.scope, tabId)) return true;

    const addedAtMs = Date.now();
    const openerTabId = currentTab.openerTabId;
    const hasScopedOpener =
      openerTabId !== undefined && isOpenTabInScope(this.state.scope, openerTabId);
    const nextScope = hasScopedOpener
      ? addDescendantTab(this.state.scope, {
          tabId,
          openerTabId,
          windowId: currentTab.windowId,
          addedAtMs,
        })
      : addTopLevelTab(this.state.scope, {
          tabId,
          windowId: currentTab.windowId,
          addedAtMs,
        });
    this.state = {
      ...this.state,
      revision: this.state.revision + 1,
      scope: nextScope,
    };
    this.tabAdmissionFailureUrls.delete(tabId);
    this.reportedUnsupportedUrls.delete(tabId);
    if (this.state.status === 'recording') {
      const observedAt = Date.now();
      await this.appendChromeEvent('tab', tabId, {
        action: 'admitted',
        admission,
        ...(hasScopedOpener ? { openerTabId } : {}),
      }, observedAt);
      await this.appendChromeEvent('navigation', tabId, {
        action: 'scope_adopted',
        kind: 'document',
        url: currentTab.url ?? '',
        transitionType: admission,
      }, observedAt);
    }

    const excludedTabIds = new Set(
      nextScope.tabs
        .filter((candidate) => candidate.closedAtMs === null && candidate.tabId !== tabId)
        .map((candidate) => candidate.tabId),
    );
    await this.persistAndBroadcast(true, excludedTabIds);
    return true;
  }

  private async requireCaptureClientReady(tabId: number): Promise<void> {
    const unavailable = (): RuntimeCodedError =>
      new RuntimeCodedError(
        'The capture client is unavailable or incompatible. Reload the current tab and try again.',
        'capture_client_unavailable',
      );
    if (!await this.probeCaptureClientReady(tabId, CAPTURE_READY_TIMEOUT_MS)) throw unavailable();
  }

  private async waitForCaptureClientReady(tabId: number): Promise<boolean> {
    const deadline = Date.now() + CAPTURE_READY_TIMEOUT_MS;
    do {
      const remainingMs = Math.max(1, deadline - Date.now());
      if (
        await this.probeCaptureClientReady(
          tabId,
          Math.min(CAPTURE_READY_PROBE_TIMEOUT_MS, remainingMs),
        )
      ) return true;
      if (Date.now() >= deadline) break;
      await delay(Math.min(CAPTURE_READY_POLL_INTERVAL_MS, Math.max(1, deadline - Date.now())));
    } while (Date.now() < deadline);
    return false;
  }

  private async probeCaptureClientReady(tabId: number, timeoutMs: number): Promise<boolean> {
    const frames = await browser.webNavigation.getAllFrames({ tabId }).catch(() => null);
    const topFrame = frames?.find((frame) => frame.frameId === 0);
    if (!topFrame) return false;
    try {
      const response = await withTimeout(
        browser.tabs.sendMessage(
          tabId,
          { type: 'CAPTURE_READY', protocolVersion: CAPTURE_PROTOCOL_VERSION },
          messageTargetOptions(0, topFrame.documentId ?? null),
        ),
        timeoutMs,
      );
      if (!isCaptureReadyAck(response)) return false;
      this.rememberContentClientForFrame(
        tabId,
        0,
        topFrame.documentId ?? null,
        response.clientId,
        response.documentId,
      );
      return true;
    } catch {
      return false;
    }
  }

  private rememberContentClient(
    sender: SenderContext,
    clientId: string,
    contentDocumentId: string,
  ): void {
    if (sender.tabId === null || sender.frameId === null) return;
    this.rememberContentClientForFrame(
      sender.tabId,
      sender.frameId,
      sender.documentId,
      clientId,
      contentDocumentId,
    );
  }

  private rememberContentClientForFrame(
    tabId: number,
    frameId: number,
    chromeDocumentId: string | null,
    clientId: string,
    contentDocumentId: string,
  ): void {
    for (const [key, identity] of this.contentClients) {
      if (identity.tabId === tabId && identity.frameId === frameId) this.contentClients.delete(key);
    }
    const identity: ContentClientIdentity = {
      tabId,
      frameId,
      chromeDocumentId,
      clientId,
      contentDocumentId,
    };
    this.contentClients.set(contentClientKey(tabId, frameId, chromeDocumentId), identity);
  }

  private findContentClient(
    tabId: number,
    frameId: number | null,
    chromeDocumentId: string | null,
  ): ContentClientIdentity | null {
    if (frameId === null) return null;
    const exact = this.contentClients.get(contentClientKey(tabId, frameId, chromeDocumentId));
    if (exact) return exact;
    if (chromeDocumentId !== null) return null;
    const candidates = [...this.contentClients.values()].filter(
      (identity) => identity.tabId === tabId && identity.frameId === frameId,
    );
    return candidates.length === 1 ? (candidates[0] ?? null) : null;
  }

  private forgetContentClientsForTab(tabId: number): void {
    for (const [key, identity] of this.contentClients) {
      if (identity.tabId === tabId) this.contentClients.delete(key);
    }
  }

  private toStoredClientEvent(event: ClientCaptureEvent, sender: SenderContext): StoredEvent {
    const startedAt = this.state.startedAtMs ?? event.observedAt;
    const seq = this.nextSeq++;
    return {
      id: `${this.state.sessionId}:${String(seq).padStart(10, '0')}`,
      sessionId: this.state.sessionId ?? 'missing-session',
      seq,
      offsetMs: Math.max(0, Math.round(event.observedAt - startedAt)),
      observedAt: new Date(event.observedAt).toISOString(),
      kind: event.kind,
      tabId: sender.tabId === null ? null : `tab-${sender.tabId}`,
      windowId: sender.windowId === null ? null : `window-${sender.windowId}`,
      frameId: sender.frameId === null ? null : `frame-${sender.frameId}`,
      documentId: sender.documentId ?? null,
      trust: 'untrusted_observation',
      data: event.data,
    };
  }

  private writeEvents(events: StoredEvent[]): Promise<void> {
    const operation = this.evidenceWriteQueue.then(() => appendEvents(events));
    this.evidenceWriteQueue = operation.catch(() => undefined);
    return operation;
  }

  private async appendSystemEvent(
    kind: string,
    data: Record<string, unknown>,
    allowCompleted = false,
  ): Promise<void> {
    if (
      !this.state.sessionId ||
      this.state.startedAtMs === null ||
      (this.state.status === 'completed' && !allowCompleted)
    ) return;
    const now = Date.now();
    const seq = this.nextSeq++;
    const event: StoredEvent = {
      id: `${this.state.sessionId}:${String(seq).padStart(10, '0')}`,
      sessionId: this.state.sessionId,
      seq,
      offsetMs: Math.max(0, now - this.state.startedAtMs),
      observedAt: new Date(now).toISOString(),
      kind,
      tabId: null,
      windowId: null,
      frameId: null,
      documentId: null,
      trust: 'extension',
      data,
    };
    await this.writeEvents([event]);
    this.eventCount += 1;
    if (kind === 'gap') this.gapCount += 1;
  }

  private async appendChromeEvent(
    kind: string,
    tabId: number,
    data: Record<string, unknown>,
    observedAt = Date.now(),
    context: { frameId?: number; documentId?: string | null } = {},
  ): Promise<string | null> {
    if (
      !this.state.sessionId ||
      this.state.startedAtMs === null ||
      this.state.status === 'completed'
    ) return null;
    const scoped = this.state.scope?.tabs.find((tab) => tab.tabId === tabId);
    const seq = this.nextSeq++;
    const eventId = `${this.state.sessionId}:${String(seq).padStart(10, '0')}`;
    await this.writeEvents([
      {
        id: eventId,
        sessionId: this.state.sessionId,
        seq,
        offsetMs: Math.max(0, Math.round(observedAt - this.state.startedAtMs)),
        observedAt: new Date(observedAt).toISOString(),
        kind,
        tabId: `tab-${tabId}`,
        windowId:
          scoped?.windowId === null || scoped?.windowId === undefined
            ? null
            : `window-${scoped.windowId}`,
        frameId: context.frameId === undefined ? null : `frame-${context.frameId}`,
        documentId: context.documentId ?? null,
        trust: 'extension',
        data,
      },
    ]);
    this.eventCount += 1;
    return eventId;
  }

  private async appendGap(
    reason: string,
    affected: string[],
    tabId?: number,
    droppedCount?: number,
  ): Promise<void> {
    const dropped = droppedCount === undefined ? {} : { droppedCount };
    if (tabId === undefined) {
      await this.appendSystemEvent('gap', {
        kind: 'capture_gap',
        reason,
        affected,
        recoverable: true,
        ...dropped,
      });
      return;
    }
    const eventId = await this.appendChromeEvent('gap', tabId, {
      kind: 'capture_gap',
      reason,
      affected,
      recoverable: true,
      ...dropped,
    });
    if (eventId) this.gapCount += 1;
  }

  private captureScreenshot(trigger: string, requestedTabId?: number): Promise<void> {
    const sessionId = this.state.sessionId;
    const epoch = this.screenshotEpoch;
    const scopeTabs = this.state.scope?.tabs.map((tab) => ({ ...tab })) ?? null;
    if (!sessionId || !scopeTabs) return Promise.resolve();
    const operation = this.screenshotQueue.then(() =>
      this.captureScreenshotNow(trigger, sessionId, epoch, scopeTabs, requestedTabId),
    );
    this.screenshotQueue = operation.catch(() => undefined);
    return operation;
  }

  private async captureScreenshotNow(
    trigger: string,
    sessionId: string,
    epoch: number,
    scopeTabs: ReadonlyArray<{
      tabId: number;
      windowId: number | null;
      closedAtMs: number | null;
    }>,
    requestedTabId?: number,
  ): Promise<void> {
    if (!this.screenshotAllowed(trigger, sessionId, epoch)) return;
    if (this.screenshotCount >= MAX_SCREENSHOTS) {
      if (!this.screenshotLimitReported) {
        this.screenshotLimitReported = true;
        await this.appendGap('Screenshot limit reached; semantic capture continues.', ['screenshots']);
      }
      return;
    }
    const now = Date.now();
    if (trigger !== 'manual' && now - this.lastScreenshotAt < 1_000) return;
    const tabId = requestedTabId ?? (await browser.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.id;
    const scoped = tabId === undefined ? undefined : scopeTabs.find((tab) => tab.tabId === tabId);
    if (tabId === undefined || !scoped || scoped.closedAtMs !== null || scoped.windowId === null) {
      throw new Error('Screenshot skipped because no visible scoped tab is available.');
    }
    let screenshot: Awaited<ReturnType<typeof captureScreenshot>>;
    try {
      screenshot = await captureScreenshot(tabId, scoped.windowId);
    } catch (error) {
      if (!this.screenshotAllowed(trigger, sessionId, epoch)) return;
      throw error;
    }
    if (!this.screenshotAllowed(trigger, sessionId, epoch)) return;
    if (this.screenshotBytes + screenshot.bytes.byteLength > MAX_SCREENSHOT_BYTES) {
      if (!this.screenshotLimitReported) {
        this.screenshotLimitReported = true;
        await this.appendGap(
          'Screenshot byte budget reached; semantic capture continues without more images.',
          ['screenshots'],
        );
      }
      return;
    }
    const index = this.screenshotCount + 1;
    const assetId = `shot-${String(index).padStart(4, '0')}`;
    const storedAssetId = `${sessionId}:${assetId}`;
    await putAsset({
      id: storedAssetId,
      sessionId,
      createdAt: new Date(now).toISOString(),
      mimeType: screenshot.mimeType,
      bytes: screenshot.bytes,
      metadata: {
        assetId,
        path: `screenshots/${assetId}.png`,
        trigger,
        tabId: `tab-${tabId}`,
        width: screenshot.width,
        height: screenshot.height,
        fullPage: false,
        redactedRectCount: screenshot.redactedRectCount,
      },
    });
    if (!this.screenshotAllowed(trigger, sessionId, epoch)) {
      await deleteAsset(storedAssetId);
      return;
    }
    const eventId = await this.appendChromeEvent('screenshot', tabId, {
      assetId,
      path: `screenshots/${assetId}.png`,
      trigger,
      mimeType: screenshot.mimeType,
      width: screenshot.width,
      height: screenshot.height,
      redactedRectCount: screenshot.redactedRectCount,
    });
    if (!eventId || !this.screenshotAllowed(trigger, sessionId, epoch)) {
      await Promise.all([
        deleteAsset(storedAssetId),
        eventId ? deleteEvent(eventId) : Promise.resolve(),
      ]);
      if (eventId) this.eventCount = Math.max(0, this.eventCount - 1);
      return;
    }
    this.screenshotCount = index;
    this.screenshotBytes += screenshot.bytes.byteLength;
    this.lastScreenshotAt = now;
  }

  private screenshotAllowed(trigger: string, sessionId: string, epoch: number): boolean {
    const expectedStatus = trigger === 'stop' ? 'finalizing' : 'recording';
    return (
      this.state.sessionId === sessionId &&
      this.screenshotEpoch === epoch &&
      this.state.status === expectedStatus
    );
  }

  private async flushScopedTabs(): Promise<void> {
    if (!this.state.sessionId || !this.state.scope) return;
    const sessionId = this.state.sessionId;
    this.expectedFlushes.clear();
    const openTabs = this.state.scope.tabs.filter((tab) => tab.closedAtMs === null);
    const targets = (
      await Promise.all(
        openTabs.map(async (tab) => {
          const frames = await browser.webNavigation.getAllFrames({ tabId: tab.tabId }).catch(() => null);
          return (frames?.length ? frames : [{ frameId: 0, documentId: undefined }]).map((frame) => {
            const chromeDocumentId = frame.documentId ?? null;
            const registered = this.findContentClient(tab.tabId, frame.frameId, chromeDocumentId);
            const flushToken = crypto.randomUUID();
            const expected: ExpectedFlush = {
              sessionId,
              flushToken,
              tabId: tab.tabId,
              frameId: frame.frameId,
              chromeDocumentId,
              clientId: registered?.clientId ?? null,
              contentDocumentId: registered?.contentDocumentId ?? null,
              completed: false,
              droppedCount: 0,
              droppedBySource: emptyTransportDropCounts(),
            };
            this.expectedFlushes.set(flushToken, expected);
            return expected;
          });
        }),
      )
    ).flat();
    const results = await Promise.allSettled(
      targets.map((target) =>
        withTimeout(
          browser.tabs.sendMessage(
            target.tabId,
            { type: 'FLUSH_CAPTURE', sessionId, flushToken: target.flushToken },
            messageTargetOptions(target.frameId, target.chromeDocumentId),
          ),
          FLUSH_TIMEOUT_MS,
        ),
      ),
    );
    let failures = 0;
    for (const [index, result] of results.entries()) {
      const expected = targets[index];
      if (!expected) continue;
      let acknowledged = false;
      if (result.status === 'fulfilled' && isFlushCaptureAck(result.value)) {
        acknowledged =
          result.value.flushed &&
          result.value.sessionId === expected.sessionId &&
          result.value.flushToken === expected.flushToken &&
          expected.completed &&
          result.value.clientId === expected.clientId &&
          result.value.documentId === expected.contentDocumentId &&
          result.value.droppedCount === expected.droppedCount &&
          sameTransportDrops(result.value.droppedBySource, expected.droppedBySource);
      }
      if (!acknowledged) failures += 1;
      if (expected.completed) {
        for (const [source, droppedCount] of Object.entries(expected.droppedBySource) as Array<
          [TransportDropSource, number]
        >) {
          if (droppedCount === 0) continue;
          await this.appendGap(
            `A content frame reported ${droppedCount} unacknowledged ${source} event(s) during final transport.`,
            [source],
            expected.tabId,
            droppedCount,
          );
        }
      }
      this.expectedFlushes.delete(expected.flushToken);
    }
    if (failures > 0) {
      await this.appendGap(
        `${failures} scoped frame(s) returned no valid, identity-bound final flush acknowledgement.`,
        ['semantic', 'rrweb', 'console'],
      );
    }
    this.expectedFlushes.clear();
  }

  private async persist(): Promise<void> {
    const state = this.state;
    const now = Date.now();
    const eventCount = this.eventCount;
    const gapCount = this.gapCount;
    const screenshotCount = this.screenshotCount;
    const envelope: PersistedRecorderSession = {
      recorder: state,
      eventCount,
      gapCount,
      screenshotCount,
      generator: {
        name: 'Bugtrace Recorder',
        version: String(browser.runtime.getManifest().version),
        formatVersion: '1.1.0',
      },
    };
    const operation = this.persistenceQueue.then(async () => {
      if (!state.sessionId) {
        await clearCurrentSessionState();
        return;
      }
      await Promise.all([
        saveCurrentSessionState(state),
        putSession({
          id: state.sessionId,
          updatedAt: new Date(now).toISOString(),
          expiresAt: new Date(now + SESSION_TTL_MS).toISOString(),
          state: envelope,
        }),
      ]);
    });
    this.persistenceQueue = operation.catch(() => undefined);
    await operation;
  }

  private async persistAndBroadcast(
    includeScopedTabs = true,
    excludedTabIds: ReadonlySet<number> = new Set(),
  ): Promise<void> {
    await this.persist();
    const view = this.getViewState();
    const [, deliveryFailures] = await Promise.all([
      this.updateBadge(),
      includeScopedTabs
        ? this.broadcastState(excludedTabIds)
        : this.broadcastExtensionState(view),
    ]);
    const deliveryKey = `${this.state.sessionId ?? 'idle'}:${this.state.revision}:${this.state.status}`;
    if (
      deliveryFailures > 0 &&
      this.state.sessionId &&
      ['recording', 'paused', 'finalizing', 'interrupted'].includes(this.state.status) &&
      this.stateDeliveryGapKey !== deliveryKey
    ) {
      this.stateDeliveryGapKey = deliveryKey;
      await this.appendGap(
        `${deliveryFailures} scoped frame(s) did not acknowledge recorder state ${this.state.status}.`,
        ['semantic', 'rrweb', 'console'],
      );
      await this.persist();
    }
  }

  private async broadcastState(excludedTabIds: ReadonlySet<number> = new Set()): Promise<number> {
    const view = this.getViewState();
    void this.broadcastExtensionState(view);
    return this.broadcastToScope(
      this.state,
      view,
      ACTIVE_STATUSES.has(this.state.status),
      excludedTabIds,
    );
  }

  private async broadcastExtensionState(view: RecorderViewState): Promise<number> {
    await browser.runtime.sendMessage({
      type: 'STATE_CHANGED',
      state: view,
      captureEnabled: false,
    }).catch(() => undefined);
    return 0;
  }

  private async broadcastToScope(
    state: RecorderSessionState,
    view: RecorderViewState,
    captureEnabled = ACTIVE_STATUSES.has(view.status),
    excludedTabIds: ReadonlySet<number> = new Set(),
  ): Promise<number> {
    const tabIds =
      state.scope?.tabs
        .filter((tab) => tab.closedAtMs === null && !excludedTabIds.has(tab.tabId))
        .map((tab) => tab.tabId) ?? [];
    const targets = (
      await Promise.all(
        tabIds.map(async (tabId) => {
          const frames = await browser.webNavigation.getAllFrames({ tabId }).catch(() => null);
          return (frames?.length ? frames : [{ frameId: 0, documentId: undefined }]).map((frame) => ({
            tabId,
            frameId: frame.frameId,
            chromeDocumentId: frame.documentId ?? null,
          }));
        }),
      )
    ).flat();
    const results = await Promise.all(
      targets.map(async (target) => {
        try {
          const response = await withTimeout(
            browser.tabs.sendMessage(
              target.tabId,
              { type: 'STATE_CHANGED', state: view, captureEnabled },
              messageTargetOptions(target.frameId, target.chromeDocumentId),
            ),
            FLUSH_TIMEOUT_MS,
          );
          if (!isStateAckAtLeast(response, view)) {
            return false;
          }
          this.rememberContentClientForFrame(
            target.tabId,
            target.frameId,
            target.chromeDocumentId,
            response.clientId,
            response.documentId,
          );
          return true;
        } catch {
          return false;
        }
      }),
    );
    return results.filter((acknowledged) => !acknowledged).length;
  }

  private async updateBadge(): Promise<void> {
    const badge = {
      idle: { text: '', color: '#60686d' },
      recording: { text: 'REC', color: '#d94235' },
      paused: { text: 'II', color: '#b7791f' },
      finalizing: { text: '…', color: '#397a8c' },
      completed: { text: 'OK', color: '#34775d' },
      interrupted: { text: '!', color: '#6e7880' },
    }[this.state.status];
    const preference = await loadLanguagePreference().catch(() => 'system' as const);
    const locale = resolveLocale(preference, getSystemLanguage());
    const title = translateMessage(locale, 'toolbar.title', {
      app: translateMessage(locale, 'common.appName'),
      status: translateMessage(locale, STATUS_LABEL_KEYS[this.state.status]),
    });
    await Promise.all([
      browser.action.setBadgeText({ text: badge.text }),
      browser.action.setBadgeBackgroundColor({ color: badge.color }),
      browser.action.setTitle({ title }),
    ]);
  }

  private clearPendingNetworkRequests(): number {
    const pendingCount = this.requestStarts.size;
    this.requestStarts.clear();
    return pendingCount;
  }

  private clearPendingNetworkRequestsForTab(tabId: number): number {
    let pendingCount = 0;
    for (const [requestId, start] of this.requestStarts) {
      if (start.tabId !== tabId) continue;
      this.requestStarts.delete(requestId);
      pendingCount += 1;
    }
    return pendingCount;
  }

  private async openResults(): Promise<void> {
    if (!this.state.sessionId) return;
    const url = new URL(browser.runtime.getURL('/results.html'));
    url.searchParams.set('session', this.state.sessionId);
    await browser.tabs.create({ url: url.toString() });
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeoutId = setTimeout(() => reject(new Error('Capture flush timed out.')), timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

function delay(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

function isStateAckAtLeast(
  value: unknown,
  view: RecorderViewState,
): value is StateChangedAck {
  return (
    isStateChangedAck(value) &&
    value.sessionId === view.sessionId &&
    value.appliedRevision >= view.revision &&
    value.transitionedAtMs >= view.transitionedAtMs
  );
}

function protocolOf(url: string | undefined): string {
  if (!url) return 'unknown';
  try {
    return new URL(url).protocol;
  } catch {
    return 'invalid';
  }
}

function isDeferredOrInternalUrl(
  url: string,
  status?: 'unloaded' | 'loading' | 'complete',
): boolean {
  const protocol = protocolOf(url);
  if (protocol === 'chrome-extension:') {
    try {
      if (new URL(url).origin === new URL(browser.runtime.getURL('/')).origin) return true;
    } catch {
      return false;
    }
  }
  if (status === 'complete') return false;
  return (
    !url ||
    url === 'about:blank' ||
    url === 'about:newtab' ||
    url.startsWith('chrome://newtab') ||
    protocol === 'chrome-search:'
  );
}

function jsonSize(value: unknown): number {
  try {
    return jsonUtf8ByteLength(value);
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function contentClientKey(
  tabId: number,
  frameId: number,
  chromeDocumentId: string | null,
): string {
  return `${tabId}:${frameId}:${chromeDocumentId ?? 'unknown-document'}`;
}

function emptyTransportDropCounts(): TransportDropCounts {
  return { semantic: 0, rrweb: 0, console: 0, lifecycle: 0 };
}

function sumTransportDrops(counts: TransportDropCounts): number {
  return Object.values(counts).reduce((sum, count) => sum + count, 0);
}

function sameTransportDrops(left: TransportDropCounts, right: TransportDropCounts): boolean {
  return (
    left.semantic === right.semantic &&
    left.rrweb === right.rrweb &&
    left.console === right.console &&
    left.lifecycle === right.lifecycle
  );
}

class RuntimeCodedError extends Error {
  constructor(
    message: string,
    readonly errorCode: RuntimeErrorCode,
  ) {
    super(message);
    this.name = 'RuntimeCodedError';
  }
}

function classifyRuntimeError(error: unknown, request: RuntimeRequest): RuntimeErrorCode {
  if (error instanceof RuntimeCodedError) return error.errorCode;
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (
    message.includes('document changed') ||
    message.includes('document with id') ||
    /frame(?: with id)? .* (?:was )?(?:removed|navigated)/u.test(message)
  ) {
    return 'screenshot_document_changed';
  }
  if (
    message.includes('activetab') ||
    message.includes('<all_urls>') ||
    (message.includes('permission') && message.includes('screenshot'))
  ) {
    return 'screenshot_authorization_required';
  }
  if (
    message.includes('no visible scoped tab') ||
    message.includes('scoped tab is not visible') ||
    message.includes('active tab changed during capture')
  ) {
    return 'screenshot_outside_scope';
  }
  if (
    message.includes('receiving end does not exist') ||
    message.includes('could not establish connection') ||
    message.includes('message port closed') ||
    message.includes('sensitive regions could not be confirmed')
  ) {
    return 'capture_client_unavailable';
  }
  return request.type === 'SESSION_COMMAND' && request.command === 'screenshot'
    ? 'screenshot_failed'
    : 'operation_rejected';
}

function messageTargetOptions(
  frameId: number,
  documentId: string | null,
): { frameId: number; documentId?: string } {
  return documentId === null ? { frameId } : { frameId, documentId };
}
