import schemaSource from './bugtrace-v1.schema.json?raw';

export const BUGTRACE_V1_SCHEMA_URL =
  'https://schemas.juner.dev/bugtrace/bugtrace-v1.schema.json' as const;

function parseSchema(source: string): Readonly<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(source);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new TypeError('Bugtrace v1 schema must be a JSON object.');
  }
  return Object.freeze(parsed as Record<string, unknown>);
}

export const BUGTRACE_V1_SCHEMA = parseSchema(schemaSource);

export const BUGTRACE_V1_SCHEMA_JSON = `${JSON.stringify(BUGTRACE_V1_SCHEMA, null, 2)}\n`;
