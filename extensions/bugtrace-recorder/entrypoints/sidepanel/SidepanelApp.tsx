import {
  Alert,
  AlertDialog,
  Button,
  Card,
  Chip,
  Dropdown,
  EmptyState,
  Input,
  Kbd,
  Label,
  Modal,
  ProgressBar,
  ScrollShadow,
  Spinner,
  TextField,
  Tooltip,
} from '@heroui/react';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import { browser } from 'wxt/browser';
import type { PersistedRecorderSession } from '../../src/background/types';
import { useI18n } from '../../src/i18n';
import {
  findRecorderWarning,
  shouldShowLongRecordingWarning,
  type RecorderViewState,
  type RuntimeErrorCode,
  type SessionCommand,
} from '../../src/messaging';
import { listSessions, type StoredSession } from '../../src/storage';
import { Brand } from '../../src/ui/components';
import { compactShortcut, formatDate, formatDuration } from '../../src/ui/format';
import { Icon } from '../../src/ui/icons';
import {
  openExtensionPage,
  sendRuntimeRequest,
  useLiveDuration,
  useRecorderState,
} from '../../src/ui/runtime';

type CommandShortcuts = Partial<Record<SessionCommand, string>>;
type RecorderStatus = RecorderViewState['status'];
type AlertStatus = 'default' | 'accent' | 'success' | 'warning' | 'danger';
type HistorySession = StoredSession<PersistedRecorderSession>;
type SessionLabels = Record<string, string>;

const VISIBLE_COMMANDS: SessionCommand[] = ['record', 'pause', 'resume', 'stop'];
const SESSION_LABELS_KEY = 'bugtrace.session-labels';
const MAX_SESSION_LABEL_LENGTH = 72;
const CLEAR_ALL_BUSY_KEY = '__clear-all-recordings__';
const ACTIVE_STATUSES = new Set<RecorderStatus>([
  'recording',
  'paused',
  'interrupted',
  'finalizing',
]);

function errorNoticeFor(errorCode?: RuntimeErrorCode) {
  switch (errorCode) {
    case 'capture_client_unavailable':
      return {
        title: 'sidepanel.notice.captureClientUnavailable.title',
        detail: 'sidepanel.notice.captureClientUnavailable.detail',
      } as const;
    case 'screenshot_authorization_required':
      return {
        title: 'sidepanel.notice.screenshotAuthorizationRequired.title',
        detail: 'sidepanel.notice.screenshotAuthorizationRequired.detail',
      } as const;
    case 'screenshot_outside_scope':
      return {
        title: 'sidepanel.notice.screenshotOutsideScope.title',
        detail: 'sidepanel.notice.screenshotOutsideScope.detail',
      } as const;
    case 'screenshot_document_changed':
      return {
        title: 'sidepanel.notice.screenshotDocumentChanged.title',
        detail: 'sidepanel.notice.screenshotDocumentChanged.detail',
      } as const;
    case 'screenshot_failed':
      return {
        title: 'sidepanel.notice.screenshotFailed.title',
        detail: 'sidepanel.notice.screenshotFailed.detail',
      } as const;
    default:
      return {
        title: 'sidepanel.notice.controlRejected',
        detail: 'sidepanel.notice.controlRejectedDetail',
      } as const;
  }
}

function statusColor(status: RecorderStatus) {
  if (status === 'recording' || status === 'interrupted') return 'danger' as const;
  if (status === 'paused' || status === 'finalizing') return 'warning' as const;
  return 'default' as const;
}

function formatRecorderClock(milliseconds: number): string {
  const duration = formatDuration(milliseconds);
  return duration.length === 5 ? `00:${duration}` : duration;
}

function completedHistory(sessions: HistorySession[]): HistorySession[] {
  const now = Date.now();
  return sessions
    .filter((session) => {
      const expiresAt = Date.parse(session.expiresAt);
      return session.state.recorder.status === 'completed' &&
        (Number.isNaN(expiresAt) || expiresAt > now);
    })
    .sort((left, right) => {
      const leftEnded = left.state.recorder.endedAtMs ?? Date.parse(left.updatedAt);
      const rightEnded = right.state.recorder.endedAtMs ?? Date.parse(right.updatedAt);
      return rightEnded - leftEnded;
    });
}

function normalizeSessionLabels(value: unknown): SessionLabels {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const labels: SessionLabels = {};
  for (const [sessionId, candidate] of Object.entries(value)) {
    if (typeof candidate !== 'string') continue;
    const label = candidate.trim().slice(0, MAX_SESSION_LABEL_LENGTH);
    if (label) labels[sessionId] = label;
  }
  return labels;
}

async function readSessionLabels(): Promise<SessionLabels> {
  const stored = await browser.storage.local.get(SESSION_LABELS_KEY);
  return normalizeSessionLabels(stored[SESSION_LABELS_KEY]);
}

async function writeSessionLabel(sessionId: string, label: string | null): Promise<SessionLabels> {
  const next = await readSessionLabels();
  if (label) next[sessionId] = label.trim().slice(0, MAX_SESSION_LABEL_LENGTH);
  else delete next[sessionId];
  await browser.storage.local.set({ [SESSION_LABELS_KEY]: next });
  return next;
}

async function removeSessionLabels(sessionIds: readonly string[]): Promise<SessionLabels> {
  const next = await readSessionLabels();
  for (const sessionId of sessionIds) delete next[sessionId];
  await browser.storage.local.set({ [SESSION_LABELS_KEY]: next });
  return next;
}

function menuTriggerId(sessionId: string): string {
  return `history-menu-trigger-${sessionId}`;
}

function historyErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof Error) || !error.message.trim()) return fallback;
  return error.message.trim().slice(0, 240);
}

function RecorderAlert({
  children,
  status,
  title,
}: {
  children: ReactNode;
  status: AlertStatus;
  title: string;
}) {
  return (
    <Alert status={status}>
      <Alert.Indicator />
      <Alert.Content>
        <Alert.Title>{title}</Alert.Title>
        <Alert.Description>{children}</Alert.Description>
      </Alert.Content>
    </Alert>
  );
}

function TooltipAction({
  children,
  isDisabled = false,
  isTooltipOpen,
  label,
  onPress,
  onTooltipOpenChange,
  tooltip,
}: {
  children: ReactNode;
  isDisabled?: boolean;
  isTooltipOpen: boolean;
  label: string;
  onPress: () => void;
  onTooltipOpenChange: (isOpen: boolean) => void;
  tooltip: string;
}) {
  return (
    <Tooltip isOpen={isTooltipOpen} onOpenChange={onTooltipOpenChange}>
      <Button
        isIconOnly
        aria-disabled={isDisabled}
        aria-label={label}
        size="sm"
        variant="ghost"
        onBlur={() => onTooltipOpenChange(false)}
        onFocus={() => onTooltipOpenChange(true)}
        onMouseEnter={() => onTooltipOpenChange(true)}
        onMouseLeave={() => onTooltipOpenChange(false)}
        onPress={() => {
          if (isDisabled) return;
          onTooltipOpenChange(false);
          onPress();
        }}
      >
        {children}
      </Button>
      <Tooltip.Content className="bg-white text-black" placement="bottom end">
        {tooltip}
      </Tooltip.Content>
    </Tooltip>
  );
}

export function SidepanelApp() {
  const { t, locale, ready } = useI18n();
  const {
    state,
    error,
    busyCommand,
    command,
    refresh,
    receivedAt,
    runtimeHistoryCommandsReady,
    runtimeReloadRequired,
  } = useRecorderState();
  const liveDuration = useLiveDuration(state, receivedAt);
  const [shortcuts, setShortcuts] = useState<CommandShortcuts>({});
  const [discardArmedFor, setDiscardArmedFor] = useState<string | null>(null);
  const [history, setHistory] = useState<HistorySession[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyError, setHistoryError] = useState(false);
  const [historyActionError, setHistoryActionError] = useState<string | null>(null);
  const [sessionLabels, setSessionLabels] = useState<SessionLabels>({});
  const [openHeaderTooltip, setOpenHeaderTooltip] = useState<'latest' | 'settings' | null>(null);
  const [openHistoryTooltipFor, setOpenHistoryTooltipFor] = useState<string | null>(null);
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [deletingSessionId, setDeletingSessionId] = useState<string | null>(null);
  const [isClearAllOpen, setIsClearAllOpen] = useState(false);
  const [draftSessionLabel, setDraftSessionLabel] = useState('');
  const [historyBusyFor, setHistoryBusyFor] = useState<string | null>(null);
  const pendingHistoryFocus = useRef<string | null>(null);

  const refreshHistory = useCallback(async () => {
    try {
      const [sessions, labels] = await Promise.all([
        listSessions<PersistedRecorderSession>(),
        readSessionLabels(),
      ]);
      const liveSessionIds = new Set(sessions.map((session) => session.id));
      const liveLabels = Object.fromEntries(
        Object.entries(labels).filter(([sessionId]) => liveSessionIds.has(sessionId)),
      );
      setHistory(completedHistory(sessions));
      setSessionLabels(liveLabels);
      setHistoryError(false);
      if (Object.keys(liveLabels).length !== Object.keys(labels).length) {
        void browser.storage.local.set({ [SESSION_LABELS_KEY]: liveLabels });
      }
    } catch {
      setHistoryError(true);
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  useEffect(() => {
    document.documentElement.lang = locale;
    document.title = t('common.appName');
  }, [locale, t]);

  useEffect(() => {
    let live = true;
    void browser.commands
      .getAll()
      .then((commands) => {
        if (!live) return;
        const next: CommandShortcuts = {};
        for (const item of commands) {
          if (VISIBLE_COMMANDS.includes(item.name as SessionCommand)) {
            next[item.name as SessionCommand] = item.shortcut ?? '';
          }
        }
        setShortcuts(next);
      })
      .catch(() => {
        if (live) setShortcuts({});
      });
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    queueMicrotask(() => void refreshHistory());
  }, [refreshHistory, state?.revision, state?.sessionId, state?.status]);

  useEffect(() => {
    const handleFocus = () => void refreshHistory();
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') void refreshHistory();
    };
    window.addEventListener('focus', handleFocus);
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      window.removeEventListener('focus', handleFocus);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [refreshHistory]);

  useEffect(() => {
    const handleStorageChange = (
      changes: Record<string, { newValue?: unknown }>,
      areaName: string,
    ) => {
      if (areaName !== 'local' || !changes[SESSION_LABELS_KEY]) return;
      setSessionLabels(normalizeSessionLabels(changes[SESSION_LABELS_KEY].newValue));
    };
    browser.storage.onChanged.addListener(handleStorageChange);
    return () => browser.storage.onChanged.removeListener(handleStorageChange);
  }, []);

  useEffect(() => {
    if (!discardArmedFor) return undefined;
    const timer = window.setTimeout(() => setDiscardArmedFor(null), 7_000);
    return () => window.clearTimeout(timer);
  }, [discardArmedFor]);

  useEffect(() => {
    const targetId = pendingHistoryFocus.current;
    if (!targetId) return;
    const target = document.getElementById(targetId);
    if (!target) return;
    pendingHistoryFocus.current = null;
    target.focus();
  }, [deletingSessionId, editingSessionId, history, isClearAllOpen, sessionLabels]);

  const latestHistory = history[0] ?? null;
  const displayedStatus: RecorderStatus = state?.status === 'completed'
    ? 'idle'
    : (state?.status ?? 'idle');
  const displayedDuration = state?.status === 'completed' ? 0 : liveDuration;
  const isActive = state ? ACTIVE_STATUSES.has(state.status) : false;
  const captureGapWarning = findRecorderWarning(state, 'capture_gaps');
  const captureGapCount = captureGapWarning?.count ?? state?.gapCount ?? 0;
  const hasCaptureGapWarning = isActive && captureGapCount > 0;
  const hasRuntimeInterruptedWarning = state?.status === 'interrupted' ||
    Boolean(findRecorderWarning(state, 'runtime_interrupted'));
  const hasLongRecordingWarning = isActive && shouldShowLongRecordingWarning(state, liveDuration);
  const discardArmed = Boolean(state?.sessionId && discardArmedFor === state.sessionId);
  const errorNotice = errorNoticeFor(error?.errorCode);

  const shortcutHint = (nextCommand: SessionCommand): string => {
    const shortcut = shortcuts[nextCommand];
    return shortcut ? compactShortcut(shortcut) : t('common.unbound');
  };
  const commandLabel = (nextCommand: SessionCommand): string => {
    if (busyCommand !== nextCommand) return t(`sidepanel.action.${nextCommand}`);
    return nextCommand === 'stop'
      ? t('sidepanel.action.sealing')
      : t('sidepanel.action.working');
  };
  const openResults = async (sessionId: string) => {
    await openExtensionPage('/results.html', new URLSearchParams({ session: sessionId }));
  };
  const discardSession = async () => {
    if (!state?.sessionId) return;
    if (!discardArmed) {
      setDiscardArmedFor(state.sessionId);
      return;
    }
    if (await command('discard')) setDiscardArmedFor(null);
  };
  const defaultSessionLabel = (sessionId: string): string =>
    t('sidepanel.history.defaultName', { session: sessionId.slice(0, 6).toUpperCase() });
  const startRenamingSession = (sessionId: string) => {
    setDraftSessionLabel(sessionLabels[sessionId] ?? defaultSessionLabel(sessionId));
    setEditingSessionId(sessionId);
    setHistoryActionError(null);
  };
  const cancelRenamingSession = (sessionId: string) => {
    pendingHistoryFocus.current = menuTriggerId(sessionId);
    setEditingSessionId(null);
    setDraftSessionLabel('');
  };
  const saveSessionRename = async (event: FormEvent<HTMLFormElement>, sessionId: string) => {
    event.preventDefault();
    const label = draftSessionLabel.trim().slice(0, MAX_SESSION_LABEL_LENGTH);
    if (!label) return;
    setHistoryBusyFor(sessionId);
    setHistoryActionError(null);
    try {
      const nextLabels = await writeSessionLabel(sessionId, label);
      pendingHistoryFocus.current = menuTriggerId(sessionId);
      setSessionLabels(nextLabels);
      setEditingSessionId(null);
      setDraftSessionLabel('');
    } catch (error) {
      setHistoryActionError(historyErrorMessage(
        error,
        t('sidepanel.history.actionFailedDetail'),
      ));
    } finally {
      setHistoryBusyFor(null);
    }
  };
  const cancelDeletingSession = (sessionId: string) => {
    pendingHistoryFocus.current = menuTriggerId(sessionId);
    setDeletingSessionId(null);
  };
  const deleteHistorySession = async (sessionId: string) => {
    if (!runtimeHistoryCommandsReady) {
      setDeletingSessionId(null);
      if (runtimeReloadRequired) {
        setHistoryActionError(t('sidepanel.history.runtimeOutdated.detail'));
      }
      return;
    }
    setHistoryBusyFor(sessionId);
    setHistoryActionError(null);
    const sessionIndex = history.findIndex((session) => session.id === sessionId);
    const fallbackSessionId =
      history[sessionIndex + 1]?.id ?? history[sessionIndex - 1]?.id ?? null;
    try {
      const response = await sendRuntimeRequest({ type: 'DELETE_SESSION', sessionId });
      if (!response.ok) throw new Error(response.error);
      pendingHistoryFocus.current = fallbackSessionId
        ? menuTriggerId(fallbackSessionId)
        : 'history-heading';
      setHistory((current) => current.filter((session) => session.id !== sessionId));
      setDeletingSessionId(null);
      if (editingSessionId === sessionId) setEditingSessionId(null);
      void writeSessionLabel(sessionId, null)
        .then(setSessionLabels)
        .catch((error: unknown) => setHistoryActionError(historyErrorMessage(
          error,
          t('sidepanel.history.actionFailedDetail'),
        )));
      await refresh();
    } catch (error) {
      setHistoryActionError(historyErrorMessage(
        error,
        t('sidepanel.history.actionFailedDetail'),
      ));
      await Promise.all([refresh(), refreshHistory()]).catch(() => undefined);
    } finally {
      setHistoryBusyFor(null);
    }
  };
  const cancelClearAllHistory = () => {
    pendingHistoryFocus.current = 'history-clear-all';
    setIsClearAllOpen(false);
  };
  const clearAllHistory = async () => {
    if (!runtimeHistoryCommandsReady) {
      setIsClearAllOpen(false);
      if (runtimeReloadRequired) {
        setHistoryActionError(t('sidepanel.history.runtimeOutdated.detail'));
      }
      return;
    }
    const sessionIds = history.map((session) => session.id);
    if (sessionIds.length === 0) return;
    const deletedSessionIds: string[] = [];
    setHistoryBusyFor(CLEAR_ALL_BUSY_KEY);
    setHistoryActionError(null);
    try {
      for (const sessionId of sessionIds) {
        const response = await sendRuntimeRequest({ type: 'DELETE_SESSION', sessionId });
        if (!response.ok) throw new Error(response.error);
        deletedSessionIds.push(sessionId);
      }
      setSessionLabels(await removeSessionLabels(deletedSessionIds));
      setHistory([]);
      pendingHistoryFocus.current = 'history-heading';
      setIsClearAllOpen(false);
      await Promise.all([refresh(), refreshHistory()]);
    } catch (error) {
      if (deletedSessionIds.length > 0) {
        setHistory((current) => current.filter(
          (session) => !deletedSessionIds.includes(session.id),
        ));
        try {
          setSessionLabels(await removeSessionLabels(deletedSessionIds));
        } catch {
          // A later history refresh also removes labels for sessions that no longer exist.
        }
      }
      pendingHistoryFocus.current = 'history-heading';
      setIsClearAllOpen(false);
      setHistoryActionError(historyErrorMessage(
        error,
        t('sidepanel.history.actionFailedDetail'),
      ));
      await Promise.all([refresh(), refreshHistory()]).catch(() => undefined);
    } finally {
      setHistoryBusyFor(null);
    }
  };

  if (!ready || !state) {
    return (
      <main className="grid h-full min-w-0 grid-rows-[3.5rem_minmax(0,1fr)] overflow-hidden bg-background text-foreground">
        <header className="flex items-center border-b border-separator px-4">
          <Brand label={t('common.appName')} />
        </header>
        <div className="grid min-h-0 place-items-center p-4">
          <Card className="w-full">
            <Card.Content className="items-center gap-3 text-center">
              <Spinner aria-hidden="true" size="sm" />
              <span className="text-sm text-muted">{t('common.loading')}</span>
              {error && (
                <>
                  <RecorderAlert status="danger" title={t('sidepanel.notice.recorderUnavailable')}>
                    {t('sidepanel.notice.recorderUnavailableDetail')}
                  </RecorderAlert>
                  <Button fullWidth variant="secondary" onPress={() => void refresh()}>
                    <Icon name="refresh" size={17} />
                    {t('sidepanel.action.retry')}
                  </Button>
                </>
              )}
            </Card.Content>
          </Card>
        </div>
      </main>
    );
  }

  const editingSession = editingSessionId
    ? history.find((session) => session.id === editingSessionId) ?? null
    : null;
  const deletingSession = deletingSessionId
    ? history.find((session) => session.id === deletingSessionId) ?? null
    : null;
  const deletingSessionLabel = deletingSession
    ? sessionLabels[deletingSession.id] ?? defaultSessionLabel(deletingSession.id)
    : '';

  return (
    <main className="grid h-full min-w-0 grid-rows-[3.5rem_minmax(0,1fr)] overflow-hidden bg-background text-foreground">
      <header className="relative z-10 flex min-w-0 items-center justify-between gap-3 border-b border-separator px-3">
        <Brand label={t('common.appName')} />
        <nav className="flex items-center gap-1" aria-label={t('sidepanel.section.destinations')}>
          <TooltipAction
            isDisabled={!latestHistory}
            isTooltipOpen={openHeaderTooltip === 'latest'}
            label={t('sidepanel.aria.openLatest')}
            tooltip={latestHistory
              ? t('sidepanel.aria.openLatest')
              : t('sidepanel.aria.noLatest')}
            onPress={() => latestHistory && void openResults(latestHistory.id)}
            onTooltipOpenChange={(isOpen) => {
              setOpenHeaderTooltip((current) => isOpen
                ? 'latest'
                : (current === 'latest' ? null : current));
            }}
          >
            <Icon name="archive" size={17} />
          </TooltipAction>
          <TooltipAction
            isTooltipOpen={openHeaderTooltip === 'settings'}
            label={t('sidepanel.aria.openSettings')}
            tooltip={t('sidepanel.aria.openSettings')}
            onPress={() => void browser.runtime.openOptionsPage()}
            onTooltipOpenChange={(isOpen) => {
              setOpenHeaderTooltip((current) => isOpen
                ? 'settings'
                : (current === 'settings' ? null : current));
            }}
          >
            <Icon name="gear" size={17} />
          </TooltipAction>
        </nav>
      </header>

      <div className="flex min-h-0 flex-col gap-4 overflow-hidden p-3">
          <Card className="shrink-0" aria-labelledby="recorder-state-heading">
            <Card.Header className="flex-row items-center justify-between gap-3">
              <Chip color={statusColor(displayedStatus)} size="sm" variant="soft">
                {t(`sidepanel.status.${displayedStatus}.label`)}
              </Chip>
              {isActive && (
                <span className="font-mono text-xs text-muted">
                  {t('common.revision', { revision: String(state.revision).padStart(3, '0') })}
                </span>
              )}
            </Card.Header>

            <Card.Content className="gap-5">
              <div className="space-y-2">
                <h1
                  id="recorder-state-heading"
                  className="font-mono text-5xl leading-none font-semibold tracking-tight tabular-nums"
                >
                  {formatRecorderClock(displayedDuration)}
                </h1>
                <p className="text-sm text-muted">
                  {t(`sidepanel.status.${displayedStatus}.detail`)}
                </p>
              </div>

              {isActive && (
                <dl
                  className="grid grid-cols-3 divide-x divide-separator"
                  aria-label={t('sidepanel.section.evidence')}
                >
                  <div className="min-w-0 px-2 first:ps-0">
                    <dt className="truncate text-xs text-muted">
                      {t('sidepanel.telemetry.events')}
                    </dt>
                    <dd className="mt-1 font-mono text-base font-medium tabular-nums">
                      {state.eventCount.toLocaleString(locale)}
                    </dd>
                  </div>
                  <div className="min-w-0 px-2">
                    <dt className="truncate text-xs text-muted">
                      {t('sidepanel.telemetry.tabs')}
                    </dt>
                    <dd className="mt-1 font-mono text-base font-medium tabular-nums">
                      {String(state.scopedTabCount).padStart(2, '0')}
                    </dd>
                  </div>
                  <div className="min-w-0 px-2 last:pe-0">
                    <dt className="truncate text-xs text-muted">
                      {t('sidepanel.telemetry.gaps')}
                    </dt>
                    <dd className={`mt-1 font-mono text-base font-medium tabular-nums${state.gapCount > 0 ? ' text-danger' : ''}`}>
                      {String(state.gapCount).padStart(2, '0')}
                    </dd>
                  </div>
                </dl>
              )}
            </Card.Content>

            <Card.Footer
              className="grid grid-cols-1 gap-2 min-[380px]:grid-cols-2"
              aria-label={t('sidepanel.section.controls')}
            >
              {(state.status === 'idle' || state.status === 'completed') && (
                <Button
                  fullWidth
                  className="min-[380px]:col-span-2"
                  isDisabled={busyCommand !== null}
                  size="lg"
                  variant="danger"
                  onPress={() => void command('record')}
                >
                  <Icon name="record" size={17} />
                  <span>{commandLabel('record')}</span>
                  <Kbd className="ms-auto">{shortcutHint('record')}</Kbd>
                </Button>
              )}

              {state.status === 'recording' && (
                <>
                  <Button
                    fullWidth
                    isDisabled={busyCommand !== null}
                    variant="primary"
                    onPress={() => void command('pause')}
                  >
                    <Icon name="pause" size={17} />
                    <span>{commandLabel('pause')}</span>
                    <Kbd className="ms-auto">{shortcutHint('pause')}</Kbd>
                  </Button>
                  <Button
                    fullWidth
                    isDisabled={busyCommand !== null}
                    variant="secondary"
                    onPress={() => void command('stop')}
                  >
                    <Icon name="stop" size={17} />
                    <span>{commandLabel('stop')}</span>
                    <Kbd className="ms-auto">{shortcutHint('stop')}</Kbd>
                  </Button>
                  <Button
                    fullWidth
                    className="min-[380px]:col-span-2"
                    isDisabled={busyCommand !== null}
                    size="sm"
                    variant="ghost"
                    onPress={() => void command('screenshot')}
                  >
                    <Icon name="camera" size={16} />
                    {commandLabel('screenshot')}
                  </Button>
                </>
              )}

              {(state.status === 'paused' || state.status === 'interrupted') && (
                <>
                  <Button
                    fullWidth
                    isDisabled={busyCommand !== null}
                    variant="primary"
                    onPress={() => void command('resume')}
                  >
                    <Icon name="play" size={17} />
                    <span>{commandLabel('resume')}</span>
                    <Kbd className="ms-auto">{shortcutHint('resume')}</Kbd>
                  </Button>
                  <Button
                    fullWidth
                    isDisabled={busyCommand !== null}
                    variant="secondary"
                    onPress={() => void command('stop')}
                  >
                    <Icon name="stop" size={17} />
                    <span>{commandLabel('stop')}</span>
                    <Kbd className="ms-auto">{shortcutHint('stop')}</Kbd>
                  </Button>
                </>
              )}

              {state.status === 'finalizing' && (
                <div className="space-y-3 py-2 min-[380px]:col-span-2">
                  <div>
                    <strong className="block text-sm font-medium">
                      {t('sidepanel.finalizing.title')}
                    </strong>
                    <small className="mt-1 block text-xs text-muted">
                      {t('sidepanel.finalizing.detail')}
                    </small>
                  </div>
                  <ProgressBar isIndeterminate aria-label={t('sidepanel.finalizing.title')} size="sm">
                    <ProgressBar.Track>
                      <ProgressBar.Fill />
                    </ProgressBar.Track>
                  </ProgressBar>
                </div>
              )}

              {['recording', 'paused', 'interrupted'].includes(state.status) && (
                <Button
                  fullWidth
                  className="min-[380px]:col-span-2"
                  isDisabled={busyCommand !== null}
                  size="sm"
                  variant={discardArmed ? 'danger' : 'ghost'}
                  onPress={() => void discardSession()}
                >
                  <Icon name="erase" size={16} />
                  {discardArmed ? t('sidepanel.action.confirmDiscard') : commandLabel('discard')}
                </Button>
              )}
            </Card.Footer>
          </Card>

          {(hasRuntimeInterruptedWarning || hasCaptureGapWarning || hasLongRecordingWarning || error) && (
            <div className="space-y-2">
              {hasRuntimeInterruptedWarning && (
                <RecorderAlert status="warning" title={t('sidepanel.notice.runtimeRestarted.title')}>
                  {t('sidepanel.notice.runtimeRestarted.detail')}
                </RecorderAlert>
              )}
              {hasCaptureGapWarning && (
                <RecorderAlert status="warning" title={t('sidepanel.notice.coverageWarning')}>
                  {t('sidepanel.notice.coverageWarning.detail', { count: captureGapCount })}
                </RecorderAlert>
              )}
              {hasLongRecordingWarning && (
                <RecorderAlert status="warning" title={t('sidepanel.notice.longRecording.title')}>
                  {t('sidepanel.notice.longRecording.detail')}
                </RecorderAlert>
              )}
              {error && (
                <RecorderAlert status="danger" title={t(errorNotice.title)}>
                  {t(errorNotice.detail)}
                </RecorderAlert>
              )}
            </div>
          )}

          <section
            className="flex min-h-0 flex-1 flex-col gap-3 pt-1"
            aria-labelledby="history-heading"
          >
            <div className="flex items-center justify-between gap-3 px-1">
              <h2 id="history-heading" className="text-base font-medium" tabIndex={-1}>
                {t('sidepanel.history.title')}
              </h2>
              <div className="flex shrink-0 items-center gap-2">
                <Chip size="sm" variant="soft">
                  {history.length.toLocaleString(locale)}
                </Chip>
                <Button
                  id="history-clear-all"
                  isDisabled={!runtimeHistoryCommandsReady || historyLoading || history.length === 0 || (
                    historyBusyFor !== null && historyBusyFor !== CLEAR_ALL_BUSY_KEY
                  )}
                  isPending={historyBusyFor === CLEAR_ALL_BUSY_KEY}
                  size="sm"
                  variant="danger-soft"
                  onPress={() => setIsClearAllOpen(true)}
                >
                  <Icon name="erase" size={15} />
                  {t('sidepanel.history.clearAll')}
                </Button>
              </div>
            </div>

            {runtimeReloadRequired && (
              <div className="space-y-2">
                <RecorderAlert
                  status="warning"
                  title={t('sidepanel.history.runtimeOutdated.title')}
                >
                  {t('sidepanel.history.runtimeOutdated.detail')}
                </RecorderAlert>
                <Button
                  fullWidth
                  variant="secondary"
                  onPress={() => browser.runtime.reload()}
                >
                  <Icon name="refresh" size={15} />
                  {t('sidepanel.history.runtimeOutdated.action')}
                </Button>
              </div>
            )}

            {historyLoading && (
              <div className="flex min-h-0 flex-1 items-center justify-center gap-2 text-sm text-muted" role="status">
                <Spinner aria-hidden="true" size="sm" />
                <span>{t('sidepanel.history.loading')}</span>
              </div>
            )}
            {!historyLoading && historyError && (
              <Card className="flex-1" variant="secondary">
                <Card.Content className="items-center gap-3 text-center">
                  <p className="text-sm text-muted">{t('sidepanel.history.loadFailed')}</p>
                  <Button size="sm" variant="secondary" onPress={() => void refreshHistory()}>
                    <Icon name="refresh" size={15} />
                    {t('common.retry')}
                  </Button>
                </Card.Content>
              </Card>
            )}
            {historyActionError && (
              <RecorderAlert status="danger" title={t('sidepanel.history.actionFailed')}>
                {historyActionError}
              </RecorderAlert>
            )}
            {!historyLoading && !historyError && history.length === 0 && (
              <Card className="flex-1" variant="secondary">
                <EmptyState className="flex min-h-28 flex-col items-center justify-center gap-2 text-center">
                  <Icon name="archive" size={20} />
                  <p>{t('sidepanel.history.empty')}</p>
                </EmptyState>
              </Card>
            )}
            {!historyLoading && !historyError && history.length > 0 && (
              <ScrollShadow
                hideScrollBar
                className="min-h-0 flex-1 overflow-y-auto pe-1"
                data-testid="history-scroll"
              >
              <ul className="grid list-none gap-3 p-0">
                {history.map((session) => {
                  const recorder = session.state.recorder;
                  const completedAt = formatDate(
                    recorder.endedAtMs ?? session.updatedAt,
                    locale,
                    t('common.unavailable'),
                  );
                  const completedDateTime = new Date(
                    recorder.endedAtMs ?? session.updatedAt,
                  ).toISOString();
                  const shortId = session.id.slice(0, 6).toUpperCase();
                  const sessionLabel = sessionLabels[session.id] ?? defaultSessionLabel(session.id);
                  const isBusy = historyBusyFor !== null;
                  return (
                    <li key={session.id}>
                      <Card className="isolate overflow-hidden" variant="secondary">
                        <Button
                          fullWidth
                          className="absolute inset-0 z-0 h-auto min-w-0"
                          isDisabled={isBusy}
                          variant="ghost"
                          aria-label={`${t('sidepanel.history.review')} · ${sessionLabel}`}
                          onPress={() => void openResults(session.id)}
                        />
                        <Card.Header className="pointer-events-none relative z-10 flex-row items-start justify-between gap-3">
                          <div className="min-w-0">
                            <Card.Title className="break-words">{sessionLabel}</Card.Title>
                            <Card.Description>
                              <time dateTime={completedDateTime}>{completedAt}</time>
                            </Card.Description>
                          </div>
                          <div className="flex shrink-0 items-center gap-1">
                            <Chip className="font-mono" size="sm" variant="soft">
                              {formatRecorderClock(recorder.activeDurationMs)}
                            </Chip>
                            <div className="pointer-events-auto">
                              <Tooltip
                                isOpen={openHistoryTooltipFor === session.id}
                                onOpenChange={(isOpen) => {
                                  setOpenHistoryTooltipFor((current) => isOpen
                                    ? session.id
                                    : (current === session.id ? null : current));
                                }}
                              >
                                <Dropdown
                                  onOpenChange={(isOpen) => {
                                    if (isOpen) setOpenHistoryTooltipFor(null);
                                  }}
                                >
                                  <Button
                                    isIconOnly
                                    id={menuTriggerId(session.id)}
                                    aria-label={`${t('sidepanel.history.menu')} · ${sessionLabel}`}
                                    isDisabled={isBusy}
                                    size="sm"
                                    variant="ghost"
                                    onBlur={() => setOpenHistoryTooltipFor((current) =>
                                      current === session.id ? null : current)}
                                    onFocus={() => setOpenHistoryTooltipFor(session.id)}
                                    onMouseEnter={() => setOpenHistoryTooltipFor(session.id)}
                                    onMouseLeave={() => setOpenHistoryTooltipFor((current) =>
                                      current === session.id ? null : current)}
                                    onPress={() => setOpenHistoryTooltipFor(null)}
                                  >
                                    <Icon name="more" size={17} />
                                  </Button>
                                  <Dropdown.Popover placement="bottom end">
                                    <Dropdown.Menu
                                      aria-label={`${t('sidepanel.history.menu')} · ${sessionLabel}`}
                                      onAction={(key) => {
                                        if (String(key) === 'rename') startRenamingSession(session.id);
                                        if (String(key) === 'delete') {
                                          setHistoryActionError(null);
                                          setDeletingSessionId(session.id);
                                        }
                                      }}
                                    >
                                      <Dropdown.Item
                                        id="rename"
                                        textValue={t('sidepanel.history.rename')}
                                      >
                                        <Icon name="edit" size={15} />
                                        <Label>{t('sidepanel.history.rename')}</Label>
                                      </Dropdown.Item>
                                      <Dropdown.Item
                                        id="delete"
                                        isDisabled={!runtimeHistoryCommandsReady}
                                        textValue={t('sidepanel.history.delete')}
                                        variant="danger"
                                      >
                                        <Icon name="erase" size={15} />
                                        <Label>{t('sidepanel.history.delete')}</Label>
                                      </Dropdown.Item>
                                    </Dropdown.Menu>
                                  </Dropdown.Popover>
                                </Dropdown>
                                <Tooltip.Content className="bg-white text-black" placement="left">
                                  {t('sidepanel.history.menu')}
                                </Tooltip.Content>
                              </Tooltip>
                            </div>
                          </div>
                        </Card.Header>
                        <Card.Content className="pointer-events-none relative z-10">
                          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
                            <span>
                              {session.state.eventCount.toLocaleString(locale)}{' '}
                              {t('sidepanel.telemetry.events')}
                            </span>
                            <span>
                              {session.state.gapCount.toLocaleString(locale)}{' '}
                              {t('sidepanel.telemetry.gaps')}
                            </span>
                            <span className="font-mono">#{shortId}</span>
                          </div>
                        </Card.Content>
                      </Card>
                    </li>
                  );
                })}
              </ul>
              </ScrollShadow>
            )}
          </section>
      </div>

      <Modal
        isOpen={Boolean(editingSession)}
        onOpenChange={(isOpen) => {
          if (!isOpen && editingSessionId) cancelRenamingSession(editingSessionId);
        }}
      >
        <Modal.Backdrop>
          <Modal.Container placement="center" size="sm">
            <Modal.Dialog>
              <Modal.Header>
                <Modal.Heading>{t('sidepanel.history.rename')}</Modal.Heading>
              </Modal.Header>
              <Modal.Body>
                {editingSession && (
                  <form
                    id={`rename-session-${editingSession.id}`}
                    onSubmit={(event) => void saveSessionRename(event, editingSession.id)}
                  >
                    <TextField
                      fullWidth
                      isRequired
                      value={draftSessionLabel}
                      onChange={setDraftSessionLabel}
                    >
                      <Label>{t('sidepanel.history.nameLabel')}</Label>
                      <Input autoFocus maxLength={MAX_SESSION_LABEL_LENGTH} />
                    </TextField>
                  </form>
                )}
              </Modal.Body>
              <Modal.Footer>
                <Button slot="close" variant="ghost">
                  {t('sidepanel.history.cancel')}
                </Button>
                <Button
                  type="submit"
                  form={`rename-session-${editingSession?.id ?? ''}`}
                  isDisabled={!draftSessionLabel.trim() || !editingSession}
                  isPending={Boolean(editingSession && historyBusyFor === editingSession.id)}
                  variant="primary"
                >
                  {t('sidepanel.history.save')}
                </Button>
              </Modal.Footer>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal>

      <AlertDialog
        isOpen={Boolean(deletingSession)}
        onOpenChange={(isOpen) => {
          if (!isOpen && deletingSessionId) cancelDeletingSession(deletingSessionId);
        }}
      >
        <AlertDialog.Backdrop>
          <AlertDialog.Container placement="center" size="sm">
            <AlertDialog.Dialog>
              <AlertDialog.Header>
                <AlertDialog.Icon status="danger" />
                <AlertDialog.Heading>{t('sidepanel.history.confirmDelete')}</AlertDialog.Heading>
              </AlertDialog.Header>
              <AlertDialog.Body>
                {deletingSession && t('sidepanel.history.deleteDetail', {
                  name: deletingSessionLabel,
                })}
              </AlertDialog.Body>
              <AlertDialog.Footer>
                <Button autoFocus slot="close" variant="ghost">
                  {t('sidepanel.history.cancel')}
                </Button>
                <Button
                  isDisabled={!deletingSession}
                  isPending={Boolean(deletingSession && historyBusyFor === deletingSession.id)}
                  variant="danger"
                  onPress={() => deletingSession && void deleteHistorySession(deletingSession.id)}
                >
                  {t('sidepanel.history.delete')}
                </Button>
              </AlertDialog.Footer>
            </AlertDialog.Dialog>
          </AlertDialog.Container>
        </AlertDialog.Backdrop>
      </AlertDialog>

      <AlertDialog
        isOpen={isClearAllOpen}
        onOpenChange={(isOpen) => {
          if (!isOpen && isClearAllOpen) cancelClearAllHistory();
        }}
      >
        <AlertDialog.Backdrop>
          <AlertDialog.Container placement="center" size="sm">
            <AlertDialog.Dialog>
              <AlertDialog.Header>
                <AlertDialog.Icon status="danger" />
                <AlertDialog.Heading>{t('sidepanel.history.clearAllTitle')}</AlertDialog.Heading>
              </AlertDialog.Header>
              <AlertDialog.Body>
                {t('sidepanel.history.clearAllDetail', { count: history.length })}
              </AlertDialog.Body>
              <AlertDialog.Footer>
                <Button autoFocus slot="close" variant="ghost">
                  {t('sidepanel.history.cancel')}
                </Button>
                <Button
                  isDisabled={history.length === 0}
                  isPending={historyBusyFor === CLEAR_ALL_BUSY_KEY}
                  variant="danger"
                  onPress={() => void clearAllHistory()}
                >
                  {t('sidepanel.history.confirmClearAll')}
                </Button>
              </AlertDialog.Footer>
            </AlertDialog.Dialog>
          </AlertDialog.Container>
        </AlertDialog.Backdrop>
      </AlertDialog>
    </main>
  );
}
