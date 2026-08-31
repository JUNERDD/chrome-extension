import { Alert, Button, Slider, Tabs } from '@heroui/react';
import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n';
import { formatDuration } from './format';
import { Icon } from './icons';
import {
  isReplaySandboxEvent,
  prepareRrwebEventsForReplay,
  REPLAY_HOST_SANDBOX,
  REPLAY_SANDBOX_PAGE,
  type ReplayPlaybackSnapshot,
  type ReplaySandboxCommand,
} from './replay-sandbox';
import type { ReplaySegmentData } from './trace-adapter';

const EMPTY_PLAYBACK: ReplayPlaybackSnapshot = {
  currentTimeMs: 0,
  durationMs: 0,
  ended: false,
  playing: false,
};

type ReplayControlCommand =
  | { type: 'pause' | 'play' | 'restart' }
  | { timeMs: number; type: 'seek' };

function singleSliderValue(value: number | number[]): number {
  return Array.isArray(value) ? (value[0] ?? 0) : value;
}

export function ReplayPanel({ segments }: { segments: ReplaySegmentData[] }) {
  const { locale, t } = useI18n();
  const [selectedId, setSelectedId] = useState(segments[0]?.id ?? '');
  const [error, setError] = useState<string | null>(null);
  const [fullscreenError, setFullscreenError] = useState<string | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [playback, setPlayback] = useState<ReplayPlaybackSnapshot>(EMPTY_PLAYBACK);
  const [scrubTimeMs, setScrubTimeMs] = useState<number | null>(null);
  const [replayReady, setReplayReady] = useState(false);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const fullscreenButtonRef = useRef<HTMLButtonElement>(null);
  const fullscreenRef = useRef<HTMLDivElement>(null);
  const wasFullscreenRef = useRef(false);
  const channelRef = useRef('');
  const selected = segments.find((segment) => segment.id === selectedId) ?? segments[0];

  useEffect(() => {
    const syncFullscreenState = () => {
      const nextFullscreen = document.fullscreenElement === fullscreenRef.current;
      const shouldRestoreFocus = wasFullscreenRef.current && !nextFullscreen;
      wasFullscreenRef.current = nextFullscreen;
      setIsFullscreen(nextFullscreen);
      if (shouldRestoreFocus) {
        requestAnimationFrame(() => fullscreenButtonRef.current?.focus());
      }
    };

    document.addEventListener('fullscreenchange', syncFullscreenState);
    return () => document.removeEventListener('fullscreenchange', syncFullscreenState);
  }, []);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame || !selected) return undefined;

    const events = prepareRrwebEventsForReplay(selected.events);
    if (events.length < 2) {
      queueMicrotask(() => {
        setError(t('results.replay.insufficient'));
        setPlayback(EMPTY_PLAYBACK);
        setScrubTimeMs(null);
        setReplayReady(false);
      });
      return undefined;
    }

    const channel = crypto.randomUUID();
    channelRef.current = channel;

    const onMessage = (event: MessageEvent<unknown>) => {
      if (
        event.source !== frame.contentWindow ||
        !isReplaySandboxEvent(event.data) ||
        event.data.channel !== channel
      ) {
        return;
      }
      if (
        event.data.type === 'ready' ||
        event.data.type === 'state' ||
        event.data.type === 'progress'
      ) {
        setPlayback({
          currentTimeMs: event.data.currentTimeMs,
          durationMs: event.data.durationMs,
          ended: event.data.ended,
          playing: event.data.playing,
        });
        if (event.data.type === 'ready') {
          setError(null);
          setReplayReady(true);
        }
        return;
      }
      if (event.data.type !== 'error') return;

      setReplayReady(false);
      setPlayback(EMPTY_PLAYBACK);
      setScrubTimeMs(null);
      const errorKey = {
        load: 'results.replay.loadFailed',
        playback: 'results.replay.playbackFailed',
        reconstruct: 'results.replay.reconstructFailed',
        restart: 'results.replay.restartFailed',
        sandbox: 'results.replay.sandboxViolation',
      } as const;
      setError(t(errorKey[event.data.reason]));
    };
    const onLoad = () => {
      setError(null);
      setPlayback(EMPTY_PLAYBACK);
      setScrubTimeMs(null);
      setReplayReady(false);
      const command: ReplaySandboxCommand = {
        channel,
        events,
        keyboardEvents: selected.keyboardEvents,
        type: 'mount',
      };
      frame.contentWindow?.postMessage(command, '*');
    };
    const onLoadError = () => {
      setReplayReady(false);
      setPlayback(EMPTY_PLAYBACK);
      setScrubTimeMs(null);
      setError(t('results.replay.loadFailed'));
    };

    window.addEventListener('message', onMessage);
    frame.addEventListener('load', onLoad);
    frame.addEventListener('error', onLoadError);
    frame.src = REPLAY_SANDBOX_PAGE;

    return () => {
      frame.contentWindow?.postMessage(
        { channel, type: 'destroy' } satisfies ReplaySandboxCommand,
        '*',
      );
      window.removeEventListener('message', onMessage);
      frame.removeEventListener('load', onLoad);
      frame.removeEventListener('error', onLoadError);
      if (channelRef.current === channel) channelRef.current = '';
    };
  }, [selected, t]);

  const sendCommand = (control: ReplayControlCommand) => {
    const channel = channelRef.current;
    const frame = frameRef.current;
    if (!channel || !frame?.contentWindow) return;
    const command = { channel, ...control } as ReplaySandboxCommand;
    frame.contentWindow.postMessage(command, '*');
    setError(null);
  };

  const togglePlayback = () => {
    sendCommand({ type: playback.playing ? 'pause' : 'play' });
  };

  const restart = () => {
    setScrubTimeMs(null);
    sendCommand({ type: 'restart' });
  };

  const commitSeek = (value: number | number[]) => {
    const timeMs = Math.min(playback.durationMs, Math.max(0, singleSliderValue(value)));
    setScrubTimeMs(null);
    sendCommand({ timeMs, type: 'seek' });
  };

  const toggleFullscreen = async () => {
    const surface = fullscreenRef.current;
    if (!surface || !document.fullscreenEnabled) return;
    setFullscreenError(null);
    try {
      if (document.fullscreenElement === surface) {
        await document.exitFullscreen();
        return;
      }
      if (document.fullscreenElement) {
        setFullscreenError(t('results.replay.fullscreenFailed'));
        return;
      }
      await surface.requestFullscreen();
    } catch {
      setFullscreenError(t('results.replay.fullscreenFailed'));
    }
  };

  if (segments.length === 0) {
    return (
      <Alert status="default" role="status">
        <Alert.Indicator />
        <Alert.Content>
          <Alert.Title>{t('results.replay.emptyTitle')}</Alert.Title>
          <Alert.Description>{t('results.replay.emptyDetail')}</Alert.Description>
        </Alert.Content>
      </Alert>
    );
  }

  const displayedTimeMs = scrubTimeMs ?? playback.currentTimeMs;
  const sliderMaximum = Math.max(1, playback.durationMs);
  const controlsDisabled = Boolean(error) || !replayReady;

  return (
    <Tabs
      className="min-w-0 max-w-full"
      selectedKey={selected?.id ?? ''}
      variant="secondary"
      onSelectionChange={(key) => {
        setError(null);
        setReplayReady(false);
        setPlayback(EMPTY_PLAYBACK);
        setScrubTimeMs(null);
        setSelectedId(String(key));
      }}
    >
      <Tabs.ListContainer className="min-w-0 max-w-full">
        <Tabs.List aria-label={t('results.replay.segmentsAria')}>
          {segments.map((segment, index) => (
            <Tabs.Tab
              key={segment.id}
              className="h-auto min-h-12 w-auto min-w-36 shrink-0 px-4 py-2"
              id={segment.id}
            >
              <Tabs.Indicator />
              <span className="grid w-full gap-1 text-left">
                <span className="font-mono text-[0.65rem] text-accent">
                  {t('results.replay.segment', { index: String(index + 1).padStart(2, '0') })}
                </span>
                <strong className="flex items-center gap-2 text-xs">
                  {t('results.replay.events', { count: segment.eventCount.toLocaleString(locale) })}
                  <span className="font-mono text-[0.65rem] font-normal text-muted">
                    +{formatDuration(segment.startedAtOffsetMs)}
                  </span>
                </strong>
              </span>
            </Tabs.Tab>
          ))}
        </Tabs.List>
      </Tabs.ListContainer>

      {selected && (
        <Tabs.Panel id={selected.id} className="mt-4 min-w-0 max-w-full">
          <div className="results-replay-surface" ref={fullscreenRef}>
            <div className="results-replay-player">
              {error && (
                <div className="border-b border-separator p-3">
                  <Alert status="warning" role="status">
                    <Alert.Indicator />
                    <Alert.Content>
                      <Alert.Title>{t('results.replay.unavailableTitle')}</Alert.Title>
                      <Alert.Description>
                        {error} {t('results.replay.unavailableDetail')}
                      </Alert.Description>
                    </Alert.Content>
                  </Alert>
                </div>
              )}

              <div
                className={`results-replay-mount ${error ? 'results-replay-mount--unavailable' : ''}`}
              >
                <iframe
                  className="results-replay-frame"
                  ref={frameRef}
                  referrerPolicy="no-referrer"
                  sandbox={REPLAY_HOST_SANDBOX}
                  tabIndex={-1}
                  title={t('results.replay.title')}
                />
              </div>

              <div className="results-player-controls">
                <Slider
                  aria-label={t('results.replay.seek')}
                  className="results-player-timeline"
                  isDisabled={controlsDisabled || playback.durationMs <= 0}
                  maxValue={sliderMaximum}
                  minValue={0}
                  step={100}
                  value={Math.min(sliderMaximum, displayedTimeMs)}
                  onChange={(value) => setScrubTimeMs(singleSliderValue(value))}
                  onChangeEnd={commitSeek}
                >
                  <Slider.Track>
                    <Slider.Fill />
                    <Slider.Thumb />
                  </Slider.Track>
                </Slider>

                <div className="results-player-transport">
                  <div className="results-player-transport-group">
                    <Button
                      variant="primary"
                      isDisabled={controlsDisabled}
                      onPress={togglePlayback}
                    >
                      <Icon name={playback.playing ? 'pause' : 'play'} size={16} />
                      {playback.playing ? t('results.replay.pause') : t('results.replay.play')}
                    </Button>
                    <span
                      className="results-player-time font-mono"
                      aria-label={`${t('results.replay.currentTime')} ${formatDuration(displayedTimeMs)}, ${t('results.replay.duration')} ${formatDuration(playback.durationMs)}`}
                    >
                      <strong>{formatDuration(displayedTimeMs)}</strong>
                      {' / '}{formatDuration(playback.durationMs)}
                    </span>
                  </div>

                  <div className="results-player-transport-group">
                    <Button
                      variant="secondary"
                      isDisabled={controlsDisabled}
                      onPress={restart}
                    >
                      <Icon name="refresh" size={16} />
                      {t('results.replay.restart')}
                    </Button>
                    {document.fullscreenEnabled && (
                      <Button
                        ref={fullscreenButtonRef}
                        variant="secondary"
                        aria-pressed={isFullscreen}
                        isDisabled={controlsDisabled}
                        onPress={() => void toggleFullscreen()}
                      >
                        {isFullscreen
                          ? t('results.replay.exitFullscreen')
                          : t('results.replay.fullscreen')}
                      </Button>
                    )}
                  </div>
                </div>

                {fullscreenError && (
                  <span className="text-xs text-danger" role="status">
                    {fullscreenError}
                  </span>
                )}
              </div>

              <div className="results-player-security">
                <Icon name="shield" size={15} />
                <strong>{t('results.replay.sandboxed')}</strong>
              </div>
            </div>
          </div>
        </Tabs.Panel>
      )}
    </Tabs>
  );
}
