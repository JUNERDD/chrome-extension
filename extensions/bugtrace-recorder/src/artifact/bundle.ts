import JSZip from 'jszip';
import { buildMarkdownReport } from './markdown';
import { BUGTRACE_V1_SCHEMA_JSON } from './schema';
import {
  assertArtifactConsistency,
  validateEvidenceResourceClosure,
} from './semantic';
import {
  BUGTRACE_BUNDLE_FORMAT,
  BUGTRACE_BUNDLE_VERSION,
  BUGTRACE_FORMAT,
  BUGTRACE_FORMAT_VERSION,
  type ArtifactEntryData,
  type BugtraceBundleManifest,
  type BuildBugtraceZipInput,
  type BuiltBugtraceZip,
  type BundleEntryPurpose,
  type BundleManifestEntry,
  type BundleResourceInput,
} from './types';
import { assertValidTrace } from './validate';

const MANIFEST_PATH = 'manifest.json';
const TRACE_PATH = 'trace.json';
const REPORT_PATH = 'report.md';
const SCHEMA_PATH = 'schema/bugtrace-v1.schema.json';
const RESERVED_PATHS = new Set([MANIFEST_PATH, TRACE_PATH, REPORT_PATH, SCHEMA_PATH]);
const SAFE_ARCHIVE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]+$/;
const SAFE_MIME_TYPE = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/;
const SAFE_LOGICAL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const MAX_RESOURCE_COUNT = 10_000;
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_ENTRY_BYTES = 240 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;

interface PreparedEntry {
  path: string;
  bytes: Uint8Array;
  mimeType: string;
  purpose: BundleEntryPurpose;
  relatedId?: string;
}

interface PreparedResourceEntry extends PreparedEntry {
  purpose: BundleResourceInput['purpose'];
  relatedId: string;
}

interface ZipEntrySize {
  compressedSize: number;
  size: number;
}

function sanitizeZipDate(date: Date): Date {
  const earliestZipTime = Date.UTC(1980, 0, 1);
  const latestZipTime = Date.UTC(2107, 11, 31, 23, 59, 58);
  return new Date(Math.min(latestZipTime, Math.max(earliestZipTime, date.getTime())));
}

async function toBytes(data: ArtifactEntryData): Promise<Uint8Array> {
  if (typeof data === 'string') {
    return new TextEncoder().encode(data);
  }
  if (data instanceof Uint8Array) {
    const copy = new Uint8Array(data.byteLength);
    copy.set(data);
    return copy;
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data.slice(0));
  }
  if (typeof Blob !== 'undefined' && data instanceof Blob) {
    return new Uint8Array(await data.arrayBuffer());
  }
  throw new TypeError('Unsupported artifact entry data.');
}

export async function sha256Hex(data: Uint8Array | ArrayBuffer | string): Promise<string> {
  const bytes = await toBytes(data);
  if (!globalThis.crypto?.subtle) {
    throw new Error('Web Crypto SHA-256 is unavailable in this runtime.');
  }
  const ownedBytes = new Uint8Array(bytes.byteLength);
  ownedBytes.set(bytes);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', ownedBytes.buffer);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function validateResource(resource: BundleResourceInput): void {
  if (!SAFE_ARCHIVE_PATH.test(resource.path) || resource.path.endsWith('/')) {
    throw new TypeError(`Unsafe Bugtrace archive path: ${resource.path}`);
  }
  if (RESERVED_PATHS.has(resource.path)) {
    throw new TypeError(`Bugtrace archive path is reserved: ${resource.path}`);
  }
  if (!SAFE_MIME_TYPE.test(resource.mimeType)) {
    throw new TypeError(`Invalid MIME type for ${resource.path}.`);
  }
  if (!SAFE_LOGICAL_ID.test(resource.relatedId) || resource.relatedId.length > 128) {
    throw new TypeError(`Invalid related evidence id for ${resource.path}.`);
  }

  const expectedPrefix: Readonly<Record<BundleResourceInput['purpose'], string>> = {
    'rrweb-segment': 'rrweb/',
    screenshot: 'screenshots/',
    attachment: 'attachments/',
  };
  if (!resource.path.startsWith(expectedPrefix[resource.purpose])) {
    throw new TypeError(
      `${resource.purpose} entries must be stored under ${expectedPrefix[resource.purpose]}`,
    );
  }
  if (resource.purpose === 'rrweb-segment' && resource.mimeType !== 'application/json') {
    throw new TypeError('rrweb segment entries must use application/json.');
  }
  if (resource.purpose === 'screenshot' && !resource.mimeType.startsWith('image/')) {
    throw new TypeError('Screenshot entries must use an image MIME type.');
  }
}

async function prepareResource(resource: BundleResourceInput): Promise<PreparedResourceEntry> {
  validateResource(resource);
  const bytes = await toBytes(resource.data);
  if (bytes.byteLength > MAX_ENTRY_BYTES) {
    throw new RangeError(
      `Bugtrace resource ${resource.path} exceeds the ${MAX_ENTRY_BYTES}-byte limit.`,
    );
  }
  return {
    path: resource.path,
    bytes,
    mimeType: resource.mimeType,
    purpose: resource.purpose,
    relatedId: resource.relatedId,
  };
}

function createZip(
  entries: readonly PreparedEntry[],
  zipDate: Date,
  manifestJson?: string,
): JSZip {
  const zip = new JSZip();
  for (const entry of entries) {
    zip.file(entry.path, entry.bytes, {
      binary: true,
      createFolders: false,
      date: zipDate,
      compression: 'DEFLATE',
    });
  }
  if (manifestJson !== undefined) {
    zip.file(MANIFEST_PATH, manifestJson, {
      createFolders: false,
      date: zipDate,
      compression: 'DEFLATE',
    });
  }
  return zip;
}

async function generateZip(
  entries: readonly PreparedEntry[],
  zipDate: Date,
  compressionLevel: number,
  manifestJson?: string,
): Promise<Uint8Array> {
  return createZip(entries, zipDate, manifestJson).generateAsync({
    type: 'uint8array',
    platform: 'UNIX',
    compression: 'DEFLATE',
    compressionOptions: { level: compressionLevel },
    streamFiles: false,
  });
}

function readUint32(view: DataView, offset: number): number {
  return view.getUint32(offset, true);
}

function readUint16(view: DataView, offset: number): number {
  return view.getUint16(offset, true);
}

function findEndOfCentralDirectory(view: DataView): number {
  const minimumOffset = Math.max(0, view.byteLength - 65_557);
  for (let offset = view.byteLength - 22; offset >= minimumOffset; offset -= 1) {
    if (readUint32(view, offset) === 0x06054b50) {
      return offset;
    }
  }
  throw new Error('Generated ZIP has no end-of-central-directory record.');
}

function readZipEntrySizes(bytes: Uint8Array): Map<string, ZipEntrySize> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const endOffset = findEndOfCentralDirectory(view);
  const entryCount = readUint16(view, endOffset + 10);
  let offset = readUint32(view, endOffset + 16);
  const result = new Map<string, ZipEntrySize>();
  const decoder = new TextDecoder();

  for (let index = 0; index < entryCount; index += 1) {
    if (readUint32(view, offset) !== 0x02014b50) {
      throw new Error('Generated ZIP central directory is malformed.');
    }
    const compressedSize = readUint32(view, offset + 20);
    const size = readUint32(view, offset + 24);
    const fileNameLength = readUint16(view, offset + 28);
    const extraLength = readUint16(view, offset + 30);
    const commentLength = readUint16(view, offset + 32);
    const nameStart = offset + 46;
    const name = decoder.decode(bytes.subarray(nameStart, nameStart + fileNameLength));
    result.set(name, { compressedSize, size });
    offset = nameStart + fileNameLength + extraLength + commentLength;
  }
  return result;
}

async function createManifestEntries(
  entries: readonly PreparedEntry[],
  sizes: ReadonlyMap<string, ZipEntrySize>,
): Promise<BundleManifestEntry[]> {
  return Promise.all(
    entries.map(async (entry) => {
      const size = sizes.get(entry.path);
      if (!size || size.size !== entry.bytes.byteLength) {
        throw new Error(`Cannot determine ZIP sizes for ${entry.path}.`);
      }
      return {
        path: entry.path,
        mimeType: entry.mimeType,
        size: size.size,
        compressedSize: size.compressedSize,
        sha256: await sha256Hex(entry.bytes),
        purpose: entry.purpose,
        ...(entry.relatedId === undefined ? {} : { relatedId: entry.relatedId }),
      };
    }),
  );
}

function validateUniquePaths(entries: readonly PreparedEntry[]): void {
  const paths = new Set<string>();
  for (const entry of entries) {
    if (paths.has(entry.path)) {
      throw new Error(`Duplicate Bugtrace archive path: ${entry.path}`);
    }
    paths.add(entry.path);
  }
}

/** Builds a portable .zip containing the semantic core and optional supporting evidence. */
export async function buildBugtraceZip(input: BuildBugtraceZipInput): Promise<BuiltBugtraceZip> {
  assertValidTrace(input.trace);
  if ((input.resources?.length ?? 0) > MAX_RESOURCE_COUNT) {
    throw new RangeError(`Bugtrace bundles support at most ${MAX_RESOURCE_COUNT} resources.`);
  }

  const traceJson = `${JSON.stringify(input.trace, null, 2)}\n`;
  const report = buildMarkdownReport(input.trace, input.report);

  const coreEntries: PreparedEntry[] = [
    {
      path: REPORT_PATH,
      bytes: new TextEncoder().encode(report),
      mimeType: 'text/markdown',
      purpose: 'report',
    },
    {
      path: TRACE_PATH,
      bytes: new TextEncoder().encode(traceJson),
      mimeType: 'application/json',
      purpose: 'trace',
    },
    {
      path: SCHEMA_PATH,
      bytes: new TextEncoder().encode(BUGTRACE_V1_SCHEMA_JSON),
      mimeType: 'application/schema+json',
      purpose: 'schema',
    },
  ];
  const resources = await Promise.all(
    [...(input.resources ?? [])]
      .sort((left, right) => left.path.localeCompare(right.path))
      .map(prepareResource),
  );
  const entries = [...coreEntries, ...resources];
  const oversizedEntry = entries.find((entry) => entry.bytes.byteLength > MAX_ENTRY_BYTES);
  if (oversizedEntry) {
    throw new RangeError(
      `Bugtrace entry ${oversizedEntry.path} exceeds the ${MAX_ENTRY_BYTES}-byte limit.`,
    );
  }
  const totalEntryBytes = entries.reduce((sum, entry) => sum + entry.bytes.byteLength, 0);
  if (totalEntryBytes > MAX_TOTAL_ENTRY_BYTES) {
    throw new RangeError(
      `Bugtrace entries exceed the ${MAX_TOTAL_ENTRY_BYTES}-byte aggregate limit.`,
    );
  }
  validateUniquePaths(entries);
  assertArtifactConsistency(validateEvidenceResourceClosure(input.trace, resources));

  const createdAt = input.createdAt ?? input.trace.session.endedAt;
  const createdAtDate = new Date(createdAt);
  if (!Number.isFinite(createdAtDate.getTime())) {
    throw new TypeError('Bugtrace bundle createdAt must be a valid ISO timestamp.');
  }
  const zipDate = sanitizeZipDate(createdAtDate);
  const compressionLevel = input.compressionLevel ?? 6;
  const payloadZip = await generateZip(entries, zipDate, compressionLevel);
  const sizes = readZipEntrySizes(payloadZip);
  const manifest: BugtraceBundleManifest = {
    format: BUGTRACE_BUNDLE_FORMAT,
    formatVersion: BUGTRACE_BUNDLE_VERSION,
    traceFormat: BUGTRACE_FORMAT,
    traceFormatVersion: BUGTRACE_FORMAT_VERSION,
    sessionId: input.trace.session.id,
    createdAt,
    entries: await createManifestEntries(entries, sizes),
  };
  const manifestJson = `${JSON.stringify(manifest, null, 2)}\n`;

  const bytes = await generateZip(entries, zipDate, compressionLevel, manifestJson);
  if (bytes.byteLength > MAX_ARCHIVE_BYTES) {
    throw new RangeError(`Bugtrace ZIP exceeds the ${MAX_ARCHIVE_BYTES}-byte archive limit.`);
  }
  const finalSizes = readZipEntrySizes(bytes);
  for (const entry of manifest.entries) {
    const finalSize = finalSizes.get(entry.path);
    if (
      !finalSize ||
      finalSize.size !== entry.size ||
      finalSize.compressedSize !== entry.compressedSize
    ) {
      throw new Error(`ZIP compression metadata changed while writing ${entry.path}.`);
    }
  }

  const datePart = createdAt.slice(0, 10);
  return {
    bytes,
    manifest,
    report,
    trace: input.trace,
    filename: `bugtrace-${datePart}-${input.trace.session.id}.bugtrace.zip`,
  };
}

export function bugtraceZipBlob(bundle: BuiltBugtraceZip): Blob {
  const ownedBytes = new Uint8Array(bundle.bytes.byteLength);
  ownedBytes.set(bundle.bytes);
  return new Blob([ownedBytes.buffer], { type: 'application/zip' });
}
