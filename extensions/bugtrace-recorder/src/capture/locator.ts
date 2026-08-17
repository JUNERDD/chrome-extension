export interface LocatorCandidate {
  kind: 'testId' | 'role' | 'id' | 'name' | 'css';
  value: string;
  confidence: number;
}

export interface TargetDescriptor {
  tag: string;
  role: string | null;
  accessibleName: string | null;
  text: string | null;
  locators: LocatorCandidate[];
  framePath: string[];
  shadowPath: string[];
  rect: { x: number; y: number; width: number; height: number };
}

const TEST_ATTRIBUTES = ['data-testid', 'data-test', 'data-cy'] as const;
export const BLOCKED_TARGET_SELECTOR =
  '[data-bugtrace-block], [data-bugtrace-mask], [data-private], [data-sensitive]';
export const EDITABLE_TEXT_ROLE_SELECTOR =
  '[role="textbox"], [role="searchbox"], [role="combobox"]';
export const EDITABLE_TEXT_SELECTOR =
  `[contenteditable]:not([contenteditable="false"]), ${EDITABLE_TEXT_ROLE_SELECTOR}`;
const SENSITIVE_SELECTOR = [
  'input',
  'textarea',
  'select',
  EDITABLE_TEXT_SELECTOR,
  // A top-frame screenshot cannot safely translate sensitive rectangles reported by
  // cross-origin child frames, so the conservative policy is to cover every iframe.
  'iframe',
  '[data-bugtrace-block]',
  '[data-bugtrace-mask]',
  '[data-private]',
  '[data-sensitive]',
  '[autocomplete="one-time-code"]',
].join(',');

export function isBlockedTarget(element: Element): boolean {
  let current: Element | null = element;
  while (current) {
    if (current.matches(BLOCKED_TARGET_SELECTOR)) return true;
    const parentElement: Element | null = current.parentElement;
    if (parentElement) {
      current = parentElement;
      continue;
    }
    const root = current.getRootNode();
    current = root instanceof ShadowRoot ? root.host : null;
  }
  return false;
}

function truncate(value: string, maxLength = 160): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized;
}

function isEditableTextTarget(element: Element): boolean {
  if (
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLSelectElement
  ) {
    return true;
  }
  return element.matches(EDITABLE_TEXT_SELECTOR);
}

function isWithinEditableTextTarget(element: Element): boolean {
  let current: Element | null = element;
  while (current) {
    if (isEditableTextTarget(current)) return true;
    if (current.parentElement) {
      current = current.parentElement;
      continue;
    }
    const root = current.getRootNode();
    current = root instanceof ShadowRoot ? root.host : null;
  }
  return false;
}

function editableValue(element: Element): string | null {
  let current: Element | null = element;
  while (current) {
    if (
      current instanceof HTMLInputElement ||
      current instanceof HTMLTextAreaElement ||
      current instanceof HTMLSelectElement
    ) {
      return current.value;
    }
    if (
      (current instanceof HTMLElement && current.isContentEditable) ||
      ['textbox', 'searchbox', 'combobox'].includes(current.getAttribute('role') ?? '')
    ) {
      return current.textContent ?? '';
    }
    if (current.parentElement) {
      current = current.parentElement;
      continue;
    }
    const root = current.getRootNode();
    current = root instanceof ShadowRoot ? root.host : null;
  }
  return null;
}

function excludesEditableValue(element: Element, candidate: string | null): string | null {
  if (!candidate) return null;
  const rawValue = editableValue(element)?.trim();
  return rawValue && candidate.includes(rawValue) ? null : candidate;
}

function safeTextContent(element: Element): string | null {
  if (isWithinEditableTextTarget(element) || element.matches(BLOCKED_TARGET_SELECTOR)) return null;
  const parts: string[] = [];
  const visit = (node: Node): void => {
    if (node instanceof Text) {
      parts.push(node.data);
      return;
    }
    if (!(node instanceof Element)) return;
    if (
      node !== element &&
      (isEditableTextTarget(node) ||
        node.matches(BLOCKED_TARGET_SELECTOR) ||
        ['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE'].includes(node.tagName))
    ) {
      return;
    }
    for (const child of node.childNodes) visit(child);
  };
  visit(element);
  const value = parts.join(' ').replace(/\s+/gu, ' ').trim();
  return value ? truncate(value) : null;
}

function cssEscape(value: string): string {
  if (globalThis.CSS?.escape) return globalThis.CSS.escape(value);
  return value.replace(/[^a-zA-Z0-9_-]/g, (character) => `\\${character}`);
}

function labelText(element: Element): string | null {
  const ariaLabel = element.getAttribute('aria-label');
  if (ariaLabel) return excludesEditableValue(element, truncate(ariaLabel));

  const labelledBy = element.getAttribute('aria-labelledby');
  if (labelledBy) {
    const value = labelledBy
      .split(/\s+/)
      .map((id) => {
        const label = element.ownerDocument.getElementById(id);
        return label ? (safeTextContent(label) ?? '') : '';
      })
      .join(' ');
    if (value.trim()) return excludesEditableValue(element, truncate(value));
  }

  if (
    (element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement ||
      element instanceof HTMLSelectElement) &&
    element.labels?.length
  ) {
    const value = [...element.labels].map((label) => safeTextContent(label) ?? '').join(' ');
    if (value.trim()) return excludesEditableValue(element, truncate(value));
  }

  const fallback =
    element.getAttribute('alt') ??
    element.getAttribute('title') ??
    safeTextContent(element);
  return fallback?.trim() ? excludesEditableValue(element, truncate(fallback)) : null;
}

function stableCssPath(element: Element): string {
  const segments: string[] = [];
  let current: Element | null = element;

  while (current && segments.length < 5) {
    if (current.id) {
      segments.unshift(`#${cssEscape(current.id)}`);
      break;
    }

    let segment = current.tagName.toLowerCase();
    const stableClass = [...current.classList].find(
      (className) => className.length < 40 && !/\d{3,}|(^|[-_])[a-f0-9]{8,}/i.test(className),
    );
    if (stableClass) segment += `.${cssEscape(stableClass)}`;

    const parentElement: Element | null = current.parentElement;
    if (parentElement) {
      const siblings = [...parentElement.children].filter((candidate) => candidate.tagName === current?.tagName);
      if (siblings.length > 1) segment += `:nth-of-type(${siblings.indexOf(current) + 1})`;
    }
    segments.unshift(segment);
    current = parentElement;
  }

  return segments.join(' > ');
}

const CROSS_ORIGIN_FRAME_MARKER = '[frame-unavailable:cross-origin]';

/**
 * Returns outer-to-inner host/frame locators for the DOM context observable from this frame.
 * A cross-origin parent cannot expose its iframe element, so that boundary is explicit rather
 * than being misrepresented as a top-level target.
 */
export function describeElementContextPaths(
  element: Element,
): Pick<TargetDescriptor, 'framePath' | 'shadowPath'> {
  const shadowPath: string[] = [];
  let shadowNode: Element = element;
  while (shadowPath.length < 32) {
    const root = shadowNode.getRootNode();
    if (!(root instanceof ShadowRoot)) break;
    shadowPath.unshift(stableCssPath(root.host));
    shadowNode = root.host;
  }

  const framePath: string[] = [];
  let view: Window | null = element.ownerDocument.defaultView;
  while (view && framePath.length < 32) {
    let top: Window | null;
    try {
      top = view.top;
    } catch {
      framePath.unshift(CROSS_ORIGIN_FRAME_MARKER);
      break;
    }
    if (top === null || view === top) break;

    let frameElement: Element | null;
    try {
      frameElement = view.frameElement;
    } catch {
      frameElement = null;
    }
    if (frameElement === null) {
      framePath.unshift(CROSS_ORIGIN_FRAME_MARKER);
      break;
    }
    framePath.unshift(stableCssPath(frameElement));

    let parent: Window;
    try {
      parent = view.parent;
    } catch {
      framePath.unshift(CROSS_ORIGIN_FRAME_MARKER);
      break;
    }
    if (parent === view) break;
    view = parent;
  }

  return { framePath, shadowPath };
}

export function elementFromEvent(event: Event): Element | null {
  return (event.composedPath().find((candidate): candidate is Element => candidate instanceof Element) ?? null);
}

export function describeTarget(element: Element): TargetDescriptor {
  const locators: LocatorCandidate[] = [];
  const rawEditableValue = editableValue(element)?.trim() ?? '';
  const addLocator = (candidate: LocatorCandidate): void => {
    if (!rawEditableValue || !candidate.value.includes(rawEditableValue)) locators.push(candidate);
  };

  for (const attribute of TEST_ATTRIBUTES) {
    const value = element.getAttribute(attribute);
    if (value) addLocator({ kind: 'testId', value: `[${attribute}="${truncate(value, 100)}"]`, confidence: 1 });
  }

  const role = element.getAttribute('role');
  const accessibleName = labelText(element);
  if (role && accessibleName) {
    addLocator({ kind: 'role', value: `${role}:${accessibleName}`, confidence: 0.92 });
  }
  if (element.id) addLocator({ kind: 'id', value: element.id, confidence: 0.88 });
  const name = element.getAttribute('name');
  if (name) addLocator({ kind: 'name', value: name, confidence: 0.8 });
  addLocator({ kind: 'css', value: stableCssPath(element), confidence: 0.45 });

  const rect = element.getBoundingClientRect();
  const contextPaths = describeElementContextPaths(element);
  return {
    tag: element.tagName.toLowerCase(),
    role,
    accessibleName,
    text: isWithinEditableTextTarget(element) ? null : labelText(element),
    locators: locators.slice(0, 6),
    framePath: contextPaths.framePath,
    shadowPath: contextPaths.shadowPath,
    rect: {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    },
  };
}

export function listSensitiveRects(): Array<{ x: number; y: number; width: number; height: number }> {
  const sensitiveRoots = new Set<Element>();
  const discover = (root: Document | ShadowRoot): void => {
    for (const element of root.querySelectorAll(SENSITIVE_SELECTOR)) sensitiveRoots.add(element);
    for (const element of root.querySelectorAll('*')) {
      if (element.shadowRoot) discover(element.shadowRoot);
    }
  };
  discover(document);

  const rects = new Map<string, { x: number; y: number; width: number; height: number }>();
  const visited = new Set<Node>();
  let overflow = false;
  const addRect = (rect: DOMRectReadOnly): void => {
    if (
      !Number.isFinite(rect.x) ||
      !Number.isFinite(rect.y) ||
      !Number.isFinite(rect.width) ||
      !Number.isFinite(rect.height) ||
      rect.width <= 0 ||
      rect.height <= 0
    ) {
      return;
    }
    const normalized = {
      x: Math.max(0, Math.round(rect.x)),
      y: Math.max(0, Math.round(rect.y)),
      width: Math.max(1, Math.round(rect.width)),
      height: Math.max(1, Math.round(rect.height)),
    };
    rects.set(
      `${normalized.x}:${normalized.y}:${normalized.width}:${normalized.height}`,
      normalized,
    );
    if (rects.size > 1_000) overflow = true;
  };
  const collect = (node: Node): void => {
    if (overflow || visited.has(node)) return;
    visited.add(node);
    if (visited.size > 10_000) {
      overflow = true;
      return;
    }
    if (node instanceof Text) {
      if (!node.data.trim()) return;
      try {
        const range = document.createRange();
        range.selectNodeContents(node);
        addRect(range.getBoundingClientRect());
        range.detach();
      } catch {
        overflow = true;
      }
      return;
    }
    if (!(node instanceof Element)) return;
    addRect(node.getBoundingClientRect());
    for (const child of node.childNodes) collect(child);
    if (node.shadowRoot) {
      for (const child of node.shadowRoot.childNodes) collect(child);
    }
  };
  for (const root of sensitiveRoots) collect(root);
  if (overflow) {
    return [
      {
        x: 0,
        y: 0,
        width: Math.max(1, window.innerWidth, document.documentElement?.clientWidth ?? 0),
        height: Math.max(1, window.innerHeight, document.documentElement?.clientHeight ?? 0),
      },
    ];
  }
  return [...rects.values()];
}
