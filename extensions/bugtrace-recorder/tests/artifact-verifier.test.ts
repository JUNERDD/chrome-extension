import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';

import {
  buildBugtraceZip,
  sha256Hex,
  validateTrace,
  verifyBugtraceZip,
  type BugtraceBundleManifest,
  type BugtraceTrace,
  type BundleResourceInput,
} from '../src/artifact';

const RRWEB_PATH = 'rrweb/segment-0001.json';
const RAW_TOKEN = 'Bearer raw-internal-token';

function makeFullFidelityTrace(): BugtraceTrace {
  return {
    format: 'bugtrace',
    formatVersion: '1.1.0',
    generator: { name: 'Bugtrace Recorder', version: '0.1.0', rrwebVersion: '2.1.1' },
    session: {
      id: 'session-verifier',
      state: 'completed',
      startedAt: '2026-08-18T01:00:00.000Z',
      endedAt: '2026-08-18T01:00:01.000Z',
      durationMs: 100,
    },
    environment: {},
    privacy: {
      localOnly: true,
      captureMode: 'full-fidelity',
      inputValues: 'captured',
      urlQueryValues: 'captured',
      requestBodies: 'captured',
      responseBodies: 'unavailable',
      cookies: 'unavailable',
      sensitiveHeaders: 'captured',
      redactionCount: 0,
      redactionCountSemantics: 'minimum_observed',
      warnings: [],
    },
    coverage: {
      semantic: { status: 'complete', droppedCount: 0, reasons: [] },
      rrweb: { status: 'complete', droppedCount: 0, reasons: [] },
      console: { status: 'complete', droppedCount: 0, reasons: [] },
      network: { status: 'complete', droppedCount: 0, reasons: [] },
      screenshots: { status: 'off', droppedCount: 0, reasons: ['Not requested.'] },
    },
    tabs: [
      {
        id: 'tab-1',
        windowId: 'window-1',
        initialUrl: 'https://example.test/form?token=raw-internal-token',
        openedAtOffsetMs: 0,
        status: 'open',
      },
    ],
    steps: [
      {
        id: 'step-1',
        seq: 1,
        sourceSeq: 7,
        offsetMs: 10,
        tabId: 'tab-1',
        action: 'fill',
        input: { status: 'captured', inputType: 'password', value: 'raw-password' },
      },
    ],
    navigations: [],
    console: [],
    network: [
      {
        id: 'network-1',
        seq: 2,
        sourceSeq: 8,
        offsetMs: 20,
        tabId: 'tab-1',
        method: 'POST',
        url: 'https://example.test/api?token=raw-internal-token',
        resourceType: 'fetch',
        outcome: 'completed',
        requestId: 'request-1',
        initiator: {
          status: 'linked',
          stepId: 'step-1',
          relation: 'temporal-predecessor',
          deltaMs: 10,
        },
        requestHeaders: {
          status: 'captured',
          value: { authorization: [RAW_TOKEN], 'x-duplicate': ['one', 'two'] },
        },
        requestBody: {
          status: 'captured',
          value: { encoding: 'base64', chunks: ['AAEC'] },
          encoding: 'json',
        },
        responseBody: { status: 'unavailable', reason: 'Browser API did not expose it.' },
      },
    ],
    errors: [],
    screenshots: [],
    rrweb: {
      status: 'complete',
      segments: [
        {
          id: 'segment-1',
          tabId: 'tab-1',
          startSeq: 3,
          endSeq: 3,
          sourceStartSeq: 9,
          sourceEndSeq: 9,
          startedAtOffsetMs: 25,
          endedAtOffsetMs: 25,
          eventCount: 1,
          droppedCount: 0,
          status: 'present',
          path: RRWEB_PATH,
        },
      ],
    },
    captureGaps: [],
    attachments: [],
  };
}

function rrwebResource(): BundleResourceInput {
  return {
    path: RRWEB_PATH,
    data: JSON.stringify([{ type: 3, timestamp: 25, data: { token: RAW_TOKEN } }]),
    mimeType: 'application/json',
    purpose: 'rrweb-segment',
    relatedId: 'segment-1',
  };
}

async function makeBundle() {
  return buildBugtraceZip({
    trace: makeFullFidelityTrace(),
    report: { summary: 'Raw internal evidence is intentionally retained.' },
    resources: [rrwebResource()],
  });
}

function compressedSizeOf(bytes: Uint8Array, requestedPath: string): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let endOffset = bytes.byteLength - 22;
  while (endOffset >= 0 && view.getUint32(endOffset, true) !== 0x06054b50) endOffset -= 1;
  if (endOffset < 0) throw new Error('Missing end record in test ZIP.');
  const entries = view.getUint16(endOffset + 10, true);
  let offset = view.getUint32(endOffset + 16, true);
  for (let index = 0; index < entries; index += 1) {
    const fileNameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const path = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + fileNameLength));
    if (path === requestedPath) return view.getUint32(offset + 20, true);
    offset += 46 + fileNameLength + extraLength + commentLength;
  }
  throw new Error(`Missing ${requestedPath} in test ZIP.`);
}

async function forgeTrace(
  originalBytes: Uint8Array,
  mutate: (trace: BugtraceTrace) => void,
): Promise<Uint8Array> {
  const firstZip = await JSZip.loadAsync(originalBytes);
  const trace = JSON.parse(await firstZip.file('trace.json')!.async('string')) as BugtraceTrace;
  mutate(trace);
  const traceText = `${JSON.stringify(trace, null, 2)}\n`;
  firstZip.file('trace.json', traceText);
  const firstPass = await firstZip.generateAsync({
    type: 'uint8array',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });

  const finalZip = await JSZip.loadAsync(firstPass);
  const manifest = JSON.parse(
    await finalZip.file('manifest.json')!.async('string'),
  ) as BugtraceBundleManifest;
  const traceEntry = manifest.entries.find((entry) => entry.path === 'trace.json')!;
  traceEntry.size = new TextEncoder().encode(traceText).byteLength;
  traceEntry.compressedSize = compressedSizeOf(firstPass, 'trace.json');
  traceEntry.sha256 = await sha256Hex(traceText);
  finalZip.file('manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);
  return finalZip.generateAsync({
    type: 'uint8array',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });
}

describe('offline Bugtrace ZIP verifier', () => {
  it('accepts a self-contained bundle and preserves full-fidelity values', async () => {
    const bundle = await makeBundle();
    const verified = await verifyBugtraceZip(bundle.bytes);
    const zip = await JSZip.loadAsync(bundle.bytes);

    expect(verified.manifest.formatVersion).toBe('1.1.0');
    expect(verified.entryCount).toBe(5);
    expect(verified.trace.network[0]?.requestHeaders).toMatchObject({ status: 'captured' });
    expect(await zip.file(RRWEB_PATH)?.async('string')).toContain(RAW_TOKEN);
  });

  it('rejects payload tampering against manifest hashes', async () => {
    const bundle = await makeBundle();
    const zip = await JSZip.loadAsync(bundle.bytes);
    const rrweb = await zip.file(RRWEB_PATH)!.async('string');
    zip.file(RRWEB_PATH, rrweb.replace('raw-internal-token', 'bad-internal-token'), {
      createFolders: false,
    });
    const tampered = await zip.generateAsync({
      type: 'uint8array',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 },
    });

    await expect(verifyBugtraceZip(tampered)).rejects.toMatchObject({ code: 'hash-mismatch' });
  });

  it('rejects unlisted files and mismatched evidence relationships', async () => {
    const bundle = await makeBundle();
    const extraZip = await JSZip.loadAsync(bundle.bytes);
    extraZip.file('attachments/unlisted.txt', 'unlisted', { createFolders: false });
    const withExtra = await extraZip.generateAsync({ type: 'uint8array' });
    await expect(verifyBugtraceZip(withExtra)).rejects.toMatchObject({ code: 'entry-mismatch' });

    const relationZip = await JSZip.loadAsync(bundle.bytes);
    const manifest = JSON.parse(
      await relationZip.file('manifest.json')!.async('string'),
    ) as BugtraceBundleManifest;
    manifest.entries.find((entry) => entry.path === RRWEB_PATH)!.relatedId = 'unknown-segment';
    relationZip.file('manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);
    const badRelation = await relationZip.generateAsync({
      type: 'uint8array',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 },
    });
    await expect(verifyBugtraceZip(badRelation)).rejects.toThrow('relatedId');
  });

  it('rejects semantic contradictions even when hashes and sizes are recomputed', async () => {
    const bundle = await makeBundle();
    const forged = await forgeTrace(bundle.bytes, (trace) => {
      trace.network[0]!.seq = trace.steps[0]!.seq;
    });

    await expect(verifyBugtraceZip(forged)).rejects.toThrow('Global seq 1');
  });

  it('applies archive bounds before inflation', async () => {
    const bundle = await makeBundle();

    await expect(
      verifyBugtraceZip(bundle.bytes, { maxTotalUncompressedBytes: 1 }),
    ).rejects.toMatchObject({ code: 'total-size-limit' });
    await expect(
      verifyBugtraceZip(bundle.bytes, { maxArchiveBytes: 1 }),
    ).rejects.toMatchObject({ code: 'archive-size-limit' });
    await expect(
      verifyBugtraceZip(bundle.bytes, { maxEntries: 1 }),
    ).rejects.toMatchObject({ code: 'entry-limit' });
    await expect(
      verifyBugtraceZip(bundle.bytes, { maxCompressionRatio: 1 }),
    ).rejects.toMatchObject({ code: 'compression-ratio-limit' });
  });
});

describe('Bugtrace semantic consistency', () => {
  it('rejects contradictory ids, chronology, coverage and temporal initiators', () => {
    const duplicate = makeFullFidelityTrace();
    duplicate.network[0]!.seq = 1;
    expect(validateTrace(duplicate)).toMatchObject({ valid: false });

    const chronology = makeFullFidelityTrace();
    chronology.network[0]!.offsetMs = 5;
    expect(validateTrace(chronology)).toMatchObject({ valid: false });

    const initiator = makeFullFidelityTrace();
    if (initiator.network[0]!.initiator?.status === 'linked') {
      initiator.network[0]!.initiator.deltaMs = 999;
    }
    expect(validateTrace(initiator)).toMatchObject({ valid: false });

    const coverage = makeFullFidelityTrace();
    coverage.captureGaps.push({
      id: 'gap-1',
      seq: 4,
      offsetMs: 30,
      source: 'scope',
      affectedSources: ['scope', 'network'],
      status: 'unavailable',
      reason: 'Network event was unavailable.',
      droppedCount: 1,
    });
    expect(validateTrace(coverage)).toMatchObject({ valid: false });
  });

  it('accounts for one multi-source gap without duplicating canonical seq values', () => {
    const trace = makeFullFidelityTrace();
    trace.coverage.network = {
      status: 'partial',
      droppedCount: 1,
      reasons: ['One shared capture failure affected network metadata.'],
    };
    trace.captureGaps.push({
      id: 'gap-1',
      seq: 4,
      sourceSeq: 10,
      offsetMs: 30,
      source: 'scope',
      affectedSources: ['scope', 'network'],
      status: 'unavailable',
      reason: 'Browser scope changed before all collectors completed.',
      droppedCount: 1,
    });

    expect(validateTrace(trace)).toMatchObject({ valid: true });
  });

  it('enforces bidirectional resource closure and resource metadata', async () => {
    const trace = makeFullFidelityTrace();
    await expect(
      buildBugtraceZip({
        trace,
        resources: [{ ...rrwebResource(), relatedId: 'network-1' }],
      }),
    ).rejects.toThrow('relatedId');

    await expect(
      buildBugtraceZip({
        trace,
        resources: [{ ...rrwebResource(), data: '[]' }],
      }),
    ).rejects.toThrow('eventCount');

    await expect(
      buildBugtraceZip({
        trace,
        resources: [
          rrwebResource(),
          {
            path: 'attachments/orphan.txt',
            data: 'orphan',
            mimeType: 'text/plain',
            purpose: 'attachment',
            relatedId: 'step-1',
          },
        ],
      }),
    ).rejects.toThrow('orphan');

    const traceWithAttachment = makeFullFidelityTrace();
    traceWithAttachment.attachments.push({
      id: 'attachment-1',
      status: 'present',
      path: 'attachments/context.json',
      mimeType: 'application/json',
      size: 99,
      purpose: 'test context',
      relatedId: 'step-1',
    });
    await expect(
      buildBugtraceZip({
        trace: traceWithAttachment,
        resources: [
          rrwebResource(),
          {
            path: 'attachments/context.json',
            data: '{}',
            mimeType: 'application/json',
            purpose: 'attachment',
            relatedId: 'attachment-1',
          },
        ],
      }),
    ).rejects.toThrow('Declared size 99');
  });
});
