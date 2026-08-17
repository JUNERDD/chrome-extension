import type { eventWithTime } from '@rrweb/types';

type UnknownRecord = Record<string, unknown>;

const URL_ATTRIBUTES = new Set([
  'action',
  'background',
  'cite',
  'data',
  'formaction',
  'href',
  'poster',
  'src',
  'srcset',
  'xlink:href',
]);

const INERT_TAGS = new Set(['applet', 'embed', 'object', 'script']);
const TRANSPARENT_PIXEL =
  'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=';

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Replaces every CSS fetch surface while retaining enough style text for layout reconstruction. */
export function sanitizeReplayCss(value: string): string {
  return value
    .replace(/@import\s+(?:url\()?\s*(?:["'][^"']*["']|[^;)\s]+)\s*\)?[^;]*;?/giu, '')
    .replace(/url\(\s*(?:["'][^"']*["']|[^)]*)\s*\)/giu, `url("${TRANSPARENT_PIXEL}")`)
    .replace(/image-set\([^)]*\)/giu, `url("${TRANSPARENT_PIXEL}")`);
}

function safeAttributeValue(name: string, value: unknown): unknown {
  if (typeof value !== 'string') return '';
  if (name === 'srcset') return '';
  if (name === 'src' || name === 'poster' || name === 'background') return TRANSPARENT_PIXEL;
  return 'about:blank';
}

function sanitizeValue(value: unknown, parentKey = '', insideStyle = false): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, parentKey, insideStyle));
  }
  if (!isRecord(value)) {
    if (insideStyle && typeof value === 'string') return sanitizeReplayCss(value);
    return value;
  }

  const rawTagName = typeof value.tagName === 'string' ? value.tagName.toLowerCase() : '';
  const tagName = INERT_TAGS.has(rawTagName) ? 'div' : rawTagName;
  const next: UnknownRecord = {};
  for (const [key, child] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase();
    if (key === 'tagName' && INERT_TAGS.has(rawTagName)) {
      next[key] = 'div';
      continue;
    }
    if (parentKey === 'attributes') {
      if (normalizedKey.startsWith('on')) continue;
      if (normalizedKey === 'srcdoc') {
        next[key] = '';
        continue;
      }
      if (URL_ATTRIBUTES.has(normalizedKey)) {
        next[key] = safeAttributeValue(normalizedKey, child);
        continue;
      }
      if (normalizedKey === 'style' && typeof child === 'string') {
        next[key] = sanitizeReplayCss(child);
        continue;
      }
    }
    if (
      typeof child === 'string' &&
      (insideStyle || normalizedKey === 'csstext' || normalizedKey === 'rule')
    ) {
      next[key] = sanitizeReplayCss(child);
      continue;
    }
    next[key] = sanitizeValue(child, key, insideStyle || tagName === 'style');
  }

  if (INERT_TAGS.has(rawTagName)) {
    next.attributes = { 'data-bugtrace-replay-blocked': rawTagName };
    next.childNodes = [];
  }

  const attributes = isRecord(next.attributes) ? next.attributes : null;
  if (tagName === 'meta' && String(attributes?.['http-equiv'] ?? '').toLowerCase() === 'refresh') {
    next.attributes = { ...attributes, content: '' };
  }
  if (tagName === 'link' && String(attributes?.rel ?? '').toLowerCase().includes('stylesheet')) {
    next.attributes = { ...attributes, href: 'about:blank' };
  }
  return next;
}

/**
 * Produces an inert clone for visual replay. The stored/exported rrweb evidence remains unchanged;
 * only the in-extension reconstruction loses remote resources and executable surfaces.
 */
export function sanitizeRrwebEventsForReplay(values: readonly unknown[]): eventWithTime[] {
  return values
    .map((value) => sanitizeValue(value))
    .filter((value): value is eventWithTime => {
      if (!isRecord(value)) return false;
      return typeof value.timestamp === 'number' && typeof value.type === 'number';
    });
}
