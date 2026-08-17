import type { ValidateFunction } from 'ajv';

import type { BugtraceTrace } from './types';

declare const validate: ValidateFunction<BugtraceTrace>;
declare const schemaSha256: string;

export { schemaSha256, validate };
export default validate;
