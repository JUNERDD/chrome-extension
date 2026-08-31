import { expect, test } from './extension.fixture';

test('settings opens as a full page and persists a language change', async ({
  controlPage,
  extensionContext,
  extensionWorker,
}) => {
  const quickActions = controlPage.getByRole('navigation', { name: 'Quick actions' });
  const [settingsPage] = await Promise.all([
    extensionContext.waitForEvent('page'),
    quickActions.getByRole('button', { name: 'Open recorder settings' }).click(),
  ]);
  await settingsPage.waitForLoadState('domcontentloaded');

  await expect(settingsPage).toHaveURL(/\/options\.html$/u);
  expect(await settingsPage.evaluate(() => window.top === window)).toBe(true);
  await expect(settingsPage.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
  await expect(settingsPage.getByText('Command bindings', { exact: true })).toBeVisible();
  await expect(settingsPage.getByRole('button', { name: 'Open Chrome shortcut manager' })).toBeVisible();
  await expect(settingsPage.getByRole('heading', { level: 2, name: 'Retention & capacity' })).toBeVisible();
  await expect(settingsPage.getByRole('button', { name: 'Remove expired sessions' })).toBeVisible();
  await expect(settingsPage.getByRole('button', { name: 'Delete retained evidence' })).toBeDisabled();
  await expect(settingsPage.getByRole('heading', { level: 2, name: 'Interface language' })).toBeVisible();

  const languageSelect = settingsPage.getByRole('button', { name: /Language preference/u });
  await languageSelect.click();
  await settingsPage.getByRole('option', { name: '简体中文' }).click();

  await expect(settingsPage.getByRole('heading', { level: 1, name: '设置' })).toBeVisible();
  await expect(settingsPage.locator('html')).toHaveAttribute('lang', 'zh-CN');
  await expect(controlPage.locator('html')).toHaveAttribute('lang', 'zh-CN');
  await expect(controlPage.getByText('已就绪', { exact: true })).toBeVisible();
  await expect
    .poll(() => settingsPage.evaluate(async () => {
      const stored = await chrome.storage.local.get('bugtrace.language-preference');
      return stored['bugtrace.language-preference'];
    }))
    .toBe('zh-CN');
  await expect
    .poll(() => extensionWorker.evaluate(() => chrome.action.getTitle({})))
    .toBe('Bugtrace 录制器 · 已就绪');

  await settingsPage.reload();
  await expect(settingsPage.getByRole('heading', { level: 1, name: '设置' })).toBeVisible();
  await expect(settingsPage.locator('html')).toHaveAttribute('lang', 'zh-CN');
});
