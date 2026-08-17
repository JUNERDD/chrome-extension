import { record } from '@rrweb/record';
import type { eventWithTime } from '@rrweb/types';
import type { ClientCaptureEvent } from '../messaging';
import {
  createSessionPseudonymizer,
  isSensitiveFieldName,
  redactSecretsInText,
  redactUrl,
} from '../privacy';
import { BLOCKED_TARGET_SELECTOR, EDITABLE_TEXT_SELECTOR } from './locator';

type Emit = (event: Omit<ClientCaptureEvent, 'clientId' | 'localSeq'>) => void;

export const RRWEB_MASK_TEXT_SELECTOR =
  `[data-bugtrace-mask], [autocomplete="one-time-code"], ${EDITABLE_TEXT_SELECTOR}`;

const REDACTED_RRWEB_VALUE = '••••';
const FORM_TAGS = new Set(['input', 'textarea', 'select', 'option']);
const URL_ATTRIBUTES = new Set([
  'action',
  'background',
  'data',
  'formaction',
  'href',
  'poster',
  'src',
  'srcset',
  'xlink:href',
]);
const SAFE_SENSITIVE_ATTRIBUTE = new Set([
  'autocomplete',
  'class',
  'contenteditable',
  'id',
  'name',
  'role',
  'type',
]);

type MutableRecord = Record<string, unknown>;

function recordValue(value: unknown): MutableRecord | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as MutableRecord
    : null;
}

function attributeMap(value: unknown): MutableRecord | null {
  return recordValue(value);
}

function hasSensitiveAttribute(attributes: MutableRecord): boolean {
  return Object.entries(attributes).some(([name, value]) => {
    const normalizedName = name.toLowerCase();
    if (isSensitiveFieldName(normalizedName) || /(?:private|sensitive|bugtrace)/iu.test(normalizedName)) return true;
    if (normalizedName === 'contenteditable') return value !== false && value !== 'false';
    if (normalizedName === 'autocomplete') {
      return typeof value === 'string' && /(?:password|one-time-code|cc-|auth)/iu.test(value);
    }
    if (normalizedName === 'name') {
      return typeof value === 'string' && isSensitiveFieldName(value);
    }
    if (normalizedName === 'role') {
      return typeof value === 'string' && ['textbox', 'searchbox', 'combobox'].includes(value.toLowerCase());
    }
    return false;
  });
}

function redactCssResource(value: string, pseudonymize: (secret: string) => string): string {
  const trimmed = value.trim();
  if (!trimmed) return trimmed;
  if (/^[a-z][a-z0-9+.-]*:/iu.test(trimmed) && !/^https?:/iu.test(trimmed)) {
    return REDACTED_RRWEB_VALUE;
  }

  const textRedacted = redactSecretsInText(trimmed, pseudonymize);
  if (textRedacted !== trimmed) return textRedacted;

  // URL text discovery deliberately does not treat every slash-containing prose fragment as a
  // URL. Inside CSS URL surfaces the grammar supplies that context, so pass a bare relative path
  // through the URL redactor explicitly to cover high-entropy segments without query strings.
  const hasRecognizedPrefix = /^(?:https?:\/\/|\/\/|\.{0,2}\/|[?#])/iu.test(trimmed);
  const candidate = hasRecognizedPrefix ? trimmed : `./${trimmed}`;
  const redacted = redactUrl(candidate, pseudonymize);
  if (redacted === '[unsupported-url]') return textRedacted;
  return hasRecognizedPrefix || !redacted.startsWith('./') ? redacted : redacted.slice(2);
}

function redactCssStrings(value: string, pseudonymize: (secret: string) => string): string {
  let output = '';
  let cursor = 0;
  while (cursor < value.length) {
    const quote = value[cursor];
    if (quote !== '"' && quote !== "'") {
      output += quote;
      cursor += 1;
      continue;
    }

    let end = cursor + 1;
    while (end < value.length) {
      if (value[end] === '\\') {
        end += 2;
        continue;
      }
      if (value[end] === quote) break;
      end += 1;
    }
    const content = value.slice(cursor + 1, end);
    output += `${quote}${redactCssResource(content, pseudonymize)}`;
    if (end < value.length) output += quote;
    cursor = end < value.length ? end + 1 : value.length;
  }
  return output;
}

function redactCssUrls(value: string, pseudonymize: (secret: string) => string): string {
  const scrubbedStrings = redactCssStrings(value, pseudonymize);
  const scrubbedFunctions = scrubbedStrings.replace(
    /url\(\s*(?:(["'])(.*?)\1|([^)]*))\s*\)/giu,
    (_match, quote: string | undefined, quotedUrl: string | undefined, bareUrl: string | undefined) => {
      const redacted = redactCssResource(quotedUrl ?? bareUrl ?? '', pseudonymize);
      return `url(${quote ?? ''}${redacted}${quote ?? ''})`;
    },
  );
  // Malformed or legacy CSS may expose an unquoted scheme outside url(). Erase the whole token;
  // quoted values have already been handled above, including payloads containing whitespace.
  const scrubbedSchemes = scrubbedFunctions.replace(
    /\b(?:blob|data|file|filesystem|javascript):[^\s"'(){}]*/giu,
    REDACTED_RRWEB_VALUE,
  );
  return redactSecretsInText(scrubbedSchemes, pseudonymize);
}

function scrubAttribute(
  name: string,
  value: unknown,
  sensitive: boolean,
  pseudonymize: (secret: string) => string,
): unknown {
  const normalizedName = name.toLowerCase();
  if (
    normalizedName === 'value' ||
    normalizedName.startsWith('aria-value') ||
    normalizedName.startsWith('data-') ||
    normalizedName === 'srcdoc' ||
    normalizedName === 'nonce' ||
    normalizedName.startsWith('on') ||
    isSensitiveFieldName(normalizedName) ||
    (sensitive && !SAFE_SENSITIVE_ATTRIBUTE.has(normalizedName))
  ) {
    return REDACTED_RRWEB_VALUE;
  }
  if (typeof value !== 'string') return value;
  if (URL_ATTRIBUTES.has(normalizedName)) {
    return /^(?:blob|data|file|filesystem|javascript):/iu.test(value.trim())
      ? REDACTED_RRWEB_VALUE
      : redactSecretsInText(value, pseudonymize);
  }
  if (normalizedName === 'style' || normalizedName === '_csstext') {
    return redactCssUrls(value, pseudonymize);
  }
  return redactSecretsInText(value, pseudonymize);
}

class RrwebPrivacyScrubber {
  private readonly sensitiveNodeIds = new Set<number>();
  private readonly childNodeIds = new Map<number, Set<number>>();
  private readonly parentNodeIds = new Map<number, number>();
  private readonly pseudonymize = createSessionPseudonymizer();

  scrub(event: eventWithTime): eventWithTime {
    const clone = structuredClone(event) as eventWithTime;
    const root = recordValue(clone);
    const data = recordValue(root?.data);
    if (!root || !data) return clone;

    if (root.type === 2) this.scrubNode(data.node, false, null);
    if (root.type === 3 && data.source === 0) this.scrubMutation(data);
    if (root.type === 3 && data.source === 5 && typeof data.text === 'string') {
      data.text = REDACTED_RRWEB_VALUE;
    }
    if (root.type === 3 && data.source === 8) this.scrubStyleSheetRule(data);
    if (root.type === 3 && data.source === 13) this.scrubStyleDeclaration(data);
    if (root.type === 3 && data.source === 15) this.scrubAdoptedStyleSheet(data);
    return clone;
  }

  private scrubMutation(data: MutableRecord): void {
    for (const addition of Array.isArray(data.adds) ? data.adds : []) {
      const item = recordValue(addition);
      const parentId = typeof item?.parentId === 'number' ? item.parentId : null;
      this.scrubNode(
        item?.node,
        parentId !== null && this.sensitiveNodeIds.has(parentId),
        parentId,
      );
    }
    for (const mutation of Array.isArray(data.attributes) ? data.attributes : []) {
      const item = recordValue(mutation);
      const id = typeof item?.id === 'number' ? item.id : null;
      const attributes = attributeMap(item?.attributes);
      if (id === null || !attributes) continue;
      const sensitive = this.sensitiveNodeIds.has(id) || hasSensitiveAttribute(attributes);
      if (sensitive) this.markSensitive(id);
      for (const name of Object.keys(attributes)) {
        attributes[name] = scrubAttribute(
          name,
          attributes[name],
          sensitive,
          this.pseudonymize,
        );
      }
    }
    for (const mutation of Array.isArray(data.texts) ? data.texts : []) {
      const item = recordValue(mutation);
      if (typeof item?.value !== 'string') continue;
      if (typeof item.id === 'number' && this.sensitiveNodeIds.has(item.id)) {
        item.value = REDACTED_RRWEB_VALUE;
      } else {
        item.value = redactSecretsInText(item.value, this.pseudonymize);
      }
    }
    for (const removal of Array.isArray(data.removes) ? data.removes : []) {
      const id = recordValue(removal)?.id;
      if (typeof id === 'number') this.removeNode(id);
    }
  }

  private scrubNode(value: unknown, inheritedSensitive: boolean, parentId: number | null): void {
    const node = recordValue(value);
    if (!node) return;
    const id = typeof node.id === 'number' ? node.id : null;
    const tagName = typeof node.tagName === 'string' ? node.tagName.toLowerCase() : '';
    const attributes = attributeMap(node.attributes);
    const sensitive =
      inheritedSensitive ||
      FORM_TAGS.has(tagName) ||
      (attributes !== null && hasSensitiveAttribute(attributes));

    if (id !== null) {
      if (parentId !== null) this.attachNode(id, parentId);
      if (sensitive) this.markSensitive(id);
    }
    if (attributes) {
      for (const name of Object.keys(attributes)) {
        attributes[name] = scrubAttribute(
          name,
          attributes[name],
          sensitive,
          this.pseudonymize,
        );
      }
    }
    if (typeof node.textContent === 'string') {
      node.textContent = sensitive
        ? REDACTED_RRWEB_VALUE
        : redactSecretsInText(node.textContent, this.pseudonymize);
    }
    for (const child of Array.isArray(node.childNodes) ? node.childNodes : []) {
      this.scrubNode(child, sensitive, id);
    }
  }

  private attachNode(id: number, parentId: number): void {
    const previousParent = this.parentNodeIds.get(id);
    if (previousParent !== undefined && previousParent !== parentId) {
      this.childNodeIds.get(previousParent)?.delete(id);
    }
    this.parentNodeIds.set(id, parentId);
    const children = this.childNodeIds.get(parentId) ?? new Set<number>();
    children.add(id);
    this.childNodeIds.set(parentId, children);
  }

  private scrubStyleSheetRule(data: MutableRecord): void {
    for (const addition of Array.isArray(data.adds) ? data.adds : []) {
      const item = recordValue(addition);
      if (typeof item?.rule === 'string') {
        item.rule = redactCssUrls(item.rule, this.pseudonymize);
      }
    }
    for (const key of ['replace', 'replaceSync'] as const) {
      if (typeof data[key] === 'string') data[key] = redactCssUrls(data[key], this.pseudonymize);
    }
  }

  private scrubStyleDeclaration(data: MutableRecord): void {
    const set = recordValue(data.set);
    if (!set || typeof set.value !== 'string') return;
    const property = typeof set.property === 'string' ? set.property : '';
    set.value = isSensitiveFieldName(property)
      ? REDACTED_RRWEB_VALUE
      : redactCssUrls(set.value, this.pseudonymize);
  }

  private scrubAdoptedStyleSheet(data: MutableRecord): void {
    for (const style of Array.isArray(data.styles) ? data.styles : []) {
      const rules = recordValue(style)?.rules;
      for (const rule of Array.isArray(rules) ? rules : []) {
        const item = recordValue(rule);
        if (typeof item?.rule === 'string') {
          item.rule = redactCssUrls(item.rule, this.pseudonymize);
        }
      }
    }
  }

  private markSensitive(id: number): void {
    if (this.sensitiveNodeIds.has(id)) return;
    this.sensitiveNodeIds.add(id);
    for (const childId of this.childNodeIds.get(id) ?? []) this.markSensitive(childId);
  }

  private removeNode(id: number): void {
    for (const childId of this.childNodeIds.get(id) ?? []) this.removeNode(childId);
    this.childNodeIds.delete(id);
    this.sensitiveNodeIds.delete(id);
    const parentId = this.parentNodeIds.get(id);
    if (parentId !== undefined) this.childNodeIds.get(parentId)?.delete(id);
    this.parentNodeIds.delete(id);
  }
}

export function sanitizeRrwebEventsForCapture(events: readonly eventWithTime[]): eventWithTime[] {
  const scrubber = new RrwebPrivacyScrubber();
  return events.map((event) => scrubber.scrub(event));
}

export class RrwebSegmentRecorder {
  private stopRecording: (() => void) | null = null;
  private segmentId: string | null = null;
  private privacyScrubber = new RrwebPrivacyScrubber();

  constructor(private readonly emit: Emit) {}

  start(): string {
    this.stop();
    this.privacyScrubber = new RrwebPrivacyScrubber();
    this.segmentId = crypto.randomUUID();
    const segmentId = this.segmentId;
    this.stopRecording =
      record<eventWithTime>({
        emit: (event) => {
          try {
            const sanitizedEvent = this.privacyScrubber.scrub(event);
            this.emit({
              observedAt: sanitizedEvent.timestamp,
              kind: 'rrweb',
              data: { segmentId, event: sanitizedEvent as unknown as Record<string, unknown> },
            });
          } catch {
            this.emit({
              observedAt: event.timestamp,
              kind: 'gap',
              data: {
                kind: 'rrweb_scrub_failed',
                source: 'rrweb',
                status: 'error',
                affected: ['rrweb'],
                reason: 'An rrweb event was discarded because capture-time privacy scrubbing failed.',
                droppedCount: 1,
              },
            });
          }
        },
        blockSelector: BLOCKED_TARGET_SELECTOR,
        checkoutEveryNms: 60_000,
        collectFonts: false,
        inlineImages: false,
        maskAllInputs: true,
        maskTextSelector: RRWEB_MASK_TEXT_SELECTOR,
        mousemoveWait: 100,
        recordCanvas: false,
        recordCrossOriginIframes: false,
        sampling: {
          input: 'last',
          mouseInteraction: true,
          mousemove: false,
          scroll: 150,
        },
        slimDOMOptions: 'all',
      }) ?? null;
    return segmentId;
  }

  stop(): void {
    this.stopRecording?.();
    this.stopRecording = null;
    this.segmentId = null;
  }
}
