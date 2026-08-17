import { useEffect, useRef, useState } from 'react';
import type { Replayer } from '@rrweb/replay';
import { InstrumentButton, Notice } from './components';
import { formatDuration } from './format';
import { sanitizeRrwebEventsForReplay } from './replay-sanitizer';
import type { ReplaySegmentData } from './trace-adapter';

export function ReplayPanel({ segments }: { segments: ReplaySegmentData[] }) {
  const [selectedId, setSelectedId] = useState(segments[0]?.id ?? '');
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const replayerRef = useRef<Replayer | null>(null);
  const selected = segments.find((segment) => segment.id === selectedId) ?? segments[0];

  useEffect(() => {
    let cancelled = false;
    const root = rootRef.current;
    replayerRef.current?.destroy();
    replayerRef.current = null;
    if (root) root.replaceChildren();
    if (!root || !selected) return undefined;

    const events = sanitizeRrwebEventsForReplay(selected.events);
    if (events.length < 2) {
      queueMicrotask(() => setError('This segment does not contain enough valid rrweb events to reconstruct a page.'));
      return undefined;
    }

    void import('@rrweb/replay')
      .then(({ Replayer: RrwebReplayer }) => {
        if (cancelled) return;
        try {
          const replayer = new RrwebReplayer(events, {
            root,
            skipInactive: true,
            showWarning: true,
            showDebug: false,
            triggerFocus: false,
            UNSAFE_replayCanvas: false,
            mouseTail: false,
            pauseAnimation: true,
            useVirtualDom: true,
            insertStyleRules: [
              '*,*::before,*::after{animation:none!important;transition:none!important}',
              'video,audio{visibility:hidden!important}',
            ],
            logger: {
              log: () => undefined,
              warn: (...items) => console.warn('[Bugtrace replay]', ...items),
            },
          });
          if (replayer.iframe.sandbox.contains('allow-scripts')) {
            replayer.destroy();
            throw new Error('Replay sandbox unexpectedly enabled scripts.');
          }
          replayer.iframe.referrerPolicy = 'no-referrer';
          replayer.disableInteract();
          replayerRef.current = replayer;
          setError(null);
          setPlaying(false);
        } catch (caught) {
          setError(caught instanceof Error ? caught.message : 'rrweb could not reconstruct this segment.');
        }
      })
      .catch((caught: unknown) => {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : 'rrweb replay support could not be loaded.');
        }
      });

    return () => {
      cancelled = true;
      replayerRef.current?.destroy();
      replayerRef.current = null;
    };
  }, [selected]);

  const togglePlayback = () => {
    const replayer = replayerRef.current;
    if (!replayer) return;
    try {
      if (playing) replayer.pause();
      else replayer.play();
      setPlaying(!playing);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Playback failed.');
      setPlaying(false);
    }
  };

  const restart = () => {
    const replayer = replayerRef.current;
    if (!replayer) return;
    try {
      replayer.pause(0);
      replayer.play(0);
      setPlaying(true);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Replay could not restart.');
    }
  };

  if (segments.length === 0) {
    return (
      <Notice tone="info" title="Semantic evidence remains available">
        No replayable rrweb segment was retained. Use the numbered semantic steps and other evidence above.
      </Notice>
    );
  }

  return (
    <div className="replay-panel">
      <div className="replay-panel__rail" aria-label="rrweb segments">
        {segments.map((segment, index) => (
          <button
            type="button"
            key={segment.id}
            className={segment.id === selected?.id ? 'is-active' : ''}
            aria-pressed={segment.id === selected?.id}
            onClick={() => setSelectedId(segment.id)}
          >
            <span className="mono">SEG {String(index + 1).padStart(2, '0')}</span>
            <strong>{segment.eventCount.toLocaleString()} events</strong>
            <small className="mono">+{formatDuration(segment.startedAtOffsetMs)}</small>
          </button>
        ))}
      </div>
      <div className="replay-panel__stage">
        <div className="replay-panel__toolbar">
          <div>
            <span className="mono">SANDBOXED SUPPORTING EVIDENCE</span>
            <small>Canvas off · external resources stripped · interaction blocked · page scripts inert</small>
          </div>
          <div>
            <InstrumentButton icon={playing ? 'pause' : 'play'} disabled={Boolean(error)} onClick={togglePlayback}>
              {playing ? 'Pause' : 'Play'}
            </InstrumentButton>
            <InstrumentButton icon="refresh" disabled={Boolean(error)} onClick={restart}>
              Restart
            </InstrumentButton>
          </div>
        </div>
        {error && (
          <div className="replay-panel__error">
            <Notice tone="warning" title="Visual reconstruction unavailable">
              {error} The semantic trace remains normative and can still be copied or exported.
            </Notice>
          </div>
        )}
        <div className={error ? 'replay-panel__mount is-unavailable' : 'replay-panel__mount'} ref={rootRef} />
      </div>
    </div>
  );
}
