/**
 * LEAVE_CONFIRM_TOGGLE_SRS — 나가기 확인 토글 (V-LVC-1~6)
 *
 * 검증 수단은 `beforeunload` 를 **직접 발화시켜 `defaultPrevented` 를 읽는** 것이다
 * (SRS §4). 실제 대화창을 띄우는 경로(`page.close({runBeforeUnload:true})`)는
 * headless 에서 결정론적이지 않고, 우리가 정하는 것은 `preventDefault` 를 부르는지
 * 여부뿐이다 (SRS §2.6 — 문구는 브라우저의 것이다).
 */
import { test, expect, waitForInit } from './fixtures';

// 설정 블롭은 서버가 가지므로 테스트 사이에 남는다. 각 스펙이 자기 전제를
// 명시적으로 세운다 — `null` 은 "저장된 적 없음" 이다 (FR-LVC-6).
async function seedConfirmLeave(request: any, v: boolean | null) {
  const r = await request.get('/api/settings');
  const s = r.ok() ? await r.json() : {};
  if (v === null) delete s.confirmLeave;
  else s.confirmLeave = v;
  await request.put('/api/settings', {
    headers: { 'Content-Type': 'application/json' },
    data: JSON.stringify(s),
  });
}

// 가드가 `preventDefault()` 를 불렀는지.
function guardFires(page: any): Promise<boolean> {
  return page.evaluate(() => {
    const ev = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(ev);
    return ev.defaultPrevented;
  });
}

const cbSel = '#ds-confirmleave';

// 체크박스를 누르면 `_saveSettings` 가 PUT 을 보낸다. 새로고침이 그 저장을
// 앞지르면 값이 유실돼 스펙이 자기 전제를 잃는다.
async function openDisplay(page: any) {
  await page.click('#settings-btn');
  await expect(page.locator('#modal-overlay')).toBeVisible();
  await page.click('button.mtab[data-tab="display"]');
  await expect(page.locator('#panel-display')).toBeVisible();
}

async function setToggle(page: any, on: boolean) {
  const put = page.waitForResponse(
    (r: any) => r.url().includes('/api/settings') && r.request().method() === 'PUT');
  if (on) await page.check(cbSel);
  else await page.uncheck(cbSel);
  await put;
}

test.describe('나가기 확인 토글', () => {
  // V-LVC-1 · FR-LVC-6·7
  test('저장된 적 없으면 묻지 않는다', async ({ page, request }) => {
    await seedConfirmLeave(request, null);
    await waitForInit(page);
    // 가드의 종전 조건(도구가 하나라도 있다)은 충족돼 있다 — 그래도 묻지 않는다.
    expect(await page.evaluate(() => (window as any).app.tools.size)).toBeGreaterThan(0);
    expect(await guardFires(page)).toBe(false);
  });

  // V-LVC-2 · FR-LVC-1·8
  test('Display 패널에서 켜면 묻는다', async ({ page, request }) => {
    await seedConfirmLeave(request, null);
    await waitForInit(page);
    await openDisplay(page);
    await expect(page.locator(cbSel)).not.toBeChecked();
    await setToggle(page, true);
    await page.click('#modal-close');
    expect(await guardFires(page)).toBe(true);
  });

  // V-LVC-3 · FR-LVC-3·4
  test('켠 값은 새로고침 뒤에도 남는다', async ({ page, request }) => {
    await seedConfirmLeave(request, true);
    await waitForInit(page);
    expect(await guardFires(page)).toBe(true);
    await openDisplay(page);
    await expect(page.locator(cbSel)).toBeChecked();
  });

  // V-LVC-4 · FR-LVC-10
  test('끄면 재적재 없이 그 즉시 묻지 않는다', async ({ page, request }) => {
    await seedConfirmLeave(request, true);
    await waitForInit(page);
    expect(await guardFires(page)).toBe(true);
    await openDisplay(page);
    await setToggle(page, false);
    await page.click('#modal-close');
    expect(await guardFires(page)).toBe(false);
  });

  // V-LVC-5 · SRS §2.4 (PUT 이 블롭 전체를 갈아치운다)
  test('다른 설정을 바꿔도 살아남는다', async ({ page, request }) => {
    await seedConfirmLeave(request, true);
    await waitForInit(page);
    await page.click('#settings-btn');
    await expect(page.locator('#theme-list')).toBeVisible();
    const put = page.waitForResponse(
      (r: any) => r.url().includes('/api/settings') && r.request().method() === 'PUT');
    await page.locator('#theme-list .tl-item').nth(1).click();
    await put;
    const saved = await (await request.get('/api/settings')).json();
    expect(saved.confirmLeave).toBe(true);
  });

  // V-LVC-6 · FR-LVC-8 (RELOAD_CONTINUITY_SRS FR-RLC-5a 를 깨뜨리지 않는다)
  test('켜져 있어도 자기 새로고침은 묻지 않는다', async ({ page, request }) => {
    await seedConfirmLeave(request, true);
    await waitForInit(page);
    expect(await guardFires(page)).toBe(true);
    await page.evaluate(() => { (window as any).__dmReloading = true });
    expect(await guardFires(page)).toBe(false);
  });
});
