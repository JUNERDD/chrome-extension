export const ALLOWED_NETWORK_RESPONSE_HEADERS = [
  'content-encoding',
  'content-length',
  'content-type',
] as const;

const ALLOWED_HEADER_SET = new Set<string>(ALLOWED_NETWORK_RESPONSE_HEADERS);
const SENSITIVE_HEADER_PATTERN =
  /(?:^|[-_])(authorization|cookie|set-cookie|proxy-authorization|api[-_]?key|auth[-_]?token|csrf|xsrf|session|secret|signature)(?:$|[-_])/iu;

export function normalizeHeaderName(name: string): string {
  return name.trim().toLowerCase();
}

export function isSensitiveHeader(name: string): boolean {
  const normalized = normalizeHeaderName(name);
  return normalized.length === 0 || SENSITIVE_HEADER_PATTERN.test(normalized);
}

export function isAllowedNetworkResponseHeader(name: string): boolean {
  const normalized = normalizeHeaderName(name);
  return !isSensitiveHeader(normalized) && ALLOWED_HEADER_SET.has(normalized);
}

export interface HeaderLike {
  readonly name: string;
  readonly value?: string;
}

/** Unknown headers are excluded; this is intentionally an allowlist, not a denylist. */
export function filterAllowedNetworkResponseHeaders(
  headers: readonly HeaderLike[],
): Readonly<Record<string, string>> {
  const output: Record<string, string> = {};
  for (const header of headers) {
    const name = normalizeHeaderName(header.name);
    if (!isAllowedNetworkResponseHeader(name) || typeof header.value !== 'string') continue;
    const value = header.value.trim();
    if (name === 'content-length') {
      if (/^\d{1,20}$/u.test(value)) output[name] = value;
      continue;
    }
    if (name === 'content-encoding') {
      if (/^[a-z0-9._-]{1,40}(?:\s*,\s*[a-z0-9._-]{1,40})*$/iu.test(value)) {
        output[name] = value.toLowerCase();
      }
      continue;
    }
    const mediaType = value.split(';', 1)[0]?.trim().toLowerCase();
    if (mediaType !== undefined && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/iu.test(mediaType)) {
      output[name] = mediaType;
    }
  }
  return output;
}
