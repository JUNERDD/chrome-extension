import type { RecorderSessionState } from '../session';

export interface PersistedRecorderSession {
  recorder: RecorderSessionState;
  eventCount: number;
  gapCount: number;
  screenshotCount: number;
  generator: {
    name: 'Bugtrace Recorder';
    version: string;
    formatVersion: '1.0.0';
  };
}

export interface SenderContext {
  tabId: number | null;
  windowId: number | null;
  frameId: number | null;
  documentId: string | null;
  url: string | null;
}

export interface NavigationObservation {
  tabId: number;
  frameId: number;
  documentId?: string | undefined;
  parentDocumentId?: string | undefined;
  url: string;
  transitionType?: string | undefined;
  transitionQualifiers?: string[] | undefined;
  error?: string | undefined;
  timeStamp: number;
}

export interface NetworkObservation {
  requestId: string;
  tabId: number;
  method: string;
  type: string;
  url: string;
  timeStamp: number;
  statusCode?: number | undefined;
  fromCache?: boolean | undefined;
  error?: string | undefined;
  responseHeaders?: Readonly<Record<string, string>> | undefined;
}
