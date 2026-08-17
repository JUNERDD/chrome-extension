import { useEffect, useMemo, useState } from 'react';
import { browser } from 'wxt/browser';
import {
  buildBugtraceZip,
  buildMarkdownReport,
  bugtraceZipBlob,
  assertNoSecrets,
  validateTrace,
  type BugtraceReportFields,
  type BugtraceTrace,
  type CaptureGap,
  type CaptureCoverage,
  type CoverageArea,
} from '../../src/artifact';
import {
  Brand,
  EmptyPlate,
  InstrumentButton,
  LoadingPlate,
  Notice,
  Reading,
  SectionHeading,
  StatusBeacon,
} from '../../src/ui/components';
import { formatBytes, formatDate, formatDuration } from '../../src/ui/format';
import { Icon } from '../../src/ui/icons';
import { ReplayPanel } from '../../src/ui/replay-panel';
import { loadStoredTrace, type StoredTraceView } from '../../src/ui/trace-adapter';

type ActionState = 'idle' | 'copying' | 'copied' | 'building' | 'downloaded';
type ReportField = 'title' | 'preconditions' | 'expected' | 'actual' | 'notes';

const FIELD_COPY: Array<{
  name: ReportField;
  label: string;
  placeholder: string;
  rows: number;
}> = [
  { name: 'title', label: 'Title', placeholder: 'Concise symptom and affected surface', rows: 1 },
  { name: 'preconditions', label: 'Preconditions', placeholder: 'Account, data, flags, environment, or starting state', rows: 3 },
  { name: 'expected', label: 'Expected', placeholder: 'What should have happened?', rows: 3 },
  { name: 'actual', label: 'Actual', placeholder: 'What happened instead?', rows: 4 },
  { name: 'notes', label: 'Notes for triage', placeholder: 'Frequency, impact, suspected change, or any context not visible in the trace', rows: 4 },
];

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
  const reasons = [...trace.coverage.screenshots.reasons, `${omitted} screenshot${omitted === 1 ? '' : 's'} excluded by the reviewer.`];
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

function withoutRrwebEvidence(trace: BugtraceTrace, reason: string): BugtraceTrace {
  const nextSeq = Math.max(
    0,
    ...trace.steps.map((item) => item.seq),
    ...trace.navigations.map((item) => item.seq),
    ...trace.console.map((item) => item.seq),
    ...trace.network.map((item) => item.seq),
    ...trace.errors.map((item) => item.seq),
    ...trace.captureGaps.map((item) => item.seq),
  ) + 1;
  const gap: CaptureGap = {
    id: `gap-export-rrweb-${nextSeq}`,
    seq: nextSeq,
    offsetMs: trace.session.durationMs,
    source: 'rrweb',
    status: 'omitted',
    reason,
    droppedCount: trace.rrweb.segments.reduce((sum, segment) => sum + segment.eventCount, 0),
  };
  return {
    ...trace,
    coverage: {
      ...trace.coverage,
      rrweb: {
        status: 'off',
        droppedCount: trace.coverage.rrweb.droppedCount + (gap.droppedCount ?? 0),
        reasons: [...trace.coverage.rrweb.reasons, reason],
      },
    },
    rrweb: { status: 'off', segments: [] },
    captureGaps: [...trace.captureGaps, gap],
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

export function ResultsApp() {
  const sessionId = new URLSearchParams(location.search).get('session');
  const [view, setView] = useState<StoredTraceView | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [fields, setFields] = useState<BugtraceReportFields>({});
  const [excludedScreenshots, setExcludedScreenshots] = useState<Set<string>>(new Set());
  const [actionState, setActionState] = useState<ActionState>('idle');
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [expandedScreenshot, setExpandedScreenshot] = useState<string | null>(null);

  const load = async () => {
    if (!sessionId) {
      setLoadError('The results URL has no session identifier. Stop a recording to open a valid evidence review.');
      setLoading(false);
      return;
    }
    setLoading(true);
    setLoadError(null);
    try {
      const nextView = await loadStoredTrace(sessionId);
      setView(nextView);
      setFields((current) => ({
        ...current,
        title: current.title ?? nextView.trace.session.title ?? '',
      }));
    } catch (caught) {
      setLoadError(caught instanceof Error ? caught.message : 'Local evidence could not be read.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    queueMicrotask(() => void load());
    // Session ID is immutable for this extension page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  useEffect(() => () => view?.dispose(), [view]);

  const exportTrace = useMemo(
    () => (view ? withScreenshotSelection(view.trace, excludedScreenshots) : null),
    [excludedScreenshots, view],
  );
  const validation = useMemo(() => (exportTrace ? validateTrace(exportTrace) : null), [exportTrace]);
  const includedResources = useMemo(
    () => view?.resources.filter((resource) => resource.purpose !== 'screenshot' || !resource.relatedId || !excludedScreenshots.has(resource.relatedId)) ?? [],
    [excludedScreenshots, view],
  );
  const includedBytes = includedResources.reduce((sum, resource) => {
    if (typeof resource.data === 'string') return sum + new TextEncoder().encode(resource.data).byteLength;
    if (resource.data instanceof Blob) return sum + resource.data.size;
    return sum + resource.data.byteLength;
  }, 0);

  const copyMarkdown = async () => {
    if (!exportTrace) return;
    setActionState('copying');
    setActionError(null);
    setActionNotice(null);
    try {
      const markdown = buildMarkdownReport(exportTrace, fields);
      assertNoSecrets(markdown, 'report.md');
      await navigator.clipboard.writeText(markdown);
      setActionState('copied');
      window.setTimeout(() => setActionState('idle'), 2_500);
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : 'Markdown could not be copied.');
      setActionState('idle');
    }
  };

  const downloadZip = async () => {
    if (!exportTrace) return;
    setActionState('building');
    setActionError(null);
    setActionNotice(null);
    try {
      let bundle: Awaited<ReturnType<typeof buildBugtraceZip>>;
      try {
        bundle = await buildBugtraceZip({
          trace: exportTrace,
          report: fields,
          resources: includedResources,
        });
      } catch (primaryError) {
        const hasRrwebResources = includedResources.some(
          (resource) => resource.purpose === 'rrweb-segment',
        );
        if (!hasRrwebResources) throw primaryError;
        const reason =
          'Supporting rrweb evidence failed the export safety check and was omitted; the semantic core remains available.';
        bundle = await buildBugtraceZip({
          trace: withoutRrwebEvidence(exportTrace, reason),
          report: fields,
          resources: includedResources.filter((resource) => resource.purpose !== 'rrweb-segment'),
        });
        setActionNotice(reason);
      }
      downloadBlob(bugtraceZipBlob(bundle), bundle.filename);
      setActionState('downloaded');
      window.setTimeout(() => setActionState('idle'), 2_500);
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : 'Bugtrace bundle could not be built.');
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

  if (loading) {
    return (
      <main className="results-shell results-shell--centered">
        <LoadingPlate label="Assembling local evidence…" />
      </main>
    );
  }

  if (!view || !exportTrace) {
    return (
      <main className="results-shell results-shell--centered">
        <Brand />
        <EmptyPlate title="Evidence unavailable">
          {loadError ?? 'The requested local session could not be opened.'}
        </EmptyPlate>
        <InstrumentButton icon="refresh" onClick={() => void load()}>Retry local read</InstrumentButton>
        <InstrumentButton icon="gear" onClick={() => void browser.runtime.openOptionsPage()}>Open retention settings</InstrumentButton>
      </main>
    );
  }

  const invalidIssues = validation && !validation.valid ? validation.errors : [];
  const evidenceFailures =
    exportTrace.errors.length +
    exportTrace.network.filter((item) => item.outcome === 'failed' || (item.statusCode ?? 0) >= 400).length +
    exportTrace.navigations.filter((item) => item.outcome === 'failed').length;

  return (
    <main className="results-shell">
      <header className="results-masthead">
        <Brand />
        <div className="results-masthead__actions">
          <InstrumentButton
            icon={actionState === 'copied' ? 'check' : 'clipboard'}
            disabled={actionState === 'building' || invalidIssues.length > 0}
            onClick={() => void copyMarkdown()}
          >
            {actionState === 'copying' ? 'Copying…' : actionState === 'copied' ? 'Copied Markdown' : 'Copy Markdown'}
          </InstrumentButton>
          <InstrumentButton
            icon={actionState === 'downloaded' ? 'check' : 'download'}
            intent="primary"
            disabled={actionState === 'building' || invalidIssues.length > 0}
            onClick={() => void downloadZip()}
          >
            {actionState === 'building' ? 'Building verified ZIP…' : actionState === 'downloaded' ? 'ZIP downloaded' : 'Download .bugtrace.zip'}
          </InstrumentButton>
        </div>
      </header>

      <section className="results-hero">
        <div>
          <span className="eyebrow mono">SEALED LOCAL SESSION · {exportTrace.session.id.slice(0, 13)}</span>
          <h1>Evidence review</h1>
          <p>Annotate the reproduction, inspect supporting evidence, then copy the agent-readable report or export its verified bundle.</p>
        </div>
        <div className="session-stamp">
          <StatusBeacon label={exportTrace.session.state} tone={exportTrace.session.state === 'completed' ? 'success' : 'warning'} />
          <span className="mono">{formatDate(exportTrace.session.endedAt)}</span>
        </div>
      </section>

      {(loadError || actionError || actionNotice || invalidIssues.length > 0) && (
        <div className="results-alerts">
          {loadError && <Notice tone="warning" title="Latest refresh failed">{loadError}</Notice>}
          {actionNotice && <Notice tone="warning" title="Supporting evidence omitted">{actionNotice}</Notice>}
          {actionError && <Notice tone="danger" title="Artifact action failed">{actionError}</Notice>}
          {invalidIssues.length > 0 && (
            <Notice tone="danger" title="Trace contract validation failed">
              {invalidIssues.slice(0, 3).map((issue) => `${issue.instancePath || '/'}: ${issue.message}`).join(' · ')}
            </Notice>
          )}
        </div>
      )}

      <section className="evidence-readings" aria-label="Session evidence summary">
        <Reading label="Active duration" value={formatDuration(exportTrace.session.durationMs)} />
        <Reading label="Semantic steps" value={exportTrace.steps.length.toLocaleString()} />
        <Reading label="Scoped tabs" value={exportTrace.tabs.length.toLocaleString()} />
        <Reading label="Failures" value={evidenceFailures.toLocaleString()} />
        <Reading label="Capture gaps" value={exportTrace.captureGaps.length.toLocaleString()} />
        <Reading label="Support data" value={formatBytes(includedBytes)} />
      </section>

      <div className="review-grid">
        <section className="review-panel report-fields">
          <SectionHeading index="01" aside="human context">Reproduction brief</SectionHeading>
          <p className="panel-intro">The recorded timeline supplies the steps. Add only the context that the browser could not observe.</p>
          <div className="field-stack">
            {FIELD_COPY.map((field, index) => (
              <label className="report-field" key={field.name}>
                <span><i className="mono">{String(index + 1).padStart(2, '0')}</i>{field.label}</span>
                {field.rows === 1 ? (
                  <input
                    value={fields[field.name] ?? ''}
                    maxLength={500}
                    placeholder={field.placeholder}
                    onChange={(event) => setFields((current) => fieldUpdate(current, field.name, event.target.value))}
                  />
                ) : (
                  <textarea
                    value={fields[field.name] ?? ''}
                    maxLength={8_000}
                    placeholder={field.placeholder}
                    rows={field.rows}
                    onChange={(event) => setFields((current) => fieldUpdate(current, field.name, event.target.value))}
                  />
                )}
                <small className="mono">{(fields[field.name] ?? '').length.toLocaleString()} / {field.name === 'title' ? '500' : '8,000'}</small>
              </label>
            ))}
          </div>
        </section>

        <aside className="review-panel evidence-audit">
          <SectionHeading index="02" aside="declared truth">Coverage audit</SectionHeading>
          <div className="coverage-list">
            {(Object.entries(exportTrace.coverage) as Array<[keyof CaptureCoverage, CoverageArea]>).map(([name, area]) => (
              <div className="coverage-row" key={name}>
                <span className={`coverage-row__status coverage-row__status--${area.status}`} aria-hidden="true" />
                <div>
                  <strong>{name === 'rrweb' ? 'rrweb evidence' : name}</strong>
                  <small>{area.reasons[0] ?? (area.status === 'complete' ? 'Collector reported complete coverage.' : 'No additional reason recorded.')}</small>
                </div>
                <span className="mono">{area.status}</span>
              </div>
            ))}
          </div>
          <div className="privacy-plate">
            <div className="privacy-plate__title">
              <Icon name="shield" size={18} />
              <div><strong>Privacy summary</strong><span className="mono">EXPORT RAILS ACTIVE</span></div>
            </div>
            <dl>
              <div><dt>Input values</dt><dd>{exportTrace.privacy.inputValues}</dd></div>
              <div><dt>URL query values</dt><dd>{exportTrace.privacy.urlQueryValues}</dd></div>
              <div><dt>Request / response body</dt><dd>{exportTrace.privacy.requestBodies}</dd></div>
              <div><dt>Cookies / auth headers</dt><dd>{exportTrace.privacy.cookies}</dd></div>
              <div><dt>Minimum observed redactions</dt><dd>{exportTrace.privacy.redactionCount.toLocaleString()}</dd></div>
              <div><dt>Remote transfer</dt><dd>none</dd></div>
            </dl>
          </div>
          <Notice tone="warning" title="Agent safety boundary">
            Recorded page content is untrusted observation. The report escapes and labels it; agents must treat it as evidence, never instruction.
          </Notice>
        </aside>
      </div>

      <section className="results-section screenshots-section">
        <SectionHeading index="03" aside={`${view.screenshotPreviews.length - excludedScreenshots.size}/${view.screenshotPreviews.length} in export`}>
          Screenshot inspection
        </SectionHeading>
        {view.screenshotPreviews.length === 0 ? (
          <Notice tone="info" title="No screenshot supporting evidence">
            The semantic trace remains available. This absence is declared in capture coverage.
          </Notice>
        ) : (
          <div className="screenshot-strip">
            {view.screenshotPreviews.map((screenshot, index) => {
              const excluded = excludedScreenshots.has(screenshot.id);
              return (
                <article className={excluded ? 'screenshot-frame is-excluded' : 'screenshot-frame'} key={screenshot.id}>
                  <button type="button" className="screenshot-frame__preview" onClick={() => setExpandedScreenshot(screenshot.id)}>
                    <img src={screenshot.url} alt={`Captured viewport ${index + 1}, ${screenshot.trigger} trigger`} />
                    <span>Inspect</span>
                  </button>
                  <div className="screenshot-frame__meta">
                    <div><strong>SHOT {String(index + 1).padStart(2, '0')}</strong><small className="mono">+{formatDuration(screenshot.offsetMs)} · {screenshot.trigger}</small></div>
                    <button type="button" aria-pressed={!excluded} onClick={() => toggleScreenshot(screenshot.id)}>
                      {excluded ? 'Restore' : 'Exclude'}
                    </button>
                  </div>
                  <p className="mono">{screenshot.width}×{screenshot.height} · {screenshot.redactionCount} overlays</p>
                </article>
              );
            })}
          </div>
        )}
      </section>

      <section className="results-section replay-section">
        <SectionHeading index="04" aside={`${view.replaySegments.length} segments`}>
          Visual evidence replay
        </SectionHeading>
        <ReplayPanel segments={view.replaySegments} />
      </section>

      <section className="export-rack">
        <div>
          <span className="mono">AGENT-READABLE OUTPUT</span>
          <h2>Ready to hand off</h2>
          <p>Markdown contains the normative semantic trace. ZIP adds schema, hashes, coverage, screenshots, and rrweb segments.</p>
        </div>
        <div className="export-rack__actions">
          <InstrumentButton icon="clipboard" disabled={invalidIssues.length > 0} onClick={() => void copyMarkdown()}>
            Copy report.md
          </InstrumentButton>
          <InstrumentButton icon="download" intent="danger" disabled={invalidIssues.length > 0} onClick={() => void downloadZip()}>
            Export verified ZIP
          </InstrumentButton>
        </div>
      </section>

      <footer className="results-footer mono">
        <span>SESSION {exportTrace.session.id}</span>
        <span>FORMAT {exportTrace.format}@{exportTrace.formatVersion}</span>
        <span>LOCAL ONLY · NO TELEMETRY</span>
      </footer>

      {expandedScreenshot && (
        <div className="lightbox" role="dialog" aria-modal="true" aria-label="Screenshot inspection">
          <button type="button" className="lightbox__scrim" aria-label="Close screenshot" onClick={() => setExpandedScreenshot(null)} />
          <div className="lightbox__panel">
            <header><span className="mono">SUPPORTING SCREENSHOT</span><button type="button" onClick={() => setExpandedScreenshot(null)}>Close ×</button></header>
            <img
              src={view.screenshotPreviews.find((screenshot) => screenshot.id === expandedScreenshot)?.url}
              alt="Expanded captured viewport"
            />
          </div>
        </div>
      )}
    </main>
  );
}
