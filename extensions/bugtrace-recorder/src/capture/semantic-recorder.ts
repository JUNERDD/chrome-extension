import type { ClientCaptureEvent } from '../messaging';
import { describeTarget, elementFromEvent } from './locator';

type Emit = (event: Omit<ClientCaptureEvent, 'clientId' | 'localSeq'>) => void;

export interface KeyObservationPolicyInput {
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  isComposing: boolean;
  altGraph: boolean;
  sensitiveTextContext: boolean;
}

/** Full-fidelity local recordings retain every trusted keyboard occurrence. */
export function shouldRecordKeyObservation(input: KeyObservationPolicyInput): boolean {
  void input;
  return true;
}

function observedAt(): number {
  return performance.timeOrigin + performance.now();
}

function targetSummary(element: Element): Record<string, unknown> {
  return { ...describeTarget(element) };
}

function inputSummary(element: Element): Record<string, unknown> {
  if (element instanceof HTMLInputElement) {
    const type = element.type || 'text';
    if (type === 'file') {
      return {
        state: 'captured',
        inputType: type,
        value: [...(element.files ?? [])].map((file) => ({
          name: file.name,
          mimeType: file.type,
          size: file.size,
          lastModified: file.lastModified,
        })),
      };
    }
    return {
      state: 'captured',
      inputType: type,
      value: ['checkbox', 'radio'].includes(type)
        ? { checked: element.checked, value: element.value }
        : element.value,
    };
  }
  if (element instanceof HTMLTextAreaElement) {
    return { state: 'captured', inputType: 'textarea', value: element.value };
  }
  if (element instanceof HTMLSelectElement) {
    return {
      state: 'captured',
      inputType: element.multiple ? 'select-multiple' : 'select-one',
      value: element.multiple
        ? [...element.selectedOptions].map((option) => option.value)
        : element.value,
    };
  }
  return {
    state: 'captured',
    inputType: 'contenteditable',
    value: element.textContent ?? '',
  };
}

export class SemanticRecorder {
  private readonly abortController = new AbortController();

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
    this.abortController.abort();
  }

  private readonly handleDiscrete = (event: Event): void => {
    if (!event.isTrusted) return;
    const target = elementFromEvent(event);
    if (!target) return;

    let action = event.type;
    const data: Record<string, unknown> = { target: targetSummary(target) };
    if (event.type === 'change') {
      if (target instanceof HTMLSelectElement) action = 'select';
      else if (target instanceof HTMLInputElement && ['checkbox', 'radio'].includes(target.type)) {
        action = target.checked ? 'check' : 'uncheck';
      }
      data.input = inputSummary(target);
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
    this.emitInput(target);
  };

  private emitInput(target: Element): void {
    this.emit({
      observedAt: observedAt(),
      kind: 'semantic',
      data: {
        action: 'fill',
        target: targetSummary(target),
        input: inputSummary(target),
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
      sensitiveTextContext: false,
    })) return;
    this.emit({
      observedAt: observedAt(),
      kind: 'semantic',
      data: {
        action: 'key',
        key: event.key.slice(0, 200),
        modifiers: modifierKeys(event),
        target: targetSummary(target),
      },
    });
  };

  private readonly handleScroll = (event: Event): void => {
    if (!event.isTrusted) return;
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

function modifierKeys(event: MouseEvent | KeyboardEvent): string[] {
  return [
    event.altKey ? 'Alt' : null,
    event.ctrlKey ? 'Control' : null,
    event.metaKey ? 'Meta' : null,
    event.shiftKey ? 'Shift' : null,
  ].filter((value): value is string => value !== null);
}
