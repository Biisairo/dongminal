// UX_AUDIT_FIX_SRS §3.11 — 7묶음: 모바일 상태바 줄 없애기 · 키바 구성과 매크로 · 서랍 단추 한 줄 (TC-UXF-90·91·94·95).
// TC-UXF-92·93 은 단위(web/js/test/keybar.test.mjs)다.
import { Page } from '@playwright/test';

import { test, expect, waitForInit, JSON_HDR, stubTopic } from './fixtures';

const MOBILE = { width: 412, height: 839 };
const NEWER = { enabled: true, current: 'v1.0.0', latest: 'v9.9.9', newer: true, failed: false, link: 'https://example.invalid/releases/v9.9.9' };
const LATEST = { ...NEWER, latest: 'v1.0.0', newer: false };

/** update-notice.spec.ts 의 대역과 같다 — 화면의 값은 채널의 `update` 토픽으로 온다(CHANNEL_PROTOCOL C2b). */
async function stubUpdate(page: Page, snap: object) {
  await stubTopic(page, 'update', snap);
  await page.route('**/api/update', (route) => route.fulfill({ status: 200, headers: JSON_HDR, body: JSON.stringify(snap) }));
  await page.route('**/api/snapshot?*', async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    if (new URL(route.request().url()).searchParams.get('parts')!.split(',').includes('update')) body.update = snap;
    await route.fulfill({ response: res, body: JSON.stringify(body) });
  });
}

/** 서버 설정의 `keybar` 를 지운다 — 다른 시험에 구성을 남기지 않는다. */
async function resetKeybar(page: Page) {
  const cur = await (await page.request.get('/api/settings')).json();
  delete cur.keybar;
  await page.request.put('/api/settings', { data: cur });
}

const keyLabels = (page: Page) => page.locator('#mobile-keybar .mkb-btn')
  .evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.act === 'kb' ? '⌨' : (e.textContent || '').trim()));

async function captureSends(page: Page) {
  await page.evaluate(() => {
    const p = (window as any).app.testing.focusedTerminal();
    (window as any).__sent = [] as string[];
    const orig = p._send.bind(p);
    p._send = (m: Uint8Array) => {
      if (m[0] === 0) {
        const t = new TextDecoder().decode(m.subarray(1));
        if (t !== '\x1b[I' && t !== '\x1b[O') (window as any).__sent.push(t);
      }
      return orig(m);
    };
  });
}
const sent = (page: Page) => page.evaluate(() => (window as any).__sent as string[]);

test.describe('7묶음 — 상태바 줄 없애기 (FR-UXF-90~92)', () => {
  test('TC-UXF-90: 모바일은 상태바가 없고 연결 점과 cwd 툴팁이 상단바에 있다', async ({ page }) => {
    await waitForInit(page, { mode: 'mobile', viewport: MOBILE });
    await expect(page.locator('#status-bar')).toBeHidden();
    const dot = page.locator('#topbar .m-conn-dot');
    await expect(dot).toBeVisible();
    await expect(dot).toHaveClass(/\bok\b/, { timeout: 15000 });
    await expect(dot).toHaveAttribute('aria-label', 'Connected');
    // 점은 창 이름 바로 앞이다.
    expect(await page.evaluate(() => document.getElementById('window-name')!.previousElementSibling!.classList.contains('m-conn-dot'))).toBe(true);
    // 상태바 cwd 항목(감춰져도 DOM 에 있다)과 같은 축약이다.
    const cwd = (await page.locator('#sb-items .sb-item[data-rkey="cwd"] .sb-ref').textContent())!;
    expect(cwd).not.toBe('');
    await expect(page.locator('#window-name')).toHaveAttribute('title', cwd);
  });

  test('TC-UXF-90: 데스크톱은 상태바가 그대로이고 연결 점이 없다', async ({ page }) => {
    await waitForInit(page);
    await expect(page.locator('#status-bar')).toBeVisible();
    await expect(page.locator('#topbar .m-conn-dot')).toBeHidden();
  });

  test('TC-UXF-91: 새 판이 있으면 ☰ 의 점과 서랍 바닥의 링크가 선다', async ({ page }) => {
    await stubUpdate(page, NEWER);
    await waitForInit(page, { mode: 'mobile', viewport: MOBILE });
    await expect(page.locator('#m-drawer-toggle .m-update-dot')).toBeVisible();
    await page.locator('#m-drawer-toggle').click();
    const link = page.locator('#sb-bottom #m-update-link');
    await expect(link).toBeVisible();
    const badge = await page.locator('#update-badge').textContent();
    await expect(link).toHaveText(badge!);
    await expect(link).toHaveAttribute('href', NEWER.link);
  });

  test('TC-UXF-91: 새 판이 없으면 점도 링크도 없다 · 데스크톱에서도 없다', async ({ page }) => {
    await stubUpdate(page, LATEST);
    await waitForInit(page, { mode: 'mobile', viewport: MOBILE });
    await expect(page.locator('#m-drawer-toggle .m-update-dot')).toBeHidden();
    await page.locator('#m-drawer-toggle').click();
    await expect(page.locator('#m-update-link')).toBeHidden();
  });

  test('TC-UXF-91: 데스크톱은 새 판이 있어도 점·링크가 서지 않는다', async ({ page }) => {
    await stubUpdate(page, NEWER);
    await waitForInit(page);
    await expect(page.locator('#update-badge')).toBeVisible();
    await expect(page.locator('#m-update-link')).toBeHidden();
    await expect(page.locator('.m-update-dot')).toBeHidden();
  });
});

test.describe('7묶음 — 키바 구성과 매크로 (FR-UXF-93~95)', () => {
  test.afterEach(async ({ page }) => { await resetKeybar(page) });

  test('TC-UXF-94: 끄기·매크로·다시 불러오기·기본값으로', async ({ page }) => {
    await waitForInit(page, { mode: 'mobile', viewport: MOBILE });
    await page.waitForSelector('#area .pn.focused .xterm-helper-textarea', { timeout: 15000 });
    expect(await keyLabels(page)).toContain('Esc');

    await page.evaluate(() => (window as any).app.testing.openSettings('terminal'));
    const sec = page.locator('#panel-terminal #ds-keybar');
    await expect(sec).toBeVisible();
    // ⌨ 는 행이 없다.
    await expect(sec.locator('.kbc-row')).toHaveCount(18);

    await sec.locator('.kbc-row[data-id="esc"] .kbc-on').uncheck();
    await expect.poll(() => keyLabels(page)).not.toContain('Esc');

    // 수식이 없으면 추가는 비활성이다.
    const add = sec.locator('.kbc-add');
    await add.locator('.kbc-key').selectOption('d');
    await expect(add.locator('.kbc-add-btn')).toBeDisabled();
    await add.locator('.kbc-ctrl').check();
    await expect(add.locator('.kbc-lbl')).toHaveAttribute('placeholder', '^D');
    await add.locator('.kbc-add-btn').click();
    await expect(sec.locator('.kbc-row.kbc-macro')).toHaveCount(1);
    await expect.poll(async () => (await keyLabels(page)).at(-1)).toBe('^D');

    // 설정을 닫고 매크로를 누르면 0x04 하나가 곧바로 간다.
    await page.locator('#modal-close').click();
    await captureSends(page);
    await page.locator('#mobile-keybar .mkb-btn').filter({ hasText: /^\^D$/ }).click();
    await expect.poll(() => sent(page), { timeout: 10000 }).toEqual(['\x04']);
    await expect(page.locator('#mobile-keybar .mkb-btn[data-mod="ctrl"]')).not.toHaveClass(/sticky/);

    // 서버 설정이므로 다시 불러와도 남는다.
    await page.reload();
    await page.waitForSelector('#mobile-keybar .mkb-btn', { timeout: 15000 });
    await expect.poll(() => keyLabels(page)).not.toContain('Esc');
    expect((await keyLabels(page)).at(-1)).toBe('^D');

    // 기본값으로: Esc 가 돌아오고 ^D 는 남는다.
    await page.evaluate(() => (window as any).app.testing.openSettings('terminal'));
    await page.locator('#ds-keybar .kbc-reset').click();
    await expect.poll(() => keyLabels(page)).toContain('Esc');
    expect(await keyLabels(page)).toContain('^D');
    const saved = await (await page.request.get('/api/settings')).json();
    expect(saved.keybar.macros).toHaveLength(1);
    expect(saved.keybar.off || []).toEqual([]);
  });

  test('TC-UXF-94: 위·아래가 키바 순서를 바꾸고 ⌨ 는 맨 왼쪽에 남는다', async ({ page }) => {
    await waitForInit(page, { mode: 'mobile', viewport: MOBILE });
    await page.evaluate(() => (window as any).app.testing.openSettings('terminal'));
    await page.locator('#ds-keybar .kbc-row[data-id="tab"] .kbc-up').click();
    await expect.poll(async () => (await keyLabels(page)).slice(0, 3)).toEqual(['⌨', 'Tab', 'Esc']);
    await expect(page.locator('#ds-keybar .kbc-row').first()).toHaveAttribute('data-id', 'tab');
  });
});

test.describe('7묶음 — 서랍 단추 한 줄 (FR-UXF-96)', () => {
  test('TC-UXF-95: 서랍 창 패널의 단추 줄은 한 줄이고 단추는 터치 하한이다', async ({ page }) => {
    await waitForInit(page, { mode: 'mobile', viewport: MOBILE });
    await page.locator('#m-drawer-toggle').click();
    const acts = page.locator('#sb-panel-windows .sb-actions');
    await expect(acts).toBeVisible();
    const touch = await page.evaluate(() =>
      parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--touch-min')));
    const h = await acts.evaluate((e) => e.getBoundingClientRect().height);
    expect(h, `단추 줄 높이 ${h}`).toBeLessThanOrEqual(touch + 9);
    const tops = await acts.locator(':scope > button:visible').evaluateAll((els) =>
      els.map((e) => { const r = e.getBoundingClientRect(); return [Math.round(r.top), Math.round(r.height)] }));
    expect(new Set(tops.map((x) => x[0])).size, `줄이 갈린다: ${JSON.stringify(tops)}`).toBe(1);
    for (const [, hh] of tops) expect(hh).toBeGreaterThanOrEqual(touch);
  });

  // D-32 개정: 데스크톱 메인 패널도 한 줄이다. 기본 폭(200px)에서 `샌드박스` 는 아이콘만이고 `새 창` 라벨은 잘리지 않는다.
  test('TC-UXF-95: 데스크톱 메인 패널의 단추 줄도 한 줄이고 `새 창` 이 잘리지 않는다', async ({ page }) => {
    await waitForInit(page);
    const acts = page.locator('#sb-panel-windows .sb-actions');
    const tops = await acts.locator(':scope > button:visible').evaluateAll((els) =>
      els.map((e) => Math.round(e.getBoundingClientRect().top)));
    expect(new Set(tops).size, `줄이 갈린다: ${tops.join(',')}`).toBe(1);
    const label = page.locator('#add-window > .ui-btn-label');
    expect(await label.evaluate((e) => e.scrollWidth <= e.clientWidth), '`새 창` 라벨이 잘렸다').toBe(true);
    await expect(page.locator('#add-sandbox-window .ui-btn-label')).toBeHidden();
  });
});
