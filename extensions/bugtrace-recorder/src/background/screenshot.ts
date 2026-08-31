import { browser } from 'wxt/browser';

export interface CapturedScreenshot {
  bytes: ArrayBuffer;
  mimeType: 'image/png';
  width: number;
  height: number;
  /** Kept for backward-compatible stored metadata; full-fidelity capture always reports zero. */
  redactedRectCount: 0;
}

/** Captures the scoped visible viewport losslessly and does not mutate any pixels. */
export async function captureScreenshot(
  tabId: number,
  windowId: number,
): Promise<CapturedScreenshot> {
  const activeTabs = await browser.tabs.query({ active: true, windowId });
  if (!activeTabs.some((tab) => tab.id === tabId)) {
    throw new Error('Screenshot skipped because the scoped tab is not visible.');
  }

  const dataUrl = await browser.tabs.captureVisibleTab(windowId, { format: 'png' });
  const activeAfterCapture = await browser.tabs.query({ active: true, windowId });
  if (!activeAfterCapture.some((tab) => tab.id === tabId)) {
    throw new Error('Screenshot discarded because the active tab changed during capture.');
  }

  const sourceBlob = await fetch(dataUrl).then((response) => response.blob());
  const bitmap = await createImageBitmap(sourceBlob);
  const width = bitmap.width;
  const height = bitmap.height;
  bitmap.close();
  return {
    bytes: await sourceBlob.arrayBuffer(),
    mimeType: 'image/png',
    width,
    height,
    redactedRectCount: 0,
  };
}

/** @deprecated Use captureScreenshot; retained so old test doubles and imports fail gracefully. */
export const captureRedactedScreenshot = captureScreenshot;
export type RedactedScreenshot = CapturedScreenshot;
