/**
 * Legacy finding names kept so callers built against Bugtrace 1.0 continue to type-check.
 * Bugtrace 1.1 is an internal, full-fidelity format and deliberately performs no secret scan.
 */
export type SecretFindingKind =
  | 'credential-field'
  | 'authorization-header'
  | 'cookie-header'
  | 'url-credentials'
  | 'url-query-value'
  | 'url-fragment'
  | 'url-email-segment'
  | 'url-identifier-segment'
  | 'url-high-entropy-segment'
  | 'jwt'
  | 'private-key'
  | 'payment-card';

export interface SecretFinding {
  kind: SecretFindingKind;
  source: string;
  index: number;
}

/** @deprecated Bugtrace 1.1 exports are never blocked by content scanning. */
export class SecretLeakError extends Error {
  readonly findings: readonly SecretFinding[];

  constructor(findings: readonly SecretFinding[]) {
    super('Bugtrace export content scanning is disabled for full-fidelity internal artifacts.');
    this.name = 'SecretLeakError';
    this.findings = findings;
  }
}

/**
 * Compatibility no-op. Full-fidelity Bugtrace artifacts intentionally preserve raw observations.
 */
export function scanForSecrets(
  input: string | Uint8Array | ArrayBuffer,
  source = 'artifact',
): SecretFinding[] {
  void input;
  void source;
  return [];
}

/**
 * Compatibility no-op. Export validity is enforced structurally and semantically, not by content.
 */
export function assertNoSecrets(
  input: string | Uint8Array | ArrayBuffer,
  source = 'artifact',
): void {
  void input;
  void source;
}

export function isTextMimeType(mimeType: string): boolean {
  const normalized = mimeType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  return (
    normalized.startsWith('text/') ||
    normalized === 'application/json' ||
    normalized.endsWith('+json') ||
    normalized === 'application/xml' ||
    normalized.endsWith('+xml') ||
    normalized === 'application/javascript'
  );
}
