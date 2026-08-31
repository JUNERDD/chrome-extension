import { describe, expect, it } from 'vitest';
import { catalogs } from '../src/i18n/catalog';
import {
  isLanguagePreference,
  normalizeLocale,
  resolveLocale,
  translateMessage,
} from '../src/i18n/core';

describe('i18n core', () => {
  it('normalizes Chinese variants and falls back to English', () => {
    expect(normalizeLocale('zh-CN')).toBe('zh-CN');
    expect(normalizeLocale('zh-Hans-US')).toBe('zh-CN');
    expect(normalizeLocale('en-GB')).toBe('en');
    expect(normalizeLocale('fr-FR')).toBe('en');
    expect(normalizeLocale(undefined)).toBe('en');
  });

  it('honors an explicit preference over the browser language', () => {
    expect(resolveLocale('system', 'zh-CN')).toBe('zh-CN');
    expect(resolveLocale('en', 'zh-CN')).toBe('en');
    expect(resolveLocale('zh-CN', 'en-US')).toBe('zh-CN');
  });

  it('validates persisted language preferences', () => {
    expect(isLanguagePreference('system')).toBe(true);
    expect(isLanguagePreference('en')).toBe(true);
    expect(isLanguagePreference('zh-CN')).toBe(true);
    expect(isLanguagePreference('zh_CN')).toBe(false);
    expect(isLanguagePreference(null)).toBe(false);
  });

  it('translates typed messages and interpolates variables', () => {
    expect(translateMessage('en', 'sidepanel.health.attention.detail', { count: 2 })).toBe(
      'Evidence gaps requiring review: 2.',
    );
    expect(translateMessage('zh-CN', 'sidepanel.health.attention.detail', { count: 2 })).toBe(
      '有 2 处证据缺口需要检查。',
    );
  });

  it('translates Results UI copy and its dynamic readouts', () => {
    expect(
      translateMessage('en', 'results.screenshots.aside', { included: 2, total: 3 }),
    ).toBe('2/3 in export');
    expect(
      translateMessage('zh-CN', 'results.screenshots.aside', { included: 2, total: 3 }),
    ).toBe('导出 2/3');
    expect(
      translateMessage('zh-CN', 'results.footer.format', {
        format: 'bugtrace',
        version: '1.0.0',
      }),
    ).toBe('格式 bugtrace@1.0.0');
    expect(translateMessage('zh-CN', 'results.replay.play')).toBe('播放');
    expect(translateMessage('zh-CN', 'results.privacy.valueRedacted')).toBe('已脱敏');
  });

  it('translates the in-page recorder overlay states', () => {
    expect(translateMessage('en', 'overlay.status.recording')).toBe('Bugtrace · recording');
    expect(translateMessage('zh-CN', 'overlay.status.paused')).toBe('Bugtrace · 已暂停');
    expect(translateMessage('zh-CN', 'overlay.status.interrupted')).toBe('Bugtrace · 已中断');
  });

  it('translates actionable Side Panel recorder errors without exposing raw runtime text', () => {
    expect(translateMessage('en', 'sidepanel.notice.captureClientUnavailable.title')).toBe(
      'Refresh the page to enable capture',
    );
    expect(translateMessage('zh-CN', 'sidepanel.notice.captureClientUnavailable.detail')).toBe(
      '当前标签页中的 Bugtrace 采集端不可用。请刷新当前 HTTP(S) 页面，然后重试刚才的操作。',
    );
    expect(translateMessage('zh-CN', 'sidepanel.notice.screenshotAuthorizationRequired.title')).toBe(
      '需要授权截取视口',
    );
    expect(translateMessage('zh-CN', 'sidepanel.notice.screenshotOutsideScope.detail')).toBe(
      '当前标签页未包含在本次录制中。请切换到已录制的 HTTP(S) 标签页，然后重试。',
    );
    expect(translateMessage('zh-CN', 'sidepanel.notice.screenshotDocumentChanged.title')).toBe(
      '页面在截图前发生变化',
    );
    expect(translateMessage('zh-CN', 'sidepanel.notice.screenshotFailed.detail')).toBe(
      'Chrome 无法截取当前视口。请确认当前激活的是受支持的 HTTP(S) 页面，然后重试。',
    );
    expect(translateMessage('en', 'sidepanel.notice.coverageWarning.detail', { count: 2 })).toBe(
      'Evidence capture gaps recorded: 2. Review the coverage audit after stopping.',
    );
    expect(translateMessage('zh-CN', 'sidepanel.notice.coverageWarning.detail', { count: 2 })).toBe(
      '已记录 2 处证据采集缺口。停止录制后，请在覆盖审计中检查。',
    );
  });

  it('keeps unresolved placeholders visible and uses English for unsupported locales', () => {
    expect(translateMessage('en', 'common.revision')).toBe('REV {revision}');
    expect(translateMessage('de-DE', 'settings.title')).toBe('Settings');
  });

  it('keeps locale catalogs structurally aligned', () => {
    expect(Object.keys(catalogs['zh-CN']).sort()).toEqual(Object.keys(catalogs.en).sort());
  });

  it('keeps interpolation variables aligned between locale catalogs', () => {
    const placeholders = (message: string) =>
      [...message.matchAll(/\{([a-zA-Z][\w]*)\}/g)].map((match) => match[1]).sort();

    for (const key of Object.keys(catalogs.en) as Array<keyof typeof catalogs.en>) {
      expect(placeholders(catalogs['zh-CN'][key]), key).toEqual(placeholders(catalogs.en[key]));
    }
  });
});
