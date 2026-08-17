import {
  createSessionPseudonymizer,
  redactSecretsInText,
  type SessionPseudonymizer,
} from './url';
import { isSensitiveFieldName } from './sensitive-field';

export type SerializedConsoleValue =
  | null
  | boolean
  | number
  | string
  | readonly SerializedConsoleValue[]
  | { readonly [key: string]: SerializedConsoleValue };

export interface ConsoleSerializationOptions {
  readonly maxDepth?: number;
  readonly maxKeys?: number;
  readonly maxArrayLength?: number;
  readonly maxStringLength?: number;
  readonly maxTotalLength?: number;
  readonly pseudonymizer?: SessionPseudonymizer;
}

interface NormalizedOptions {
  readonly maxDepth: number;
  readonly maxKeys: number;
  readonly maxArrayLength: number;
  readonly maxStringLength: number;
  readonly maxTotalLength: number;
  readonly pseudonymizer: SessionPseudonymizer;
}

function boundedInteger(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined || !Number.isSafeInteger(value) || value < 1) return fallback;
  return Math.min(value, maximum);
}

function normalizeOptions(options: ConsoleSerializationOptions): NormalizedOptions {
  return {
    maxDepth: boundedInteger(options.maxDepth, 3, 6),
    maxKeys: boundedInteger(options.maxKeys, 20, 100),
    maxArrayLength: boundedInteger(options.maxArrayLength, 20, 100),
    maxStringLength: boundedInteger(options.maxStringLength, 500, 4_000),
    maxTotalLength: boundedInteger(options.maxTotalLength, 8_000, 32_000),
    pseudonymizer: options.pseudonymizer ?? createSessionPseudonymizer(),
  };
}

function serializePrimitive(
  value: unknown,
  options: NormalizedOptions,
): SerializedConsoleValue | undefined {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const redacted = redactSecretsInText(value, options.pseudonymizer);
    return redacted.length > options.maxStringLength
      ? `${redacted.slice(0, options.maxStringLength)}…[truncated]`
      : redacted;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : `[${String(value)}]`;
  if (typeof value === 'undefined') return '[undefined]';
  if (typeof value === 'bigint') return `${value.toString()}n`;
  if (typeof value === 'symbol') return '[Symbol]';
  if (typeof value === 'function') return '[Function]';
  return undefined;
}

function safeDescriptors(value: object): Record<string, PropertyDescriptor> | null {
  try {
    return Object.getOwnPropertyDescriptors(value);
  } catch {
    return null;
  }
}

function serializeInternal(
  value: unknown,
  options: NormalizedOptions,
  depth: number,
  seen: WeakSet<object>,
): SerializedConsoleValue {
  const primitive = serializePrimitive(value, options);
  if (primitive !== undefined) return primitive;
  if (typeof value !== 'object' || value === null) return '[Unserializable]';
  if (seen.has(value)) return '[Circular]';
  if (depth >= options.maxDepth) return '[MaxDepth]';
  seen.add(value);

  const descriptors = safeDescriptors(value);
  if (descriptors === null) return '[Uninspectable]';

  if (Array.isArray(value)) {
    const declaredLength = descriptors.length?.value;
    const length =
      typeof declaredLength === 'number'
        ? Math.min(declaredLength, options.maxArrayLength)
        : options.maxArrayLength;
    const output: SerializedConsoleValue[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (descriptor === undefined) {
        output.push('[empty]');
      } else if ('value' in descriptor) {
        output.push(serializeInternal(descriptor.value, options, depth + 1, seen));
      } else {
        output.push('[Accessor]');
      }
    }
    if (typeof declaredLength === 'number' && declaredLength > length) {
      output.push(`[${declaredLength - length} more items]`);
    }
    return output;
  }

  const output: Record<string, SerializedConsoleValue> = {};
  const entries = Object.entries(descriptors)
    .filter(([key, descriptor]) => key !== '__proto__' && descriptor.enumerable === true)
    .slice(0, options.maxKeys);

  for (const [rawKey, descriptor] of entries) {
    const redactedKey = redactSecretsInText(rawKey, options.pseudonymizer).slice(
      0,
      options.maxStringLength,
    );
    if (isSensitiveFieldName(rawKey)) {
      output[redactedKey] = '[Redacted]';
    } else if ('value' in descriptor) {
      output[redactedKey] = serializeInternal(descriptor.value, options, depth + 1, seen);
    } else {
      output[redactedKey] = '[Accessor]';
    }
  }
  const enumerableCount = Object.values(descriptors).filter(
    (descriptor) => descriptor.enumerable === true,
  ).length;
  if (enumerableCount > entries.length) output['[truncated]'] = `${enumerableCount - entries.length} keys`;
  return output;
}

/**
 * Produces a bounded JSON-safe snapshot without evaluating property getters. Proxy traps are
 * contained and represented as an opaque marker instead of aborting capture.
 */
export function serializeConsoleValue(
  value: unknown,
  options: ConsoleSerializationOptions = {},
): SerializedConsoleValue {
  const normalized = normalizeOptions(options);
  const serialized = serializeInternal(value, normalized, 0, new WeakSet());
  try {
    if (JSON.stringify(serialized).length <= normalized.maxTotalLength) return serialized;
  } catch {
    return '[Unserializable]';
  }
  return '[Truncated]';
}
