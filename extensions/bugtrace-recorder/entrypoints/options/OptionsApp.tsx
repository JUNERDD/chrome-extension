import { useCallback, useEffect, useMemo, useState } from 'react';
import { browser } from 'wxt/browser';
import type { RuntimeResponse, SessionCommand } from '../../src/messaging';
import {
  cleanupExpiredSessions,
  deleteSession,
  listAssets,
  listEvents,
  listSessions,
  loadCurrentSessionState,
  type StoredSession,
} from '../../src/storage';
import {
  Brand,
  InstrumentButton,
  LoadingPlate,
  Notice,
  Reading,
  SectionHeading,
  StatusBeacon,
} from '../../src/ui/components';
import { compactShortcut, formatBytes, formatDate } from '../../src/ui/format';
import { Icon } from '../../src/ui/icons';

type CommandName = Extract<SessionCommand, 'record' | 'pause' | 'resume' | 'stop'>;

interface CommandBinding {
  name: CommandName;
  description: string;
  shortcut: string;
}

interface RetentionSnapshot {
  sessions: Array<StoredSession<Record<string, unknown>>>;
  totalBytes: number;
  eventCount: number;
  assetCount: number;
  currentSessionId: string | null;
  activeSessionId: string | null;
  quotaUsage: number | null;
  quota: number | null;
}

const COMMAND_ORDER: readonly CommandName[] = ['record', 'pause', 'resume', 'stop'];
const COMMAND_LABEL: Record<CommandName, string> = {
  record: 'Start recording',
  pause: 'Pause capture',
  resume: 'Continue capture',
  stop: 'Stop and review',
};

function objectString(value: unknown, key: string): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === 'string' ? candidate : null;
}

async function measureRetention(): Promise<RetentionSnapshot> {
  const [sessions, currentState, estimate] = await Promise.all([
    listSessions<Record<string, unknown>>(),
    loadCurrentSessionState<Record<string, unknown>>(),
    navigator.storage.estimate().catch(() => ({ usage: undefined, quota: undefined })),
  ]);

  let totalBytes = 0;
  let eventCount = 0;
  let assetCount = 0;
  for (const session of sessions) {
    const [events, assets] = await Promise.all([listEvents(session.id), listAssets(session.id)]);
    eventCount += events.length;
    assetCount += assets.length;
    totalBytes += assets.reduce((sum, asset) => sum + asset.bytes.byteLength, 0);
    totalBytes += new TextEncoder().encode(JSON.stringify(events)).byteLength;
  }

  const currentStatus = objectString(currentState, 'status');
  const currentSessionId = objectString(currentState, 'sessionId');
  const activeStatuses = new Set(['recording', 'paused', 'interrupted', 'finalizing']);
  return {
    sessions,
    totalBytes,
    eventCount,
    assetCount,
    currentSessionId,
    activeSessionId: currentStatus && activeStatuses.has(currentStatus) ? currentSessionId : null,
    quotaUsage: estimate.usage ?? null,
    quota: estimate.quota ?? null,
  };
}

export function OptionsApp() {
  const [commands, setCommands] = useState<CommandBinding[] | null>(null);
  const [retention, setRetention] = useState<RetentionSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleteArmed, setDeleteArmed] = useState(false);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const [commandList, snapshot] = await Promise.all([browser.commands.getAll(), measureRetention()]);
      const byName = new Map(commandList.map((item) => [item.name, item]));
      setCommands(
        COMMAND_ORDER.map((name) => ({
          name,
          description: byName.get(name)?.description ?? COMMAND_LABEL[name],
          shortcut: byName.get(name)?.shortcut ?? '',
        })),
      );
      setRetention(snapshot);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to read recorder settings.');
    }
  }, []);

  useEffect(() => {
    queueMicrotask(() => void refresh());
  }, [refresh]);

  useEffect(() => {
    if (!deleteArmed) return undefined;
    const timer = window.setTimeout(() => setDeleteArmed(false), 7_000);
    return () => window.clearTimeout(timer);
  }, [deleteArmed]);

  const unbound = useMemo(() => commands?.filter((command) => !command.shortcut).length ?? 0, [commands]);

  const openShortcutManager = async () => {
    try {
      await browser.tabs.create({ url: 'chrome://extensions/shortcuts' });
    } catch {
      setError('Chrome blocked the shortcuts page. Open chrome://extensions/shortcuts manually.');
    }
  };

  const cleanExpired = async () => {
    setBusy(true);
    setError(null);
    try {
      const deleted = await cleanupExpiredSessions();
      setNotice(deleted.length ? `Removed ${deleted.length} expired session${deleted.length === 1 ? '' : 's'}.` : 'No expired sessions found.');
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Expired session cleanup failed.');
    } finally {
      setBusy(false);
    }
  };

  const deleteRetained = async () => {
    if (!deleteArmed) {
      setDeleteArmed(true);
      return;
    }
    if (!retention) return;
    setBusy(true);
    setError(null);
    try {
      const deletable = retention.sessions.filter((session) => session.id !== retention.activeSessionId);
      const deletesCurrentCompleted =
        retention.currentSessionId !== null &&
        retention.activeSessionId === null &&
        deletable.some((session) => session.id === retention.currentSessionId);
      if (deletesCurrentCompleted) {
        const response = (await browser.runtime.sendMessage({
          type: 'SESSION_COMMAND',
          command: 'discard',
        })) as RuntimeResponse;
        if (!response.ok) throw new Error(response.error);
      }
      await Promise.all(
        deletable
          .filter((session) => !deletesCurrentCompleted || session.id !== retention.currentSessionId)
          .map((session) => deleteSession(session.id)),
      );
      setNotice(
        retention.activeSessionId
          ? `Removed ${deletable.length} retained session${deletable.length === 1 ? '' : 's'}; the active recording was protected.`
          : `Removed ${deletable.length} retained session${deletable.length === 1 ? '' : 's'}.`,
      );
      setDeleteArmed(false);
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Local data deletion failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="options-shell">
      <header className="options-masthead">
        <Brand />
        <div className="options-masthead__meta">
          <StatusBeacon label="Local instrument" tone="success" />
          <span className="mono">CONFIG / V0.1</span>
        </div>
      </header>

      <section className="options-intro">
        <span className="eyebrow mono">FLIGHT RECORDER CONFIGURATION</span>
        <h1>Visible controls.<br /><em>Fixed privacy rails.</em></h1>
        <p>
          Bugtrace records a scoped browser reproduction for testers and agents. Capture remains local;
          privacy-critical omissions cannot be disabled here.
        </p>
      </section>

      {error && (
        <div className="options-alert">
          <Notice tone="danger" title="Configuration readout error">{error}</Notice>
        </div>
      )}
      {notice && (
        <div className="options-alert">
          <Notice tone="success" title="Local maintenance complete">{notice}</Notice>
        </div>
      )}

      <div className="options-grid">
        <section className="options-panel options-panel--commands">
          <SectionHeading index="01" aside={commands ? `${4 - unbound}/4 assigned` : 'reading'}>
            Command bindings
          </SectionHeading>
          {!commands ? (
            <LoadingPlate label="Reading Chrome commands…" />
          ) : (
            <>
              <div className="command-list">
                {commands.map((command, index) => (
                  <div className="command-row" key={command.name}>
                    <span className="command-row__number mono">{String(index + 1).padStart(2, '0')}</span>
                    <div>
                      <strong>{COMMAND_LABEL[command.name]}</strong>
                      <small>{command.description}</small>
                    </div>
                    <kbd className={command.shortcut ? '' : 'command-row__unbound'}>
                      {compactShortcut(command.shortcut)}
                    </kbd>
                  </div>
                ))}
              </div>
              {unbound > 0 && (
                <Notice title={`${unbound} command${unbound === 1 ? '' : 's'} need a binding`}>
                  Chrome owns extension shortcuts. Assign missing keys and resolve any conflicts in its shortcut manager.
                </Notice>
              )}
              <InstrumentButton icon="arrow-up-right" intent="primary" onClick={() => void openShortcutManager()}>
                Open Chrome shortcut manager
              </InstrumentButton>
              <p className="manual-route mono">FALLBACK ROUTE · chrome://extensions/shortcuts</p>
            </>
          )}
        </section>

        <section className="options-panel options-panel--privacy">
          <SectionHeading index="02" aside="non-negotiable">
            Privacy boundary
          </SectionHeading>
          <div className="rail-list">
            <PrivacyRail code="LOCAL" title="Device-only evidence" detail="No telemetry, upload, cloud sync, or clipboard reading." />
            <PrivacyRail code="MASK" title="All input values redacted" detail="Type and coarse length may remain; entered values never do." />
            <PrivacyRail code="META" title="Network metadata only" detail="No request or response body, cookie, Authorization, or sensitive header." />
            <PrivacyRail code="SAFE" title="Untrusted page evidence" detail="Page text is escaped and labelled so agents never treat it as instruction." />
          </div>
        </section>

        <section className="options-panel options-panel--permissions">
          <SectionHeading index="03" aside="manifest v3">
            Permission ledger
          </SectionHeading>
          <div className="permission-table">
            <PermissionRow name="activeTab" use="User-authorized, redacted viewport screenshots" />
            <PermissionRow name="storage" use="Resumable state and local evidence log" />
            <PermissionRow name="webNavigation" use="Document, SPA, hash, and history transitions" />
            <PermissionRow name="webRequest" use="Redacted timing/status metadata; no body access" />
            <PermissionRow name="http(s)://*/*" use="Dormant recorder on approved in-scope pages" warning />
          </div>
          <Notice tone="info" title="Explicit exclusions">
            No debugger, downloads, unlimitedStorage, clipboard, incognito, file://, browser UI, or OS-level capture.
          </Notice>
        </section>

        <section className="options-panel options-panel--retention">
          <SectionHeading index="04" aside="local maintenance">
            Retention & capacity
          </SectionHeading>
          {!retention ? (
            <LoadingPlate label="Measuring retained evidence…" />
          ) : (
            <>
              <div className="retention-readings">
                <Reading label="Sessions" value={retention.sessions.length.toString().padStart(2, '0')} />
                <Reading label="Measured evidence" value={formatBytes(retention.totalBytes)} />
                <Reading label="Objects" value={(retention.eventCount + retention.assetCount).toLocaleString()} />
              </div>
              <div className="capacity-meter" aria-label="Browser storage utilization">
                <div>
                  <span>Browser storage estimate</span>
                  <strong className="mono">
                    {retention.quotaUsage === null ? 'UNAVAILABLE' : formatBytes(retention.quotaUsage)}
                    {retention.quota === null ? '' : ` / ${formatBytes(retention.quota)}`}
                  </strong>
                </div>
                <span className="capacity-meter__track">
                  <i
                    style={{
                      width: `${retention.quota && retention.quotaUsage ? Math.min(100, (retention.quotaUsage / retention.quota) * 100) : 0}%`,
                    }}
                  />
                </span>
              </div>
              <dl className="retention-rules">
                <div><dt>Default TTL</dt><dd>24 hours from last activity</dd></div>
                <div><dt>Target bundle</dt><dd>&lt; 10 MiB</dd></div>
                <div><dt>Capacity warning</dt><dd>25 MiB</dd></div>
                <div><dt>Evidence hard rail</dt><dd>50 MiB; semantic core retained</dd></div>
                {retention.sessions.at(-1) && (
                  <div><dt>Latest local update</dt><dd>{formatDate(retention.sessions.at(-1)?.updatedAt ?? '')}</dd></div>
                )}
              </dl>
              <div className="maintenance-actions">
                <InstrumentButton icon="refresh" disabled={busy} onClick={() => void cleanExpired()}>
                  Remove expired
                </InstrumentButton>
                <InstrumentButton
                  icon="erase"
                  intent={deleteArmed ? 'danger' : 'quiet'}
                  disabled={busy || retention.sessions.length === 0}
                  onClick={() => void deleteRetained()}
                >
                  {deleteArmed ? 'Confirm deletion' : 'Delete retained data'}
                </InstrumentButton>
              </div>
              {retention.activeSessionId && (
                <p className="active-protection mono">
                  <Icon name="shield" size={13} /> ACTIVE SESSION {retention.activeSessionId.slice(0, 8)}… IS PROTECTED
                </p>
              )}
            </>
          )}
        </section>
      </div>

      <footer className="options-footer mono">
        <span>BUGTRACE RECORDER</span>
        <span>LOCAL EVIDENCE SYSTEM</span>
        <span>SETTINGS ARE SAVED BY CHROME</span>
      </footer>
    </main>
  );
}

function PrivacyRail({ code, title, detail }: { code: string; title: string; detail: string }) {
  return (
    <div className="privacy-rail">
      <span className="privacy-rail__code mono">{code}</span>
      <div><strong>{title}</strong><p>{detail}</p></div>
      <Icon name="check" size={17} />
    </div>
  );
}

function PermissionRow({ name, use, warning = false }: { name: string; use: string; warning?: boolean }) {
  return (
    <div className="permission-row">
      <code>{name}</code>
      <span>{use}</span>
      <span className={warning ? 'permission-row__host' : ''}>{warning ? 'HOST' : 'API'}</span>
    </div>
  );
}
