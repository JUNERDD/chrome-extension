import { redactPaymentCardsInText } from './payment-card';

export type SessionPseudonymizer = (secret: string) => string;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL_PATTERN = /^[^\s/@]+@[^\s/@]+\.[^\s/@]+$/u;
const SAFE_PLACEHOLDER_PATTERN = /^<(?:redacted|secret:\d+)>$/u;
const BARE_HOST_PATH_PATTERN =
  /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}(?::\d{1,5})?\/[A-Za-z0-9._~%!$&'()*+,;=:@/-]+$/u;

export function createSessionPseudonymizer(startIndex = 1): SessionPseudonymizer {
  const aliases = new Map<string, string>();
  return (secret: string): string => {
    const existing = aliases.get(secret);
    if (existing !== undefined) return existing;
    const alias = `<secret:${startIndex + aliases.size}>`;
    aliases.set(secret, alias);
    return alias;
  };
}

function shannonEntropy(value: string): number {
  if (value.length === 0) return 0;
  const frequencies = new Map<string, number>();
  for (const character of value) {
    frequencies.set(character, (frequencies.get(character) ?? 0) + 1);
  }
  let entropy = 0;
  for (const count of frequencies.values()) {
    const probability = count / value.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

export function isSensitivePathSegment(segment: string): boolean {
  if (segment.length === 0 || SAFE_PLACEHOLDER_PATTERN.test(segment)) return false;
  if (UUID_PATTERN.test(segment) || EMAIL_PATTERN.test(segment)) return true;

  const token = segment.replace(/\.[a-z0-9]{1,8}$/iu, '');
  if (token.length < 20 || /\s/u.test(token)) return false;
  const characterClasses = [/[a-z]/u, /[A-Z]/u, /\d/u, /[-_.~+/=]/u].filter((pattern) =>
    pattern.test(token),
  ).length;
  return characterClasses >= 2 && shannonEntropy(token) >= 3.25;
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function redactPath(pathname: string, pseudonymize: SessionPseudonymizer): string {
  return pathname
    .split('/')
    .map((rawSegment) => {
      const decoded = decodeSegment(rawSegment);
      return isSensitivePathSegment(decoded) ? pseudonymize(decoded) : rawSegment;
    })
    .join('/');
}

function redactQuery(searchParams: URLSearchParams, pseudonymize: SessionPseudonymizer): string {
  const pairs: string[] = [];
  for (const [rawKey] of searchParams) {
    const key = isSensitivePathSegment(rawKey) ? pseudonymize(rawKey) : encodeURIComponent(rawKey);
    pairs.push(`${key}=<redacted>`);
  }
  return pairs.length === 0 ? '' : `?${pairs.join('&')}`;
}

function redactParsedUrl(parsed: URL, pseudonymize: SessionPseudonymizer): string {
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '[unsupported-url]';
  const authority = parsed.host;
  const path = redactPath(parsed.pathname, pseudonymize);
  const query = redactQuery(parsed.searchParams, pseudonymize);
  const fragment = parsed.hash.length > 0 ? '#<redacted>' : '';
  return `${parsed.protocol}//${authority}${path}${query}${fragment}`;
}

function redactSchemeRelativeUrl(input: string, pseudonymize: SessionPseudonymizer): string {
  const absolute = redactParsedUrl(new URL(`https:${input}`), pseudonymize);
  return absolute.startsWith('https:') ? absolute.slice('https:'.length) : absolute;
}

function redactBareHostUrl(input: string, pseudonymize: SessionPseudonymizer): string {
  const absolute = redactParsedUrl(new URL(`https://${input}`), pseudonymize);
  return absolute.startsWith('https://') ? absolute.slice('https://'.length) : absolute;
}

function redactRelativeUrl(input: string, pseudonymize: SessionPseudonymizer): string {
  const fragmentIndex = input.indexOf('#');
  const withoutFragment = fragmentIndex === -1 ? input : input.slice(0, fragmentIndex);
  const queryIndex = withoutFragment.indexOf('?');
  const pathname = queryIndex === -1 ? withoutFragment : withoutFragment.slice(0, queryIndex);
  const rawQuery = queryIndex === -1 ? '' : withoutFragment.slice(queryIndex + 1);
  const path = redactPath(pathname, pseudonymize);
  const query =
    rawQuery.length === 0
      ? queryIndex === -1
        ? ''
        : '?'
      : redactQuery(new URLSearchParams(rawQuery), pseudonymize);
  const fragment = fragmentIndex === -1 ? '' : '#<redacted>';
  return `${path}${query}${fragment}`;
}

export interface TextUrlCandidate {
  index: number;
  value: string;
}

function trimUrlCandidate(value: string): string {
  return value.replace(/[),.;\]}]+$/gu, '');
}

function hasSensitiveBarePath(value: string): boolean {
  if (!BARE_HOST_PATH_PATTERN.test(value)) return false;
  const pathStart = value.indexOf('/');
  if (pathStart === -1) return false;
  return value
    .slice(pathStart + 1)
    .split('/')
    .some((segment) => isSensitivePathSegment(decodeSegment(segment)));
}

/** Finds HTTP(S), relative, and hostname/path-like URL tokens embedded in untrusted text. */
export function findHttpUrlCandidatesInText(input: string): TextUrlCandidate[] {
  const candidates: TextUrlCandidate[] = [];
  const pushMatches = (expression: RegExp, valueGroup = 0, prefixGroup?: number): void => {
    for (const match of input.matchAll(expression)) {
      const value = trimUrlCandidate(match[valueGroup] ?? '');
      if (!value) continue;
      const prefixLength = prefixGroup === undefined ? 0 : (match[prefixGroup]?.length ?? 0);
      candidates.push({ index: (match.index ?? 0) + prefixLength, value });
    }
  };

  pushMatches(/https?:\/\/[^\s<>"']+/giu);
  pushMatches(
    /(^|[\s"'`(=])((?:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?|\.{1,2}\/|\/(?!\/))[A-Za-z0-9._~%!$&'()*+,;=:@/?#-]*)/gmu,
    2,
    1,
  );
  for (const match of input.matchAll(
    /(^|[\s"'`(=])((?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}(?::\d{1,5})?\/[A-Za-z0-9._~%!$&'()*+,;=:@/-]+)/gmu,
  )) {
    const prefix = match[1] ?? '';
    const value = trimUrlCandidate(match[2] ?? '');
    // A bare hostname/path without query or fragment is ambiguous in prose. Only promote it to
    // a URL candidate when its path contains a value the URL policy would actually pseudonymize.
    // This avoids treating Markdown paths and CSS locators as leaked URLs.
    if (!hasSensitiveBarePath(value)) continue;
    candidates.push({ index: (match.index ?? 0) + prefix.length, value });
  }
  for (const match of input.matchAll(
    /=\s*["'`]?([?#][A-Za-z0-9._~%!$&'()*+,;=:@/?#-]+)/gmu,
  )) {
    const value = trimUrlCandidate(match[1] ?? '');
    if (value) candidates.push({ index: (match.index ?? 0) + match[0].lastIndexOf(value), value });
  }
  for (const match of input.matchAll(
    /["'](?:url|uri|href|src|action|location|next)["']\s*:\s*["']?([?#][A-Za-z0-9._~%!$&'()*+,;=:@/?#-]+)/gimu,
  )) {
    const value = trimUrlCandidate(match[1] ?? '');
    if (value) candidates.push({ index: (match.index ?? 0) + match[0].lastIndexOf(value), value });
  }

  for (const match of input.matchAll(
    /(^|[\s"'`(=])([A-Za-z0-9][A-Za-z0-9._~%!$&'()*+,;=:@/-]*(?:[?#][A-Za-z0-9._~%!$&'()*+,;=:@/?#-]+))/gmu,
  )) {
    const prefix = match[1] ?? '';
    const value = trimUrlCandidate(match[2] ?? '');
    const stem = value.split(/[?#]/u, 1)[0] ?? '';
    if (!value || (!stem.includes('/') && !stem.includes('.'))) continue;
    candidates.push({ index: (match.index ?? 0) + prefix.length, value });
  }

  candidates.sort((left, right) => left.index - right.index || right.value.length - left.value.length);
  const nonOverlapping: TextUrlCandidate[] = [];
  for (const candidate of candidates) {
    const previous = nonOverlapping.at(-1);
    if (previous && candidate.index < previous.index + previous.value.length) continue;
    nonOverlapping.push(candidate);
  }
  return nonOverlapping;
}

/**
 * Removes credentials, every query value and the whole fragment. UUID, e-mail and
 * high-entropy path segments receive stable aliases when a session pseudonymizer is supplied.
 */
export function redactUrl(
  input: string,
  pseudonymize: SessionPseudonymizer = createSessionPseudonymizer(),
): string {
  const trimmed = input.trim();
  if (trimmed.length === 0) return '';
  try {
    if (/^https?:\/\//iu.test(trimmed)) {
      return redactParsedUrl(new URL(trimmed), pseudonymize);
    }
    if (/^[a-z][a-z0-9+.-]*:/iu.test(trimmed)) return '[unsupported-url]';
    if (/^\/\//u.test(trimmed)) {
      return redactSchemeRelativeUrl(trimmed, pseudonymize);
    }
    if (BARE_HOST_PATH_PATTERN.test(trimmed)) {
      return redactBareHostUrl(trimmed, pseudonymize);
    }
    if (/^(?:\/|\.{1,2}\/|\?|#)/u.test(trimmed)) {
      return redactRelativeUrl(trimmed, pseudonymize);
    }
    if (/[?#]/u.test(trimmed) && (trimmed.split(/[?#]/u, 1)[0]?.match(/[./]/u))) {
      return redactRelativeUrl(trimmed, pseudonymize);
    }
    return '[unsupported-url]';
  } catch {
    const fragmentIndex = trimmed.indexOf('#');
    const withoutFragment = fragmentIndex === -1 ? trimmed : trimmed.slice(0, fragmentIndex);
    const queryIndex = withoutFragment.indexOf('?');
    const path = queryIndex === -1 ? withoutFragment : withoutFragment.slice(0, queryIndex);
    return `${redactPath(path, pseudonymize)}${queryIndex === -1 ? '' : '?<redacted>'}${
      fragmentIndex === -1 ? '' : '#<redacted>'
    }`;
  }
}

export function redactSecretsInText(
  input: string,
  pseudonymize: SessionPseudonymizer = createSessionPseudonymizer(),
): string {
  const urlCandidates = findHttpUrlCandidatesInText(input);
  let output = '';
  let cursor = 0;
  for (const candidate of urlCandidates) {
    output += input.slice(cursor, candidate.index);
    output += redactUrl(candidate.value, pseudonymize);
    cursor = candidate.index + candidate.value.length;
  }
  output += input.slice(cursor);
  output = output.replace(
    /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/giu,
    (_match, scheme: string) => `${scheme} <redacted>`,
  );
  output = output.replace(
    /\b(authorization|cookie|set-cookie)\b\s*[:=]\s*[^\r\n]*/giu,
    (_match, name: string) => `${name}:<redacted>`,
  );
  output = output.replace(
    /(?<!<)\b(password|passwd|passcode|pwd|pin|otp|token|secret|auth|authorization|credential|csrf|xsrf|api[-_ ]?key|authorization|cookie|iban|ssn)\b\s*([:=])\s*([^\s,;]+)/giu,
    (_match, name: string, separator: string) => `${name}${separator}<redacted>`,
  );
  output = output.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/gu, (value) =>
    pseudonymize(value),
  );
  output = output.replace(
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/giu,
    (value) => pseudonymize(value),
  );
  output = output.replace(
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu,
    (value) => pseudonymize(value),
  );
  output = output.replace(/\b[A-Za-z0-9_+/-]{28,}={0,2}\b/gu, (value) =>
    isSensitivePathSegment(value) ? pseudonymize(value) : value,
  );
  return redactPaymentCardsInText(output, pseudonymize);
}
