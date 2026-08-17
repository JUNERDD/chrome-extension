import { browser } from 'wxt/browser';
import { RecorderService, type NavigationObservation, type NetworkObservation } from '../src/background';
import { parseRuntimeRequest, SESSION_COMMANDS, type RuntimeResponse } from '../src/messaging';
import { filterAllowedNetworkResponseHeaders, redactUrl } from '../src/privacy';

const service = new RecorderService();
const requestFilter = { urls: ['http://*/*', 'https://*/*'] };

export default defineBackground(() => {
  void service.ensureInitialized();

  browser.runtime.onMessage.addListener((rawMessage, sender, sendResponse) => {
    void handleRuntimeMessage(rawMessage, sender).then(sendResponse, (error: unknown) => {
      sendResponse({
        ok: false,
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
  browser.windows.onFocusChanged.addListener((windowId) => {
    void service.handleWindowFocused(windowId);
  });
  browser.windows.onRemoved.addListener((windowId) => {
    void service.handleWindowRemoved(windowId);
  });

  browser.webNavigation.onCreatedNavigationTarget.addListener((details) => {
    void service.handleTabCreated({ id: details.tabId, openerTabId: details.sourceTabId });
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
  }, requestFilter);
  browser.webRequest.onCompleted.addListener((details) => {
    void service.handleNetworkEnd(networkObservation(details));
  }, requestFilter, ['responseHeaders']);
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
    | Browser.webRequest.OnCompletedDetails
    | Browser.webRequest.OnErrorOccurredDetails,
): NetworkObservation {
  return {
    requestId: details.requestId,
    tabId: details.tabId,
    method: details.method,
    type: details.type,
    url: redactUrl(details.url, () => '<redacted>'),
    timeStamp: details.timeStamp,
    statusCode: 'statusCode' in details ? details.statusCode : undefined,
    fromCache: 'fromCache' in details ? details.fromCache : undefined,
    error: 'error' in details ? details.error : undefined,
    responseHeaders:
      'responseHeaders' in details && details.responseHeaders
        ? filterAllowedNetworkResponseHeaders(
            details.responseHeaders.map((header) =>
              header.value === undefined
                ? { name: header.name }
                : { name: header.name, value: header.value },
            ),
          )
        : undefined,
  };
}
