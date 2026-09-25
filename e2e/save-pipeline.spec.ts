import { Page } from '@playwright/test';

import { test, expect, waitForInit } from './fixtures';

/**
 * OPTIMIZE_REFACTOR_SRS 묶음 O5 — 쓰기 경로 합치기 (FR-OPT-5-1 · FR-OPT-5-2).
 *
 * 세는 것은 요청이다 (FR-OPT-0-4). 전후 수는 각 검사의 주석에 적는다.
 */

function countRequests(page: Page, method: string, path: string) {
  const seen = { n: 0 };
  page.on('request', (r) => {
    if (r.method() === method && new URL(r.url()).pathname === path) seen.n++;
  });
  return seen;
}

// 설정은 서버에 산다 — 이 파일이 바꾼 것을 다음 스펙에 흘리지 않는다.
let original: unknown = null;
test.beforeEach(async ({ request }) => {
  original = await (await request.get('/api/settings')).json();
});
test.afterEach(async ({ request }) => {
  if (original) await request.put('/api/settings', { data: original });
});

async function openCustomEditor(page: Page) {
  await page.click('#settings-btn');
  await expect(page.locator('#theme-list')).toBeVisible();
  await page.click('#custom-toggle');
  await expect(page.locator('#custom-editor')).toBeVisible();
}

// 색 입력 하나를 사용자가 고른 것처럼 움직인다 — 끄는 동안 input, 놓을 때 change.
async function pickColor(page: Page, idx: number, value: string, change = true) {
  await page.evaluate(({ idx, value, change }) => {
    const inp = document.querySelectorAll('#ce-ui input[type=color]')[idx] as HTMLInputElement;
    inp.value = value;
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    if (change) inp.dispatchEvent(new Event('change', { bubbles: true }));
  }, { idx, value, change });
}

async function serverUi(page: Page, key: string) {
  const r = await page.request.get('/api/settings');
  const j = await r.json();
  return j && j.customTheme && j.customTheme.ui ? j.customTheme.ui[key] : undefined;
}

// UI_LABELS 의 순서: bg · sidebarBg · border · accent …
const BG = 0, SIDEBAR = 1, BORDER = 2;

test.describe('설정 저장 파이프라인 (FR-OPT-5-2)', () => {
  /**
   * FEC-4 재현: 색 입력 사이에 settings_changed 가 끼면 두 번째 편집이 사라졌다.
   *
   * 에코가 `customTheme` 을 새 객체로 갈아 끼우고, 편집기는 옛 객체를 고쳤다.
   * 방송은 같은 본문을 다시 PUT 해 일으킨다 — 서버가 보기에는 다른 화면의 저장이다.
   */
  test('FEC-4 색 입력 사이의 settings_changed 가 다음 편집을 끊지 않는다', async ({ page, request }) => {
    await waitForInit(page);
    await openCustomEditor(page);

    await pickColor(page, BG, '#111111');
    await expect.poll(() => serverUi(page, 'bg'), { timeout: 10000 }).toBe('#111111');

    // 같은 본문을 다시 넣어 방송을 일으키고, 이 화면이 그것을 다시 받는 것을 기다린다.
    const blob = await (await request.get('/api/settings')).json();
    const echoed = page.waitForResponse((r) =>
      new URL(r.url()).pathname === '/api/settings' && r.request().method() === 'GET');
    await request.put('/api/settings', { data: blob });
    await echoed;

    await pickColor(page, SIDEBAR, '#222222');
    await expect.poll(() => serverUi(page, 'sidebarBg'), { timeout: 10000 }).toBe('#222222');
    expect(await serverUi(page, 'bg')).toBe('#111111');
  });

  // 다른 화면이 실제로 테마를 바꿔도 열린 편집기는 새 값 위에서 계속 고친다.
  test('다른 화면의 테마 변경 뒤에도 편집이 저장된다', async ({ page, request }) => {
    await waitForInit(page);
    await openCustomEditor(page);
    await pickColor(page, BG, '#111111');
    await expect.poll(() => serverUi(page, 'bg'), { timeout: 10000 }).toBe('#111111');

    const blob = await (await request.get('/api/settings')).json();
    blob.customTheme.ui.bg = '#333333';
    await request.put('/api/settings', { data: blob });
    await expect.poll(() => page.evaluate(() => (window as any).customTheme?.ui?.bg), { timeout: 10000 }).toBe('#333333');

    await pickColor(page, BORDER, '#444444');
    await expect.poll(() => serverUi(page, 'border'), { timeout: 10000 }).toBe('#444444');
    expect(await serverUi(page, 'bg')).toBe('#333333');
  });

  // FEC-5: 끄는 동안의 input 20번이 PUT 20번이 되지 않는다 (전 20 · 후 ≤1, 놓을 때 1).
  test('FEC-5 색 끌기는 디바운스되고 놓을 때 확정한다', async ({ page }) => {
    await waitForInit(page);
    await openCustomEditor(page);
    const puts = countRequests(page, 'PUT', '/api/settings');
    for (let i = 0; i < 20; i++) {
      await pickColor(page, BG, '#1010' + String(i + 10), false);
    }
    // **예외 (`TEST-16`)**: 끄는 동안 PUT 이 **나가지 않음**을 잰다.
    await page.waitForTimeout(100);
    expect(puts.n).toBe(0);
    await pickColor(page, BG, '#101099', true);
    await expect.poll(() => serverUi(page, 'bg'), { timeout: 10000 }).toBe('#101099');
    // **예외 (`TEST-16`)**: 확정 뒤 디바운스가 PUT 을 **더 내지 않음**을 잰다 (500ms 를 넘겨 본다).
    await page.waitForTimeout(800);
    expect(puts.n).toBe(1);
  });

  // FEC-7: 비행 중 호출은 합쳐진다 — 5번 불러도 PUT 은 비행 하나 + 뒤따르는 하나 (전 5 · 후 2).
  test('FEC-7 비행 중 saveSettings 는 하나로 합쳐진다', async ({ page }) => {
    await waitForInit(page);
    const puts = countRequests(page, 'PUT', '/api/settings');
    const oks = await page.evaluate(async () => {
      const a = (window as any).app;
      const ps = [];
      for (let i = 0; i < 5; i++) {
        (window as any).pageTitle = 'coalesce-' + i;
        ps.push(a.testing.saveSettings());
      }
      return Promise.all(ps);
    });
    expect(oks.every(Boolean)).toBe(true);
    const r = await page.request.get('/api/settings');
    expect((await r.json()).pageTitle).toBe('coalesce-4');
    expect(puts.n).toBe(2);
  });

  // FEC-M3 · D-OPT-7: 자기 저장의 방송은 GET 도 재적용도 부르지 않는다
  // (O5 전 GET 1 · 재적용 1 → O5 GET 1 · 재적용 0 → 지금 GET 0 · 재적용 0).
  test('D-OPT-7 자기 저장의 에코는 화면에 다시 얹지 않는다', async ({ page }) => {
    await waitForInit(page);
    await page.evaluate(() => {
      const w = window as any;
      w.__applied = 0;
      w.__echo = [];
      const t = w.app.testing;
      const apply = t.settingsApply;
      t.settingsApply = function (...args: unknown[]) { w.__applied++; return apply(...args); };
      const onChanged = t.onSettingsChanged;
      t.onSettingsChanged = function (a: any) { w.__echo.push(a && a.origin); return onChanged(a); };
    });
    const gets = countRequests(page, 'GET', '/api/settings');
    await page.evaluate(() => {
      (window as any).pageTitle = 'echo-self';
      return (window as any).app.testing.saveSettings();
    });
    const self = await page.evaluate(() => (window as any).app.clientId);
    await expect.poll(() => page.evaluate(() => (window as any).__echo), { timeout: 5000 }).toContain(self);
    // **예외 (`TEST-16`)**: 방송 뒤에 GET 이 **나가지 않음**을 잰다.
    await page.waitForTimeout(300);
    expect(gets.n).toBe(0);
    expect(await page.evaluate(() => (window as any).__applied)).toBe(0);
  });
});

test.describe('워크스페이스 저장 (FR-OPT-5-1)', () => {
  // FEC-1: 창 전환·같은 포커스는 본문을 바꾸지 않는다 — PUT 이 나가지 않는다 (전 4 · 후 0).
  test('FEC-1 본문이 같으면 PUT 하지 않는다', async ({ page }) => {
    await waitForInit(page);
    // 기준선 — 지금 본문을 한 번 저장해 둔다.
    await page.evaluate(() => (window as any).app.testing.save());
    const puts = countRequests(page, 'PUT', '/api/workspace');
    const rev0 = await page.evaluate(() => (window as any).app.wsETag);
    await page.evaluate(async () => {
      const a = (window as any).app;
      const wins = a.ws.windows.map((w: any) => w.id);
      const back = a.ws.activeWindow;
      if (wins.length > 1) {
        a.switchWindow(wins.find((id: string) => id !== back));
        await a.testing.save();
        a.switchWindow(back);
        await a.testing.save();
      }
      await a.testing.save();
      await a.testing.save();
    });
    // **예외 (`TEST-16`)**: PUT 이 **나가지 않음**을 잰다.
    await page.waitForTimeout(300);
    expect(puts.n).toBe(0);
    expect(await page.evaluate(() => (window as any).app.wsETag)).toBe(rev0);

    // 바뀐 본문은 종전대로 나간다.
    await page.evaluate(() => {
      const a = (window as any).app;
      a.ws.windows[0].name = (a.ws.windows[0].name || '') + '·';
      return a.testing.save();
    });
    await expect.poll(() => puts.n, { timeout: 5000 }).toBe(1);
    await page.evaluate(() => {
      const a = (window as any).app;
      a.ws.windows[0].name = a.ws.windows[0].name.replace(/·$/, '');
      return a.testing.save();
    });
  });
});
