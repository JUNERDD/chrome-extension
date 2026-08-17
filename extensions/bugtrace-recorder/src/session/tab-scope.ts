export interface ScopedTab {
  readonly tabId: number;
  readonly parentTabId: number | null;
  readonly windowId: number | null;
  readonly addedAtMs: number;
  readonly closedAtMs: number | null;
}

export interface SessionTabScope {
  readonly rootTabId: number;
  readonly tabs: readonly ScopedTab[];
}

export interface TabScopeOptions {
  readonly windowId?: number | null;
  readonly addedAtMs?: number;
}

export interface DescendantTabInput extends TabScopeOptions {
  readonly tabId: number;
  readonly openerTabId: number;
}

export interface ReplacementTabInput extends TabScopeOptions {
  readonly removedTabId: number;
  readonly addedTabId: number;
}

export class TabScopeError extends Error {
  readonly code:
    | 'invalid_tab_id'
    | 'opener_outside_scope'
    | 'tab_parent_conflict'
    | 'tab_already_closed'
    | 'replacement_conflict';

  constructor(
    code: TabScopeError['code'],
    message: string,
  ) {
    super(message);
    this.name = 'TabScopeError';
    this.code = code;
  }
}

function assertTabId(tabId: number, label: string): void {
  if (!Number.isSafeInteger(tabId) || tabId < 0) {
    throw new TabScopeError('invalid_tab_id', `${label} must be a non-negative safe integer.`);
  }
}

function assertTimestamp(timestamp: number, label: string): void {
  if (!Number.isFinite(timestamp) || timestamp < 0) {
    throw new RangeError(`${label} must be a non-negative finite number.`);
  }
}

export function createTabScope(
  rootTabId: number,
  options: TabScopeOptions = {},
): SessionTabScope {
  assertTabId(rootTabId, 'rootTabId');
  const addedAtMs = options.addedAtMs ?? 0;
  assertTimestamp(addedAtMs, 'addedAtMs');

  return {
    rootTabId,
    tabs: [
      {
        tabId: rootTabId,
        parentTabId: null,
        windowId: options.windowId ?? null,
        addedAtMs,
        closedAtMs: null,
      },
    ],
  };
}

export function getScopedTab(scope: SessionTabScope, tabId: number): ScopedTab | null {
  return scope.tabs.find((tab) => tab.tabId === tabId) ?? null;
}

/** Closed tabs remain in scope so their timeline and lineage stay attributable. */
export function isTabInScope(scope: SessionTabScope | null, tabId: number): boolean {
  return scope !== null && getScopedTab(scope, tabId) !== null;
}

export function isOpenTabInScope(scope: SessionTabScope | null, tabId: number): boolean {
  return scope !== null && getScopedTab(scope, tabId)?.closedAtMs === null;
}

export function addDescendantTab(
  scope: SessionTabScope,
  input: DescendantTabInput,
): SessionTabScope;
export function addDescendantTab(
  scope: SessionTabScope,
  tabId: number,
  openerTabId: number,
  addedAtMs?: number,
): SessionTabScope;
export function addDescendantTab(
  scope: SessionTabScope,
  inputOrTabId: DescendantTabInput | number,
  positionalOpenerTabId?: number,
  positionalAddedAtMs = 0,
): SessionTabScope {
  const input: DescendantTabInput =
    typeof inputOrTabId === 'number'
      ? {
          tabId: inputOrTabId,
          openerTabId: positionalOpenerTabId ?? -1,
          addedAtMs: positionalAddedAtMs,
        }
      : inputOrTabId;

  assertTabId(input.tabId, 'tabId');
  assertTabId(input.openerTabId, 'openerTabId');
  const addedAtMs = input.addedAtMs ?? 0;
  assertTimestamp(addedAtMs, 'addedAtMs');

  const opener = getScopedTab(scope, input.openerTabId);
  if (opener === null) {
    throw new TabScopeError(
      'opener_outside_scope',
      `Tab ${input.tabId} cannot join the scope because opener ${input.openerTabId} is outside it.`,
    );
  }
  if (opener.closedAtMs !== null && addedAtMs > opener.closedAtMs) {
    throw new TabScopeError(
      'tab_already_closed',
      `Tab ${input.tabId} cannot be added after opener ${input.openerTabId} closed.`,
    );
  }

  const existing = getScopedTab(scope, input.tabId);
  if (existing !== null) {
    if (existing.closedAtMs !== null) {
      throw new TabScopeError(
        'tab_already_closed',
        `Tab ${input.tabId} was already closed and cannot be re-added ambiguously.`,
      );
    }
    if (existing.parentTabId === input.openerTabId) {
      if (existing.windowId === null && input.windowId !== null && input.windowId !== undefined) {
        return {
          ...scope,
          tabs: scope.tabs.map((tab) =>
            tab.tabId === input.tabId ? { ...tab, windowId: input.windowId ?? null } : tab,
          ),
        };
      }
      return scope;
    }
    throw new TabScopeError(
      'tab_parent_conflict',
      `Tab ${input.tabId} is already attributed to a different opener.`,
    );
  }

  return {
    ...scope,
    tabs: [
      ...scope.tabs,
      {
        tabId: input.tabId,
        parentTabId: input.openerTabId,
        windowId: input.windowId ?? null,
        addedAtMs,
        closedAtMs: null,
      },
    ],
  };
}

export function markTabClosed(
  scope: SessionTabScope,
  tabId: number,
  closedAtMs: number,
): SessionTabScope {
  assertTimestamp(closedAtMs, 'closedAtMs');
  const tab = getScopedTab(scope, tabId);
  if (tab === null || tab.closedAtMs !== null) return scope;
  if (closedAtMs < tab.addedAtMs) {
    throw new RangeError('closedAtMs cannot be earlier than addedAtMs.');
  }
  return {
    ...scope,
    tabs: scope.tabs.map((candidate) =>
      candidate.tabId === tabId ? { ...candidate, closedAtMs } : candidate,
    ),
  };
}

export function updateScopedTabWindow(
  scope: SessionTabScope,
  tabId: number,
  windowId: number | null,
): SessionTabScope {
  assertTabId(tabId, 'tabId');
  if (windowId !== null) assertTabId(windowId, 'windowId');
  const tab = getScopedTab(scope, tabId);
  if (tab === null || tab.closedAtMs !== null || tab.windowId === windowId) return scope;
  return {
    ...scope,
    tabs: scope.tabs.map((candidate) =>
      candidate.tabId === tabId ? { ...candidate, windowId } : candidate,
    ),
  };
}

/** Chrome may swap a tab ID while preserving the logical page (for example prerender activation). */
export function replaceScopedTab(
  scope: SessionTabScope,
  input: ReplacementTabInput,
): SessionTabScope {
  assertTabId(input.removedTabId, 'removedTabId');
  assertTabId(input.addedTabId, 'addedTabId');
  if (input.windowId !== null && input.windowId !== undefined) {
    assertTabId(input.windowId, 'windowId');
  }
  const removed = getScopedTab(scope, input.removedTabId);
  if (removed === null || removed.closedAtMs !== null) return scope;
  if (input.removedTabId === input.addedTabId) {
    return updateScopedTabWindow(scope, input.addedTabId, input.windowId ?? removed.windowId);
  }
  if (getScopedTab(scope, input.addedTabId) !== null) {
    throw new TabScopeError(
      'replacement_conflict',
      `Replacement tab ${input.addedTabId} already belongs to the recording scope.`,
    );
  }
  const replacementWindowId = input.windowId ?? removed.windowId;
  return {
    rootTabId:
      scope.rootTabId === input.removedTabId ? input.addedTabId : scope.rootTabId,
    tabs: scope.tabs.map((candidate) => {
      if (candidate.tabId === input.removedTabId) {
        return {
          ...candidate,
          tabId: input.addedTabId,
          windowId: replacementWindowId,
        };
      }
      return candidate.parentTabId === input.removedTabId
        ? { ...candidate, parentTabId: input.addedTabId }
        : candidate;
    }),
  };
}

/** Returns root-to-leaf lineage, or an empty array when the tab is out of scope. */
export function getTabLineage(scope: SessionTabScope, tabId: number): readonly number[] {
  const lineage: number[] = [];
  const visited = new Set<number>();
  let current = getScopedTab(scope, tabId);
  while (current !== null) {
    if (visited.has(current.tabId)) return [];
    visited.add(current.tabId);
    lineage.push(current.tabId);
    current =
      current.parentTabId === null ? null : getScopedTab(scope, current.parentTabId);
  }
  lineage.reverse();
  return lineage[0] === scope.rootTabId ? lineage : [];
}

export function isSupportedCaptureUrl(url: string): boolean {
  try {
    const protocol = new URL(url).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}
