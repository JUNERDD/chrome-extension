import type { Replayer } from '@rrweb/replay';
import { ReplayerEvents } from '@rrweb/types';
import '@rrweb/replay/dist/style.css';
import {
  FULL_FIDELITY_REPLAY_OPTIONS,
  hasFullFidelityRrwebSandbox,
  isReplayKeyboardCustomEvent,
  isReplaySandboxCommand,
  prepareReplayKeyboardEvents,
  prepareReplayTimeline,
  prepareRrwebEventsForReplay,
  replayKeyboardToastExpirationsAfter,
  replayKeyboardToastStatesAt,
  type ReplayKeyboardEvent,
  type ReplayPlaybackSnapshot,
  type ReplaySandboxCommand,
  type ReplaySandboxErrorReason,
  type ReplaySandboxEvent,
} from '../../src/ui/replay-sandbox';
import './style.css';

type CapabilityWindow = Window & {
  browser?: unknown;
  chrome?: unknown;
};

const root = (() => {
  const element = document.getElementById('replay-root');
  if (!element) throw new Error('Replay sandbox root is missing.');
  return element;
})();

let activeChannel: string | null = null;
let replayer: Replayer | null = null;
let destroyReplayLayout: (() => void) | null = null;
let destroyReplaySubscriptions: (() => void) | null = null;
let progressFrame: number | null = null;
let keyboardToastStack: HTMLDivElement | null = null;
let keyboardToastSignature = '';
const keyboardToastElements = new Map<number, HTMLDivElement>();
const finishedKeyboardToastTimers = new Set<number>();
let keyboardEvents: ReplayKeyboardEvent[] = [];
let lastProgressAt = 0;
let durationMs = 0;
let ended = false;
let playing = false;

const PROGRESS_INTERVAL_MS = 100;
const KEYBOARD_INDICATOR_INSET_PX = 16;

type ReplayViewport = {
  height: number;
  width: number;
};

function isReplayViewport(value: unknown): value is ReplayViewport {
  if (typeof value !== 'object' || value === null) return false;
  const viewport = value as Partial<ReplayViewport>;
  return (
    typeof viewport.width === 'number' &&
    Number.isFinite(viewport.width) &&
    viewport.width > 0 &&
    typeof viewport.height === 'number' &&
    Number.isFinite(viewport.height) &&
    viewport.height > 0
  );
}

/**
 * rrweb renders its document, cursor, and canvas at the recorded viewport size. Fit the complete
 * wrapper as one plane so every layer stays aligned while the available replay surface changes.
 */
function fitReplayToSurface(player: Replayer, onLayout: () => void): () => void {
  let viewport: ReplayViewport | null = null;
  player.wrapper.style.visibility = 'hidden';

  const update = () => {
    if (!viewport) return;
    const availableWidth = root.clientWidth;
    const availableHeight = root.clientHeight;
    if (availableWidth <= 0 || availableHeight <= 0) return;

    const scale = Math.min(
      availableWidth / viewport.width,
      availableHeight / viewport.height,
    );
    player.wrapper.style.width = `${viewport.width}px`;
    player.wrapper.style.height = `${viewport.height}px`;
    player.wrapper.style.transform = `translate(-50%, -50%) scale(${scale})`;
    player.wrapper.style.visibility = 'visible';
    onLayout();
  };

  const onReplayResize = (value: unknown) => {
    if (!isReplayViewport(value)) return;
    viewport = value;
    update();
  };
  const surfaceObserver = new ResizeObserver(update);
  surfaceObserver.observe(root);
  player.on('resize', onReplayResize);

  const width = Number(player.iframe.getAttribute('width'));
  const height = Number(player.iframe.getAttribute('height'));
  if (isReplayViewport({ height, width })) viewport = { height, width };
  update();

  return () => {
    surfaceObserver.disconnect();
    player.off('resize', onReplayResize);
    player.wrapper.style.removeProperty('height');
    player.wrapper.style.removeProperty('transform');
    player.wrapper.style.removeProperty('visibility');
    player.wrapper.style.removeProperty('width');
  };
}

/**
 * This page remains an extension-origin document because Chromium's manifest sandbox forbids the
 * same-origin capability rrweb needs for canvas reconstruction. Shadow the extension globals in
 * both replay windows before any recorded DOM is rebuilt.
 */
function isolateExtensionGlobals(target: Window): boolean {
  for (const capability of ['browser', 'chrome'] as const) {
    try {
      const current = Object.getOwnPropertyDescriptor(target, capability);
      Object.defineProperty(target, capability, {
        configurable: current?.configurable ?? false,
        enumerable: current?.enumerable ?? false,
        value: undefined,
        writable: false,
      });
    } catch {
      return false;
    }
  }
  const isolated = target as CapabilityWindow;
  return typeof isolated.browser === 'undefined' && typeof isolated.chrome === 'undefined';
}

const hostIsolated = isolateExtensionGlobals(window);

function post(event: ReplaySandboxEvent): void {
  window.parent.postMessage(event, '*');
}

function stopProgress(): void {
  if (progressFrame !== null) cancelAnimationFrame(progressFrame);
  progressFrame = null;
  lastProgressAt = 0;
}

function cancelFinishedKeyboardToastCleanup(): void {
  for (const timer of finishedKeyboardToastTimers) window.clearTimeout(timer);
  finishedKeyboardToastTimers.clear();
}

function clearKeyboardToasts(remove = false): void {
  cancelFinishedKeyboardToastCleanup();
  keyboardToastSignature = '';
  keyboardToastElements.clear();
  if (!keyboardToastStack) return;
  keyboardToastStack.dataset.visible = 'false';
  keyboardToastStack.dataset.toastCount = '0';
  keyboardToastStack.replaceChildren();
  if (remove) {
    keyboardToastStack.remove();
    keyboardToastStack = null;
  }
}

function createKeyboardToastStack(): void {
  const stack = document.createElement('div');
  stack.className = 'replay-keyboard-toast-stack';
  stack.dataset.toastCount = '0';
  stack.dataset.visible = 'false';
  stack.setAttribute('aria-atomic', 'false');
  stack.setAttribute('aria-live', 'polite');
  stack.setAttribute('aria-relevant', 'additions');
  stack.setAttribute('role', 'log');
  root.append(stack);
  keyboardToastStack = stack;
}

function positionKeyboardToastStack(player: Replayer): void {
  const stack = keyboardToastStack;
  if (!stack) return;

  const rootRect = root.getBoundingClientRect();
  const wrapperRect = player.wrapper.getBoundingClientRect();
  const visibleLeft = Math.max(rootRect.left, wrapperRect.left);
  const visibleRight = Math.min(rootRect.right, wrapperRect.right);
  const visibleTop = Math.max(rootRect.top, wrapperRect.top);
  const visibleBottom = Math.min(rootRect.bottom, wrapperRect.bottom);
  if (visibleRight <= visibleLeft || visibleBottom <= visibleTop) return;

  stack.style.right = `${Math.max(0, rootRect.right - visibleRight) + KEYBOARD_INDICATOR_INSET_PX}px`;
  stack.style.bottom = `${Math.max(0, rootRect.bottom - visibleBottom) + KEYBOARD_INDICATOR_INSET_PX}px`;
  stack.style.maxWidth = `${Math.max(0, visibleRight - visibleLeft - KEYBOARD_INDICATOR_INSET_PX * 2)}px`;
}

function renderKeyboardToastsAt(timeMs: number): void {
  const stack = keyboardToastStack;
  if (!stack) return;
  const states = replayKeyboardToastStatesAt(keyboardEvents, timeMs);
  const signature = states
    .map((state) => `${state.occurrenceIndex}:${state.cueId}`)
    .join('|');
  if (signature === keyboardToastSignature) return;
  keyboardToastSignature = signature;

  const activeOccurrences = new Set(states.map((state) => state.occurrenceIndex));
  for (const [occurrenceIndex, toast] of keyboardToastElements) {
    if (activeOccurrences.has(occurrenceIndex)) continue;
    toast.remove();
    keyboardToastElements.delete(occurrenceIndex);
  }

  for (const state of states) {
    const existing = keyboardToastElements.get(state.occurrenceIndex);
    if (existing) continue;
    const toast = document.createElement('div');
    toast.className = 'replay-keyboard-indicator replay-keyboard-indicator--animate';
    toast.dataset.cueId = state.cueId;
    toast.dataset.occurrenceIndex = String(state.occurrenceIndex);
    toast.dataset.visible = 'true';
    toast.textContent = state.text;
    toast.addEventListener('animationend', () => {
      toast.classList.remove('replay-keyboard-indicator--animate');
    }, { once: true });
    keyboardToastElements.set(state.occurrenceIndex, toast);
    stack.append(toast);
  }
  stack.dataset.toastCount = String(states.length);
  stack.dataset.visible = states.length > 0 ? 'true' : 'false';
}

function scheduleFinishedKeyboardToastCleanup(
  channel: string,
  player: Replayer,
  timeMs: number,
): void {
  cancelFinishedKeyboardToastCleanup();
  for (const expiration of replayKeyboardToastExpirationsAfter(keyboardEvents, timeMs)) {
    const timer = window.setTimeout(() => {
      finishedKeyboardToastTimers.delete(timer);
      if (
        activeChannel !== channel ||
        replayer !== player ||
        !ended ||
        playing
      ) return;
      renderKeyboardToastsAt(expiration.replayTimeMs);
    }, expiration.delayMs);
    finishedKeyboardToastTimers.add(timer);
  }
}

function boundedTime(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(durationMs, Math.max(0, value));
}

function replayEndOffset(): number {
  // rrweb applies events strictly before a paused offset. Advance one millisecond so an event at
  // the exact duration is reconstructed when the timeline is placed at its end.
  return durationMs + 1;
}

function playbackSnapshot(): ReplayPlaybackSnapshot {
  return {
    currentTimeMs: ended ? durationMs : boundedTime(replayer?.getCurrentTime() ?? 0),
    durationMs,
    ended,
    playing,
  };
}

function postPlayback(
  channel: string,
  type: Extract<ReplaySandboxEvent['type'], 'progress' | 'ready' | 'state'>,
): void {
  if (channel !== activeChannel || !replayer) return;
  post({ channel, type, ...playbackSnapshot() });
}

function startProgress(channel: string): void {
  stopProgress();
  const update = (now: number) => {
    if (channel !== activeChannel || !replayer || !playing) {
      progressFrame = null;
      return;
    }
    renderKeyboardToastsAt(boundedTime(replayer.getCurrentTime()));
    if (now - lastProgressAt >= PROGRESS_INTERVAL_MS) {
      lastProgressAt = now;
      postPlayback(channel, 'progress');
    }
    progressFrame = requestAnimationFrame(update);
  };
  progressFrame = requestAnimationFrame(update);
}

function destroyReplay(): void {
  try {
    stopProgress();
    clearKeyboardToasts(true);
    destroyReplaySubscriptions?.();
    destroyReplaySubscriptions = null;
    destroyReplayLayout?.();
    destroyReplayLayout = null;
    replayer?.destroy();
  } finally {
    replayer = null;
    keyboardEvents = [];
    keyboardToastSignature = '';
    keyboardToastElements.clear();
    durationMs = 0;
    ended = false;
    playing = false;
    root.replaceChildren();
  }
}

function fail(channel: string, reason: ReplaySandboxErrorReason): void {
  destroyReplay();
  post({ channel, reason, type: 'error' });
}

async function mount(command: Extract<ReplaySandboxCommand, { type: 'mount' }>): Promise<void> {
  destroyReplay();
  activeChannel = command.channel;
  if (!hostIsolated) {
    fail(command.channel, 'sandbox');
    return;
  }
  const rrwebEvents = prepareRrwebEventsForReplay(command.events);
  if (rrwebEvents.length < 2) {
    fail(command.channel, 'reconstruct');
    return;
  }
  keyboardEvents = prepareReplayKeyboardEvents(command.keyboardEvents ?? []);
  const events = prepareReplayTimeline(rrwebEvents, keyboardEvents);

  let RrwebReplayer: typeof Replayer;
  try {
    ({ Replayer: RrwebReplayer } = await import('@rrweb/replay'));
  } catch {
    if (activeChannel === command.channel) fail(command.channel, 'load');
    return;
  }
  if (activeChannel !== command.channel) return;

  try {
    const nextReplayer = new RrwebReplayer(events, {
      ...FULL_FIDELITY_REPLAY_OPTIONS,
      root,
      logger: {
        log: () => undefined,
        warn: () => undefined,
      },
    });
    if (
      !hasFullFidelityRrwebSandbox(nextReplayer.iframe.sandbox) ||
      !nextReplayer.iframe.contentWindow ||
      !isolateExtensionGlobals(nextReplayer.iframe.contentWindow)
    ) {
      nextReplayer.destroy();
      fail(command.channel, 'sandbox');
      return;
    }

    nextReplayer.iframe.referrerPolicy = 'no-referrer';
    nextReplayer.disableInteract();
    replayer = nextReplayer;
    createKeyboardToastStack();
    destroyReplayLayout = fitReplayToSurface(nextReplayer, () => {
      positionKeyboardToastStack(nextReplayer);
    });
    const totalTime = nextReplayer.getMetaData().totalTime;
    durationMs = Number.isFinite(totalTime) ? Math.max(0, totalTime) : 0;
    ended = durationMs === 0;
    playing = false;
    const onFinish = () => {
      if (activeChannel !== command.channel || replayer !== nextReplayer) return;
      stopProgress();
      ended = true;
      playing = false;
      renderKeyboardToastsAt(durationMs);
      scheduleFinishedKeyboardToastCleanup(command.channel, nextReplayer, durationMs);
      postPlayback(command.channel, 'state');
    };
    const onCustomEvent = (event: unknown) => {
      if (
        activeChannel !== command.channel ||
        replayer !== nextReplayer ||
        !isReplayKeyboardCustomEvent(event)
      ) {
        return;
      }
      renderKeyboardToastsAt(event.data.payload.timeMs);
    };
    nextReplayer.on(ReplayerEvents.Finish, onFinish);
    nextReplayer.on(ReplayerEvents.CustomEvent, onCustomEvent);
    destroyReplaySubscriptions = () => {
      nextReplayer.off(ReplayerEvents.Finish, onFinish);
      nextReplayer.off(ReplayerEvents.CustomEvent, onCustomEvent);
    };
    postPlayback(command.channel, 'ready');
    postPlayback(command.channel, 'state');
  } catch {
    if (activeChannel === command.channel) fail(command.channel, 'reconstruct');
  }
}

function control(command: Exclude<ReplaySandboxCommand, { type: 'mount' }>): void {
  if (command.channel !== activeChannel) return;
  if (command.type === 'destroy') {
    destroyReplay();
    activeChannel = null;
    return;
  }
  if (!replayer) return;

  try {
    if (command.type === 'pause') {
      replayer.pause();
      stopProgress();
      playing = false;
      ended = durationMs === 0 || boundedTime(replayer.getCurrentTime()) >= durationMs;
      renderKeyboardToastsAt(boundedTime(replayer.getCurrentTime()));
      postPlayback(command.channel, 'state');
      return;
    }
    if (command.type === 'play') {
      if (durationMs === 0) {
        replayer.pause(replayEndOffset());
        stopProgress();
        ended = true;
        playing = false;
        postPlayback(command.channel, 'state');
        return;
      }
      if (ended) clearKeyboardToasts();
      const currentTimeMs = ended ? 0 : boundedTime(replayer.getCurrentTime());
      replayer.play(currentTimeMs);
      renderKeyboardToastsAt(currentTimeMs);
      ended = false;
      playing = true;
      startProgress(command.channel);
      postPlayback(command.channel, 'state');
      return;
    }
    if (command.type === 'seek') {
      clearKeyboardToasts();
      const wasPlaying = playing;
      const timeMs = boundedTime(command.timeMs);
      stopProgress();
      if (timeMs >= durationMs) {
        replayer.pause(replayEndOffset());
        ended = true;
        playing = false;
      } else if (wasPlaying) {
        replayer.play(timeMs);
        ended = false;
        playing = true;
        startProgress(command.channel);
      } else {
        replayer.pause(timeMs);
        ended = false;
        playing = false;
      }
      renderKeyboardToastsAt(timeMs);
      if (ended) {
        scheduleFinishedKeyboardToastCleanup(command.channel, replayer, timeMs);
      }
      postPlayback(command.channel, 'state');
      return;
    }
    if (durationMs === 0) {
      clearKeyboardToasts();
      replayer.pause(replayEndOffset());
      stopProgress();
      ended = true;
      playing = false;
      postPlayback(command.channel, 'state');
      return;
    }
    clearKeyboardToasts();
    replayer.play(0);
    renderKeyboardToastsAt(0);
    ended = false;
    playing = true;
    startProgress(command.channel);
    postPlayback(command.channel, 'state');
  } catch {
    fail(command.channel, command.type === 'restart' ? 'restart' : 'playback');
  }
}

window.addEventListener('message', (event: MessageEvent<unknown>) => {
  if (event.source !== window.parent || !isReplaySandboxCommand(event.data)) return;
  if (event.data.type === 'mount') {
    void mount(event.data);
    return;
  }
  control(event.data);
});

window.addEventListener('pagehide', destroyReplay, { once: true });
