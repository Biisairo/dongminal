import { expect, test, waitForInit } from './fixtures';

// TELEGRAM_BRIDGE_SRS FR-TGB-1·3 — 설정 ▸ Telegram.
//
// 이 스펙은 Telegram 에 요청하지 않는다. token 확인·등록·브리지 동작은 가짜 Bot API 를 쓰는
// Go 시험(telegram_api_test.go·telegram_wire_test.go)이 잰다. 여기서는 화면이 서고, token 이
// 쓰기 전용으로 보이는지만 본다.

async function openTelegramTab(page) {
  await page.click('#settings-btn');
  await expect(page.locator('#modal-overlay')).toBeVisible();
  await page.click('button.mtab[data-tab="telegram"]');
  await expect(page.locator('#panel-telegram')).toBeVisible();
  await expect(page.locator('#tg-bot')).not.toHaveText('');
}

test.describe('Telegram 설정', () => {
  test('패널이 서고, token 칸은 비밀번호 칸이며 비어 있다', async ({ page }) => {
    await waitForInit(page);
    await openTelegramTab(page);
    await expect(page.locator('#panel-telegram .ds-sec')).toHaveCount(3);
    await expect(page.locator('#tg-enabled')).not.toBeChecked();
    await expect(page.locator('#tg-token')).toHaveAttribute('type', 'password');
    await expect(page.locator('#tg-token')).toHaveValue('');
    await expect(page.locator('#tg-silence')).toHaveValue('5');
    await expect(page.locator('#tg-pair-box')).toBeHidden();
  });

  test('token 이 없으면 등록 코드를 만들지 않고 이유를 보인다', async ({ page }) => {
    await waitForInit(page);
    await openTelegramTab(page);
    await page.click('#tg-pair-make');
    await expect(page.locator('#tg-pair-status')).toHaveClass(/err/);
    await expect(page.locator('#tg-pair-status')).not.toHaveText('');
    await expect(page.locator('#tg-pair-box')).toBeHidden();
  });
});
