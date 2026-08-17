import { findPaymentCardCandidates } from '../privacy/payment-card';
import { findHttpUrlCandidatesInText, isSensitivePathSegment } from '../privacy/url';

export type SecretFindingKind =
  | 'credential-field'
  | 'authorization-header'
  | 'cookie-header'
  | 'url-credentials'
  | 'url-query-value'
  | 'url-fragment'
  | 'url-email-segment'
  | 'url-identifier-segment'
  | 'url-high-entropy-segment'
  | 'jwt'
  | 'private-key'
  | 'payment-card';

export interface SecretFinding {
  kind: SecretFindingKind;
  source: string;
  index: number;
}

export class SecretLeakError extends Error {
  readonly findings: readonly SecretFinding[];

  constructor(findings: readonly SecretFinding[]) {
    const summary = [...new Set(findings.map((finding) => finding.kind))].join(', ');
    const sources = [...new Set(findings.map((finding) => finding.source))].join(', ');
    super(`Bugtrace export blocked by sensitive-data scan (${summary}) in ${sources}.`);
    this.name = 'SecretLeakError';
    this.findings = findings;
  }
}

interface SecretPattern {
  kind: SecretFindingKind;
  expression: RegExp;
}

const SECRET_PATTERNS: readonly SecretPattern[] = [
  {
    kind: 'credential-field',
    expression:
      /(?<!<)\b(?:password|passwd|passcode|pwd|pin|secret|token|auth|authorization|credential|csrf|xsrf|client[_ -]?secret|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|one[_ -]?time[_ -]?(?:password|code)|otp|iban|ssn|request[_ -]?body|response[_ -]?body)\b["']?\s*[:=]\s*["']?(?!\s*(?:redacted|omitted|<redacted>|\[redacted\]|\*{3,}))[A-Za-z0-9+/_@.:-]{4,}/giu,
  },
  {
    kind: 'credential-field',
    expression:
      /(?<!<)\b(?:password|passwd|passcode|pwd|pin|secret|token|auth|authorization|credential|csrf|xsrf|otp|iban|ssn)\b["']?\s*[:=]\s*["']?<(?!(?:redacted|omitted|secret:\d+)>)[^>\s]{4,}>/giu,
  },
  {
    kind: 'authorization-header',
    expression:
      /\bauthorization\b["']?\s*[:=]\s*["']?\s*(?:bearer|basic)\s+(?!<?redacted>?)[A-Za-z0-9+/_=.-]{6,}/giu,
  },
  {
    kind: 'cookie-header',
    expression:
      /\b(?:cookie|set-cookie)\b["']?\s*[:=]\s*["']?(?!\s*(?:omitted|redacted|<redacted>))[A-Za-z0-9_.-]{2,}=[^\s"',;}]{2,}/giu,
  },
  {
    kind: 'jwt',
    expression: /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/gu,
  },
  {
    kind: 'private-key',
    expression: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/gu,
  },
];

function decodeInput(input: string | Uint8Array | ArrayBuffer): string {
  if (typeof input === 'string') {
    return input;
  }
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

function normalizeEscapedReport(value: string): string {
  return value
    .replace(/\\([\\`*_[\]{}()#+.!|>~=:-])/g, '$1')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&amp;', '&');
}

function safeUrlValue(value: string): boolean {
  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    // A malformed value is still inspected in its encoded form.
  }
  const normalized = decoded.trim().replace(/^['"]|['"]$/g, '').toLowerCase();
  return (
    normalized === '' ||
    normalized === 'redacted' ||
    normalized === 'omitted' ||
    normalized === '<redacted>' ||
    normalized === '[redacted]' ||
    normalized === '<omitted>' ||
    /^<secret:\d+>$/.test(normalized) ||
    /^\*{3,}$/.test(normalized)
  );
}

function scanUrls(text: string, source: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  const candidates = findHttpUrlCandidatesInText(text).filter(
    ({ value }) => !/^#\/(?:\$defs|definitions)(?:\/|$)/u.test(value),
  );

  for (const candidate of candidates) {
    const rawCandidate = candidate.value.replace(/[),.;]+$/g, '');
    let url: URL;
    try {
      url = rawCandidate.startsWith('//')
        ? new URL(`https:${rawCandidate}`)
        : new URL(rawCandidate, 'https://bugtrace.invalid');
    } catch {
      continue;
    }
    const index = candidate.index;
    if ((url.username && !safeUrlValue(url.username)) || (url.password && !safeUrlValue(url.password))) {
      findings.push({ kind: 'url-credentials', source, index });
    }
    for (const [, value] of url.searchParams) {
      if (!safeUrlValue(value)) {
        findings.push({ kind: 'url-query-value', source, index });
        break;
      }
    }
    if (url.hash.length > 1 && !safeUrlValue(url.hash.slice(1))) {
      findings.push({ kind: 'url-fragment', source, index });
    }
    for (const rawSegment of url.pathname.split('/').filter(Boolean)) {
      let segment = rawSegment;
      try {
        segment = decodeURIComponent(rawSegment);
      } catch {
        // Inspect malformed encodings as-is.
      }
      if (safeUrlValue(segment)) {
        continue;
      }
      if (/^[^@/\s]+@[^@/\s]+\.[^@/\s]+$/u.test(segment)) {
        findings.push({ kind: 'url-email-segment', source, index });
      } else if (
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
          segment,
        )
      ) {
        findings.push({ kind: 'url-identifier-segment', source, index });
      } else if (isSensitivePathSegment(segment)) {
        findings.push({ kind: 'url-high-entropy-segment', source, index });
      }
    }
  }
  return findings;
}

function scanPaymentCards(text: string, source: string): SecretFinding[] {
  return findPaymentCardCandidates(text).map((candidate) => ({
    kind: 'payment-card',
    source,
    index: candidate.index,
  }));
}

/**
 * Scans a textual artifact without ever returning the matched secret itself.
 * This is a final export guard, not a replacement for capture-time redaction.
 */
export function scanForSecrets(
  input: string | Uint8Array | ArrayBuffer,
  source = 'artifact',
): SecretFinding[] {
  const text = normalizeEscapedReport(decodeInput(input));
  const findings: SecretFinding[] = [];
  for (const pattern of SECRET_PATTERNS) {
    for (const match of text.matchAll(pattern.expression)) {
      findings.push({
        kind: pattern.kind,
        source,
        index: match.index ?? 0,
      });
    }
  }
  findings.push(...scanUrls(text, source), ...scanPaymentCards(text, source));
  return findings.sort((left, right) => left.index - right.index || left.kind.localeCompare(right.kind));
}

export function assertNoSecrets(
  input: string | Uint8Array | ArrayBuffer,
  source = 'artifact',
): void {
  const findings = scanForSecrets(input, source);
  if (findings.length > 0) {
    throw new SecretLeakError(findings);
  }
}

export function isTextMimeType(mimeType: string): boolean {
  const normalized = mimeType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  return (
    normalized.startsWith('text/') ||
    normalized === 'application/json' ||
    normalized.endsWith('+json') ||
    normalized === 'application/xml' ||
    normalized.endsWith('+xml') ||
    normalized === 'application/javascript'
  );
}
