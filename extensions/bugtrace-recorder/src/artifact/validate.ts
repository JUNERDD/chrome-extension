import type { ErrorObject } from 'ajv';

import validateBugtraceV1, { schemaSha256 } from './bugtrace-v1.validator.js';
import { validateTraceSemantics } from './semantic';
import type { BugtraceTrace } from './types';

export interface TraceValidationIssue {
  instancePath: string;
  schemaPath: string;
  keyword: string;
  message: string;
}

export type TraceValidationResult =
  | { valid: true; trace: BugtraceTrace; errors: readonly [] }
  | { valid: false; errors: readonly TraceValidationIssue[] };

export const BUGTRACE_V1_VALIDATOR_SCHEMA_SHA256 = schemaSha256;

export class BugtraceValidationError extends Error {
  readonly issues: readonly TraceValidationIssue[];

  constructor(issues: readonly TraceValidationIssue[]) {
    const detail = issues
      .slice(0, 5)
      .map((issue) => `${issue.instancePath || '/'} ${issue.message}`)
      .join('; ');
    super(`Invalid Bugtrace v1 trace${detail ? `: ${detail}` : '.'}`);
    this.name = 'BugtraceValidationError';
    this.issues = issues;
  }
}

function normalizeErrors(errors: ErrorObject[] | null | undefined): TraceValidationIssue[] {
  return (errors ?? []).map((error) => ({
    instancePath: error.instancePath,
    schemaPath: error.schemaPath,
    keyword: error.keyword,
    message: error.message ?? 'Schema validation failed.',
  }));
}

export function validateTrace(input: unknown): TraceValidationResult {
  if (validateBugtraceV1(input)) {
    const trace = input as BugtraceTrace;
    const semanticErrors = validateTraceSemantics(trace).map((issue) => ({
      ...issue,
      schemaPath: '#/x-bugtrace-semantic',
    }));
    if (semanticErrors.length > 0) {
      return { valid: false, errors: semanticErrors };
    }
    return { valid: true, trace, errors: [] };
  }
  return { valid: false, errors: normalizeErrors(validateBugtraceV1.errors) };
}

export function assertValidTrace(input: unknown): asserts input is BugtraceTrace {
  const result = validateTrace(input);
  if (!result.valid) {
    throw new BugtraceValidationError(result.errors);
  }
}
