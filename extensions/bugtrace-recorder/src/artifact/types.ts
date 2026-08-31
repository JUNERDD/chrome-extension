export const BUGTRACE_FORMAT = 'bugtrace' as const;
export const BUGTRACE_FORMAT_VERSION = '1.1.0' as const;
export const BUGTRACE_BUNDLE_FORMAT = 'bugtrace-bundle' as const;
export const BUGTRACE_BUNDLE_VERSION = '1.1.0' as const;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type MissingEvidenceStatus =
  | 'unavailable'
  | 'redacted'
  | 'omitted'
  | 'unsupported'
  | 'truncated'
  | 'error';

export type EvidenceStatus = 'present' | MissingEvidenceStatus;

export interface MissingEvidence {
  status: MissingEvidenceStatus;
  reason: string;
}

export type UntrustedObservation =
  | {
      status: 'present';
      trust: 'untrusted_observation';
      value: string;
      originalLength?: never;
    }
  | {
      status: 'truncated';
      trust: 'untrusted_observation';
      value: string;
      originalLength: number;
    }
  | {
      status: 'redacted';
      trust: 'untrusted_observation';
      value?: never;
      originalLength?: number;
    };

export interface GeneratorInfo {
  name: string;
  version: string;
  build?: string;
  rrwebVersion?: string;
}

export type SessionState = 'completed' | 'interrupted';

export interface SessionInfo {
  id: string;
  state: SessionState;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  title?: string;
}

export interface ViewportInfo {
  width: number;
  height: number;
  devicePixelRatio: number;
}

export interface EnvironmentInfo {
  browser?: {
    name: string;
    version: string | MissingEvidence;
  };
  platform?: string;
  userAgent?: string;
  locale?: string;
  timezone?: string;
  viewport?: ViewportInfo;
}

export interface PrivacyInfo {
  localOnly: true;
  captureMode: 'full-fidelity' | 'privacy-filtered';
  inputValues: 'captured' | 'redacted';
  urlQueryValues: 'captured' | 'redacted';
  requestBodies: 'captured' | 'unavailable' | 'omitted';
  responseBodies: 'captured' | 'unavailable' | 'omitted';
  cookies: 'captured' | 'unavailable' | 'omitted';
  sensitiveHeaders: 'captured' | 'unavailable' | 'omitted';
  redactionCount: number;
  redactionCountSemantics: 'minimum_observed';
  warnings: string[];
}

export type CoverageStatus = 'complete' | 'partial' | 'off';

export interface CoverageArea {
  status: CoverageStatus;
  droppedCount: number;
  reasons: string[];
}

export interface CaptureCoverage {
  semantic: CoverageArea;
  rrweb: CoverageArea;
  console: CoverageArea;
  network: CoverageArea;
  screenshots: CoverageArea;
}

export interface TabRecord {
  id: string;
  windowId: string;
  openerTabId?: string;
  initialUrl: string;
  finalUrl?: string;
  title?: UntrustedObservation | MissingEvidence;
  openedAtOffsetMs: number;
  closedAtOffsetMs?: number;
  status: 'open' | 'closed' | 'unavailable';
}

export interface ViewportRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LocatorCandidate {
  strategy:
    | 'test-id'
    | 'role-name'
    | 'id'
    | 'name'
    | 'label'
    | 'attributes'
    | 'css'
    | 'xpath';
  value: string;
  confidence: number;
}

export interface TargetDescriptor {
  trust: 'untrusted_observation';
  tagName: string;
  role?: string;
  accessibleName?: UntrustedObservation | MissingEvidence;
  text?: UntrustedObservation | MissingEvidence;
  locators: LocatorCandidate[];
  framePath: string[];
  shadowPath: string[];
  rect?: ViewportRect;
}

export interface RedactedInputInfo {
  status: 'redacted';
  inputType: string;
  lengthBucket?: 'empty' | '1-4' | '5-8' | '9-16' | '17+';
}

export interface CapturedInputInfo {
  status: 'captured';
  inputType: string;
  value: JsonValue;
}

export type InputInfo = CapturedInputInfo | RedactedInputInfo;

export type StepAction =
  | 'click'
  | 'double_click'
  | 'context_menu'
  | 'fill'
  | 'change'
  | 'select'
  | 'check'
  | 'uncheck'
  | 'submit'
  | 'shortcut'
  | 'scroll'
  | 'drag_drop';

export type ModifierKey = 'Alt' | 'Control' | 'Meta' | 'Shift';

export interface ScrollPosition {
  x: number;
  y: number;
}

export interface DroppedFileInfo {
  mimeType: string;
  size?: number;
  name?: string;
  lastModified?: number;
  relativePath?: string;
}

export interface SemanticStep {
  id: string;
  seq: number;
  sourceSeq?: number;
  offsetMs: number;
  tabId: string;
  frameId?: string;
  documentId?: string;
  action: StepAction;
  target?: TargetDescriptor | MissingEvidence;
  observation?: UntrustedObservation | MissingEvidence;
  input?: InputInfo;
  key?: string;
  modifiers?: ModifierKey[];
  mouseButton?: 0 | 1 | 2 | 3 | 4;
  scroll?: ScrollPosition;
  files?: DroppedFileInfo[];
  selectedCount?: number;
}

export type NavigationPhase =
  | 'started'
  | 'committed'
  | 'completed'
  | 'failed'
  | 'history_state'
  | 'fragment_updated'
  | 'observed';

export type NavigationOutcome = 'pending' | 'completed' | 'failed';

export interface NavigationRecord {
  id: string;
  seq: number;
  sourceSeq?: number;
  offsetMs: number;
  tabId: string;
  frameId?: string;
  kind: 'document' | 'history' | 'hash' | 'reload' | 'back_forward' | 'new_tab';
  phase: NavigationPhase;
  outcome: NavigationOutcome;
  url: string;
  title?: UntrustedObservation | MissingEvidence;
  transitionType?: string;
  error?: UntrustedObservation | MissingEvidence;
}

export interface ConsoleRecord {
  id: string;
  seq: number;
  sourceSeq?: number;
  offsetMs: number;
  tabId: string;
  frameId?: string;
  level: 'warn' | 'error';
  message: UntrustedObservation | MissingEvidence;
  repeatCount: number;
}

export interface NetworkRecord {
  id: string;
  seq: number;
  sourceSeq?: number;
  offsetMs: number;
  tabId: string;
  method: string;
  url: string;
  resourceType: string;
  outcome: 'completed' | 'failed' | 'redirected';
  requestId?: string;
  initiator?: NetworkInitiator;
  statusCode?: number;
  durationMs?: number;
  fromCache?: boolean;
  contentType?: string | MissingEvidence;
  encodedSize?: number | MissingEvidence;
  requestHeaders?: CapturedValue | MissingEvidence;
  responseHeaders?: CapturedValue | MissingEvidence;
  requestBody?: CapturedValue | MissingEvidence;
  responseBody?: CapturedValue | MissingEvidence;
  error?: UntrustedObservation | MissingEvidence;
}

export type NetworkInitiator =
  | {
      status: 'linked';
      stepId: string;
      relation: 'temporal-predecessor';
      deltaMs: number;
    }
  | {
      status: 'unavailable';
      reason: string;
    };

export interface CapturedValue {
  status: 'captured';
  value: JsonValue;
  encoding?: string;
}

export interface ErrorRecord {
  id: string;
  seq: number;
  sourceSeq?: number;
  offsetMs: number;
  tabId: string;
  frameId?: string;
  kind: 'window_error' | 'unhandled_rejection' | 'resource_error' | 'capture_error';
  message: UntrustedObservation | MissingEvidence;
  stack?: UntrustedObservation | MissingEvidence;
  sourceUrl?: string | MissingEvidence;
}

interface ScreenshotRecordBase {
  id: string;
  seq: number;
  sourceSeq?: number;
  offsetMs: number;
  tabId: string;
  trigger: 'manual' | 'error' | 'navigation' | 'stop';
  redactionCount: number;
}

export type ScreenshotRecord =
  | (ScreenshotRecordBase & {
      status: 'present';
      path: string;
      mimeType: 'image/webp' | 'image/png';
      width: number;
      height: number;
      reason?: never;
    })
  | (ScreenshotRecordBase & {
      status: MissingEvidenceStatus;
      path?: never;
      mimeType?: never;
      width?: never;
      height?: never;
      reason: string;
    });

interface RrwebSegmentRecordBase {
  id: string;
  tabId: string;
  frameId?: string;
  startSeq: number;
  endSeq: number;
  sourceStartSeq?: number;
  sourceEndSeq?: number;
  startedAtOffsetMs: number;
  endedAtOffsetMs: number;
  eventCount: number;
  droppedCount: number;
}

export type RrwebSegmentRecord =
  | (RrwebSegmentRecordBase & {
      status: 'present';
      path: string;
      reason?: never;
    })
  | (RrwebSegmentRecordBase & {
      status: MissingEvidenceStatus;
      path?: never;
      reason: string;
    });

export interface RrwebEvidence {
  status: CoverageStatus;
  segments: RrwebSegmentRecord[];
}

export type CaptureGapSource =
  | 'semantic'
  | 'rrweb'
  | 'console'
  | 'network'
  | 'screenshot'
  | 'navigation'
  | 'scope'
  | 'lifecycle';

export interface CaptureGap {
  id: string;
  seq: number;
  sourceSeq?: number;
  offsetMs: number;
  source: CaptureGapSource;
  affectedSources?: CaptureGapSource[];
  status: MissingEvidenceStatus;
  reason: string;
  tabId?: string;
  frameId?: string;
  droppedCount?: number;
  observation?: UntrustedObservation;
}

interface AttachmentRecordBase {
  id: string;
  purpose: string;
  relatedId?: string;
}

export type AttachmentRecord =
  | (AttachmentRecordBase & {
      status: 'present';
      path: string;
      mimeType: string;
      size: number;
      reason?: never;
    })
  | (AttachmentRecordBase & {
      status: MissingEvidenceStatus;
      path?: never;
      mimeType?: never;
      size?: never;
      reason: string;
    });

export interface BugtraceTrace {
  format: typeof BUGTRACE_FORMAT;
  formatVersion: typeof BUGTRACE_FORMAT_VERSION;
  generator: GeneratorInfo;
  session: SessionInfo;
  environment: EnvironmentInfo;
  privacy: PrivacyInfo;
  coverage: CaptureCoverage;
  tabs: TabRecord[];
  steps: SemanticStep[];
  navigations: NavigationRecord[];
  console: ConsoleRecord[];
  network: NetworkRecord[];
  errors: ErrorRecord[];
  screenshots: ScreenshotRecord[];
  rrweb: RrwebEvidence;
  captureGaps: CaptureGap[];
  attachments: AttachmentRecord[];
}

export interface BugtraceReportFields {
  title?: string;
  summary?: string;
  expected?: string;
  actual?: string;
  preconditions?: string;
  notes?: string;
}

export type BundleEntryPurpose =
  | 'trace'
  | 'schema'
  | 'report'
  | 'rrweb-segment'
  | 'screenshot'
  | 'attachment';

export type ArtifactEntryData = string | Uint8Array | ArrayBuffer | Blob;

export interface BundleResourceInput {
  path: string;
  data: ArtifactEntryData;
  mimeType: string;
  purpose: Exclude<BundleEntryPurpose, 'trace' | 'schema' | 'report'>;
  relatedId: string;
}

export interface BundleManifestEntry {
  path: string;
  mimeType: string;
  size: number;
  compressedSize: number;
  sha256: string;
  purpose: BundleEntryPurpose;
  relatedId?: string;
}

export interface BugtraceBundleManifest {
  format: typeof BUGTRACE_BUNDLE_FORMAT;
  formatVersion: typeof BUGTRACE_BUNDLE_VERSION;
  traceFormat: typeof BUGTRACE_FORMAT;
  traceFormatVersion: typeof BUGTRACE_FORMAT_VERSION;
  sessionId: string;
  createdAt: string;
  entries: BundleManifestEntry[];
}

export interface BuildBugtraceZipInput {
  trace: BugtraceTrace;
  report?: BugtraceReportFields;
  resources?: readonly BundleResourceInput[];
  createdAt?: string;
  compressionLevel?: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
}

export interface BuiltBugtraceZip {
  bytes: Uint8Array;
  manifest: BugtraceBundleManifest;
  report: string;
  trace: BugtraceTrace;
  filename: string;
}

export interface BugtraceZipVerificationLimits {
  maxArchiveBytes?: number;
  maxEntries?: number;
  maxEntryUncompressedBytes?: number;
  maxTotalUncompressedBytes?: number;
  maxCompressionRatio?: number;
}

export interface VerifiedBugtraceZip {
  manifest: BugtraceBundleManifest;
  trace: BugtraceTrace;
  report: string;
  entryCount: number;
  totalUncompressedBytes: number;
}
