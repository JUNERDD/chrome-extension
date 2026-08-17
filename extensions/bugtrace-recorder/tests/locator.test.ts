import { afterEach, describe, expect, it, vi } from 'vitest';

import { describeElementContextPaths } from '../src/capture/locator';

class FakeElement {
  readonly classList: string[];
  readonly children: FakeElement[] = [];
  parentElement: FakeElement | null = null;
  ownerDocument: { defaultView: unknown };

  constructor(
    readonly tagName: string,
    readonly id = '',
    classes: string[] = [],
    private root: unknown = {},
    view: unknown = null,
  ) {
    this.classList = classes;
    this.ownerDocument = { defaultView: view };
  }

  getRootNode(): unknown {
    return this.root;
  }
}

class FakeShadowRoot {
  constructor(readonly host: FakeElement) {}
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('element context paths', () => {
  it('returns outer-to-inner locators for nested open shadow roots', () => {
    vi.stubGlobal('ShadowRoot', FakeShadowRoot);
    const outerHost = new FakeElement('BUG-SHELL', 'outer-host');
    const outerRoot = new FakeShadowRoot(outerHost);
    const innerHost = new FakeElement('BUG-PANEL', 'inner-host', [], outerRoot);
    const innerRoot = new FakeShadowRoot(innerHost);
    const target = new FakeElement('BUTTON', '', ['submit-action'], innerRoot);

    expect(describeElementContextPaths(target as unknown as Element)).toEqual({
      framePath: [],
      shadowPath: ['#outer-host', '#inner-host'],
    });
  });

  it('returns observable nested frame locators and marks a hidden cross-origin boundary', () => {
    vi.stubGlobal('ShadowRoot', FakeShadowRoot);
    const topView = {} as {
      top: unknown;
      parent: unknown;
      frameElement: unknown;
    };
    topView.top = topView;
    topView.parent = topView;
    topView.frameElement = null;

    const outerFrame = new FakeElement('IFRAME', 'outer-frame');
    const middleView = {
      top: topView,
      parent: topView,
      frameElement: outerFrame,
    };
    const innerFrame = new FakeElement('IFRAME', 'inner-frame');
    const innerView = {
      top: topView,
      parent: middleView,
      frameElement: innerFrame,
    };
    const target = new FakeElement('BUTTON', 'save', [], {}, innerView);

    expect(describeElementContextPaths(target as unknown as Element).framePath).toEqual([
      '#outer-frame',
      '#inner-frame',
    ]);

    const crossOriginView = { top: topView, parent: topView, frameElement: null };
    const crossOriginTarget = new FakeElement('BUTTON', 'remote', [], {}, crossOriginView);
    expect(describeElementContextPaths(crossOriginTarget as unknown as Element).framePath).toEqual([
      '[frame-unavailable:cross-origin]',
    ]);
  });
});
