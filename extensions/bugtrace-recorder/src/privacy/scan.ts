import { isSensitiveHeader } from './headers';

export type SecretFindingKind =
  | 'sentinel'
  | 'sensitive-key'
  | 'credential-pattern'
  | 'email'
  | 'url-query-or-fragment';

export interface SecretFinding {
  readonly path: string;
  readonly kind: SecretFindingKind;
  readonly sentinelIndex: number | null;
}

export interface SecretScanOptions {
  readonly sentinels?: readonly string[];
  readonly caseSensitiveSentinels?: boolean;
  readonly maxDepth?: number;
  readonly maxNodes?: number;
}

export interface SecretScanResult {
  readonly safe: boolean;
  readonly findings: readonly SecretFinding[];
  readonly truncated: boolean;
  readonly visitedNodes: number;
}

const SENSITIVE_KEY_PATTERN =
  /^(?:password|passwd|pwd|otp|token|secret|authorization|cookie|set-cookie|api[-_]?key|request[-_]?body|response[-_]?body)$/iu;
const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/u;
const CREDENTIAL_PATTERN =
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{3,}|\b(?:password|passwd|pwd|otp|token|secret|api[-_ ]?key|authorization|cookie)\b\s*[:=]\s*[^\s,;]+/iu;
const SAFE_REDACTION_PATTERN = /^(?:<redacted>|<secret:\d+>|\[Redacted\]|redacted)$/iu;

function boundedInteger(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined || !Number.isSafeInteger(value) || value < 1) return fallback;
  return Math.min(value, maximum);
}

function safeStringForPatternScan(value: string): string {
  return value
    .replace(/<(?:redacted|secret:\d+)>/giu, '')
    .replace(/%3C(?:redacted|secret%3A\d+)%3E/giu, '')
    .replace(/\[Redacted\]/giu, '');
}

function containsUnsafeUrl(value: string): boolean {
  const candidates = value.match(/https?:\/\/[^\s<>"']+/giu) ?? [];
  return candidates.some((candidate) => {
    try {
      const url = new URL(candidate);
      for (const queryValue of url.searchParams.values()) {
        if (queryValue.length > 0 && !SAFE_REDACTION_PATTERN.test(queryValue)) return true;
      }
      if (url.hash.length > 1 && !SAFE_REDACTION_PATTERN.test(decodeURIComponent(url.hash.slice(1)))) {
        return true;
      }
      return url.username.length > 0 || url.password.length > 0;
    } catch {
      return /[?#].+/u.test(candidate) && !/<redacted>|<secret:\d+>/iu.test(candidate);
    }
  });
}

function isSafeRedactionValue(value: unknown): boolean {
  if (value === null || value === false) return true;
  if (typeof value === 'string') return value.length === 0 || SAFE_REDACTION_PATTERN.test(value);
  if (typeof value !== 'object') return false;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, 'redacted');
    return descriptor !== undefined && 'value' in descriptor && descriptor.value === true;
  } catch {
    return false;
  }
}

function pathForKey(parentPath: string, key: string): string {
  if (/^(?:0|[1-9]\d*)$/u.test(key)) return `${parentPath}[${key}]`;
  if (/^[A-Za-z_$][\w$]*$/u.test(key) && key.length <= 80) return `${parentPath}.${key}`;
  return `${parentPath}["<redacted-key>"]`;
}

export function scanForSecrets(
  value: unknown,
  options: SecretScanOptions = {},
): SecretScanResult {
  const sentinels = (options.sentinels ?? []).filter((sentinel) => sentinel.length > 0);
  const normalizedSentinels = options.caseSensitiveSentinels
    ? sentinels
    : sentinels.map((sentinel) => sentinel.toLocaleLowerCase());
  const maxDepth = boundedInteger(options.maxDepth, 32, 64);
  const maxNodes = boundedInteger(options.maxNodes, 100_000, 500_000);
  const findings: SecretFinding[] = [];
  const seen = new WeakSet<object>();
  const dedupe = new Set<string>();
  let visitedNodes = 0;
  let truncated = false;

  function addFinding(path: string, kind: SecretFindingKind, sentinelIndex: number | null): void {
    const key = `${path}\u0000${kind}\u0000${String(sentinelIndex)}`;
    if (dedupe.has(key)) return;
    dedupe.add(key);
    findings.push({ path, kind, sentinelIndex });
  }

  function inspectString(text: string, path: string): void {
    const sentinelHaystack = options.caseSensitiveSentinels ? text : text.toLocaleLowerCase();
    normalizedSentinels.forEach((sentinel, index) => {
      if (sentinelHaystack.includes(sentinel)) addFinding(path, 'sentinel', index);
    });

    const patternText = safeStringForPatternScan(text);
    if (CREDENTIAL_PATTERN.test(patternText)) addFinding(path, 'credential-pattern', null);
    if (EMAIL_PATTERN.test(patternText)) addFinding(path, 'email', null);
    if (containsUnsafeUrl(text)) addFinding(path, 'url-query-or-fragment', null);
  }

  function visit(current: unknown, path: string, depth: number): void {
    if (visitedNodes >= maxNodes || depth > maxDepth) {
      truncated = true;
      return;
    }
    visitedNodes += 1;

    if (typeof current === 'string') {
      inspectString(current, path);
      return;
    }
    if (typeof current === 'bigint') {
      inspectString(current.toString(), path);
      return;
    }
    if (current === null || typeof current !== 'object') return;
    if (seen.has(current)) return;
    seen.add(current);

    if (current instanceof ArrayBuffer || ArrayBuffer.isView(current)) {
      try {
        const bytes =
          current instanceof ArrayBuffer
            ? new Uint8Array(current)
            : new Uint8Array(current.buffer, current.byteOffset, current.byteLength);
        if (bytes.byteLength > 2_000_000) truncated = true;
        inspectString(new TextDecoder().decode(bytes.subarray(0, 2_000_000)), path);
      } catch {
        truncated = true;
      }
      return;
    }

    let descriptors: Record<string, PropertyDescriptor>;
    try {
      descriptors = Object.getOwnPropertyDescriptors(current);
    } catch {
      truncated = true;
      return;
    }

    for (const [key, descriptor] of Object.entries(descriptors)) {
      const childPath = pathForKey(path, key);
      inspectString(key, childPath);
      if (!('value' in descriptor)) {
        truncated = true;
        continue;
      }
      if (
        (SENSITIVE_KEY_PATTERN.test(key) || isSensitiveHeader(key)) &&
        !isSafeRedactionValue(descriptor.value)
      ) {
        addFinding(childPath, 'sensitive-key', null);
      }
      visit(descriptor.value, childPath, depth + 1);
      if (visitedNodes >= maxNodes) {
        truncated = true;
        break;
      }
    }
  }

  visit(value, '$', 0);
  return {
    safe: findings.length === 0 && !truncated,
    findings,
    truncated,
    visitedNodes,
  };
}

export function findSensitivePaths(
  value: unknown,
  sentinels: readonly string[] = [],
): readonly string[] {
  return [...new Set(scanForSecrets(value, { sentinels }).findings.map((finding) => finding.path))];
}
