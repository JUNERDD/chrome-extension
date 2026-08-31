import {
  Alert,
  Button,
  Card,
  Chip,
  Description,
  Kbd,
  Label,
  ListBox,
  Select,
  Spinner,
  Typography,
} from '@heroui/react';
import { useCallback, useEffect, useMemo, useState, type PropsWithChildren } from 'react';
import { browser } from 'wxt/browser';
import {
  resolveLocale,
  translateMessage,
  useI18n,
  type LanguagePreference,
} from '../../src/i18n';
import { hasRuntimeCapability } from '../../src/messaging';
import type { SessionCommand } from '../../src/messaging';
import {
  cleanupExpiredSessions,
  listAssets,
  listEvents,
  listSessions,
  loadCurrentSessionState,
  type StoredSession,
} from '../../src/storage';
import { Brand } from '../../src/ui/components';
import { compactShortcut, formatBytes, formatDate } from '../../src/ui/format';
import { Icon } from '../../src/ui/icons';
import { sendRuntimeRequest } from '../../src/ui/runtime';

type CommandName = Extract<SessionCommand, 'record' | 'pause' | 'resume' | 'stop'>;

interface CommandBinding {
  name: CommandName;
  description: string;
  shortcut: string;
}

interface RetentionSnapshot {
  sessions: Array<StoredSession<Record<string, unknown>>>;
  totalBytes: number;
  activeSessionId: string | null;
}

const COMMAND_ORDER: readonly CommandName[] = ['record', 'pause', 'resume', 'stop'];

function objectString(value: unknown, key: string): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === 'string' ? candidate : null;
}

async function measureRetention(): Promise<RetentionSnapshot> {
  const [sessions, currentState] = await Promise.all([
    listSessions<Record<string, unknown>>(),
    loadCurrentSessionState<Record<string, unknown>>(),
  ]);

  let totalBytes = 0;
  for (const session of sessions) {
    const [events, assets] = await Promise.all([listEvents(session.id), listAssets(session.id)]);
    totalBytes += assets.reduce((sum, asset) => sum + asset.bytes.byteLength, 0);
    totalBytes += new TextEncoder().encode(JSON.stringify(events)).byteLength;
  }

  const currentStatus = objectString(currentState, 'status');
  const currentSessionId = objectString(currentState, 'sessionId');
  const activeStatuses = new Set(['recording', 'paused', 'interrupted', 'finalizing']);
  return {
    sessions,
    totalBytes,
    activeSessionId: currentStatus && activeStatuses.has(currentStatus) ? currentSessionId : null,
  };
}

function isLanguagePreference(value: unknown): value is LanguagePreference {
  return value === 'system' || value === 'en' || value === 'zh-CN';
}

export function OptionsApp() {
  const {
    t,
    locale,
    ready,
    languagePreference,
    setLanguagePreference,
    systemLanguage,
  } = useI18n();
  const [commands, setCommands] = useState<CommandBinding[] | null>(null);
  const [retention, setRetention] = useState<RetentionSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [languageBusy, setLanguageBusy] = useState(false);
  const [deleteArmed, setDeleteArmed] = useState(false);
  const [runtimeHistoryCommandsReady, setRuntimeHistoryCommandsReady] = useState(false);
  const [runtimeReloadRequired, setRuntimeReloadRequired] = useState(false);

  const commandLabel = useCallback(
    (name: CommandName) => t(`settings.shortcuts.command.${name}.label`),
    [t],
  );

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const [commandList, snapshot, runtimeResponse] = await Promise.all([
        browser.commands.getAll(),
        measureRetention(),
        sendRuntimeRequest({ type: 'GET_STATE' }),
      ]);
      const byName = new Map(commandList.map((item) => [item.name, item]));
      setCommands(
        COMMAND_ORDER.map((name) => ({
          name,
          description: t(`settings.shortcuts.command.${name}.detail`),
          shortcut: byName.get(name)?.shortcut ?? '',
        })),
      );
      setRetention(snapshot);
      const runtimeIsCurrent = runtimeResponse.ok &&
        hasRuntimeCapability(runtimeResponse, 'deleteSession');
      setRuntimeHistoryCommandsReady(runtimeIsCurrent);
      setRuntimeReloadRequired(runtimeResponse.ok && !runtimeIsCurrent);
      if (!runtimeResponse.ok) setError(t('settings.alert.error.detail'));
    } catch {
      setError(t('settings.alert.error.detail'));
    }
  }, [t]);

  useEffect(() => {
    document.documentElement.lang = locale;
    document.title = `${t('settings.title')} — ${t('common.appName')}`;
  }, [locale, t]);

  useEffect(() => {
    if (!ready) return undefined;
    queueMicrotask(() => void refresh());
    const handleFocus = () => void refresh();
    window.addEventListener('focus', handleFocus);
    return () => window.removeEventListener('focus', handleFocus);
  }, [ready, refresh]);

  useEffect(() => {
    if (!deleteArmed) return undefined;
    const timer = window.setTimeout(() => setDeleteArmed(false), 7_000);
    return () => window.clearTimeout(timer);
  }, [deleteArmed]);

  const unbound = useMemo(
    () => commands?.filter((command) => !command.shortcut).length ?? 0,
    [commands],
  );
  const latestSession = useMemo(
    () => retention?.sessions.reduce<StoredSession<Record<string, unknown>> | null>(
      (latest, session) => !latest || session.updatedAt > latest.updatedAt ? session : latest,
      null,
    ) ?? null,
    [retention],
  );
  const deletableCount = useMemo(
    () => retention?.sessions.filter((session) => session.id !== retention.activeSessionId).length ?? 0,
    [retention],
  );

  const openShortcutManager = async () => {
    try {
      await browser.tabs.create({ url: 'chrome://extensions/shortcuts' });
    } catch {
      setError(t('settings.shortcuts.openManagerError'));
    }
  };

  const changeLanguage = async (preference: LanguagePreference) => {
    setLanguageBusy(true);
    setError(null);
    try {
      await setLanguagePreference(preference);
      const nextLocale = resolveLocale(preference, systemLanguage);
      setNotice(translateMessage(nextLocale, 'settings.language.saved'));
    } catch {
      setError(t('settings.language.saveFailed'));
    } finally {
      setLanguageBusy(false);
    }
  };

  const cleanExpired = async () => {
    setBusy(true);
    setError(null);
    try {
      const deleted = await cleanupExpiredSessions();
      setNotice(
        deleted.length
          ? t('settings.storage.expiredRemoved', { count: deleted.length })
          : t('settings.storage.expiredNone'),
      );
      await refresh();
    } catch {
      setError(t('settings.storage.cleanupFailed'));
    } finally {
      setBusy(false);
    }
  };

  const deleteRetained = async () => {
    if (!runtimeHistoryCommandsReady) {
      if (runtimeReloadRequired) setError(t('settings.storage.runtimeOutdated.detail'));
      return;
    }
    if (!deleteArmed) {
      setDeleteArmed(true);
      return;
    }
    if (!retention) return;
    setBusy(true);
    setError(null);
    try {
      const deletable = retention.sessions.filter((session) => session.id !== retention.activeSessionId);
      const responses = await Promise.all(
        deletable.map((session) => sendRuntimeRequest({
          type: 'DELETE_SESSION',
          sessionId: session.id,
        })),
      );
      const rejection = responses.find((response) => !response.ok);
      if (rejection && !rejection.ok) throw new Error(rejection.error);
      setNotice(
        retention.activeSessionId
          ? t('settings.storage.deletedProtected', { count: deletable.length })
          : t('settings.storage.deleted', { count: deletable.length }),
      );
      setDeleteArmed(false);
      await refresh();
    } catch {
      setError(t('settings.storage.deleteFailed'));
    } finally {
      setBusy(false);
    }
  };

  if (!ready) {
    return (
      <main className="grid min-h-screen place-items-center bg-background px-4 text-foreground">
        <div className="flex items-center gap-3" role="status">
          <Spinner size="sm" aria-label={t('common.loading')} />
          <Typography.Paragraph color="muted" size="sm">
            {t('common.loading')}
          </Typography.Paragraph>
        </div>
      </main>
    );
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-20 border-b border-separator bg-background">
        <div className="mx-auto flex min-h-16 w-full max-w-5xl items-center justify-between gap-4 px-4 sm:px-6">
          <Brand label={t('common.appName')} />
          <Chip color="success" size="sm" variant="soft">
            <Chip.Label>{t('common.localOnly')}</Chip.Label>
          </Chip>
        </div>
      </header>

      <main className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6 sm:py-12">
        <header className="max-w-2xl">
          <Typography className="font-mono text-accent" type="body-xs" weight="medium">
            {t('settings.eyebrow')}
          </Typography>
          <Typography.Heading className="mt-2" level={1}>
            {t('settings.title')}
          </Typography.Heading>
          <Typography.Paragraph className="mt-3" color="muted" size="sm">
            {t('settings.description')}
          </Typography.Paragraph>
        </header>

        {(error || notice || runtimeReloadRequired) && (
          <div className="mt-6 grid gap-3">
            {error && (
              <SettingsAlert status="danger" title={t('settings.alert.error.title')}>
                {error}
              </SettingsAlert>
            )}
            {notice && (
              <SettingsAlert status="success" title={t('settings.alert.maintenance.title')}>
                {notice}
              </SettingsAlert>
            )}
            {runtimeReloadRequired && (
              <div className="grid gap-2">
                <SettingsAlert
                  status="warning"
                  title={t('settings.storage.runtimeOutdated.title')}
                >
                  {t('settings.storage.runtimeOutdated.detail')}
                </SettingsAlert>
                <Button variant="secondary" onPress={() => browser.runtime.reload()}>
                  <Icon name="refresh" size={16} />
                  {t('settings.storage.runtimeOutdated.action')}
                </Button>
              </div>
            )}
          </div>
        )}

        <div className="mt-8 grid gap-4">
          <Card aria-labelledby="language-heading">
            <Card.Header className="gap-1">
              <Card.Title
                id="language-heading"
                render={(props) => <h2 {...props} />}
              >
                {t('settings.language.heading')}
              </Card.Title>
              <Card.Description>{t('settings.language.description')}</Card.Description>
            </Card.Header>
            <Card.Content className="max-w-lg">
              <Select
                fullWidth
                isDisabled={languageBusy}
                value={languagePreference}
                onChange={(value) => {
                  if (isLanguagePreference(value)) void changeLanguage(value);
                }}
              >
                <Label>{t('settings.language.label')}</Label>
                <Select.Trigger>
                  <Select.Value />
                  <Select.Indicator />
                </Select.Trigger>
                {languagePreference === 'system' && (
                  <Description>{t('settings.language.systemDetail', { language: systemLanguage })}</Description>
                )}
                <Select.Popover>
                  <ListBox>
                    <ListBox.Item id="system" textValue={t('settings.language.system')}>
                      <Label>{t('settings.language.system')}</Label>
                      <ListBox.ItemIndicator />
                    </ListBox.Item>
                    <ListBox.Item id="en" textValue={t('settings.language.en')}>
                      <Label>{t('settings.language.en')}</Label>
                      <ListBox.ItemIndicator />
                    </ListBox.Item>
                    <ListBox.Item id="zh-CN" textValue={t('settings.language.zhCN')}>
                      <Label>{t('settings.language.zhCN')}</Label>
                      <ListBox.ItemIndicator />
                    </ListBox.Item>
                  </ListBox>
                </Select.Popover>
              </Select>
            </Card.Content>
          </Card>

          <Card aria-labelledby="shortcuts-heading">
            <Card.Header className="gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="grid gap-1">
                <Card.Title
                  id="shortcuts-heading"
                  render={(props) => <h2 {...props} />}
                >
                  {t('settings.shortcuts.heading')}
                </Card.Title>
                <Card.Description>{t('settings.shortcuts.description')}</Card.Description>
              </div>
              <Chip color={unbound > 0 ? 'warning' : 'success'} size="sm" variant="soft">
                <Chip.Label>
                  {commands
                    ? t('settings.shortcuts.assigned', { assigned: COMMAND_ORDER.length - unbound })
                    : t('settings.shortcuts.loading')}
                </Chip.Label>
              </Chip>
            </Card.Header>
            <Card.Content className="gap-3">
              {!commands ? (
                <LoadingRow label={t('settings.shortcuts.loading')} />
              ) : (
                <div className="grid gap-2">
                  {commands.map((command) => (
                    <Card key={command.name} variant="secondary">
                      <Card.Content className="flex-row items-center justify-between gap-4">
                        <div className="min-w-0">
                          <Card.Title>{commandLabel(command.name)}</Card.Title>
                          <Card.Description>{command.description}</Card.Description>
                        </div>
                        <Kbd>
                          {command.shortcut
                            ? compactShortcut(command.shortcut)
                            : t('common.unbound')}
                        </Kbd>
                      </Card.Content>
                    </Card>
                  ))}
                </div>
              )}
            </Card.Content>
            <Card.Footer className="flex-col items-stretch gap-3 sm:flex-row sm:justify-between">
              {unbound > 0 && (
                <Chip color="warning" variant="soft">
                  <Icon name="warning" size={15} />
                  <Chip.Label>{t('settings.shortcuts.unbound', { count: unbound })}</Chip.Label>
                </Chip>
              )}
              <Button
                variant="primary"
                {...(unbound === 0 ? { className: 'sm:ml-auto' } : {})}
                onPress={() => void openShortcutManager()}
              >
                {t('settings.shortcuts.openManager')}
                <Icon name="arrow-up-right" size={16} />
              </Button>
            </Card.Footer>
          </Card>

          <Card aria-labelledby="storage-heading">
            <Card.Header className="gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="grid gap-1">
                <Card.Title
                  id="storage-heading"
                  render={(props) => <h2 {...props} />}
                >
                  {t('settings.storage.heading')}
                </Card.Title>
                <Card.Description>{t('settings.storage.intro')}</Card.Description>
              </div>
              {retention?.activeSessionId && (
                <Chip color="success" size="sm" variant="soft">
                  <Chip.Label>{t('settings.storage.activeProtected')}</Chip.Label>
                </Chip>
              )}
            </Card.Header>
            <Card.Content className="gap-3">
              {!retention ? (
                <LoadingRow label={t('settings.storage.loading')} />
              ) : (
                <dl
                  className="grid gap-2 sm:grid-cols-3"
                  aria-label={t('settings.storage.heading')}
                >
                  <MetricCard
                    label={t('settings.storage.sessions')}
                    value={retention.sessions.length.toLocaleString(locale)}
                  />
                  <MetricCard
                    label={t('settings.storage.measured')}
                    value={formatBytes(retention.totalBytes)}
                  />
                  <MetricCard
                    label={t('settings.storage.rule.latest')}
                    value={latestSession
                      ? formatDate(latestSession.updatedAt, locale, t('common.unavailable'))
                      : t('common.unavailable')}
                  />
                </dl>
              )}
            </Card.Content>
            <Card.Footer className="flex-col items-stretch gap-2 sm:flex-row sm:flex-wrap sm:justify-end">
              <Button variant="ghost" isDisabled={busy} onPress={() => void refresh()}>
                <Icon name="refresh" size={16} />
                {t('common.refresh')}
              </Button>
              <Button variant="secondary" isDisabled={busy} onPress={() => void cleanExpired()}>
                {t('settings.storage.cleanup')}
              </Button>
              <Button
                variant={deleteArmed ? 'danger' : 'danger-soft'}
                isDisabled={
                  busy || !runtimeHistoryCommandsReady || !retention || deletableCount === 0
                }
                onPress={() => void deleteRetained()}
              >
                <Icon name="erase" size={16} />
                {deleteArmed ? t('settings.storage.confirmDelete') : t('settings.storage.delete')}
              </Button>
            </Card.Footer>
          </Card>
        </div>

        <footer className="flex flex-col gap-2 py-8 sm:flex-row sm:items-center sm:justify-between">
          <Typography.Paragraph color="muted" size="xs">
            {t('settings.footer')}
          </Typography.Paragraph>
          <Typography className="font-mono" color="muted" type="body-xs">
            V{browser.runtime.getManifest().version}
          </Typography>
        </footer>
      </main>
    </div>
  );
}

function SettingsAlert({
  children,
  status,
  title,
}: PropsWithChildren<{ status: 'danger' | 'success' | 'warning'; title: string }>) {
  return (
    <Alert
      status={status}
      {...(status === 'danger'
        ? { role: 'alert' as const }
        : { role: 'status' as const, 'aria-live': 'polite' as const })}
    >
      <Alert.Indicator />
      <Alert.Content>
        <Alert.Title>{title}</Alert.Title>
        <Alert.Description>{children}</Alert.Description>
      </Alert.Content>
    </Alert>
  );
}

function LoadingRow({ label }: { label: string }) {
  return (
    <div className="flex min-h-24 items-center justify-center gap-3" role="status">
      <Spinner size="sm" />
      <Typography.Paragraph color="muted" size="sm">{label}</Typography.Paragraph>
    </div>
  );
}

function MetricCard({ label, value }: { label: string; value: string }) {
  return (
    <Card variant="secondary">
      <Card.Description render={(props) => <dt {...props} />}>{label}</Card.Description>
      <Card.Title
        className="break-words font-mono"
        render={(props) => <dd {...props} />}
      >
        {value}
      </Card.Title>
    </Card>
  );
}
