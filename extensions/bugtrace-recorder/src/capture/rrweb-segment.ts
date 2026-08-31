import { record } from '@rrweb/record';
import type { eventWithTime } from '@rrweb/types';
import type { ClientCaptureEvent } from '../messaging';

type Emit = (event: Omit<ClientCaptureEvent, 'clientId' | 'localSeq'>) => void;

/**
 * Bugtrace is an internal, device-local recorder. Capture therefore preserves the rrweb event
 * exactly as observed instead of applying a second privacy transform. The clone prevents a later
 * rrweb mutation from changing the event after it has entered the transport buffer.
 */
export function sanitizeRrwebEventsForCapture(events: readonly eventWithTime[]): eventWithTime[] {
  return events.map((event) => structuredClone(event));
}

export class RrwebSegmentRecorder {
  private stopRecording: (() => void) | null = null;
  private segmentId: string | null = null;

  constructor(private readonly emit: Emit) {}

  start(): string {
    this.stop();
    this.segmentId = crypto.randomUUID();
    const segmentId = this.segmentId;
    this.stopRecording =
      record<eventWithTime>({
        emit: (event) => {
          const capturedEvent = structuredClone(event);
          this.emit({
            observedAt: capturedEvent.timestamp,
            kind: 'rrweb',
            data: { segmentId, event: capturedEvent as unknown as Record<string, unknown> },
          });
        },
        checkoutEveryNms: 60_000,
        collectFonts: true,
        inlineImages: true,
        inlineStylesheet: true,
        keepIframeSrcFn: () => true,
        maskAllInputs: false,
        // rrweb defaults to `{ password: true }` even when maskAllInputs is false.
        // This internal recorder intentionally retains every input type.
        maskInputOptions: { password: false },
        mousemoveWait: 0,
        recordCanvas: true,
        // Content scripts run in every frame. Let rrweb forward cross-origin child activity into
        // the parent stream and suppress independent same-origin child snapshots/segments.
        recordCrossOriginIframes: true,
        recordDOM: true,
        sampling: {
          canvas: 'all',
          input: 'all',
          media: 0,
          mouseInteraction: true,
          mousemove: true,
          scroll: 0,
        },
      }) ?? null;
    return segmentId;
  }

  stop(): void {
    this.stopRecording?.();
    this.stopRecording = null;
    this.segmentId = null;
  }
}
