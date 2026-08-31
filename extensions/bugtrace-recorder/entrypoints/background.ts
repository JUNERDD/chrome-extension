import { browser } from 'wxt/browser';
import { RecorderService, type NavigationObservation, type NetworkObservation } from '../src/background';
import { subscribeLanguagePreference } from '../src/i18n/runtime';
import {
  CURRENT_RUNTIME_METADATA,
  parseRuntimeRequest,
  SESSION_COMMANDS,
  type RuntimeResponse,
} from '../src/messaging';

const service = new RecorderService();
const requestFilter = { urls: ['http://*/*', 'https://*/*'] };

export default defineBackground(() => {
  void service.ensureInitialized();
  subscribeLanguagePreference(() => void service.refreshActionTitle().catch(() => undefined));
  void browser.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch(() => undefined);

  browser.runtime.onMessage.addListener((rawMessage, sender, sendResponse) => {
    void handleRuntimeMessage(rawMessage, sender).then(sendResponse, (error: unknown) => {
      sendResponse({
        ok: false,
        ...CURRENT_RUNTIME_METADATA,
        error: error instanceof Error ? error.message : String(error),
        state: service.getViewState(),
      } satisfies RuntimeResponse);
    });
    return true;
  });

  browser.commands.onCommand.addListener((command) => {
    if (SESSION_COMMANDS.includes(command as (typeof SESSION_COMMANDS)[number])) {
      void service.executeCommand(command as (typeof SESSION_COMMANDS)[number]).catch(() => undefined);
    }
  });

  browser.tabs.onCreated.addListener((tab) => {
    void service.handleTabCreated(tab);
  });
  browser.tabs.onRemoved.addListener((tabId) => {
    void service.handleTabRemoved(tabId);
  });
  browser.tabs.onDetached.addListener((tabId, { oldWindowId }) => {
    void service.handleTabDetached(tabId, oldWindowId);
  });
  browser.tabs.onAttached.addListener((tabId, { newWindowId }) => {
    void service.handleTabAttached(tabId, newWindowId);
  });
  browser.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
    void service.handleTabReplaced(addedTabId, removedTabId);
  });
  browser.tabs.onActivated.addListener(({ tabId }) => {
    void service.handleTabActivated(tabId);
  });
  browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.url === undefined && changeInfo.status !== 'complete') return;
    const status = changeInfo.status === 'complete' || tab.status === 'complete'
      ? 'complete'
      : changeInfo.status === 'loading' || tab.status === 'loading'
        ? 'loading'
        : undefined;
    void service.handleTabUpdated(tabId, tab, status);
  });
  browser.windows.onFocusChanged.addListener((windowId) => {
    void service.handleWindowFocused(windowId);
  });
  browser.windows.onRemoved.addListener((windowId) => {
    void service.handleWindowRemoved(windowId);
  });

  browser.webNavigation.onCreatedNavigationTarget.addListener((details) => {
    void browser.tabs.get(details.tabId).then(
      (tab) => service.handleTabCreated({
        id: details.tabId,
        openerTabId: details.sourceTabId,
        windowId: tab.windowId,
      }),
      () => service.handleTabCreated({
        id: details.tabId,
        openerTabId: details.sourceTabId,
      }),
    );
  });
  browser.webNavigation.onCommitted.addListener((details) => {
    void service.handleNavigation('committed', navigationObservation(details));
  });
  browser.webNavigation.onCompleted.addListener((details) => {
    void service.handleNavigation('completed', navigationObservation(details));
  });
  browser.webNavigation.onErrorOccurred.addListener((details) => {
    void service.handleNavigation('error', navigationObservation(details));
  });
  browser.webNavigation.onHistoryStateUpdated.addListener((details) => {
    void service.handleNavigation('history_state', navigationObservation(details));
  });
  browser.webNavigation.onReferenceFragmentUpdated.addListener((details) => {
    void service.handleNavigation('fragment', navigationObservation(details));
  });

  browser.webRequest.onBeforeRequest.addListener((details) => {
    void service.handleNetworkStart(networkObservation(details));
    return undefined;
  }, requestFilter, ['requestBody']);
  browser.webRequest.onBeforeSendHeaders.addListener((details) => {
    void service.handleNetworkHeaders(networkObservation(details));
    return undefined;
  }, requestFilter, ['requestHeaders', 'extraHeaders']);
  browser.webRequest.onCompleted.addListener((details) => {
    void service.handleNetworkEnd(networkObservation(details));
  }, requestFilter, ['responseHeaders', 'extraHeaders']);
  browser.webRequest.onErrorOccurred.addListener((details) => {
    void service.handleNetworkEnd(networkObservation(details));
  }, requestFilter);
});

async function handleRuntimeMessage(
  rawMessage: unknown,
  sender: Browser.runtime.MessageSender,
): Promise<RuntimeResponse> {
  await service.ensureInitialized();
  try {
    const request = parseRuntimeRequest(rawMessage);
    return service.handleRequest(request, {
      tabId: sender.tab?.id ?? null,
      windowId: sender.tab?.windowId ?? null,
      frameId: sender.frameId ?? null,
      documentId: sender.documentId ?? null,
      url: sender.url ?? sender.tab?.url ?? null,
    });
  } catch (error) {
    return {
      ok: false,
      ...CURRENT_RUNTIME_METADATA,
      error: error instanceof Error ? error.message : String(error),
      state: service.getViewState(),
    };
  }
}

function navigationObservation(
  details:
    | Browser.webNavigation.WebNavigationTransitionCallbackDetails
    | Browser.webNavigation.WebNavigationFramedCallbackDetails
    | Browser.webNavigation.WebNavigationFramedErrorCallbackDetails,
): NavigationObservation {
  return {
    tabId: details.tabId,
    frameId: details.frameId,
    documentId: details.documentId,
    parentDocumentId: details.parentDocumentId,
    url: details.url,
    transitionType: 'transitionType' in details ? details.transitionType : undefined,
    transitionQualifiers: 'transitionQualifiers' in details ? details.transitionQualifiers : undefined,
    error: 'error' in details ? details.error : undefined,
    timeStamp: details.timeStamp,
  };
}

function networkObservation(
  details:
    | Browser.webRequest.OnBeforeRequestDetails
    | Browser.webRequest.OnBeforeSendHeadersDetails
    | Browser.webRequest.OnCompletedDetails
    | Browser.webRequest.OnErrorOccurredDetails,
): NetworkObservation {
  return {
    requestId: details.requestId,
    tabId: details.tabId,
    method: details.method,
    type: details.type,
    url: details.url,
    timeStamp: details.timeStamp,
    statusCode: 'statusCode' in details ? details.statusCode : undefined,
    fromCache: 'fromCache' in details ? details.fromCache : undefined,
    error: 'error' in details ? details.error : undefined,
    requestHeaders:
      'requestHeaders' in details && details.requestHeaders
        ? captureHeaders(details.requestHeaders)
        : undefined,
    responseHeaders:
      'responseHeaders' in details && details.responseHeaders
        ? captureHeaders(details.responseHeaders)
        : undefined,
    requestBody:
      'requestBody' in details ? captureRequestBody(details.requestBody) : undefined,
  };
}

function captureHeaders(
  headers: ReadonlyArray<{
    name: string;
    value?: string | undefined;
    binaryValue?: ArrayBuffer | undefined;
  }>,
): Readonly<Record<string, readonly string[]>> {
  const output: Record<string, string[]> = {};
  for (const header of headers) {
    const name = header.name.trim().toLowerCase();
    if (!name) continue;
    const value = header.value ?? (
      header.binaryValue ? `base64:${bytesToBase64(new Uint8Array(header.binaryValue))}` : ''
    );
    (output[name] ??= []).push(value);
  }
  return output;
}

function captureRequestBody(
  requestBody: {
    error?: string | undefined;
    formData?: Record<string, ReadonlyArray<string | ArrayBuffer>> | undefined;
    raw?: Array<{
      bytes?: ArrayBuffer | undefined;
      file?: string | undefined;
    }> | undefined;
  } | undefined,
): NetworkObservation['requestBody'] {
  if (!requestBody) {
    return { status: 'unavailable', reason: 'Chrome reported no request body.' };
  }
  if (requestBody.formData) {
    const value = Object.fromEntries(
      Object.entries(requestBody.formData).map(([name, values]) => [
        name,
        values.map((item) =>
          typeof item === 'string'
            ? item
            : { bytes: bytesToBase64(new Uint8Array(item)) },
        ),
      ]),
    );
    return {
      status: 'captured',
      encoding: 'form-data',
      value,
    };
  }
  if (requestBody.raw) {
    return {
      status: 'captured',
      encoding: 'base64',
      value: requestBody.raw.map((part) => ({
        ...(part.bytes ? { bytes: bytesToBase64(new Uint8Array(part.bytes)) } : {}),
        ...(part.file ? { file: part.file } : {}),
      })),
    };
  }
  if (requestBody.error) {
    return { status: 'unavailable', reason: requestBody.error };
  }
  return { status: 'unavailable', reason: 'Chrome exposed an empty request-body descriptor.' };
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}
