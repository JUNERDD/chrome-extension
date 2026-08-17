export type InputLengthBucket =
  | 'empty'
  | '1-4'
  | '5-8'
  | '9-16'
  | '17-32'
  | '33-64'
  | '65-128'
  | '129+'
  | 'unknown';

export interface InputElementMetadata {
  readonly inputType?: string;
  readonly elementKind?: string;
  /** Lets the collector avoid transporting a value across the extension boundary. */
  readonly valueLength?: number;
}

export interface InputRedactionRequest extends InputElementMetadata {
  readonly value?: unknown;
}

export interface RedactedInput {
  readonly redacted: true;
  readonly inputType: string;
  readonly elementKind: 'input' | 'textarea' | 'select' | 'contenteditable' | 'unknown';
  readonly lengthBucket: InputLengthBucket;
}

const ALLOWED_INPUT_TYPES = new Set([
  'button',
  'checkbox',
  'color',
  'date',
  'datetime-local',
  'email',
  'file',
  'hidden',
  'month',
  'number',
  'password',
  'radio',
  'range',
  'search',
  'select-multiple',
  'select-one',
  'submit',
  'tel',
  'text',
  'time',
  'url',
  'week',
]);

const ALLOWED_ELEMENT_KINDS = new Set<RedactedInput['elementKind']>([
  'input',
  'textarea',
  'select',
  'contenteditable',
  'unknown',
]);

function lengthBucket(length: number | null): InputLengthBucket {
  if (length === null) return 'unknown';
  if (length === 0) return 'empty';
  if (length <= 4) return '1-4';
  if (length <= 8) return '5-8';
  if (length <= 16) return '9-16';
  if (length <= 32) return '17-32';
  if (length <= 64) return '33-64';
  if (length <= 128) return '65-128';
  return '129+';
}

function safeDescriptorValue(object: object, key: string): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    return descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function isRequest(value: unknown): value is InputRedactionRequest {
  if (value === null || typeof value !== 'object') return false;
  try {
    return ['value', 'valueLength', 'inputType', 'elementKind'].some(
      (key) => Object.getOwnPropertyDescriptor(value, key) !== undefined,
    );
  } catch {
    return false;
  }
}

function normalizeInputType(value: unknown): string {
  if (typeof value !== 'string') return 'unknown';
  const normalized = value.toLowerCase();
  return ALLOWED_INPUT_TYPES.has(normalized) ? normalized : 'unknown';
}

function normalizeElementKind(value: unknown): RedactedInput['elementKind'] {
  if (typeof value !== 'string') return 'unknown';
  const normalized = value.toLowerCase() as RedactedInput['elementKind'];
  return ALLOWED_ELEMENT_KINDS.has(normalized) ? normalized : 'unknown';
}

function normalizeLength(value: unknown, explicitLength: unknown): number | null {
  if (
    typeof explicitLength === 'number' &&
    Number.isSafeInteger(explicitLength) &&
    explicitLength >= 0
  ) {
    return explicitLength;
  }
  return typeof value === 'string' ? value.length : null;
}

export function redactInput(request: InputRedactionRequest): RedactedInput;
export function redactInput(value: unknown, metadata?: InputElementMetadata): RedactedInput;
export function redactInput(
  valueOrRequest: unknown,
  metadata: InputElementMetadata = {},
): RedactedInput {
  const request = isRequest(valueOrRequest) ? valueOrRequest : null;
  const value = request === null ? valueOrRequest : safeDescriptorValue(request, 'value');
  const explicitLength =
    request === null
      ? safeDescriptorValue(metadata, 'valueLength')
      : safeDescriptorValue(request, 'valueLength');
  const inputType =
    request === null
      ? safeDescriptorValue(metadata, 'inputType')
      : safeDescriptorValue(request, 'inputType');
  const elementKind =
    request === null
      ? safeDescriptorValue(metadata, 'elementKind')
      : safeDescriptorValue(request, 'elementKind');

  return {
    redacted: true,
    inputType: normalizeInputType(inputType),
    elementKind: normalizeElementKind(elementKind),
    lengthBucket: lengthBucket(normalizeLength(value, explicitLength)),
  };
}
