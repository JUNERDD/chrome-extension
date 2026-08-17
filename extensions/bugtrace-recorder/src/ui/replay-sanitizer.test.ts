import { describe, expect, it } from 'vitest';
import { sanitizeReplayCss, sanitizeRrwebEventsForReplay } from './replay-sanitizer';

describe('replay sanitizer', () => {
  it('removes remote URL and inline execution surfaces from snapshots', () => {
    const [event] = sanitizeRrwebEventsForReplay([
      {
        type: 2,
        timestamp: 1,
        data: {
          node: {
            type: 2,
            tagName: 'img',
            attributes: {
              src: 'https://tracker.invalid/pixel?secret=value',
              srcset: 'https://tracker.invalid/2x.png 2x',
              onclick: 'fetch("https://tracker.invalid/click")',
              style: 'background-image:url(https://tracker.invalid/background.png)',
            },
            childNodes: [],
          },
        },
      },
    ]);

    expect(JSON.stringify(event)).not.toContain('tracker.invalid');
    expect(JSON.stringify(event)).not.toContain('onclick');
    expect(JSON.stringify(event)).toContain('data:image/gif;base64');
  });

  it('turns executable and embedded elements into inert placeholders', () => {
    const [event] = sanitizeRrwebEventsForReplay([
      {
        type: 3,
        timestamp: 2,
        data: {
          adds: [
            {
              node: {
                type: 2,
                tagName: 'script',
                attributes: { src: 'https://tracker.invalid/run.js' },
                childNodes: [{ type: 3, textContent: 'globalThis.compromised = true' }],
              },
            },
          ],
        },
      },
    ]);

    expect(JSON.stringify(event)).not.toContain('tracker.invalid');
    expect(JSON.stringify(event)).not.toContain('globalThis.compromised');
    expect(JSON.stringify(event)).toContain('data-bugtrace-replay-blocked');
  });

  it('neutralizes CSS imports, URLs, and image sets', () => {
    const sanitized = sanitizeReplayCss(
      '@import "https://tracker.invalid/a.css"; .a{background:url(https://tracker.invalid/a.png)} .b{background:image-set(url(a.png) 1x)}',
    );
    expect(sanitized).not.toContain('tracker.invalid');
    expect(sanitized).not.toContain('@import');
    expect(sanitized).toContain('data:image/gif;base64');
  });
});
