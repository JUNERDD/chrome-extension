import { describe, expect, it } from 'vitest';

import type { eventWithTime } from '@rrweb/types';
import {
  RRWEB_MASK_TEXT_SELECTOR,
  sanitizeRrwebEventsForCapture,
} from '../src/capture/rrweb-segment';

describe('rrweb privacy policy', () => {
  it('masks editable text that is not represented by a native input value', () => {
    expect(RRWEB_MASK_TEXT_SELECTOR).toContain('[contenteditable]');
    expect(RRWEB_MASK_TEXT_SELECTOR).toContain('one-time-code');
    expect(RRWEB_MASK_TEXT_SELECTOR).toContain('[role="textbox"]');
    expect(RRWEB_MASK_TEXT_SELECTOR).toContain('[role="searchbox"]');
    expect(RRWEB_MASK_TEXT_SELECTOR).toContain('[role="combobox"]');
  });

  it('scrubs short values from form controls, sensitive attributes and input mutations', () => {
    const events = [
      {
        type: 2,
        timestamp: 1,
        data: {
          node: {
            id: 1,
            type: 0,
            childNodes: [
              { id: 2, type: 2, tagName: 'input', attributes: { type: 'hidden', name: 'csrf', value: '123456' }, childNodes: [] },
              { id: 3, type: 2, tagName: 'input', attributes: { type: 'checkbox', value: 'lowsecret' }, childNodes: [] },
              { id: 4, type: 2, tagName: 'div', attributes: { 'data-token': 'shortsecret' }, childNodes: [] },
              { id: 5, type: 2, tagName: 'p', attributes: {}, childNodes: [{ id: 6, type: 3, textContent: 'public text' }] },
              { id: 7, type: 2, tagName: 'iframe', attributes: { srcdoc: '<input value="srcdocsecret">', nonce: 'noncesecret' }, childNodes: [] },
              { id: 8, type: 2, tagName: 'a', attributes: { href: 'https://example.test/?user=urlsecret', onclick: 'send(handlersecret)', style: 'background:url(data:text/plain,datasecret)' }, childNodes: [] },
              { id: 10, type: 2, tagName: 'object', attributes: { data: 'data:text/html,objectdatasecret' }, childNodes: [] },
              { id: 11, type: 2, tagName: 'style', attributes: { _cssText: '.s{background:url(data:text/plain,csssnapshotsecret)}@import "data:text/css,body { color: cssquotedsecret }";.x{background:image-set("images/AbCdEf1234567890GhIj" 1x)}' }, childNodes: [] },
              { id: 12, type: 2, tagName: 'div', attributes: { role: 'textbox', 'aria-valuetext': 'rolevaluesecret' }, childNodes: [{ id: 13, type: 3, textContent: 'roletextsecret' }] },
              { id: 14, type: 2, tagName: 'p', attributes: {}, childNodes: [{ id: 15, type: 3, textContent: '4242\u00a04242\u22124242\u20094242' }] },
            ],
          },
        },
      },
      {
        type: 3,
        timestamp: 2,
        data: {
          source: 0,
          texts: [{ id: 6, value: 'promotesecret' }],
          attributes: [
            { id: 3, attributes: { value: 'latersecret' } },
            { id: 5, attributes: { 'data-sensitive': 'true' } },
          ],
          removes: [],
          adds: [{ parentId: 4, node: { id: 9, type: 3, textContent: 'addedsecret' } }],
        },
      },
      { type: 3, timestamp: 3, data: { source: 5, id: 3, text: '654321', isChecked: true } },
      {
        type: 3,
        timestamp: 4,
        data: {
          source: 8,
          adds: [
            { rule: '.a{background:url(data:text/plain,cssaddsecret)}', index: 0 },
            { rule: '.d{background:image-set("https://example.test/a?token=cssimagesetsecret" 1x)}', index: 1 },
            { rule: '.e{background:url(images/ZyXwVu1234567890TsRq)}', index: 2 },
          ],
          replace: '@import "data:text/css,cssreplacesecret";',
          replaceSync: '.b{background:url(blob:https://example.test/csssyncsecret)}',
        },
      },
      {
        type: 3,
        timestamp: 5,
        data: {
          source: 13,
          index: [0],
          set: { property: '--token', value: 'cssdeclarationsecret', priority: '' },
        },
      },
      {
        type: 3,
        timestamp: 6,
        data: {
          source: 15,
          id: 1,
          styleIds: [1],
          styles: [{ styleId: 1, rules: [{ rule: '.c{background:url(data:text/plain,cssadoptedsecret)}', index: 0 }] }],
        },
      },
    ] as unknown as eventWithTime[];

    const serialized = JSON.stringify(sanitizeRrwebEventsForCapture(events));
    for (const secret of [
      '123456',
      'lowsecret',
      'shortsecret',
      'latersecret',
      '654321',
      'srcdocsecret',
      'noncesecret',
      'urlsecret',
      'handlersecret',
      'datasecret',
      'objectdatasecret',
      'csssnapshotsecret',
      'cssquotedsecret',
      'AbCdEf1234567890GhIj',
      'rolevaluesecret',
      'roletextsecret',
      '4242\u00a04242\u22124242\u20094242',
      'promotesecret',
      'addedsecret',
      'cssaddsecret',
      'cssimagesetsecret',
      'ZyXwVu1234567890TsRq',
      'cssreplacesecret',
      'csssyncsecret',
      'cssdeclarationsecret',
      'cssadoptedsecret',
    ]) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).toContain('public text');
  });
});
