import type {
  BugtraceTrace,
  BundleEntryPurpose,
  BundleResourceInput,
} from './types';

export interface ArtifactConsistencyIssue {
  instancePath: string;
  keyword: 'semantic';
  message: string;
}

export class BugtraceArtifactConsistencyError extends Error {
  readonly issues: readonly ArtifactConsistencyIssue[];

  constructor(issues: readonly ArtifactConsistencyIssue[]) {
    const detail = issues
      .slice(0, 5)
      .map((issue) => `${issue.instancePath || '/'} ${issue.message}`)
      .join('; ');
    super(`Inconsistent Bugtrace artifact${detail ? `: ${detail}` : '.'}`);
    this.name = 'BugtraceArtifactConsistencyError';
    this.issues = issues;
  }
}

export function assertArtifactConsistency(issues: readonly ArtifactConsistencyIssue[]): void {
  if (issues.length > 0) throw new BugtraceArtifactConsistencyError(issues);
}

export interface EvidenceResourceDescriptor {
  path: string;
  bytes: Uint8Array;
  mimeType: string;
  purpose: BundleResourceInput['purpose'];
  relatedId?: string;
}

interface ExpectedEvidenceResource {
  id: string;
  path: string;
  purpose: BundleResourceInput['purpose'];
  mimeType: string;
  size?: number;
  eventCount?: number;
  instancePath: string;
}

interface SequencedRecord {
  id: string;
  seq: number;
  sourceSeq?: number;
  offsetMs: number;
  tabId?: string;
}

function semanticIssue(instancePath: string, message: string): ArtifactConsistencyIssue {
  return { instancePath, keyword: 'semantic', message };
}

function findRedactedStatusPaths(value: unknown, path = ''): string[] {
  const paths: string[] = [];
  const pending: Array<{ value: unknown; path: string }> = [{ value, path }];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (!current.value || typeof current.value !== 'object') continue;
    if (Array.isArray(current.value)) {
      current.value.forEach((item, index) => {
        pending.push({ value: item, path: `${current.path}/${index}` });
      });
      continue;
    }
    const record = current.value as Record<string, unknown>;
    if (record.status === 'redacted') paths.push(`${current.path}/status`);
    Object.entries(record).forEach(([key, item]) => {
      const isOpaqueCapturedValue = record.status === 'captured' && key === 'value';
      if (key !== 'status' && !isOpaqueCapturedValue) {
        pending.push({ value: item, path: `${current.path}/${key}` });
      }
    });
  }
  return paths;
}

function isPng(bytes: Uint8Array): boolean {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  return signature.every((value, index) => bytes[index] === value);
}

function isWebp(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 12 &&
    new TextDecoder().decode(bytes.subarray(0, 4)) === 'RIFF' &&
    new TextDecoder().decode(bytes.subarray(8, 12)) === 'WEBP';
}

function expectedEvidenceResources(trace: BugtraceTrace): ExpectedEvidenceResource[] {
  const expected: ExpectedEvidenceResource[] = [];
  trace.rrweb.segments.forEach((segment, index) => {
    if (segment.status !== 'present') return;
    expected.push({
      id: segment.id,
      path: segment.path,
      purpose: 'rrweb-segment',
      mimeType: 'application/json',
      eventCount: segment.eventCount,
      instancePath: `/rrweb/segments/${index}`,
    });
  });
  trace.screenshots.forEach((screenshot, index) => {
    if (screenshot.status !== 'present') return;
    expected.push({
      id: screenshot.id,
      path: screenshot.path,
      purpose: 'screenshot',
      mimeType: screenshot.mimeType,
      instancePath: `/screenshots/${index}`,
    });
  });
  trace.attachments.forEach((attachment, index) => {
    if (attachment.status !== 'present') return;
    expected.push({
      id: attachment.id,
      path: attachment.path,
      purpose: 'attachment',
      mimeType: attachment.mimeType,
      size: attachment.size,
      instancePath: `/attachments/${index}`,
    });
  });
  return expected;
}

function registerUnique(
  seen: Map<string, string>,
  value: string,
  instancePath: string,
  label: string,
  issues: ArtifactConsistencyIssue[],
): void {
  const prior = seen.get(value);
  if (prior) {
    issues.push(semanticIssue(instancePath, `${label} ${JSON.stringify(value)} duplicates ${prior}.`));
    return;
  }
  seen.set(value, instancePath);
}

export function validateTraceSemantics(trace: BugtraceTrace): ArtifactConsistencyIssue[] {
  const issues: ArtifactConsistencyIssue[] = [];
  const ids = new Map<string, string>();
  const tabIds = new Set(trace.tabs.map((tab) => tab.id));

  trace.tabs.forEach((tab, index) => {
    const path = `/tabs/${index}`;
    registerUnique(ids, tab.id, `${path}/id`, 'Logical id', issues);
    if (tab.openerTabId && !tabIds.has(tab.openerTabId)) {
      issues.push(semanticIssue(`${path}/openerTabId`, `Unknown opener tab ${JSON.stringify(tab.openerTabId)}.`));
    }
    if (tab.openedAtOffsetMs > trace.session.durationMs) {
      issues.push(semanticIssue(`${path}/openedAtOffsetMs`, 'Tab opened after the session duration.'));
    }
    if (tab.closedAtOffsetMs !== undefined) {
      if (tab.closedAtOffsetMs < tab.openedAtOffsetMs) {
        issues.push(semanticIssue(`${path}/closedAtOffsetMs`, 'Tab closed before it opened.'));
      }
      if (tab.closedAtOffsetMs > trace.session.durationMs) {
        issues.push(semanticIssue(`${path}/closedAtOffsetMs`, 'Tab closed after the session duration.'));
      }
    }
  });

  const collections: ReadonlyArray<readonly [string, readonly SequencedRecord[]]> = [
    ['steps', trace.steps],
    ['navigations', trace.navigations],
    ['console', trace.console],
    ['network', trace.network],
    ['errors', trace.errors],
    ['screenshots', trace.screenshots],
    ['captureGaps', trace.captureGaps],
  ];
  const sequenceOwners = new Map<number, { path: string; record: SequencedRecord }>();
  const sourceSequenceOwners = new Map<number, string>();

  for (const [name, records] of collections) {
    let priorSeq = -1;
    records.forEach((record, index) => {
      const path = `/${name}/${index}`;
      registerUnique(ids, record.id, `${path}/id`, 'Logical id', issues);
      if (record.seq < priorSeq) {
        issues.push(semanticIssue(`${path}/seq`, `${name} records are not ordered by global seq.`));
      }
      priorSeq = record.seq;
      const prior = sequenceOwners.get(record.seq);
      if (prior) {
        issues.push(
          semanticIssue(`${path}/seq`, `Global seq ${record.seq} is already owned by ${prior.path}.`),
        );
      } else {
        sequenceOwners.set(record.seq, { path, record });
      }
      if (record.sourceSeq !== undefined) {
        const priorSourceOwner = sourceSequenceOwners.get(record.sourceSeq);
        if (priorSourceOwner) {
          issues.push(
            semanticIssue(
              `${path}/sourceSeq`,
              `Source seq ${record.sourceSeq} is already owned by ${priorSourceOwner}.`,
            ),
          );
        } else {
          sourceSequenceOwners.set(record.sourceSeq, path);
        }
      }
      if (record.offsetMs > trace.session.durationMs) {
        issues.push(semanticIssue(`${path}/offsetMs`, 'Record occurs after the session duration.'));
      }
      if (record.tabId !== undefined && !tabIds.has(record.tabId)) {
        issues.push(semanticIssue(`${path}/tabId`, `Unknown tab ${JSON.stringify(record.tabId)}.`));
      }
    });
  }

  let priorChronology: { seq: number; offsetMs: number; path: string } | undefined;
  for (const [seq, owner] of [...sequenceOwners.entries()].sort(([left], [right]) => left - right)) {
    if (priorChronology && owner.record.offsetMs < priorChronology.offsetMs) {
      issues.push(
        semanticIssue(
          `${owner.path}/offsetMs`,
          `Global seq ${seq} occurs before seq ${priorChronology.seq} at ${priorChronology.path}.`,
        ),
      );
    }
    priorChronology = { seq, offsetMs: owner.record.offsetMs, path: owner.path };
  }

  const stepsById = new Map(trace.steps.map((step) => [step.id, step]));
  trace.network.forEach((record, index) => {
    if (record.initiator?.status !== 'linked') return;
    const path = `/network/${index}/initiator`;
    const step = stepsById.get(record.initiator.stepId);
    if (!step) {
      issues.push(
        semanticIssue(`${path}/stepId`, `Unknown initiating step ${JSON.stringify(record.initiator.stepId)}.`),
      );
      return;
    }
    if (step.tabId !== record.tabId) {
      issues.push(semanticIssue(`${path}/stepId`, 'Initiating step must belong to the request tab.'));
    }
    if (step.seq >= record.seq || step.offsetMs > record.offsetMs) {
      issues.push(semanticIssue(`${path}/stepId`, 'Initiating step must temporally precede the request.'));
    }
    const observedDelta = record.offsetMs - step.offsetMs;
    if (record.initiator.deltaMs !== observedDelta) {
      issues.push(
        semanticIssue(
          `${path}/deltaMs`,
          `Initiator deltaMs must equal the observed offset difference (${observedDelta}).`,
        ),
      );
    }
  });

  trace.rrweb.segments.forEach((segment, index) => {
    const path = `/rrweb/segments/${index}`;
    registerUnique(ids, segment.id, `${path}/id`, 'Logical id', issues);
    if (!tabIds.has(segment.tabId)) {
      issues.push(semanticIssue(`${path}/tabId`, `Unknown tab ${JSON.stringify(segment.tabId)}.`));
    }
    if (segment.startSeq > segment.endSeq) {
      issues.push(semanticIssue(`${path}/endSeq`, 'rrweb segment endSeq precedes startSeq.'));
    }
    if (
      segment.sourceStartSeq !== undefined &&
      segment.sourceEndSeq !== undefined &&
      segment.sourceStartSeq > segment.sourceEndSeq
    ) {
      issues.push(semanticIssue(`${path}/sourceEndSeq`, 'rrweb sourceEndSeq precedes sourceStartSeq.'));
    }
    if ((segment.sourceStartSeq === undefined) !== (segment.sourceEndSeq === undefined)) {
      issues.push(
        semanticIssue(path, 'rrweb sourceStartSeq and sourceEndSeq must be supplied together.'),
      );
    }
    if (segment.startedAtOffsetMs > segment.endedAtOffsetMs) {
      issues.push(semanticIssue(`${path}/endedAtOffsetMs`, 'rrweb segment ends before it starts.'));
    }
    if (segment.endedAtOffsetMs > trace.session.durationMs) {
      issues.push(semanticIssue(`${path}/endedAtOffsetMs`, 'rrweb segment ends after the session duration.'));
    }
  });

  trace.attachments.forEach((attachment, index) => {
    const path = `/attachments/${index}`;
    registerUnique(ids, attachment.id, `${path}/id`, 'Logical id', issues);
  });
  trace.attachments.forEach((attachment, index) => {
    if (attachment.relatedId && !ids.has(attachment.relatedId)) {
      issues.push(
        semanticIssue(
          `/attachments/${index}/relatedId`,
          `Attachment references unknown id ${JSON.stringify(attachment.relatedId)}.`,
        ),
      );
    }
  });

  const evidencePaths = new Map<string, string>();
  for (const expected of expectedEvidenceResources(trace)) {
    registerUnique(
      evidencePaths,
      expected.path,
      `${expected.instancePath}/path`,
      'Present evidence path',
      issues,
    );
  }

  const startedAt = Date.parse(trace.session.startedAt);
  const endedAt = Date.parse(trace.session.endedAt);
  if (endedAt < startedAt) {
    issues.push(semanticIssue('/session/endedAt', 'Session ended before it started.'));
  } else if (trace.session.durationMs > endedAt - startedAt) {
    issues.push(semanticIssue('/session/durationMs', 'Active duration exceeds the session wall-clock interval.'));
  }

  const coverageGapSources = {
    semantic: 'semantic',
    rrweb: 'rrweb',
    console: 'console',
    network: 'network',
    screenshots: 'screenshot',
  } as const;
  for (const [areaName, gapSource] of Object.entries(coverageGapSources) as Array<
    [keyof BugtraceTrace['coverage'], (typeof coverageGapSources)[keyof typeof coverageGapSources]]
  >) {
    const area = trace.coverage[areaName];
    const matchingGaps = trace.captureGaps.filter(
      (gap) => gap.source === gapSource || gap.affectedSources?.includes(gapSource),
    );
    const reportedDropped = matchingGaps.reduce((sum, gap) => sum + (gap.droppedCount ?? 0), 0);
    if (area.droppedCount !== reportedDropped) {
      issues.push(
        semanticIssue(
          `/coverage/${areaName}/droppedCount`,
          `Coverage reports ${area.droppedCount} dropped occurrence(s), but matching capture gaps account for ${reportedDropped}.`,
        ),
      );
    }
    if (area.status === 'complete' && (matchingGaps.length > 0 || area.droppedCount > 0 || area.reasons.length > 0)) {
      issues.push(
        semanticIssue(
          `/coverage/${areaName}/status`,
          'Complete coverage cannot contain matching gaps, dropped occurrences, or limitation reasons.',
        ),
      );
    }
    if (area.status !== 'complete' && area.reasons.length === 0) {
      issues.push(semanticIssue(`/coverage/${areaName}/reasons`, 'Partial or off coverage requires a reason.'));
    }
  }

  trace.captureGaps.forEach((gap, index) => {
    if (gap.affectedSources && !gap.affectedSources.includes(gap.source)) {
      issues.push(
        semanticIssue(
          `/captureGaps/${index}/affectedSources`,
          'affectedSources must include the primary capture-gap source.',
        ),
      );
    }
  });

  if (trace.rrweb.status !== trace.coverage.rrweb.status) {
    issues.push(semanticIssue('/rrweb/status', 'rrweb status must match coverage.rrweb.status.'));
  }
  const presentSegments = trace.rrweb.segments.filter((segment) => segment.status === 'present');
  if (trace.rrweb.status === 'complete' && presentSegments.length === 0) {
    issues.push(semanticIssue('/rrweb/segments', 'Complete rrweb coverage requires at least one present segment.'));
  }
  if (
    trace.rrweb.status === 'complete' &&
    trace.rrweb.segments.some((segment) => segment.status !== 'present' || segment.droppedCount > 0)
  ) {
    issues.push(semanticIssue('/rrweb/segments', 'Complete rrweb coverage cannot include missing or dropped segment evidence.'));
  }
  if (trace.rrweb.status === 'off' && presentSegments.length > 0) {
    issues.push(semanticIssue('/rrweb/status', 'Off rrweb coverage cannot contain present segments.'));
  }

  const presentScreenshots = trace.screenshots.filter((screenshot) => screenshot.status === 'present');
  if (trace.coverage.screenshots.status === 'complete' && presentScreenshots.length === 0) {
    issues.push(semanticIssue('/screenshots', 'Complete screenshot coverage requires at least one present screenshot.'));
  }
  if (trace.coverage.screenshots.status === 'off' && presentScreenshots.length > 0) {
    issues.push(semanticIssue('/coverage/screenshots/status', 'Off screenshot coverage cannot contain present screenshots.'));
  }

  if (trace.privacy.captureMode === 'full-fidelity') {
    if (trace.privacy.redactionCount !== 0) {
      issues.push(semanticIssue('/privacy/redactionCount', 'Full-fidelity capture cannot report redactions.'));
    }
    findRedactedStatusPaths(trace).forEach((path) => {
      issues.push(semanticIssue(path, 'Full-fidelity capture cannot contain redacted evidence.'));
    });
    trace.network.forEach((record, index) => {
      for (const field of [
        'requestHeaders',
        'responseHeaders',
        'requestBody',
        'responseBody',
      ] as const) {
        if (record[field]?.status === 'omitted') {
          issues.push(
            semanticIssue(
              `/network/${index}/${field}/status`,
              'Full-fidelity network evidence must be captured or explicitly unavailable, not omitted.',
            ),
          );
        }
      }
    });
    trace.screenshots.forEach((screenshot, index) => {
      if (screenshot.redactionCount !== 0) {
        issues.push(
          semanticIssue(
            `/screenshots/${index}/redactionCount`,
            'Full-fidelity capture cannot report screenshot redactions.',
          ),
        );
      }
    });
  }

  return issues;
}

export function validateEvidenceResourceClosure(
  trace: BugtraceTrace,
  resources: readonly EvidenceResourceDescriptor[],
): ArtifactConsistencyIssue[] {
  const issues: ArtifactConsistencyIssue[] = [];
  const expected = expectedEvidenceResources(trace);
  const resourcesByPath = new Map<string, EvidenceResourceDescriptor>();
  const relatedIds = new Map<string, string>();

  resources.forEach((resource, index) => {
    const path = `/resources/${index}`;
    if (resourcesByPath.has(resource.path)) {
      issues.push(semanticIssue(`${path}/path`, `Duplicate bundle resource path ${JSON.stringify(resource.path)}.`));
    } else {
      resourcesByPath.set(resource.path, resource);
    }
    if (!resource.relatedId) {
      issues.push(semanticIssue(`${path}/relatedId`, 'Every supporting resource requires a related evidence id.'));
    } else {
      const prior = relatedIds.get(resource.relatedId);
      if (prior) {
        issues.push(
          semanticIssue(
            `${path}/relatedId`,
            `Evidence id ${JSON.stringify(resource.relatedId)} is already mapped by ${prior}.`,
          ),
        );
      } else {
        relatedIds.set(resource.relatedId, path);
      }
    }
  });

  const expectedPaths = new Set(expected.map((item) => item.path));
  resources.forEach((resource, index) => {
    if (!expectedPaths.has(resource.path)) {
      issues.push(semanticIssue(`/resources/${index}/path`, 'Bundle contains an orphan supporting resource.'));
    }
  });

  for (const item of expected) {
    const resource = resourcesByPath.get(item.path);
    if (!resource) {
      issues.push(
        semanticIssue(
          `${item.instancePath}/path`,
          `Present evidence has no bundle resource at ${JSON.stringify(item.path)}.`,
        ),
      );
      continue;
    }
    if (resource.purpose !== item.purpose) {
      issues.push(semanticIssue(`${item.instancePath}/path`, `Resource purpose must be ${item.purpose}.`));
    }
    if (resource.relatedId !== item.id) {
      issues.push(
        semanticIssue(
          `${item.instancePath}/id`,
          `Resource relatedId must equal evidence id ${JSON.stringify(item.id)}.`,
        ),
      );
    }
    if (resource.mimeType !== item.mimeType) {
      issues.push(
        semanticIssue(
          `${item.instancePath}/mimeType`,
          `Resource MIME ${JSON.stringify(resource.mimeType)} does not match ${JSON.stringify(item.mimeType)}.`,
        ),
      );
    }
    if (item.size !== undefined && resource.bytes.byteLength !== item.size) {
      issues.push(
        semanticIssue(
          `${item.instancePath}/size`,
          `Declared size ${item.size} does not match ${resource.bytes.byteLength} resource bytes.`,
        ),
      );
    }
    if (item.purpose === 'rrweb-segment') {
      try {
        const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(resource.bytes));
        if (!Array.isArray(parsed)) {
          issues.push(semanticIssue(item.instancePath, 'rrweb resource must contain one JSON array.'));
        } else if (parsed.length !== item.eventCount) {
          issues.push(
            semanticIssue(
              `${item.instancePath}/eventCount`,
              `Declared eventCount ${item.eventCount} does not match ${parsed.length} serialized events.`,
            ),
          );
        }
      } catch {
        issues.push(semanticIssue(item.instancePath, 'rrweb resource is not valid UTF-8 JSON.'));
      }
    }
    if (
      item.purpose === 'screenshot' &&
      ((item.mimeType === 'image/png' && !isPng(resource.bytes)) ||
        (item.mimeType === 'image/webp' && !isWebp(resource.bytes)))
    ) {
      issues.push(semanticIssue(item.instancePath, `Screenshot bytes do not match ${item.mimeType}.`));
    }
  }

  return issues;
}

export function purposeForEvidencePath(
  trace: BugtraceTrace,
  path: string,
): BundleEntryPurpose | undefined {
  return expectedEvidenceResources(trace).find((item) => item.path === path)?.purpose;
}
