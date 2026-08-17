import { expect, test } from './extension.fixture';

test('popup loads and reports the idle recorder state', async ({ controlPage }) => {
  await expect(controlPage.getByLabel('Bugtrace Recorder')).toBeVisible();
  await expect(controlPage.getByText('Ready', { exact: true })).toBeVisible();
  await expect(controlPage.getByRole('button', { name: 'Start recording' })).toBeVisible();
  await expect(controlPage.getByText('LOCAL ONLY', { exact: true })).toBeVisible();
});
