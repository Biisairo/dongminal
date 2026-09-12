/**
 * LEAVE_CONFIRM_TOGGLE_SRS — 나가기 확인 토글 (V-LVC-1~6)
 *
 * 검증 수단은 `beforeunload` 를 **직접 발화시켜 `defaultPrevented` 를 읽는** 것이다
 * (SRS §4). 실제 대화창을 띄우는 경로(`page.close({runBeforeUnload:true})`)는
 * headless 에서 결정론적이지 않고, 우리가 정하는 것은 `preventDefault` 를 부르는지
 * 여부뿐이다 (SRS §2.6 — 문구는 브라우저의 것이다).
 */
import { mkdtempSync, readFileSync } from 'fs';
import { join } from 'path';

import { Page } from '@playwright/test';

import {
  test, expect, waitForInit, rmTree, enterDocRoot, openDocFile, makeDocDirty,
} from './fixtures';
import { TMP, realPath } from './osenv';

let BASE = '';
test.beforeAll(() => { BASE = realPath(mkdtempSync(join(TMP, 'dm-clg-'))) });
test.afterAll(() => { rmTree(BASE) });

const OVERLAY = '.confirm-overlay';

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

// 체크박스를 누르면 `saveSettings` 가 PUT 을 보낸다. 새로고침이 그 저장을
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


/**
 * 묶음 CLG — **닫기도 같은 가드를 지난다** (FR-CLG-1~6).
 *
 * `TEST-7` 로 `ux-batch8` 에서 옮겨 왔다. 여기 있는 이유는 수단이 같기 때문이다 —
 * V-CLG-3 은 이 파일의 `beforeunload` 규약(§4)을 그대로 쓴다. 접수한 넷 중 이
 * 둘은 **이미 서 있던 것**이었고, 재는 것은 "생겼는가" 가 아니라 **닿지 않던
 * 자리에 닿는가** 다. 단정은 옮기면서 바꾸지 않았다.
 */
test.describe('묶음 CLG — 닫기 가드 (FR-CLG-1~6)', () => {
  // V-CLG-1 (FR-CLG-1·3)
  test('V-CLG-1: dirty 인 창을 닫으면 묻고, 취소하면 창과 편집이 남는다', async ({ page, request }) => {
    const root = await enterDocRoot(page, request, BASE, 'clg1');
    await openDocFile(page, root);
    await makeDocDirty(page);

    const winId = await page.evaluate(() => (window as any).app.testing.aw().id);
    await page.evaluate((id: string) => { (window as any).__del = (window as any).app.delWindow(id) }, winId);

    await expect(page.locator(OVERLAY)).toBeVisible({ timeout: 10000 });
    // 탭 닫기와 **같은 팝업**이다 — 문구도 버튼도 (FR-CLG-1).
    await expect(page.locator(OVERLAY + ' .confirm-msg')).toHaveText('저장되지 않은 변경사항이 있습니다.');
    await expect(page.locator(OVERLAY + ' .confirm-save')).toHaveText('저장 후 닫기');
    await expect(page.locator(OVERLAY + ' .confirm-ok')).toHaveText('닫기');
    await expect(page.locator(OVERLAY + ' .confirm-cancel')).toHaveText('취소');

    await page.click(OVERLAY + ' .confirm-cancel');
    await page.evaluate(() => (window as any).__del);
    const after = await page.evaluate((id: string) => ({
      there: !!(window as any).app.ws.windows.find((w: any) => w.id === id),
      dirty: [...(window as any).app.fileEditors.values()].some((e: any) => e._dirty),
    }), winId);
    expect(after.there, '취소했는데 창이 사라졌다').toBe(true);
    expect(after.dirty, '취소했는데 편집이 사라졌다').toBe(true);
  });

  // V-CLG-2 (FR-CLG-2)
  test('V-CLG-2: 저장 후 닫기는 디스크에 쓰고 창을 닫는다', async ({ page, request }) => {
    const root = await enterDocRoot(page, request, BASE, 'clg2');
    await openDocFile(page, root);
    await makeDocDirty(page, 'SAVED');

    const winId = await page.evaluate(() => (window as any).app.testing.aw().id);
    await page.evaluate((id: string) => { (window as any).__del = (window as any).app.delWindow(id) }, winId);
    await expect(page.locator(OVERLAY)).toBeVisible({ timeout: 10000 });
    await page.click(OVERLAY + ' .confirm-save');
    await page.evaluate(() => (window as any).__del);

    await expect.poll(
      () => readFileSync(join(root, 'doc.md'), 'utf8').slice(0, 5),
      { timeout: 15000, message: '저장 후 닫기가 디스크에 닿지 않았다' },
    ).toBe('SAVED');
    const gone = await page.evaluate((id: string) =>
      !(window as any).app.ws.windows.find((w: any) => w.id === id), winId);
    expect(gone, '저장했는데 창이 남았다').toBe(true);
  });

  // V-CLG-3 (FR-CLG-5·6)
  //
  // 가드가 `preventDefault()` 를 불렀는지로 잰다 — 이 파일의 `guardFires` 와 같은
  // 수단이다 (§4: 실제 대화창은 headless 에서 결정론적이지 않다).
  test('V-CLG-3: 도구가 없어도 dirty 면 떠남을 막는다 — 스위치 아래에서', async ({ page, request }) => {
    const root = await enterDocRoot(page, request, BASE, 'clg3');
    await openDocFile(page, root);

    const fires = () => guardFires(page);
    const setLeave = (on: boolean) => page.evaluate((v: boolean) => { (window as any).confirmLeave = v }, on);

    // 전제: 스위치가 켜져 있고, 잃을 **도구**는 이 창에 없다.
    await setLeave(true);
    await page.evaluate((id: string) => {
      const a = (window as any).app;
      const w = a.ws.windows.find((x: any) => x.id === id);
      (window as any).__tools = a.tools;
      a.tools = new Map();
      return !!w;
    }, await page.evaluate(() => (window as any).app.testing.aw().id));

    expect(await fires(), 'dirty 가 없는데 막았다').toBe(false);
    await makeDocDirty(page);
    expect(await fires(), 'dirty 인데 떠남을 막지 않았다').toBe(true);

    // FR-CLG-6: 스위치 아래에 산다 — 끈 사용자에게 새 사유로 다시 묻지 않는다.
    await setLeave(false);
    expect(await fires(), '스위치를 껐는데 막았다').toBe(false);

    await page.evaluate(() => { (window as any).app.tools = (window as any).__tools });
  });
});
