const DOCUMENT_RECORDER_OWNER = Symbol.for('bugtrace-recorder.document-owner.v1');

/**
 * Content scripts can be evaluated more than once in the same isolated document realm. Keep the
 * ownership marker on that realm so duplicate bundle instances cannot start competing collectors.
 */
export function claimDocumentRecorderOwnership(target: object = globalThis): boolean {
  if (Object.prototype.hasOwnProperty.call(target, DOCUMENT_RECORDER_OWNER)) return false;
  try {
    Object.defineProperty(target, DOCUMENT_RECORDER_OWNER, {
      configurable: false,
      enumerable: false,
      value: true,
      writable: false,
    });
    return true;
  } catch {
    return false;
  }
}
