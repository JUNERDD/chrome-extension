import { useEffect, useMemo, useState } from 'react';
import { browser } from 'wxt/browser';
import type { RecorderViewState, SessionCommand } from '../../src/messaging';
import {
  Brand,
  InstrumentButton,
  LoadingPlate,
  Notice,
  Reading,
  StatusBeacon,
} from '../../src/ui/components';
import { compactShortcut, formatDuration } from '../../src/ui/format';
import { Icon } from '../../src/ui/icons';
import { openExtensionPage, useLiveDuration, useRecorderState } from '../../src/ui/runtime';

type CommandShortcuts = Partial<Record<SessionCommand, string>>;

const STATUS_COPY: Record<RecorderViewState['status'], { label: string; detail: string }> = {
  idle: { label: 'Ready', detail: 'Awaiting a supported HTTP(S) tab' },
  recording: { label: 'Recording', detail: 'Evidence collectors are live' },
  paused: { label: 'Paused', detail: 'No page evidence is being persisted' },
  finalizing: { label: 'Finalizing', detail: 'Flushing scoped tabs and sealing evidence' },
  completed: { label: 'Complete', detail: 'Local evidence is ready for review' },
  interrupted: { label: 'Interrupted', detail: 'Explicit action is required after runtime restart' },
};

function toneForStatus(status: RecorderViewState['status']) {
  if (status === 'recording') return 'recording' as const;
  if (status === 'paused') return 'paused' as const;
  if (status === 'completed') return 'success' as const;
  if (status === 'interrupted' || status === 'finalizing') return 'warning' as const;
  return 'neutral' as const;
}

function commandLabel(command: SessionCommand, busyCommand: SessionCommand | null): string {
  if (busyCommand !== command) {
    return {
      record: 'Start recording',
      pause: 'Pause',
      resume: 'Resume',
      stop: 'Stop & review',
      discard: 'Discard',
      screenshot: 'Capture viewport',
    }[command];
  }
  return command === 'stop' ? 'Sealing…' : 'Working…';
}

export function PopupApp() {
  const { state, error, busyCommand, command, refresh, receivedAt } = useRecorderState();
  const duration = useLiveDuration(state, receivedAt);
  const [shortcuts, setShortcuts] = useState<CommandShortcuts>({});
  const [commandReadError, setCommandReadError] = useState(false);
  const [discardArmed, setDiscardArmed] = useState(false);

  useEffect(() => {
    let live = true;
    void browser.commands
      .getAll()
      .then((commands) => {
        if (!live) return;
        const next: CommandShortcuts = {};
        for (const item of commands) {
          if (
            item.name === 'record' ||
            item.name === 'pause' ||
            item.name === 'resume' ||
            item.name === 'stop'
          ) {
            next[item.name] = item.shortcut ?? '';
          }
        }
        setShortcuts(next);
      })
      .catch(() => {
        if (live) setCommandReadError(true);
      });
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    if (!discardArmed) return undefined;
    const timer = window.setTimeout(() => setDiscardArmed(false), 7_000);
    return () => window.clearTimeout(timer);
  }, [discardArmed]);

  const missingShortcutCount = useMemo(
    () => ['record', 'pause', 'resume', 'stop'].filter((name) => !shortcuts[name as SessionCommand]).length,
    [shortcuts],
  );

  const openResults = async () => {
    if (!state?.sessionId) return;
    await openExtensionPage('/results.html', new URLSearchParams({ session: state.sessionId }));
  };

  const discardSession = async () => {
    if (!discardArmed) {
      setDiscardArmed(true);
      return;
    }
    if (await command('discard')) setDiscardArmed(false);
  };

  return (
    <main className="popup-shell">
      <header className="popup-header">
        <Brand />
        <button
          type="button"
          className="icon-button"
          aria-label="Open recorder settings"
          title="Recorder settings"
          onClick={() => void browser.runtime.openOptionsPage()}
        >
          <Icon name="gear" size={17} />
        </button>
      </header>

      {!state ? (
        <>
          <LoadingPlate label="Contacting recorder core…" />
          {error && (
            <div className="popup-edge-notice">
              <Notice tone="danger" title="Recorder unavailable">
                {error}
              </Notice>
              <InstrumentButton icon="refresh" onClick={() => void refresh()}>
                Retry
              </InstrumentButton>
            </div>
          )}
        </>
      ) : (
        <>
          <section className={`recorder-face recorder-face--${state.status}`} aria-labelledby="recorder-status">
            <div className="recorder-face__status">
              <StatusBeacon label={STATUS_COPY[state.status].label} tone={toneForStatus(state.status)} />
              <span className="recorder-face__revision mono">REV {String(state.revision).padStart(3, '0')}</span>
            </div>
            <div className="timer" aria-label={`Active recording duration ${formatDuration(duration)}`}>
              <span className="timer__digits mono">{formatDuration(duration)}</span>
              <span className="timer__unit mono">ACTIVE</span>
            </div>
            <p>{STATUS_COPY[state.status].detail}</p>
            <div className="tick-strip" aria-hidden="true">
              {Array.from({ length: 31 }, (_, index) => <i key={index} />)}
            </div>
          </section>

          <section className="telemetry" aria-label="Capture telemetry">
            <Reading label="Scoped tabs" value={String(state.scopedTabCount).padStart(2, '0')} />
            <Reading label="Events" value={state.eventCount.toLocaleString()} />
            <Reading label="Evidence gaps" value={String(state.gapCount).padStart(2, '0')} />
          </section>

          <section className="control-deck" aria-label="Recorder controls">
            {state.status === 'idle' && (
              <InstrumentButton
                className="control-deck__wide"
                icon="record"
                intent="danger"
                keyHint={compactShortcut(shortcuts.record)}
                disabled={busyCommand !== null}
                onClick={() => void command('record')}
              >
                {commandLabel('record', busyCommand)}
              </InstrumentButton>
            )}

            {state.status === 'recording' && (
              <>
                <InstrumentButton
                  icon="pause"
                  intent="primary"
                  keyHint={compactShortcut(shortcuts.pause)}
                  disabled={busyCommand !== null}
                  onClick={() => void command('pause')}
                >
                  {commandLabel('pause', busyCommand)}
                </InstrumentButton>
                <InstrumentButton
                  icon="stop"
                  keyHint={compactShortcut(shortcuts.stop)}
                  disabled={busyCommand !== null}
                  onClick={() => void command('stop')}
                >
                  {commandLabel('stop', busyCommand)}
                </InstrumentButton>
                <InstrumentButton
                  className="control-deck__wide control-deck__secondary"
                  icon="camera"
                  disabled={busyCommand !== null}
                  onClick={() => void command('screenshot')}
                >
                  Capture supporting viewport
                </InstrumentButton>
              </>
            )}

            {(state.status === 'paused' || state.status === 'interrupted') && (
              <>
                <InstrumentButton
                  icon="play"
                  intent="amber"
                  keyHint={compactShortcut(shortcuts.resume)}
                  disabled={busyCommand !== null}
                  onClick={() => void command('resume')}
                >
                  {commandLabel('resume', busyCommand)}
                </InstrumentButton>
                <InstrumentButton
                  icon="stop"
                  keyHint={compactShortcut(shortcuts.stop)}
                  disabled={busyCommand !== null}
                  onClick={() => void command('stop')}
                >
                  {commandLabel('stop', busyCommand)}
                </InstrumentButton>
              </>
            )}

            {state.status === 'finalizing' && (
              <div className="finalizing-rack control-deck__wide" role="status">
                <span />
                <div>
                  <strong>Sealing local evidence</strong>
                  <small>Waiting for scoped documents; gaps will be declared on timeout.</small>
                </div>
              </div>
            )}

            {state.status === 'completed' && (
              <>
                <InstrumentButton
                  icon="archive"
                  intent="primary"
                  onClick={() => void openResults()}
                >
                  Review evidence
                </InstrumentButton>
                <InstrumentButton
                  icon="record"
                  keyHint={compactShortcut(shortcuts.record)}
                  disabled={busyCommand !== null}
                  onClick={() => void command('record')}
                >
                  New recording
                </InstrumentButton>
              </>
            )}

            {['recording', 'paused', 'interrupted', 'completed'].includes(state.status) && (
              <InstrumentButton
                className="control-deck__wide"
                icon="erase"
                intent={discardArmed ? 'danger' : 'quiet'}
                disabled={busyCommand !== null}
                onClick={() => void discardSession()}
              >
                {discardArmed ? 'Confirm permanent deletion' : 'Discard local session'}
              </InstrumentButton>
            )}
          </section>

          <div className="popup-notices">
            {state.status === 'interrupted' && (
              <Notice title="Recorder runtime restarted">
                Recording did not silently resume. Continue explicitly or stop with the evidence captured so far.
              </Notice>
            )}
            {state.warning && (
              <Notice tone="warning" title="Coverage warning">
                {state.warning}
              </Notice>
            )}
            {error && (
              <Notice tone="danger" title="Control rejected">
                {error}
              </Notice>
            )}
            {(missingShortcutCount > 0 || commandReadError) && (
              <button
                type="button"
                className="shortcut-warning"
                onClick={() => void browser.runtime.openOptionsPage()}
              >
                <Icon name="warning" size={14} />
                <span>
                  {commandReadError
                    ? 'Shortcut status unavailable'
                    : `${missingShortcutCount} recorder shortcut${missingShortcutCount === 1 ? '' : 's'} unbound`}
                </span>
                <Icon name="arrow-up-right" size={13} />
              </button>
            )}
          </div>

          <footer className="popup-footer">
            <span>LOCAL ONLY</span>
            <span>INPUTS REDACTED</span>
            <span>NO BODY CAPTURE</span>
          </footer>
        </>
      )}
    </main>
  );
}
