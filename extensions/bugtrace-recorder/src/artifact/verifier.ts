import JSZip from 'jszip';

import { sha256Hex } from './bundle';
import { BUGTRACE_V1_SCHEMA_JSON } from './schema';
import {
  assertArtifactConsistency,
  validateEvidenceResourceClosure,
  type EvidenceResourceDescriptor,
} from './semantic';
import {
  BUGTRACE_BUNDLE_FORMAT,
  BUGTRACE_BUNDLE_VERSION,
  BUGTRACE_FORMAT,
  BUGTRACE_FORMAT_VERSION,
  type ArtifactEntryData,
  type BugtraceBundleManifest,
  type BugtraceTrace,
  type BugtraceZipVerificationLimits,
  type BundleEntryPurpose,
  type BundleManifestEntry,
  type VerifiedBugtraceZip,
} from './types';
import { assertValidTrace } from './validate';

const MANIFEST_PATH = 'manifest.json';
const TRACE_PATH = 'trace.json';
const REPORT_PATH = 'report.md';
const SCHEMA_PATH = 'schema/bugtrace-v1.schema.json';
const SAFE_ARCHIVE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]+$/;
const SAFE_MIME_TYPE = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/;
const SAFE_LOGICAL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

const CORE_ENTRIES = new Map<string, { mimeType: string; purpose: BundleEntryPurpose }>([
  [TRACE_PATH, { mimeType: 'application/json', purpose: 'trace' }],
  [REPORT_PATH, { mimeType: 'text/markdown', purpose: 'report' }],
  [SCHEMA_PATH, { mimeType: 'application/schema+json', purpose: 'schema' }],
]);

const DEFAULT_LIMITS = {
  maxArchiveBytes: 128 * 1024 * 1024,
  maxEntries: 10_004,
  maxEntryUncompressedBytes: 64 * 1024 * 1024,
  maxTotalUncompressedBytes: 256 * 1024 * 1024,
  maxCompressionRatio: 1_000,
} as const;

interface ResolvedLimits {
  maxArchiveBytes: number;
  maxEntries: number;
  maxEntryUncompressedBytes: number;
  maxTotalUncompressedBytes: number;
  maxCompressionRatio: number;
}

interface CentralDirectoryEntry {
  path: string;
  compressedSize: number;
  size: number;
}

interface CentralDirectory {
  entries: Map<string, CentralDirectoryEntry>;
  totalUncompressedBytes: number;
}

export class BugtraceBundleVerificationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'BugtraceBundleVerificationError';
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new BugtraceBundleVerificationError(code, message);
}

function resolveLimits(overrides: BugtraceZipVerificationLimits = {}): ResolvedLimits {
  const limits = { ...DEFAULT_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits).filter(
    ([key]) => key !== 'maxCompressionRatio',
  )) {
    if (!Number.isFinite(value) || value <= 0 || !Number.isInteger(value)) {
      throw new RangeError(`${name} must be a positive integer.`);
    }
  }
  if (!Number.isFinite(limits.maxCompressionRatio) || limits.maxCompressionRatio <= 0) {
    throw new RangeError('maxCompressionRatio must be a positive finite number.');
  }
  return limits;
}

async function toArchiveBytes(data: ArtifactEntryData): Promise<Uint8Array> {
  if (typeof data === 'string') {
    fail('invalid-input', 'A Bugtrace ZIP must be supplied as binary data.');
  }
  if (data instanceof Uint8Array) return new Uint8Array(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data.slice(0));
  if (typeof Blob !== 'undefined' && data instanceof Blob) {
    return new Uint8Array(await data.arrayBuffer());
  }
  fail('invalid-input', 'Unsupported Bugtrace ZIP input.');
}

function readUint16(view: DataView, offset: number): number {
  if (offset < 0 || offset + 2 > view.byteLength) fail('malformed-zip', 'ZIP metadata is truncated.');
  return view.getUint16(offset, true);
}

function readUint32(view: DataView, offset: number): number {
  if (offset < 0 || offset + 4 > view.byteLength) fail('malformed-zip', 'ZIP metadata is truncated.');
  return view.getUint32(offset, true);
}

function findEndOfCentralDirectory(view: DataView): number {
  if (view.byteLength < 22) fail('malformed-zip', 'ZIP is too short.');
  const minimumOffset = Math.max(0, view.byteLength - 65_557);
  for (let offset = view.byteLength - 22; offset >= minimumOffset; offset -= 1) {
    if (readUint32(view, offset) !== 0x06054b50) continue;
    const commentLength = readUint16(view, offset + 20);
    if (offset + 22 + commentLength === view.byteLength) return offset;
  }
  fail('malformed-zip', 'ZIP has no valid end-of-central-directory record.');
}

function parseCentralDirectory(bytes: Uint8Array, limits: ResolvedLimits): CentralDirectory {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const endOffset = findEndOfCentralDirectory(view);
  if (readUint16(view, endOffset + 4) !== 0 || readUint16(view, endOffset + 6) !== 0) {
    fail('unsupported-zip', 'Multi-disk ZIP archives are not supported.');
  }
  const diskEntryCount = readUint16(view, endOffset + 8);
  const entryCount = readUint16(view, endOffset + 10);
  if (entryCount === 0xffff || diskEntryCount !== entryCount) {
    fail('unsupported-zip', 'ZIP64 or inconsistent entry counts are not supported.');
  }
  if (entryCount > limits.maxEntries) {
    fail('entry-limit', `ZIP contains ${entryCount} entries; limit is ${limits.maxEntries}.`);
  }
  const centralSize = readUint32(view, endOffset + 12);
  const centralOffset = readUint32(view, endOffset + 16);
  if (centralOffset === 0xffffffff || centralSize === 0xffffffff) {
    fail('unsupported-zip', 'ZIP64 archives are not supported.');
  }
  if (centralOffset + centralSize !== endOffset) {
    fail('malformed-zip', 'ZIP central-directory bounds are inconsistent.');
  }

  const decoder = new TextDecoder('utf-8', { fatal: true });
  const entries = new Map<string, CentralDirectoryEntry>();
  let totalUncompressedBytes = 0;
  let offset = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > endOffset || readUint32(view, offset) !== 0x02014b50) {
      fail('malformed-zip', 'ZIP central directory is malformed.');
    }
    const flags = readUint16(view, offset + 8);
    const compressionMethod = readUint16(view, offset + 10);
    const compressedSize = readUint32(view, offset + 20);
    const size = readUint32(view, offset + 24);
    const fileNameLength = readUint16(view, offset + 28);
    const extraLength = readUint16(view, offset + 30);
    const commentLength = readUint16(view, offset + 32);
    const localHeaderOffset = readUint32(view, offset + 42);
    const nextOffset = offset + 46 + fileNameLength + extraLength + commentLength;
    if (nextOffset > endOffset) fail('malformed-zip', 'ZIP central-directory entry is truncated.');
    if ((flags & 0x1) !== 0 || (flags & 0x40) !== 0) {
      fail('unsupported-zip', 'Encrypted ZIP entries are not supported.');
    }
    if (compressionMethod !== 0 && compressionMethod !== 8) {
      fail('unsupported-zip', `ZIP compression method ${compressionMethod} is not supported.`);
    }
    if (compressedSize === 0xffffffff || size === 0xffffffff || localHeaderOffset === 0xffffffff) {
      fail('unsupported-zip', 'ZIP64 entries are not supported.');
    }
    if (localHeaderOffset + 4 > centralOffset || readUint32(view, localHeaderOffset) !== 0x04034b50) {
      fail('malformed-zip', 'ZIP local-header reference is invalid.');
    }
    let path: string;
    try {
      path = decoder.decode(bytes.subarray(offset + 46, offset + 46 + fileNameLength));
    } catch {
      fail('unsafe-path', 'ZIP entry name is not valid UTF-8.');
    }
    if (!SAFE_ARCHIVE_PATH.test(path) || path.endsWith('/')) {
      fail('unsafe-path', `Unsafe ZIP entry path: ${JSON.stringify(path)}.`);
    }
    if (entries.has(path)) fail('duplicate-entry', `Duplicate ZIP entry path: ${path}.`);
    if (size > limits.maxEntryUncompressedBytes) {
      fail('entry-size-limit', `${path} exceeds the uncompressed entry-size limit.`);
    }
    const compressionRatio = size === 0 ? 1 : size / Math.max(1, compressedSize);
    if (compressionRatio > limits.maxCompressionRatio) {
      fail('compression-ratio-limit', `${path} exceeds the compression-ratio limit.`);
    }
    totalUncompressedBytes += size;
    if (totalUncompressedBytes > limits.maxTotalUncompressedBytes) {
      fail('total-size-limit', 'ZIP exceeds the aggregate uncompressed-size limit.');
    }
    entries.set(path, { path, compressedSize, size });
    offset = nextOffset;
  }
  if (offset !== endOffset) fail('malformed-zip', 'ZIP central directory has unparsed data.');
  return { entries, totalUncompressedBytes };
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('invalid-manifest', `${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allowedSet = new Set(allowed);
  const extra = Object.keys(value).find((key) => !allowedSet.has(key));
  if (extra) fail('invalid-manifest', `${label} has undeclared property ${JSON.stringify(extra)}.`);
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== 'string') fail('invalid-manifest', `${label} must be a string.`);
  return value;
}

function integerValue(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    fail('invalid-manifest', `${label} must be a non-negative safe integer.`);
  }
  return value as number;
}

function parseManifest(input: unknown, limits: ResolvedLimits): BugtraceBundleManifest {
  const value = objectValue(input, 'manifest');
  exactKeys(
    value,
    ['format', 'formatVersion', 'traceFormat', 'traceFormatVersion', 'sessionId', 'createdAt', 'entries'],
    'manifest',
  );
  if (value.format !== BUGTRACE_BUNDLE_FORMAT || value.formatVersion !== BUGTRACE_BUNDLE_VERSION) {
    fail('unsupported-format', 'Unsupported Bugtrace bundle format or version.');
  }
  if (value.traceFormat !== BUGTRACE_FORMAT || value.traceFormatVersion !== BUGTRACE_FORMAT_VERSION) {
    fail('unsupported-format', 'Unsupported Bugtrace trace format or version.');
  }
  const sessionId = stringValue(value.sessionId, 'manifest.sessionId');
  if (!SAFE_LOGICAL_ID.test(sessionId) || sessionId.length > 128) {
    fail('invalid-manifest', 'manifest.sessionId is not a logical id.');
  }
  const createdAt = stringValue(value.createdAt, 'manifest.createdAt');
  if (!ISO_DATE_TIME.test(createdAt) || !Number.isFinite(Date.parse(createdAt))) {
    fail('invalid-manifest', 'manifest.createdAt is not an ISO timestamp.');
  }
  if (!Array.isArray(value.entries) || value.entries.length > limits.maxEntries - 1) {
    fail('invalid-manifest', 'manifest.entries is missing or exceeds the entry limit.');
  }
  const seenPaths = new Set<string>();
  const entries: BundleManifestEntry[] = value.entries.map((entryValue, index) => {
    const entry = objectValue(entryValue, `manifest.entries[${index}]`);
    exactKeys(
      entry,
      ['path', 'mimeType', 'size', 'compressedSize', 'sha256', 'purpose', 'relatedId'],
      `manifest.entries[${index}]`,
    );
    const path = stringValue(entry.path, `manifest.entries[${index}].path`);
    if (!SAFE_ARCHIVE_PATH.test(path) || path.endsWith('/') || path === MANIFEST_PATH) {
      fail('invalid-manifest', `Invalid manifest entry path ${JSON.stringify(path)}.`);
    }
    if (seenPaths.has(path)) fail('invalid-manifest', `Duplicate manifest entry path ${path}.`);
    seenPaths.add(path);
    const mimeType = stringValue(entry.mimeType, `manifest.entries[${index}].mimeType`);
    if (!SAFE_MIME_TYPE.test(mimeType)) fail('invalid-manifest', `Invalid MIME type for ${path}.`);
    const purpose = stringValue(entry.purpose, `manifest.entries[${index}].purpose`);
    if (!['trace', 'schema', 'report', 'rrweb-segment', 'screenshot', 'attachment'].includes(purpose)) {
      fail('invalid-manifest', `Invalid purpose for ${path}.`);
    }
    const sha256 = stringValue(entry.sha256, `manifest.entries[${index}].sha256`);
    if (!SHA256_HEX.test(sha256)) fail('invalid-manifest', `Invalid SHA-256 digest for ${path}.`);
    const relatedId = entry.relatedId === undefined
      ? undefined
      : stringValue(entry.relatedId, `manifest.entries[${index}].relatedId`);
    if (relatedId !== undefined && (!SAFE_LOGICAL_ID.test(relatedId) || relatedId.length > 128)) {
      fail('invalid-manifest', `Invalid relatedId for ${path}.`);
    }
    return {
      path,
      mimeType,
      size: integerValue(entry.size, `manifest.entries[${index}].size`),
      compressedSize: integerValue(
        entry.compressedSize,
        `manifest.entries[${index}].compressedSize`,
      ),
      sha256,
      purpose: purpose as BundleEntryPurpose,
      ...(relatedId === undefined ? {} : { relatedId }),
    };
  });
  return {
    format: BUGTRACE_BUNDLE_FORMAT,
    formatVersion: BUGTRACE_BUNDLE_VERSION,
    traceFormat: BUGTRACE_FORMAT,
    traceFormatVersion: BUGTRACE_FORMAT_VERSION,
    sessionId,
    createdAt,
    entries,
  };
}

function decodeUtf8(bytes: Uint8Array, path: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    fail('invalid-text', `${path} is not valid UTF-8.`);
  }
}

function parseJson(bytes: Uint8Array, path: string): unknown {
  try {
    return JSON.parse(decodeUtf8(bytes, path)) as unknown;
  } catch (error) {
    if (error instanceof BugtraceBundleVerificationError) throw error;
    fail('invalid-json', `${path} is not valid JSON.`);
  }
}

function validateManifestEntryKind(entry: BundleManifestEntry): void {
  const core = CORE_ENTRIES.get(entry.path);
  if (core) {
    if (entry.purpose !== core.purpose || entry.mimeType !== core.mimeType || entry.relatedId !== undefined) {
      fail('invalid-manifest', `Core metadata for ${entry.path} is inconsistent.`);
    }
    return;
  }
  const expectedPrefix: Partial<Record<BundleEntryPurpose, string>> = {
    'rrweb-segment': 'rrweb/',
    screenshot: 'screenshots/',
    attachment: 'attachments/',
  };
  const prefix = expectedPrefix[entry.purpose];
  if (!prefix || !entry.path.startsWith(prefix) || entry.relatedId === undefined) {
    fail('invalid-manifest', `Supporting metadata for ${entry.path} is inconsistent.`);
  }
  if (entry.purpose === 'rrweb-segment' && entry.mimeType !== 'application/json') {
    fail('invalid-manifest', `${entry.path} must use application/json.`);
  }
  if (entry.purpose === 'screenshot' && !['image/png', 'image/webp'].includes(entry.mimeType)) {
    fail('invalid-manifest', `${entry.path} has an unsupported screenshot MIME type.`);
  }
}

/**
 * Verifies an untrusted Bugtrace ZIP without network access. Archive bounds are checked before any
 * entry is inflated; hashes, format metadata, semantic references, and evidence closure are then
 * checked against the extracted bytes.
 */
export async function verifyBugtraceZip(
  data: ArtifactEntryData,
  limitOverrides: BugtraceZipVerificationLimits = {},
): Promise<VerifiedBugtraceZip> {
  const limits = resolveLimits(limitOverrides);
  const bytes = await toArchiveBytes(data);
  if (bytes.byteLength > limits.maxArchiveBytes) {
    fail('archive-size-limit', `ZIP exceeds the ${limits.maxArchiveBytes}-byte archive limit.`);
  }
  const central = parseCentralDirectory(bytes, limits);
  if (!central.entries.has(MANIFEST_PATH)) fail('missing-manifest', 'ZIP is missing manifest.json.');

  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes, { createFolders: false });
  } catch {
    fail('malformed-zip', 'ZIP payload cannot be decoded.');
  }
  const zipPaths = Object.keys(zip.files);
  if (
    zipPaths.length !== central.entries.size ||
    zipPaths.some((path) => !central.entries.has(path) || zip.files[path]?.dir)
  ) {
    fail('entry-mismatch', 'ZIP extractor and central directory disagree about file entries.');
  }

  const manifestFile = zip.file(MANIFEST_PATH);
  if (!manifestFile) fail('missing-manifest', 'ZIP is missing manifest.json.');
  const manifestBytes = await manifestFile.async('uint8array');
  const manifest = parseManifest(parseJson(manifestBytes, MANIFEST_PATH), limits);
  if (manifest.entries.length + 1 !== central.entries.size) {
    fail('entry-mismatch', 'Manifest does not describe every non-manifest ZIP entry exactly once.');
  }

  const payloads = new Map<string, Uint8Array>();
  for (const entry of manifest.entries) {
    validateManifestEntryKind(entry);
    const centralEntry = central.entries.get(entry.path);
    const file = zip.file(entry.path);
    if (!centralEntry || !file) fail('entry-mismatch', `Manifest entry ${entry.path} is missing.`);
    if (centralEntry.size !== entry.size || centralEntry.compressedSize !== entry.compressedSize) {
      fail('metadata-mismatch', `ZIP sizes do not match the manifest for ${entry.path}.`);
    }
    const payload = await file.async('uint8array');
    if (payload.byteLength !== entry.size) {
      fail('metadata-mismatch', `Inflated size does not match the manifest for ${entry.path}.`);
    }
    if ((await sha256Hex(payload)) !== entry.sha256) {
      fail('hash-mismatch', `SHA-256 does not match the manifest for ${entry.path}.`);
    }
    payloads.set(entry.path, payload);
  }
  for (const path of central.entries.keys()) {
    if (path !== MANIFEST_PATH && !payloads.has(path)) {
      fail('entry-mismatch', `ZIP entry ${path} is not listed in the manifest.`);
    }
  }
  for (const corePath of CORE_ENTRIES.keys()) {
    if (!payloads.has(corePath)) fail('missing-core-entry', `ZIP is missing ${corePath}.`);
  }

  const schemaText = decodeUtf8(payloads.get(SCHEMA_PATH)!, SCHEMA_PATH);
  if (schemaText !== BUGTRACE_V1_SCHEMA_JSON) {
    fail('schema-mismatch', 'Bundled schema is not the canonical Bugtrace 1.1 schema.');
  }
  const traceValue = parseJson(payloads.get(TRACE_PATH)!, TRACE_PATH);
  assertValidTrace(traceValue);
  const trace = traceValue as BugtraceTrace;
  if (trace.session.id !== manifest.sessionId) {
    fail('session-mismatch', 'Manifest sessionId does not match trace.json.');
  }
  const report = decodeUtf8(payloads.get(REPORT_PATH)!, REPORT_PATH);
  if (!report.startsWith('# Bug reproduction: ') || !report.includes('Prompt-injection warning')) {
    fail('invalid-report', 'report.md is not the agent-oriented Bugtrace report format.');
  }

  const supportResources: EvidenceResourceDescriptor[] = manifest.entries
    .filter(
      (entry): entry is BundleManifestEntry & {
        purpose: 'rrweb-segment' | 'screenshot' | 'attachment';
        relatedId: string;
      } => !CORE_ENTRIES.has(entry.path),
    )
    .map((entry) => ({
      path: entry.path,
      bytes: payloads.get(entry.path)!,
      mimeType: entry.mimeType,
      purpose: entry.purpose,
      relatedId: entry.relatedId,
    }));
  assertArtifactConsistency(validateEvidenceResourceClosure(trace, supportResources));

  return {
    manifest,
    trace,
    report,
    entryCount: central.entries.size,
    totalUncompressedBytes: central.totalUncompressedBytes,
  };
}
