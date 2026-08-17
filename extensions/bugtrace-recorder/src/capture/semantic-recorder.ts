import type { ClientCaptureEvent } from '../messaging';
import { describeTarget, elementFromEvent, isBlockedTarget } from './locator';

type Emit = (event: Omit<ClientCaptureEvent, 'clientId' | 'localSeq'>) => void;

const SAFE_KEYS = new Set([
  'Enter',
  'Escape',
  'Tab',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'Backspace',
  'Delete',
]);

const MODIFIER_KEYS = new Set(['Alt', 'AltGraph', 'Control', 'Meta', 'Shift']);

export interface KeyObservationPolicyInput {
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  isComposing: boolean;
  altGraph: boolean;
  sensitiveTextContext: boolean;
}

/**
 * Character-producing modifier sequences can reveal the physical keys used to enter a secret.
 * Keep navigation keys and genuine shortcuts, but suppress Alt/AltGraph/IME text entry while an
 * editable or explicitly blocked target owns focus.
 */
export function shouldRecordKeyObservation(input: KeyObservationPolicyInput): boolean {
  if (MODIFIER_KEYS.has(input.key)) return false;
  if (input.sensitiveTextContext && (input.isComposing || input.altGraph)) return false;
  if (SAFE_KEYS.has(input.key)) return true;

  const hasCommandModifier = input.altKey || input.ctrlKey || input.metaKey;
  if (!hasCommandModifier) return false;
  if (
    input.sensitiveTextContext &&
    input.altKey &&
    ([...input.key].length === 1 || ['Dead', 'Process', 'Unidentified'].includes(input.key))
  ) {
    return false;
  }
  return true;
}

function observedAt(): number {
  return performance.timeOrigin + performance.now();
}

function targetSummary(element: Element): Record<string, unknown> {
  return isBlockedTarget(element)
    ? { status: 'redacted', reason: 'Target matched the configured privacy block selector.' }
    : { ...describeTarget(element) };
}

function inputSummary(element: Element): Record<string, unknown> {
  if (element instanceof HTMLInputElement) {
    const type = element.type || 'text';
    if (type === 'file') {
      return {
        state: 'redacted',
        inputType: type,
        fileCount: element.files?.length ?? 0,
      };
    }
    return { state: 'redacted', inputType: type, lengthBucket: lengthBucket(element.value.length) };
  }
  if (element instanceof HTMLTextAreaElement) {
    return { state: 'redacted', inputType: 'textarea', lengthBucket: lengthBucket(element.value.length) };
  }
  if (element instanceof HTMLSelectElement) {
    return { state: 'redacted', inputType: 'select', selectedCount: element.selectedOptions.length };
  }
  return { state: 'redacted', inputType: 'contenteditable' };
}

function lengthBucket(length: number): string {
  if (length === 0) return 'empty';
  if (length <= 4) return '1-4';
  if (length <= 8) return '5-8';
  if (length <= 16) return '9-16';
  return '17+';
}

export class SemanticRecorder {
  private readonly abortController = new AbortController();
  private readonly inputTimers = new Map<Element, number>();
  private readonly pendingInputTimers = new Set<number>();
  private lastScrollAt = 0;

  constructor(private readonly emit: Emit) {}

  start(): void {
    const options: AddEventListenerOptions = { capture: true, signal: this.abortController.signal };
    for (const eventName of ['click', 'dblclick', 'contextmenu', 'change', 'submit', 'drop']) {
      document.addEventListener(eventName, this.handleDiscrete, options);
    }
    document.addEventListener('input', this.handleInput, options);
    document.addEventListener('keydown', this.handleKeydown, options);
    document.addEventListener('scroll', this.handleScroll, options);
  }

  stop(): void {
    for (const [target, timer] of this.inputTimers) {
      window.clearTimeout(timer);
      this.emitInput(target);
    }
    this.inputTimers.clear();
    this.pendingInputTimers.clear();
    this.abortController.abort();
  }

  private readonly handleDiscrete = (event: Event): void => {
    if (!event.isTrusted) return;
    const target = elementFromEvent(event);
    if (!target) return;

    let action = event.type;
    const blocked = isBlockedTarget(target);
    const data: Record<string, unknown> = { target: targetSummary(target) };
    if (event.type === 'change') {
      if (target instanceof HTMLSelectElement) action = 'select';
      else if (target instanceof HTMLInputElement && ['checkbox', 'radio'].includes(target.type)) {
        action = target.checked ? 'check' : 'uncheck';
      }
      data.input = blocked
        ? { state: 'redacted', inputType: 'blocked' }
        : inputSummary(target);
    }
    data.action = action;
    if (event instanceof MouseEvent) {
      data.button = event.button;
      data.modifiers = modifierKeys(event);
    }
    if (event.type === 'drop' && event instanceof DragEvent) {
      data.files = event.dataTransfer?.files
        ? [...event.dataTransfer.files].map((file) => ({ mimeType: file.type, size: file.size }))
        : [];
    }
    this.emit({ observedAt: observedAt(), kind: 'semantic', data });
  };

  private readonly handleInput = (event: Event): void => {
    if (!event.isTrusted) return;
    const target = elementFromEvent(event);
    if (!target) return;
    if (
      target instanceof HTMLSelectElement ||
      (target instanceof HTMLInputElement && ['checkbox', 'radio'].includes(target.type))
    ) return;
    const existingTimer = this.inputTimers.get(target);
    if (existingTimer !== undefined) {
      window.clearTimeout(existingTimer);
      this.pendingInputTimers.delete(existingTimer);
    }
    const timer = window.setTimeout(() => {
      this.inputTimers.delete(target);
      this.pendingInputTimers.delete(timer);
      if (this.abortController.signal.aborted) return;
      this.emitInput(target);
    }, 350);
    this.inputTimers.set(target, timer);
    this.pendingInputTimers.add(timer);
  };

  private emitInput(target: Element): void {
    this.emit({
      observedAt: observedAt(),
      kind: 'semantic',
      data: {
        action: 'fill',
        target: targetSummary(target),
        input: isBlockedTarget(target)
          ? { state: 'redacted', inputType: 'blocked' }
          : inputSummary(target),
      },
    });
  }

  private readonly handleKeydown = (event: KeyboardEvent): void => {
    if (!event.isTrusted) return;
    const target = elementFromEvent(event);
    if (!target) return;
    if (!shouldRecordKeyObservation({
      key: event.key,
      altKey: event.altKey,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      isComposing: event.isComposing,
      altGraph: event.getModifierState('AltGraph'),
      sensitiveTextContext: isSensitiveTextContext(target),
    })) return;
    const code = /^[A-Za-z0-9]{1,40}$/u.test(event.code) ? event.code : 'shortcut';
    this.emit({
      observedAt: observedAt(),
      kind: 'semantic',
      data: {
        action: 'key',
        key: SAFE_KEYS.has(event.key) ? event.key : code,
        modifiers: modifierKeys(event),
        target: targetSummary(target),
      },
    });
  };

  private readonly handleScroll = (event: Event): void => {
    if (!event.isTrusted) return;
    const now = performance.now();
    if (now - this.lastScrollAt < 500) return;
    this.lastScrollAt = now;
    const target = event.target instanceof Element ? event.target : document.documentElement;
    const x = target === document.documentElement ? window.scrollX : target.scrollLeft;
    const y = target === document.documentElement ? window.scrollY : target.scrollTop;
    this.emit({
      observedAt: observedAt(),
      kind: 'semantic',
      data: { action: 'scroll', x: Math.round(x), y: Math.round(y), target: targetSummary(target) },
    });
  };
}

function isSensitiveTextContext(element: Element): boolean {
  let current: Element | null = element;
  while (current) {
    if (
      isBlockedTarget(current) ||
      current instanceof HTMLInputElement ||
      current instanceof HTMLTextAreaElement ||
      current instanceof HTMLSelectElement ||
      (current instanceof HTMLElement && current.isContentEditable) ||
      ['textbox', 'searchbox', 'combobox'].includes(current.getAttribute('role') ?? '')
    ) {
      return true;
    }
    if (current.parentElement) {
      current = current.parentElement;
      continue;
    }
    const root = current.getRootNode();
    current = root instanceof ShadowRoot ? root.host : null;
  }
  return false;
}

function modifierKeys(event: MouseEvent | KeyboardEvent): string[] {
  return [
    event.altKey ? 'Alt' : null,
    event.ctrlKey ? 'Control' : null,
    event.metaKey ? 'Meta' : null,
    event.shiftKey ? 'Shift' : null,
  ].filter((value): value is string => value !== null);
}
