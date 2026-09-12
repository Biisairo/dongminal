import { test, expect, waitForInit } from './fixtures';

// M5 — Backup 탭의 두 새 입구.
//
//   FUI-24  설정 전부를 기본값으로 되돌린다
//   G4-7    창 배치를 저장 직전의 판으로 되돌린다
//
// 둘은 **서로 다른 것을 되돌린다.** 앞의 것은 설정(`settings.json`)이고 뒤의
// 것은 배치(`workspace.json`)다. 한 탭에 나란히 두되 문구가 그 차이를 말한다.

async function openBackupTab(page) {
  await page.click('#settings-btn');
  await expect(page.locator('#modal-overlay')).toBeVisible();
  await page.click('button.mtab[data-tab="backup"]');
  await expect(page.locator('#panel-backup')).toBeVisible();
}

// FUI-24 — 되돌릴 수 없으므로 **한 단계를 더 둔다.**
test('TC-RST-1 기본값 되돌리기는 확인을 한 번 더 묻는다', async ({ page }) => {
  await waitForInit(page);
  await openBackupTab(page);

  const confirm = page.locator('#bk-reset-confirm');
  await expect(confirm).toBeHidden();

  await page.click('#bk-reset');
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText('되돌릴 수 없습니다');

  // 취소하면 아무 일도 일어나지 않는다.
  await page.click('#bk-reset-cancel');
  await expect(confirm).toBeHidden();
});

// 확인을 누르면 서버 블롭이 비워지고 페이지가 다시 열린다.
test('TC-RST-2 되돌리면 서버 설정이 비워지고 다시 열린다', async ({ page, baseURL }) => {
  await waitForInit(page);

  // 되돌릴 값을 하나 심는다 — 되돌아갔는지 보려면 되돌릴 것이 있어야 한다.
  await page.evaluate(() => {
    (window as any).pageTitle = '되돌리기 전';
    return (window as any).app.testing.saveSettings();
  });
  const before = await (await page.request.get(`${baseURL}/api/settings`)).json();
  expect(before.pageTitle).toBe('되돌리기 전');

  await openBackupTab(page);
  // 다시 열렸는지 보려고 창에 표식을 심는다 — 주소는 그대로라 URL 로는 알 수 없다.
  await page.evaluate(() => { (window as any).__beforeReset = true; });
  await page.click('#bk-reset');
  await page.click('#bk-reset-apply');

  await expect.poll(async () => page.evaluate(() => (window as any).__beforeReset ?? null),
    { timeout: 10_000 }).toBeNull();

  const after = await (await page.request.get(`${baseURL}/api/settings`)).json();
  expect(after.pageTitle ?? '').toBe('');
});

// G4-7 — 되돌릴 수 있는 판을 보인다.
test('TC-RVT-1 되돌릴 수 있는 창 배치 판을 보인다', async ({ page }) => {
  await waitForInit(page);
  await openBackupTab(page);

  const box = page.locator('#bk-revs');
  await expect(box).toBeHidden();
  await page.click('#bk-revlist');
  await expect(box).toBeVisible();
  // 세대가 있든 없든 **무언가를 말한다** — 빈 상자를 남기지 않는다.
  await expect(box.locator('.bk-rev').first()).toBeVisible();
});

// 종단이 실제로 답하고, 세대 번호의 범위를 스스로 지킨다.
test('TC-RVT-2 되돌리기 종단이 범위를 지킨다', async ({ page, baseURL }) => {
  await waitForInit(page);

  const list = await (await page.request.get(`${baseURL}/api/workspace/revisions`)).json();
  expect(Array.isArray(list.generations)).toBe(true);
  expect(typeof list.rev).toBe('number');

  // 범위 밖은 400 이고 문구가 범위를 말한다 — 파일을 만지기 전에 거절한다.
  const bad = await page.request.post(`${baseURL}/api/workspace/revert`, { data: { gen: 999 } });
  expect(bad.status()).toBe(400);
  expect(await bad.text()).toContain('1..');

  // 오류 응답에 코드와 요청 ID 가 실린다 (ERROR_CONTRACT_SRS FR-ERR-4·6).
  expect(bad.headers()['x-error-code']).toBe('bad_request');
  expect(bad.headers()['x-request-id']).toBeTruthy();
});
