import { browser } from 'wxt/browser';
import { listSensitiveRects, RrwebSegmentRecorder, SemanticRecorder } from '../src/capture';
import type {
  BackgroundMessage,
  ClientCaptureEvent,
  RecorderViewState,
  RuntimeResponse,
  TransportDropCounts,
  TransportDropSource,
} from '../src/messaging';
import { jsonUtf8ByteLength } from '../src/messaging';

const CHANNEL = 'bugtrace-recorder:v1';
const MAX_BATCH_BYTES = 3_500_000;
const MAX_PENDING_TRANSPORT_BYTES = 8_000_000;
const TRANSPORT_ACK_TIMEOUT_MS = 1_500;

export default defineContentScript({
  matches: ['http://*/*', 'https://*/*'],
  allFrames: true,
  matchOriginAsFallback: true,
  noScriptStartedPostMessage: true,
  runAt: 'document_start',
  async main() {
    const clientId = crypto.randomUUID();
    const documentId = crypto.randomUUID();
    let localSeq = 0;
    let currentSessionId: string | null = null;
    let captureEnabled = false;
    let semanticRecorder: SemanticRecorder | null = null;
    let rrwebRecorder: RrwebSegmentRecorder | null = null;
    let buffer: ClientCaptureEvent[] = [];
    let bufferedBytes = 0;
    let flushTimer: number | null = null;
    let pendingTransportBytes = 0;
    let pendingDroppedCount = 0;
    const pendingDroppedBySource = new Map<TransportDropSource, number>();
    let collectorFailureQueued = false;
    let sendQueue: Promise<void> = Promise.resolve();
    let stateApplyQueue: Promise<void> = Promise.resolve();
    let queuedSessionId: string | null | undefined;
    let highestQueuedRevision = -1;
    let highestQueuedTransitionAt = -1;
    let appliedState: RecorderViewState | null = null;
    const retiredSessionIds = new Set<string>();
    let overlay: ReturnType<typeof createStatusOverlay> | null = null;

    const sourceForEvent = (event: ClientCaptureEvent): TransportDropSource => {
      if (event.kind === 'error' || event.kind === 'console') return 'console';
      if (event.kind === 'gap') return 'lifecycle';
      return event.kind;
    };

    const noteDropped = (events: readonly ClientCaptureEvent[]): void => {
      pendingDroppedCount += events.length;
      for (const event of events) {
        const source = sourceForEvent(event);
        pendingDroppedBySource.set(source, (pendingDroppedBySource.get(source) ?? 0) + 1);
      }
    };

    const dropCounts = (): TransportDropCounts => ({
      semantic: pendingDroppedBySource.get('semantic') ?? 0,
      rrweb: pendingDroppedBySource.get('rrweb') ?? 0,
      console: pendingDroppedBySource.get('console') ?? 0,
      lifecycle: pendingDroppedBySource.get('lifecycle') ?? 0,
    });

    const acknowledgeDropReport = (reported: TransportDropCounts): void => {
      for (const [source, count] of Object.entries(reported) as Array<
        [TransportDropSource, number]
      >) {
        const remaining = Math.max(0, (pendingDroppedBySource.get(source) ?? 0) - count);
        if (remaining === 0) pendingDroppedBySource.delete(source);
        else pendingDroppedBySource.set(source, remaining);
      }
      pendingDroppedCount = [...pendingDroppedBySource.values()].reduce(
        (sum, count) => sum + count,
        0,
      );
    };

    const flush = async (): Promise<void> => {
      if (flushTimer !== null) window.clearTimeout(flushTimer);
      flushTimer = null;
      if (!currentSessionId) {
        buffer = [];
        bufferedBytes = 0;
        await sendQueue;
        return;
      }
      if (buffer.length === 0 && pendingDroppedCount === 0) {
        await sendQueue;
        return;
      }

      const sessionId = currentSessionId;
      const rawEvents = buffer;
      const events = [...rawEvents];
      buffer = [];
      bufferedBytes = 0;
      const reportedDrops = dropCounts();
      for (const [source, droppedCount] of Object.entries(reportedDrops) as Array<
        [TransportDropSource, number]
      >) {
        if (droppedCount === 0) continue;
        events.unshift({
          clientId,
          localSeq: localSeq++,
          observedAt: performance.timeOrigin + performance.now(),
          kind: 'gap',
          data: {
            kind: 'content_transport_gap',
            source,
            status: 'truncated',
            reason: `The content transport could not durably acknowledge ${droppedCount} ${source} event(s).`,
            droppedCount,
            affected: [source],
          },
        });
      }

      const batchBytes = events.reduce((sum, event) => sum + jsonUtf8ByteLength(event), 0);
      if (pendingTransportBytes + batchBytes > MAX_PENDING_TRANSPORT_BYTES) {
        noteDropped(rawEvents);
        await sendQueue;
        if (currentSessionId === sessionId) await flush();
        return;
      }

      pendingTransportBytes += batchBytes;
      const operation = sendQueue.then(async () => {
        try {
          const response = (await withTimeout(
            browser.runtime.sendMessage({
              type: 'CAPTURE_BATCH',
              sessionId,
              documentId,
              events,
            }),
            TRANSPORT_ACK_TIMEOUT_MS,
          )) as RuntimeResponse;
          if (!response.ok) throw new Error(response.error);
          if (
            !('accepted' in response) ||
            !Number.isSafeInteger(response.accepted) ||
            response.accepted < 0 ||
            response.accepted > events.length
          ) {
            throw new Error('Capture batch returned a malformed acknowledgement.');
          }
          acknowledgeDropReport(reportedDrops);
          collectorFailureQueued = false;
        } catch (error) {
          // Keep the raw batch in the bounded transport closure until this attempt settles. A
          // rejected or malformed acknowledgement becomes an explicit, retryable gap summary.
          noteDropped(rawEvents);
          throw error;
        }
      });
      sendQueue = operation
        .catch(() => undefined)
        .finally(() => {
          pendingTransportBytes = Math.max(0, pendingTransportBytes - batchBytes);
        });
      await operation;
    };

    const scheduleFlush = (): void => {
      if (flushTimer !== null) return;
      flushTimer = window.setTimeout(() => void flush().catch(() => undefined), 250);
    };

    const emit = (event: Omit<ClientCaptureEvent, 'clientId' | 'localSeq'>): void => {
      if (!captureEnabled || !currentSessionId) return;
      const candidate: ClientCaptureEvent = { ...event, clientId, localSeq: localSeq++ };
      const bytes = jsonUtf8ByteLength(candidate);
      if (bytes > MAX_BATCH_BYTES) {
        noteDropped([candidate]);
        if (candidate.kind === 'rrweb') rrwebRecorder?.stop();
        recordCollectorFailure(
          new Error(`${candidate.kind} event exceeded the 3.5 MB per-message limit.`),
          [candidate.kind === 'error' ? 'console' : candidate.kind],
        );
        return;
      }
      if (buffer.length > 0 && (bufferedBytes + bytes > 350_000 || buffer.length >= 50)) {
        void flush().catch(() => undefined);
      }
      buffer.push(candidate);
      bufferedBytes += bytes;
      scheduleFlush();
    };

    const startCollectors = (): void => {
      if (semanticRecorder || rrwebRecorder) return;
      window.dispatchEvent(new CustomEvent(`${CHANNEL}:diagnostics-start`));
      semanticRecorder = new SemanticRecorder(emit);
      rrwebRecorder = new RrwebSegmentRecorder(emit);
      semanticRecorder.start();
      rrwebRecorder.start();
    };

    const stopCollectors = async (flushEvidence = true): Promise<void> => {
      semanticRecorder?.stop();
      semanticRecorder = null;
      rrwebRecorder?.stop();
      rrwebRecorder = null;
      window.dispatchEvent(new CustomEvent(`${CHANNEL}:diagnostics-stop`));
      // Pending semantic input is emitted synchronously by SemanticRecorder.stop(). Disable new
      // observations only after that tail has entered the buffer, then drain the transport.
      captureEnabled = false;
      if (!flushEvidence) {
        await sendQueue;
        buffer = [];
        bufferedBytes = 0;
        pendingDroppedCount = 0;
        pendingDroppedBySource.clear();
        return;
      }
      try {
        await flush();
      } catch (error) {
        // One bounded follow-up transports the gap created by the failed batch. It never retries
        // the ambiguous original payload, so duplicate captured actions cannot be introduced.
        try {
          await flush();
        } catch {
          throw error;
        }
      }
    };

    const applyState = async (nextState: RecorderViewState, enabled = captureEnabled): Promise<void> => {
      const inScope = enabled && nextState.sessionId !== null;
      const shouldCapture = inScope && nextState.status === 'recording';

      if (shouldCapture) {
        if (currentSessionId !== nextState.sessionId) {
          pendingDroppedCount = 0;
          pendingDroppedBySource.clear();
        }
        currentSessionId = nextState.sessionId;
        captureEnabled = true;
        startCollectors();
      } else {
        // Flush with the previous session identity before disabling capture. This preserves events
        // observed just before a pause/stop without admitting any events from the paused interval.
        await stopCollectors(inScope);
        currentSessionId = inScope ? nextState.sessionId : null;
      }

      if (inScope && ['recording', 'paused', 'interrupted'].includes(nextState.status)) {
        overlay ??= createStatusOverlay();
        overlay.update(nextState);
      } else {
        overlay?.remove();
        overlay = null;
      }
    };

    const enqueueState = (
      nextState: RecorderViewState,
      enabled = captureEnabled,
    ): Promise<void> => {
      if (queuedSessionId === undefined) {
        queuedSessionId = nextState.sessionId;
        highestQueuedRevision = nextState.revision;
        highestQueuedTransitionAt = nextState.transitionedAtMs;
      } else if (nextState.sessionId === queuedSessionId) {
        if (
          nextState.transitionedAtMs < highestQueuedTransitionAt ||
          nextState.revision <= highestQueuedRevision
        ) return stateApplyQueue;
        highestQueuedRevision = nextState.revision;
        highestQueuedTransitionAt = Math.max(
          highestQueuedTransitionAt,
          nextState.transitionedAtMs,
        );
      } else {
        if (
          nextState.transitionedAtMs < highestQueuedTransitionAt ||
          (nextState.sessionId !== null && retiredSessionIds.has(nextState.sessionId))
        ) {
          return stateApplyQueue;
        }
        if (queuedSessionId !== null) retiredSessionIds.add(queuedSessionId);
        queuedSessionId = nextState.sessionId;
        highestQueuedRevision = nextState.revision;
        highestQueuedTransitionAt = nextState.transitionedAtMs;
      }
      const operation = stateApplyQueue.then(async () => {
        await applyState(nextState, enabled);
        appliedState = nextState;
      });
      stateApplyQueue = operation.catch(() => undefined);
      return operation;
    };

    async function hello(): Promise<void> {
      const url = new URL(location.href);
      url.search = '';
      url.hash = '';
      const response = (await browser.runtime.sendMessage({
        type: 'HELLO',
        clientId,
        documentId,
        url: url.toString(),
      })) as RuntimeResponse;
      if (response.ok) {
        const enabled = 'captureEnabled' in response ? (response.captureEnabled ?? false) : false;
        await enqueueState(response.state, enabled);
      }
    }

    function recordCollectorFailure(
      error: unknown,
      affected: ClientCaptureEvent['kind'][] = ['semantic', 'rrweb', 'console'],
    ): void {
      if (!captureEnabled || collectorFailureQueued) return;
      collectorFailureQueued = true;
      const message = error instanceof Error ? error.message : String(error);
      const gap: ClientCaptureEvent = {
        clientId,
        localSeq: localSeq++,
        observedAt: performance.timeOrigin + performance.now(),
        kind: 'gap',
        data: {
          kind: 'collector_error',
          source: 'lifecycle',
          status: 'error',
          affected,
          reason: message.slice(0, 500),
          recoverable: true,
        },
      };
      if (jsonUtf8ByteLength(gap) + bufferedBytes <= MAX_BATCH_BYTES) {
        buffer.push(gap);
        scheduleFlush();
      }
    }

    window.addEventListener('message', (event) => {
      if (!captureEnabled || event.source !== window) return;
      const payload = event.data as Record<string, unknown> | null;
      if (!payload || payload.channel !== CHANNEL) return;
      const kind = payload.kind === 'error' ? 'error' : 'console';
      const data = payload.data;
      if (!data || typeof data !== 'object' || jsonUtf8ByteLength(data) > 32_000) return;
      emit({
        observedAt: performance.timeOrigin + performance.now(),
        kind,
        data: data as Record<string, unknown>,
      });
    });

    browser.runtime.onMessage.addListener((message: BackgroundMessage, _sender, sendResponse) => {
      if (message.type === 'STATE_CHANGED') {
        void enqueueState(message.state, message.captureEnabled)
          .then(() => {
            if (!appliedState) throw new Error('Recorder state was not applied.');
            sendResponse({
              appliedRevision: appliedState.revision,
              sessionId: appliedState.sessionId,
              transitionedAtMs: appliedState.transitionedAtMs,
              clientId,
              documentId,
            });
          })
          .catch((error: unknown) => {
            recordCollectorFailure(error);
            sendResponse({
              error: error instanceof Error ? error.message : String(error),
            });
          });
        return true;
      }
      if (message.type === 'FLUSH_CAPTURE') {
        void (async () => {
          const matchesSession = message.sessionId === currentSessionId;
          let flushError: unknown = null;
          if (matchesSession) {
            try {
              await stopCollectors();
            } catch (error) {
              flushError = error;
            }
          }
          const droppedBySource = dropCounts();
          const droppedCount = Object.values(droppedBySource).reduce((sum, count) => sum + count, 0);
          if (matchesSession) {
            try {
              const completion = (await withTimeout(
                browser.runtime.sendMessage({
                  type: 'FLUSH_COMPLETE',
                  sessionId: message.sessionId,
                  flushToken: message.flushToken,
                  clientId,
                  documentId,
                  droppedCount,
                  droppedBySource,
                }),
                TRANSPORT_ACK_TIMEOUT_MS,
              )) as RuntimeResponse;
              if (!completion.ok) throw new Error(completion.error);
            } catch (error) {
              flushError ??= error;
            }
          }
          sendResponse({
            flushed: matchesSession && flushError === null,
            sessionId: message.sessionId,
            flushToken: message.flushToken,
            clientId,
            documentId,
            droppedCount,
            droppedBySource,
            ...(flushError === null
              ? {}
              : { error: flushError instanceof Error ? flushError.message : String(flushError) }),
          });
        })().catch((error: unknown) => {
          const droppedBySource = dropCounts();
          sendResponse({
            flushed: false,
            sessionId: message.sessionId,
            flushToken: message.flushToken,
            clientId,
            documentId,
            droppedCount: Object.values(droppedBySource).reduce((sum, count) => sum + count, 0),
            droppedBySource,
            error: error instanceof Error ? error.message : String(error),
          });
        });
        return true;
      }
      if (message.type === 'CAPTURE_SCREENSHOT_RECTS') {
        sendResponse({
          rects: listSensitiveRects(),
          devicePixelRatio: window.devicePixelRatio,
          documentToken: documentId,
        });
        return;
      }
      return;
    });

    window.addEventListener('pageshow', () => void hello().catch(recordCollectorFailure));
    window.addEventListener('pagehide', () => void flush().catch(() => undefined));
    await hello();
  },
});

function createStatusOverlay(): { update: (state: RecorderViewState) => void; remove: () => void } {
  const host = document.createElement('div');
  host.dataset.bugtraceBlock = 'true';
  host.setAttribute('aria-hidden', 'true');
  const shadow = host.attachShadow({ mode: 'closed' });
  const pill = document.createElement('div');
  const style = document.createElement('style');
  style.textContent = `
    :host { all: initial; }
    div {
      position: fixed; top: 14px; right: 14px; z-index: 2147483647;
      display: flex; align-items: center; gap: 8px; min-height: 28px;
      padding: 0 11px; border: 1px solid rgba(255,255,255,.18); border-radius: 999px;
      background: rgba(12,16,18,.92); color: #f2f0e9;
      box-shadow: 0 8px 28px rgba(0,0,0,.34); backdrop-filter: blur(10px);
      font: 700 11px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
      letter-spacing: .09em; text-transform: uppercase; pointer-events: none;
    }
    div::before { content: ''; width: 7px; height: 7px; border-radius: 50%; background: #ff5d52; box-shadow: 0 0 0 4px rgba(255,93,82,.16); }
    div[data-state='paused']::before { background: #f5bd4f; box-shadow: 0 0 0 4px rgba(245,189,79,.16); }
    div[data-state='interrupted']::before { background: #9ba6ad; box-shadow: 0 0 0 4px rgba(155,166,173,.16); }
  `;
  shadow.append(style, pill);
  const mount = (): void => {
    if (!host.isConnected) (document.documentElement ?? document).append(host);
  };
  mount();
  return {
    update(state) {
      mount();
      pill.dataset.state = state.status;
      pill.textContent = state.status === 'recording' ? 'Bugtrace · recording' : `Bugtrace · ${state.status}`;
    },
    remove() {
      host.remove();
    },
  };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeoutId = setTimeout(() => reject(new Error('Content transport acknowledgement timed out.')), timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}
