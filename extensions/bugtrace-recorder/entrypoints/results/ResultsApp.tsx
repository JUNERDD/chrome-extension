import {
  Alert,
  Button,
  Card,
  Chip,
  Description,
  Disclosure,
  Input,
  Label,
  Modal,
  Spinner,
  TextArea,
  TextField,
  Tooltip,
  Typography,
} from '@heroui/react';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PropsWithChildren,
} from 'react';
import { browser } from 'wxt/browser';
import {
  BugtraceArtifactConsistencyError,
  BugtraceValidationError,
  buildBugtraceZip,
  buildMarkdownReport,
  bugtraceZipBlob,
  SecretLeakError,
  validateTrace,
  type BugtraceReportFields,
  type BugtraceTrace,
  type CaptureCoverage,
  type CoverageArea,
  type ScreenshotRecord,
} from '../../src/artifact';
import { useI18n } from '../../src/i18n';
import { Brand } from '../../src/ui/components';
import { formatDate, formatDuration } from '../../src/ui/format';
import { Icon } from '../../src/ui/icons';
import { ReplayPanel } from '../../src/ui/replay-panel';
import { loadStoredTrace, type StoredTraceView } from '../../src/ui/trace-adapter';

type ActionState = 'idle' | 'copying' | 'copied' | 'building' | 'downloaded';
type ReportField = 'title' | 'summary' | 'preconditions' | 'expected' | 'actual' | 'notes';
type AlertStatus = 'default' | 'danger' | 'success' | 'warning';
type ArtifactAction = 'load_trace' | 'validate_trace' | 'copy_markdown' | 'download_zip';
type ArtifactStage =
  | 'read_local_trace'
  | 'validate_export_trace'
  | 'render_report'
  | 'write_clipboard'
  | 'assemble_bundle'
  | 'trigger_download';

interface ArtifactActionError {
  action: ArtifactAction;
  code: string;
  detail: string;
  source: string;
  stage: ArtifactStage;
}

const REPORT_FIELDS: ReadonlyArray<{ name: ReportField; rows: number }> = [
  { name: 'title', rows: 1 },
  { name: 'summary', rows: 3 },
  { name: 'preconditions', rows: 3 },
  { name: 'expected', rows: 3 },
  { name: 'actual', rows: 4 },
  { name: 'notes', rows: 4 },
];

const MAX_ACTION_ERROR_DETAIL_CHARACTERS = 800;
const MAX_ACTION_ERROR_SOURCE_CHARACTERS = 300;

function replaceDiagnosticControls(value: string): string {
  let result = '';
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    const allowedWhitespace = character === '\n' || character === '\r' || character === '\t';
    const control = (codePoint < 32 && !allowedWhitespace) || codePoint === 127;
    const bidiControl =
      (codePoint >= 0x202a && codePoint <= 0x202e) ||
      (codePoint >= 0x2066 && codePoint <= 0x2069);
    result += control || bidiControl ? '�' : character;
  }
  return result;
}

function fieldUpdate(
  fields: BugtraceReportFields,
  name: ReportField,
  value: string,
): BugtraceReportFields {
  return { ...fields, [name]: value };
}

function withScreenshotSelection(
  trace: BugtraceTrace,
  excluded: ReadonlySet<string>,
): BugtraceTrace {
  if (excluded.size === 0) return trace;
  const screenshots = trace.screenshots.filter((screenshot) => !excluded.has(screenshot.id));
  const omitted = trace.screenshots.length - screenshots.length;
  const reasons = [
    ...trace.coverage.screenshots.reasons,
    `${omitted} screenshot${omitted === 1 ? '' : 's'} excluded by the reviewer.`,
  ];
  return {
    ...trace,
    screenshots,
    coverage: {
      ...trace.coverage,
      screenshots: {
        ...trace.coverage.screenshots,
        status: screenshots.length === 0 ? 'off' : 'partial',
        reasons,
      },
    },
  };
}

function boundedErrorDetail(caught: unknown): string {
  if (!(caught instanceof Error)) return 'An unknown non-Error value was thrown.';
  const normalized = replaceDiagnosticControls(caught.message)
    .normalize('NFC')
    .replace(/\s+/gu, ' ')
    .trim();
  if (!normalized) return `${caught.name || 'Error'} without a diagnostic message.`;
  return normalized.length <= MAX_ACTION_ERROR_DETAIL_CHARACTERS
    ? normalized
    : `${normalized.slice(0, MAX_ACTION_ERROR_DETAIL_CHARACTERS)}…`;
}

function artifactErrorCode(caught: unknown): string {
  if (caught instanceof SecretLeakError) return 'sensitive_data_detected';
  if (caught instanceof BugtraceArtifactConsistencyError) return 'artifact_inconsistent';
  if (caught instanceof BugtraceValidationError) return 'trace_contract_invalid';
  if (caught instanceof DOMException) {
    if (caught.name === 'NotAllowedError') return 'operation_not_allowed';
    if (caught.name === 'AbortError') return 'operation_aborted';
    return `dom_${caught.name.replace(/Error$/u, '').replace(/([a-z])([A-Z])/gu, '$1_$2').toLowerCase() || 'error'}`;
  }
  if (caught instanceof ReferenceError) return 'runtime_reference_error';
  if (caught instanceof RangeError) return 'range_error';
  if (caught instanceof TypeError) return 'type_error';
  if (caught instanceof Error) {
    if (caught.message === 'This local session no longer exists or has expired.') {
      return 'session_not_found';
    }
    if (caught.message.startsWith('Trace declares present evidence without bundle data:')) {
      return 'evidence_resource_missing';
    }
    if (caught.message.startsWith('Trace evidence purpose mismatch for')) {
      return 'evidence_resource_mismatch';
    }
    if (caught.message.includes('SHA-256 is unavailable')) return 'crypto_unavailable';
    if (caught.message.includes('ZIP')) return 'zip_integrity_failed';
    return 'unexpected_error';
  }
  return 'non_error_thrown';
}

function artifactErrorSource(caught: unknown, fallback: string): string {
  const sources = caught instanceof SecretLeakError
    ? caught.findings.map((finding) => finding.source)
    : caught instanceof BugtraceArtifactConsistencyError || caught instanceof BugtraceValidationError
      ? caught.issues.map((issue) => issue.instancePath || '/')
      : [];
  const uniqueSources = [...new Set(sources)];
  const value = replaceDiagnosticControls(uniqueSources.length > 0 ? uniqueSources.join(', ') : fallback)
    .replace(/\s+/gu, ' ')
    .trim();
  return value.length <= MAX_ACTION_ERROR_SOURCE_CHARACTERS
    ? value
    : `${value.slice(0, MAX_ACTION_ERROR_SOURCE_CHARACTERS)}…`;
}

function describeArtifactActionError(
  caught: unknown,
  action: ArtifactAction,
  stage: ArtifactStage,
  source: string,
): ArtifactActionError {
  return {
    action,
    code: artifactErrorCode(caught),
    detail: boundedErrorDetail(caught),
    source: artifactErrorSource(caught, source),
    stage,
  };
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function ResultsAlert({
  children,
  status,
  title,
}: PropsWithChildren<{ status: AlertStatus; title: string }>) {
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

export function ResultsApp() {
  const { locale, ready, t } = useI18n();
  const sessionId = new URLSearchParams(location.search).get('session');
  const [view, setView] = useState<StoredTraceView | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadDiagnostic, setLoadDiagnostic] = useState<ArtifactActionError | null>(null);
  const [fields, setFields] = useState<BugtraceReportFields>({});
  const [excludedScreenshots, setExcludedScreenshots] = useState<Set<string>>(new Set());
  const [actionState, setActionState] = useState<ActionState>('idle');
  const [actionError, setActionError] = useState<ArtifactActionError | null>(null);
  const [expandedScreenshot, setExpandedScreenshot] = useState<string | null>(null);
  const actionResetTimer = useRef<number | null>(null);

  useEffect(() => {
    document.documentElement.lang = locale;
    document.title = t('results.pageTitle');
  }, [locale, t]);

  const load = useCallback(async () => {
    if (!sessionId) {
      setLoadError(t('results.error.missingSession'));
      setLoadDiagnostic(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setLoadError(null);
    setLoadDiagnostic(null);
    try {
      const nextView = await loadStoredTrace(sessionId);
      setView(nextView);
      setFields((current) => ({
        ...current,
        title: current.title ?? nextView.trace.session.title ?? '',
      }));
    } catch (caught) {
      const missingSession = caught instanceof Error &&
        caught.message === 'This local session no longer exists or has expired.';
      setLoadError(t(missingSession ? 'results.error.sessionExpired' : 'results.error.readLocal'));
      setLoadDiagnostic(describeArtifactActionError(
        caught,
        'load_trace',
        'read_local_trace',
        `session:${sessionId}`,
      ));
    } finally {
      setLoading(false);
    }
  }, [sessionId, t]);

  useEffect(() => {
    if (!ready) return;
    queueMicrotask(() => void load());
  }, [load, ready]);

  useEffect(() => () => view?.dispose(), [view]);
  useEffect(() => () => {
    if (actionResetTimer.current !== null) window.clearTimeout(actionResetTimer.current);
  }, []);

  const clearActionReset = () => {
    if (actionResetTimer.current === null) return;
    window.clearTimeout(actionResetTimer.current);
    actionResetTimer.current = null;
  };
  const scheduleActionReset = () => {
    clearActionReset();
    actionResetTimer.current = window.setTimeout(() => {
      setActionState('idle');
      actionResetTimer.current = null;
    }, 2_500);
  };

  const exportTrace = useMemo(
    () => (view ? withScreenshotSelection(view.trace, excludedScreenshots) : null),
    [excludedScreenshots, view],
  );
  const validation = useMemo(
    () => (exportTrace ? validateTrace(exportTrace) : null),
    [exportTrace],
  );
  const includedResources = useMemo(
    () => view?.resources.filter(
      (resource) =>
        resource.purpose !== 'screenshot' ||
        !resource.relatedId ||
        !excludedScreenshots.has(resource.relatedId),
    ) ?? [],
    [excludedScreenshots, view],
  );

  const copyMarkdown = async () => {
    if (!exportTrace) return;
    clearActionReset();
    setActionState('copying');
    setActionError(null);
    let stage: ArtifactStage = 'render_report';
    let source = 'report.md';
    try {
      const markdown = buildMarkdownReport(exportTrace, fields);
      stage = 'write_clipboard';
      source = 'system-clipboard';
      await navigator.clipboard.writeText(markdown);
      setActionState('copied');
      scheduleActionReset();
    } catch (caught) {
      setActionError(describeArtifactActionError(caught, 'copy_markdown', stage, source));
      setActionState('idle');
    }
  };

  const downloadZip = async () => {
    if (!exportTrace) return;
    clearActionReset();
    setActionState('building');
    setActionError(null);
    let stage: ArtifactStage = 'assemble_bundle';
    let source = 'full-evidence-bundle';
    try {
      const bundle = await buildBugtraceZip({
        trace: exportTrace,
        report: fields,
        resources: includedResources,
      });
      stage = 'trigger_download';
      source = bundle.filename;
      downloadBlob(bugtraceZipBlob(bundle), bundle.filename);
      setActionState('downloaded');
      scheduleActionReset();
    } catch (caught) {
      setActionError(describeArtifactActionError(caught, 'download_zip', stage, source));
      setActionState('idle');
    }
  };

  const toggleScreenshot = (id: string) => {
    setExcludedScreenshots((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  if (!ready || loading) {
    return (
      <main className="grid min-h-screen place-items-center bg-background px-5 text-foreground">
        <Card className="w-full max-w-md">
          <Card.Content className="flex min-h-32 items-center justify-center gap-3 text-sm text-muted">
            <Spinner size="sm" aria-label={t('results.loading.assembling')} />
            <span>{t('results.loading.assembling')}</span>
          </Card.Content>
        </Card>
      </main>
    );
  }

  if (!view || !exportTrace) {
    return (
      <main className="grid min-h-screen place-items-center bg-background px-5 text-foreground">
        <Card className="w-full max-w-xl">
          <Card.Header className="border-b border-separator">
            <Brand label={t('common.appName')} />
          </Card.Header>
          <Card.Content className="grid gap-4 py-6">
            <ResultsAlert status="danger" title={t('results.empty.title')}>
              <span className="grid gap-1">
                <span>{loadError ?? t('results.empty.detail')}</span>
                {loadDiagnostic && (
                  <>
                    <span className="font-mono text-xs">
                      {t('results.error.diagnostic', {
                        action: loadDiagnostic.action,
                        code: loadDiagnostic.code,
                        source: loadDiagnostic.source,
                        stage: loadDiagnostic.stage,
                      })}
                    </span>
                    <span>{loadDiagnostic.detail}</span>
                    <span>{t('results.error.loadRecovery')}</span>
                  </>
                )}
              </span>
            </ResultsAlert>
          </Card.Content>
          <Card.Footer className="flex-col items-stretch gap-2 sm:flex-row sm:justify-end">
            <Button variant="secondary" onPress={() => void load()}>
              <Icon name="refresh" size={16} />
              {t('results.empty.retry')}
            </Button>
            <Button variant="primary" onPress={() => void browser.runtime.openOptionsPage()}>
              <Icon name="gear" size={16} />
              {t('results.empty.openSettings')}
            </Button>
          </Card.Footer>
        </Card>
      </main>
    );
  }

  const invalidIssues = validation && !validation.valid ? validation.errors : [];
  const invalidSource = [...new Set(invalidIssues.map((issue) => issue.instancePath || '/'))]
    .slice(0, 5)
    .join(', ');
  const invalidDetail = boundedErrorDetail(new Error(
    invalidIssues
      .slice(0, 5)
      .map((issue) => `${issue.instancePath || '/'} ${issue.keyword}: ${issue.message}`)
      .join('; '),
  ));
  const evidenceFailures =
    exportTrace.errors.length +
    exportTrace.network.filter(
      (item) => item.outcome === 'failed' || (item.statusCode ?? 0) >= 400,
    ).length +
    exportTrace.navigations.filter((item) => item.outcome === 'failed').length;
  const coverageEntries = Object.entries(exportTrace.coverage) as Array<
    [keyof CaptureCoverage, CoverageArea]
  >;
  const completeCoverageCount = coverageEntries.filter(([, area]) => area.status === 'complete').length;
  const expandedPreview = view.screenshotPreviews.find(
    (screenshot) => screenshot.id === expandedScreenshot,
  );
  const copyLabel = actionState === 'copying'
    ? t('results.action.copying')
    : actionState === 'copied'
      ? t('results.action.copied')
      : t('results.action.copy');
  const downloadLabel = actionState === 'building'
    ? t('results.action.building')
    : actionState === 'downloaded'
      ? t('results.action.downloaded')
      : t('results.action.downloadZip');
  const actionBusy = actionState === 'copying' || actionState === 'building';

  return (
    <main className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-40 bg-background p-3">
        <Card className="mx-auto w-full max-w-7xl">
          <Card.Content className="flex-row flex-wrap items-center gap-3">
            <Brand label={t('common.appName')} />
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <Chip
                color={exportTrace.session.state === 'completed' ? 'success' : 'warning'}
                size="sm"
                variant="soft"
              >
                <Chip.Label>{t(`results.status.${exportTrace.session.state}`)}</Chip.Label>
              </Chip>
              <span className="hidden truncate font-mono text-xs text-muted sm:inline">
                {exportTrace.session.id.slice(0, 13)}
              </span>
              <span className="ml-auto hidden truncate font-mono text-xs text-muted lg:inline">
                {formatDate(exportTrace.session.endedAt, locale, t('common.unavailable'))}
              </span>
            </div>
            <div className="grid w-full min-w-0 gap-2 sm:ml-auto sm:w-auto sm:grid-cols-2">
              <Button
                fullWidth
                variant="secondary"
                isDisabled={actionBusy || invalidIssues.length > 0}
                onPress={() => void copyMarkdown()}
              >
                <Icon name={actionState === 'copied' ? 'check' : 'clipboard'} size={16} />
                {copyLabel}
              </Button>
              <Button
                fullWidth
                variant="primary"
                isDisabled={actionBusy || invalidIssues.length > 0}
                onPress={() => void downloadZip()}
              >
                <Icon name={actionState === 'downloaded' ? 'check' : 'download'} size={16} />
                {downloadLabel}
              </Button>
            </div>
          </Card.Content>
        </Card>
      </header>

      <div className="mx-auto grid w-full max-w-7xl gap-6 px-3 pb-16 pt-3 sm:px-6 sm:pt-6">
        <Card>
          <Card.Header>
            <Typography.Heading level={1}>{t('results.hero.title')}</Typography.Heading>
          </Card.Header>
          <Card.Content>
            <dl
              className="grid min-w-0 grid-cols-2 gap-3 lg:grid-cols-4"
              aria-label={t('results.summary.aria')}
            >
              <EvidenceMetric
                label={t('results.summary.duration')}
                value={formatDuration(exportTrace.session.durationMs)}
              />
              <EvidenceMetric
                label={t('results.summary.steps')}
                value={exportTrace.steps.length.toLocaleString(locale)}
              />
              <EvidenceMetric
                label={t('results.summary.failures')}
                value={evidenceFailures.toLocaleString(locale)}
              />
              <EvidenceMetric
                label={t('results.summary.gaps')}
                value={exportTrace.captureGaps.length.toLocaleString(locale)}
              />
            </dl>
          </Card.Content>
        </Card>

        <div className="grid min-w-0 gap-6">
          {(loadError || actionError || invalidIssues.length > 0) && (
            <div className="grid gap-3">
              {loadError && (
                <ResultsAlert status="warning" title={t('results.alert.refreshFailed')}>
                  <span className="grid gap-1">
                    <span>{loadError}</span>
                    {loadDiagnostic && (
                      <>
                        <span className="font-mono text-xs">
                          {t('results.error.diagnostic', {
                            action: loadDiagnostic.action,
                            code: loadDiagnostic.code,
                            source: loadDiagnostic.source,
                            stage: loadDiagnostic.stage,
                          })}
                        </span>
                        <span>{loadDiagnostic.detail}</span>
                        <span>{t('results.error.loadRecovery')}</span>
                      </>
                    )}
                  </span>
                </ResultsAlert>
              )}
              {actionError && (
                <ResultsAlert status="danger" title={t('results.alert.artifactFailed')}>
                  <span className="grid gap-1">
                    <span className="font-mono text-xs">
                      {t('results.error.diagnostic', {
                        action: actionError.action,
                        code: actionError.code,
                        source: actionError.source,
                        stage: actionError.stage,
                      })}
                    </span>
                    <span>{actionError.detail}</span>
                    <span>{t('results.error.actionRecovery')}</span>
                  </span>
                </ResultsAlert>
              )}
              {invalidIssues.length > 0 && (
                <ResultsAlert status="danger" title={t('results.alert.validationFailed')}>
                  <span className="grid gap-1">
                    <span>{t('results.alert.validationFailedDetail', { count: invalidIssues.length })}</span>
                    <span className="font-mono text-xs">
                      {t('results.error.diagnostic', {
                        action: 'validate_trace',
                        code: 'trace_contract_invalid',
                        source: invalidSource || 'trace.json',
                        stage: 'validate_export_trace',
                      })}
                    </span>
                    <span>{invalidDetail}</span>
                    <span>{t('results.error.validationRecovery')}</span>
                  </span>
                </ResultsAlert>
              )}
            </div>
          )}

          <section className="min-w-0 scroll-mt-28" id="replay" aria-labelledby="replay-heading">
            <Card>
              <Card.Header>
                <Typography.Heading id="replay-heading" level={2}>
                  {t('results.replay.title')}
                </Typography.Heading>
              </Card.Header>
              <Card.Content className="min-w-0">
                <ReplayPanel segments={view.replaySegments} />
              </Card.Content>
            </Card>
          </section>

          <section className="min-w-0 scroll-mt-28" id="screenshots" aria-labelledby="screenshots-heading">
            <Card>
              <Card.Header className="flex-row flex-wrap items-center justify-between gap-3">
                <Typography.Heading id="screenshots-heading" level={3}>
                  {t('results.screenshots.title')}
                </Typography.Heading>
                <Chip size="sm" variant="soft">
                  <Chip.Label>
                    {t('results.screenshots.aside', {
                      included: view.screenshotPreviews.length - excludedScreenshots.size,
                      total: view.screenshotPreviews.length,
                    })}
                  </Chip.Label>
                </Chip>
              </Card.Header>
              <Card.Content>
                {view.screenshotPreviews.length === 0 ? (
                  <ResultsAlert status="default" title={t('results.screenshots.noneTitle')}>
                    {t('results.screenshots.noneDetail')}
                  </ResultsAlert>
                ) : (
                  <div className="grid min-w-0 gap-4 md:grid-cols-2">
                    {view.screenshotPreviews.map((screenshot, index) => {
                      const excluded = excludedScreenshots.has(screenshot.id);
                      const displayIndex = String(index + 1).padStart(2, '0');
                      const trigger = screenshotTriggerLabel(screenshot.trigger, t);
                      return (
                        <Card
                          key={screenshot.id}
                          className={excluded ? 'opacity-50' : ''}
                          variant="secondary"
                        >
                          <Card.Content>
                            <Button
                              fullWidth
                              className="aspect-video h-auto overflow-hidden p-0"
                              variant="ghost"
                              aria-label={`${t('results.screenshots.inspect')}: ${t('results.screenshots.shot', { index: displayIndex })}`}
                              onPress={() => setExpandedScreenshot(screenshot.id)}
                            >
                              <img
                                className="h-full w-full object-cover"
                                src={screenshot.url}
                                alt={t('results.screenshots.alt', { index: index + 1, trigger })}
                                height={screenshot.height}
                                loading="lazy"
                                width={screenshot.width}
                              />
                            </Button>
                          </Card.Content>
                          <Card.Footer className="flex-wrap items-center justify-between gap-3">
                            <div className="min-w-0">
                              <strong className="block text-sm font-medium">
                                {t('results.screenshots.shot', { index: displayIndex })}
                              </strong>
                              <span className="mt-1 block truncate font-mono text-xs text-muted">
                                +{formatDuration(screenshot.offsetMs)} · {trigger}
                              </span>
                            </div>
                            <Button
                              size="sm"
                              variant={excluded ? 'secondary' : 'danger-soft'}
                              onPress={() => toggleScreenshot(screenshot.id)}
                            >
                              {excluded
                                ? t('results.screenshots.restore')
                                : t('results.screenshots.exclude')}
                            </Button>
                          </Card.Footer>
                        </Card>
                      );
                    })}
                  </div>
                )}
              </Card.Content>
            </Card>
          </section>

          <section className="min-w-0 scroll-mt-28" id="report" aria-labelledby="report-heading">
            <Card>
              <Card.Header>
                <Typography.Heading id="report-heading" level={2}>
                  {t('results.brief.title')}
                </Typography.Heading>
                <Card.Description>{t('results.brief.intro')}</Card.Description>
              </Card.Header>
              <Card.Content>
                <div className="grid min-w-0 gap-4 sm:grid-cols-2">
                  {REPORT_FIELDS.map((field) => {
                    const value = fields[field.name] ?? '';
                    const maxLength = field.name === 'title' ? 500 : 8_000;
                    const fullRow = ['title', 'summary', 'preconditions', 'notes'].includes(
                      field.name,
                    );
                    return (
                      <TextField
                        key={field.name}
                        {...(fullRow ? { className: 'sm:col-span-2' } : {})}
                        fullWidth
                        value={value}
                        onChange={(nextValue) => {
                          setFields((current) => fieldUpdate(current, field.name, nextValue));
                        }}
                      >
                        <Label>{t(`results.field.${field.name}.label`)}</Label>
                        {field.rows === 1 ? (
                          <Input
                            fullWidth
                            maxLength={maxLength}
                            placeholder={t(`results.field.${field.name}.placeholder`)}
                          />
                        ) : (
                          <TextArea
                            fullWidth
                            maxLength={maxLength}
                            placeholder={t(`results.field.${field.name}.placeholder`)}
                            rows={field.rows}
                          />
                        )}
                        <Description className="text-right font-mono">
                          {value.length.toLocaleString(locale)} /{' '}
                          {maxLength.toLocaleString(locale)}
                        </Description>
                      </TextField>
                    );
                  })}
                </div>
              </Card.Content>
            </Card>
          </section>

          <section className="min-w-0 scroll-mt-28" aria-labelledby="coverage-heading">
            <Card id="integrity">
              <Card.Content>
                <Disclosure>
                  <Disclosure.Heading>
                    <Disclosure.Trigger className="flex w-full min-w-0 items-center gap-3 text-left">
                      <span className="grid min-w-0 flex-1 gap-1">
                        <strong id="coverage-heading" className="font-medium">
                          {t('results.coverage.title')}
                        </strong>
                        <span className="truncate text-sm text-muted">
                          {t('results.privacy.eyebrow')} · {t('results.footer.localOnly')}
                        </span>
                      </span>
                      <Chip
                        color={completeCoverageCount === coverageEntries.length
                          ? 'success'
                          : 'warning'}
                        size="sm"
                        variant="soft"
                      >
                        <Chip.Label>
                          {completeCoverageCount}/{coverageEntries.length}
                        </Chip.Label>
                      </Chip>
                      <Disclosure.Indicator />
                    </Disclosure.Trigger>
                  </Disclosure.Heading>

                  <Disclosure.Content>
                    <Disclosure.Body className="grid min-w-0 gap-6 pt-4 lg:grid-cols-2">
                      <section aria-label={t('results.coverage.title')}>
                        <div className="grid gap-3">
                          {coverageEntries.map(([name, area]) => {
                            const reason = area.status === 'complete'
                              ? t('results.coverage.completeReason')
                              : area.reasons.length > 0
                                ? t('results.coverage.reportedGap')
                                : t('results.coverage.noReason');
                            const statusKey = area.status === 'complete'
                              ? 'statusComplete'
                              : area.status === 'partial'
                                ? 'statusPartial'
                                : 'statusOff';
                            const statusColor = area.status === 'complete'
                              ? 'success'
                              : area.status === 'partial'
                                ? 'warning'
                                : 'danger';
                            return (
                              <Card key={name} variant="secondary">
                                <Card.Content className="flex-row items-center justify-between gap-3">
                                  <div className="min-w-0">
                                    <strong className="block text-sm font-medium">
                                      {t(`results.coverage.${name}`)}
                                    </strong>
                                    <span className="mt-1 block truncate text-xs text-muted">
                                      {reason}
                                    </span>
                                  </div>
                                  <Chip color={statusColor} size="sm" variant="soft">
                                    <Chip.Label>
                                      {t(`results.coverage.${statusKey}`)}
                                    </Chip.Label>
                                  </Chip>
                                </Card.Content>
                              </Card>
                            );
                          })}
                        </div>
                      </section>

                      <section aria-labelledby="fidelity-heading">
                        <Typography.Heading id="fidelity-heading" level={3}>
                          {t('results.privacy.title')}
                        </Typography.Heading>
                        <dl className="mt-3 grid gap-3">
                          <PrivacyRow
                            label={t('results.privacy.inputValues')}
                            value={privacyValueLabel(exportTrace.privacy.inputValues, t)}
                          />
                          <PrivacyRow
                            label={t('results.privacy.urlQueries')}
                            value={privacyValueLabel(exportTrace.privacy.urlQueryValues, t)}
                          />
                          <PrivacyRow
                            label={t('results.privacy.requestBodies')}
                            value={privacyValueLabel(exportTrace.privacy.requestBodies, t)}
                          />
                          <PrivacyRow
                            label={t('results.privacy.responseBodies')}
                            value={privacyValueLabel(exportTrace.privacy.responseBodies, t)}
                          />
                          <PrivacyRow
                            label={t('results.privacy.cookies')}
                            value={privacyValueLabel(exportTrace.privacy.cookies, t)}
                          />
                          <PrivacyRow
                            label={t('results.privacy.sensitiveHeaders')}
                            value={privacyValueLabel(exportTrace.privacy.sensitiveHeaders, t)}
                          />
                          <PrivacyRow
                            label={t('results.privacy.minimumRedactions')}
                            value={exportTrace.privacy.redactionCount.toLocaleString(locale)}
                          />
                          <PrivacyRow
                            label={t('results.privacy.remoteTransfer')}
                            value={t('results.privacy.none')}
                          />
                        </dl>
                      </section>
                    </Disclosure.Body>
                  </Disclosure.Content>
                </Disclosure>

                <Alert status="default" role="status">
                  <Alert.Indicator />
                  <Alert.Content>
                    <Alert.Description>{t('results.agentSafety.short')}</Alert.Description>
                  </Alert.Content>
                </Alert>
              </Card.Content>
            </Card>
          </section>
        </div>
      </div>

      <footer className="mx-auto flex w-full max-w-7xl flex-col gap-2 px-3 pb-8 font-mono text-xs text-muted sm:flex-row sm:justify-between sm:px-6">
        <span>{t('results.footer.format', { format: exportTrace.format, version: exportTrace.formatVersion })}</span>
        <span>{t('results.footer.localOnly')}</span>
      </footer>

      <Modal
        isOpen={Boolean(expandedScreenshot)}
        onOpenChange={(isOpen) => {
          if (!isOpen) setExpandedScreenshot(null);
        }}
      >
        <Modal.Backdrop variant="blur">
          <Modal.Container placement="center" size="cover">
            <Modal.Dialog aria-label={t('results.lightbox.dialog')}>
              <Modal.Header>
                <Modal.Heading>{t('results.lightbox.title')}</Modal.Heading>
                <Tooltip delay={250}>
                  <Modal.CloseTrigger
                    aria-label={t('results.lightbox.close')}
                  />
                  <Tooltip.Content className="bg-white text-black" placement="bottom end">
                    {t('results.lightbox.close')}
                  </Tooltip.Content>
                </Tooltip>
              </Modal.Header>
              <Modal.Body className="grid min-h-0 place-items-center">
                {expandedPreview && (
                  <img
                    className="max-h-[calc(100vh-9rem)] max-w-full object-contain"
                    src={expandedPreview.url}
                    alt={t('results.lightbox.alt')}
                  />
                )}
              </Modal.Body>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal>
    </main>
  );
}

function EvidenceMetric({ label, value }: { label: string; value: string }) {
  return (
    <Card className="min-w-0" variant="secondary">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="m-0 truncate font-mono text-lg font-medium">{value}</dd>
    </Card>
  );
}

function PrivacyRow({ label, value }: { label: string; value: string }) {
  return (
    <Card className="flex-row items-center justify-between gap-4" variant="secondary">
      <dt className="text-sm text-muted">{label}</dt>
      <dd className="m-0">
        <Chip size="sm" variant="soft"><Chip.Label>{value}</Chip.Label></Chip>
      </dd>
    </Card>
  );
}

function screenshotTriggerLabel(
  trigger: ScreenshotRecord['trigger'],
  t: ReturnType<typeof useI18n>['t'],
): string {
  const keys = {
    manual: 'results.screenshots.triggerManual',
    error: 'results.screenshots.triggerError',
    navigation: 'results.screenshots.triggerNavigation',
    stop: 'results.screenshots.triggerStop',
  } as const;
  return t(keys[trigger]);
}

function privacyValueLabel(
  value: 'captured' | 'omitted' | 'redacted' | 'unavailable',
  t: ReturnType<typeof useI18n>['t'],
): string {
  const keys = {
    captured: 'results.privacy.valueCaptured',
    omitted: 'results.privacy.valueOmitted',
    redacted: 'results.privacy.valueRedacted',
    unavailable: 'results.privacy.valueUnavailable',
  } as const;
  return t(keys[value]);
}
