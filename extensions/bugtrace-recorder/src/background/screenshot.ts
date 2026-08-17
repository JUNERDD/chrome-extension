import { browser } from 'wxt/browser';
import type { SensitiveRect } from '../messaging';

interface SensitiveRectResponse {
  rects: SensitiveRect[];
  devicePixelRatio: number;
  documentToken: string;
}

function validatedResponse(value: SensitiveRectResponse | undefined): SensitiveRectResponse {
  if (
    !value ||
    !Array.isArray(value.rects) ||
    typeof value.documentToken !== 'string' ||
    value.documentToken.length === 0 ||
    !Number.isFinite(value.devicePixelRatio) ||
    value.devicePixelRatio <= 0 ||
    value.devicePixelRatio > 16
  ) {
    throw new Error('Screenshot skipped because sensitive regions could not be confirmed.');
  }
  return {
    ...value,
    rects: value.rects.filter(
      (rect) =>
        Number.isFinite(rect.x) &&
        Number.isFinite(rect.y) &&
        Number.isFinite(rect.width) &&
        Number.isFinite(rect.height) &&
        rect.width > 0 &&
        rect.height > 0,
    ),
  };
}

function unionRects(before: SensitiveRect[], after: SensitiveRect[]): SensitiveRect[] {
  const unique = new Map<string, SensitiveRect>();
  for (const rect of [...before, ...after]) {
    const key = [rect.x, rect.y, rect.width, rect.height].map((value) => Math.round(value * 10)).join(':');
    unique.set(key, rect);
  }
  return [...unique.values()];
}

export interface RedactedScreenshot {
  bytes: ArrayBuffer;
  mimeType: 'image/webp';
  width: number;
  height: number;
  redactedRectCount: number;
}

export async function captureRedactedScreenshot(
  tabId: number,
  windowId: number,
): Promise<RedactedScreenshot> {
  const activeTabs = await browser.tabs.query({ active: true, windowId });
  if (!activeTabs.some((tab) => tab.id === tabId)) {
    throw new Error('Screenshot skipped because the scoped tab is not visible.');
  }

  const rectResponse = validatedResponse(
    (await browser.tabs.sendMessage(
      tabId,
      { type: 'CAPTURE_SCREENSHOT_RECTS' },
      { frameId: 0 },
    )) as SensitiveRectResponse | undefined,
  );

  const dataUrl = await browser.tabs.captureVisibleTab(windowId, { format: 'jpeg', quality: 78 });
  const activeAfterCapture = await browser.tabs.query({ active: true, windowId });
  if (!activeAfterCapture.some((tab) => tab.id === tabId)) {
    throw new Error('Screenshot discarded because the active tab changed during capture.');
  }
  const documentAfterCapture = validatedResponse(
    (await browser.tabs.sendMessage(
      tabId,
      { type: 'CAPTURE_SCREENSHOT_RECTS' },
      { frameId: 0 },
    )) as SensitiveRectResponse | undefined,
  );
  if (documentAfterCapture.documentToken !== rectResponse.documentToken) {
    throw new Error('Screenshot discarded because the document changed during capture.');
  }
  if (Math.abs(documentAfterCapture.devicePixelRatio - rectResponse.devicePixelRatio) > 0.001) {
    throw new Error('Screenshot discarded because the display scale changed during capture.');
  }
  const rects = unionRects(rectResponse.rects, documentAfterCapture.rects);
  const sourceBlob = await fetch(dataUrl).then((response) => response.blob());
  const bitmap = await createImageBitmap(sourceBlob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Screenshot skipped because the redaction canvas is unavailable.');

  context.drawImage(bitmap, 0, 0);
  context.fillStyle = '#111416';
  const ratio = Number.isFinite(rectResponse.devicePixelRatio) ? rectResponse.devicePixelRatio : 1;
  if (rects.length > 1_000) {
    // Never silently leave the tail unmasked. An unusually dense page keeps only an opaque
    // screenshot as evidence; the semantic trace remains useful and honest.
    context.fillRect(0, 0, canvas.width, canvas.height);
  } else {
    for (const rect of rects) {
      context.fillRect(
        Math.max(0, rect.x * ratio - 3),
        Math.max(0, rect.y * ratio - 3),
        Math.max(1, rect.width * ratio + 6),
        Math.max(1, rect.height * ratio + 6),
      );
    }
  }
  bitmap.close();

  const redacted = await canvas.convertToBlob({ type: 'image/webp', quality: 0.78 });
  return {
    bytes: await redacted.arrayBuffer(),
    mimeType: 'image/webp',
    width: canvas.width,
    height: canvas.height,
    redactedRectCount: rects.length,
  };
}
