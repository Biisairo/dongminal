import { Page } from '@playwright/test';

import { test, expect } from './fixtures';

// 묶음 A (USER_CHECKLIST_FIXES_SRS §3.1 / §4.1) — 백그라운드 UI 일관화.
//
// 확인창의 "백그라운드로" 버튼만 형태 규약 밖에 있었고(§2.1), 백그라운드
// 진입점이 상태바 지표에 묻힌 채 폴링마다 재생성됐고(§2.2), 목록이 사라질
// 앵커에 매여 있었다(§2.3).

async function waitForInit(page: Page) {
  await page.context().addInitScript(() => {
    sessionStorage.setItem('displayMode', 'desktop');
  });
  await page.goto('/');
  await page.waitForSelector('#area .pn.focused .xterm-helper-textarea', { timeout: 15000 });
}

// 확인창을 직접 띄운다. busy 프로세스를 만들어 실제 경로를 타는 것보다
// 결정론적이고, 검증 대상이 버튼의 형태·색 규약이므로 충분하다.
async function openConfirm(page: Page, opts: Record<string, unknown>) {
  await page.evaluate((o) => {
    // Promise 는 의도적으로 버린다 — 닫힘까지 기다리면 evaluate 가 걸린다.
    void (window as any).app._confirmClose('테스트', o);
  }, opts);
  await page.waitForSelector('.confirm-overlay .confirm-btns button');
}

const FORM_PROPS = [
  'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
  'borderTopStyle', 'borderRightStyle', 'borderBottomStyle', 'borderLeftStyle',
  'borderTopLeftRadius', 'borderBottomRightRadius',
  'fontSize', 'fontFamily', 'cursor',
] as const;

async function formStyles(page: Page, selector: string) {
  return page.evaluate(({ sel, props }) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const cs = getComputedStyle(el);
    const out: Record<string, string> = {};
    for (const p of props) out[p] = (cs as any)[p];
    return out;
  }, { sel: selector, props: FORM_PROPS as unknown as string[] });
}

async function roleColors(page: Page, selector: string) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const cs = getComputedStyle(el);
    return { color: cs.color, borderColor: cs.borderTopColor, background: cs.backgroundColor };
  }, selector);
}

// 백그라운드 도구를 실제 경로(detachTab broadcast)로 만든다. 창이 사라지지
// 않도록 탭을 하나 더 만든 뒤 detach 한다.
async function makeBackgroundTool(page: Page, request: any): Promise<string> {
  const before = await page.evaluate(() => {
    const app = (window as any).app;
    const w = app.ws.windows.find((x: any) => x.id === app.ws.activeWindow);
    const walk = (n: any): string | null => {
      if (!n) return null;
      for (const t of n.tabs || []) if (t.toolId) return t.toolId;
      for (const c of n.children || []) { const r = walk(c); if (r) return r; }
      return null;
    };
    return walk(w?.layout);
  });
  expect(before, '참조된 도구가 없다').toBeTruthy();

  const add = await request.post('/api/commands', { data: { action: 'newTab', args: {} } });
  expect(add.status()).toBe(200);
  await expect.poll(async () => {
    return page.evaluate(() => {
      const app = (window as any).app;
      const w = app.ws.windows.find((x: any) => x.id === app.ws.activeWindow);
      let n = 0;
      const walk = (x: any) => {
        if (!x) return;
        n += (x.tabs || []).length;
        for (const c of x.children || []) walk(c);
      };
      walk(w?.layout);
      return n;
    });
  }, { timeout: 10000 }).toBeGreaterThan(1);

  const r = await request.post('/api/commands', { data: { action: 'detachTab', args: { toolId: before } } });
  expect(r.status(), `detachTab 이 ${r.status()} 로 거부됐다`).toBe(200);

  await expect.poll(async () => {
    const bg = await (await request.get('/api/tools/background')).json();
    return (bg.background || []).some((b: any) => b.toolId === before);
  }, { timeout: 10000 }).toBe(true);

  // 브라우저가 목록을 반영할 때까지 기다린다.
  await expect.poll(async () => page.evaluate(() => (window as any).app._bg.length),
    { timeout: 10000 }).toBeGreaterThan(0);

  return before as string;
}

test.describe('FR-BGU-1: 확인창 버튼 형태 규약', () => {
  test('TC-BGU-1: 백그라운드 버튼이 형제 버튼과 동일한 형태 규약을 쓴다', async ({ page }) => {
    await waitForInit(page);
    await openConfirm(page, { bgBtn: true });

    const bg = await formStyles(page, '.confirm-btns .confirm-bg');
    const ok = await formStyles(page, '.confirm-btns .confirm-ok');
    const cancel = await formStyles(page, '.confirm-btns .confirm-cancel');

    expect(bg, '.confirm-bg 버튼이 없다').not.toBeNull();
    expect(ok).toEqual(cancel);
    expect(bg).toEqual(ok);
  });

  test('TC-BGU-1b: 저장 버튼도 동일한 형태 규약을 쓴다', async ({ page }) => {
    await waitForInit(page);
    await openConfirm(page, { saveBtn: true });

    const save = await formStyles(page, '.confirm-btns .confirm-save');
    const ok = await formStyles(page, '.confirm-btns .confirm-ok');
    expect(save).toEqual(ok);
  });

  test('TC-BGU-2: 동시 표출되는 버튼 조합 안에서 역할 색이 서로 다르다', async ({ page }) => {
    await waitForInit(page);

    await openConfirm(page, { bgBtn: true });
    const bg = await roleColors(page, '.confirm-btns .confirm-bg');
    let ok = await roleColors(page, '.confirm-btns .confirm-ok');
    let cancel = await roleColors(page, '.confirm-btns .confirm-cancel');
    expect(new Set([bg!.color, ok!.color, cancel!.color]).size,
      '백그라운드/닫기/취소 의 글자색이 겹친다').toBe(3);
    await page.keyboard.press('Escape');

    await openConfirm(page, { saveBtn: true });
    const save = await roleColors(page, '.confirm-btns .confirm-save');
    ok = await roleColors(page, '.confirm-btns .confirm-ok');
    cancel = await roleColors(page, '.confirm-btns .confirm-cancel');
    expect(new Set([save!.color, ok!.color, cancel!.color]).size,
      '저장/닫기/취소 의 글자색이 겹친다').toBe(3);
  });
});

test.describe('FR-BGU-2..5: 백그라운드 진입점', () => {
  test('TC-BGU-6: 백그라운드 도구가 0개면 진입점이 표시되지 않는다', async ({ page }) => {
    await waitForInit(page);
    await expect.poll(async () => page.evaluate(() => (window as any).app._bg.length),
      { timeout: 10000 }).toBe(0);
    await expect(page.locator('#sb-bg-btn')).toBeHidden();
  });

  test('TC-BGU-3: 진입점이 상태바 우측 끝에 놓인다', async ({ page, request }) => {
    await waitForInit(page);
    await makeBackgroundTool(page, request);

    const btn = page.locator('#sb-bg-btn');
    await expect(btn).toBeVisible();

    const geom = await page.evaluate(() => {
      const bar = document.getElementById('status-bar')!;
      const b = document.getElementById('sb-bg-btn')!;
      const barBox = bar.getBoundingClientRect();
      const btnBox = b.getBoundingClientRect();
      const cs = getComputedStyle(bar);
      const others = Array.from(bar.querySelectorAll('.sb-item'))
        .map((e) => e.getBoundingClientRect().right);
      return {
        gapRight: barBox.right - btnBox.right,
        padRight: parseFloat(cs.paddingRight),
        maxOtherRight: others.length ? Math.max(...others) : -Infinity,
        btnLeft: btnBox.left,
      };
    });

    // 우측 내부 경계(= 상태바 우측 - padding)에 밀착한다.
    expect(geom.gapRight).toBeLessThanOrEqual(geom.padRight + 1);
    // 어떤 지표보다도 오른쪽에 있다.
    expect(geom.btnLeft).toBeGreaterThanOrEqual(geom.maxOtherRight);
  });

  test('TC-BGU-4: 진입점 색이 테마 팔레트를 따른다', async ({ page, request }) => {
    await waitForInit(page);
    await makeBackgroundTool(page, request);
    await expect(page.locator('#sb-bg-btn')).toBeVisible();

    const before = await page.evaluate(() => getComputedStyle(document.getElementById('sb-bg-btn')!).color);

    // 테마를 바꾸면 진입점 색도 함께 바뀐다 (리터럴 색상이 아니라는 증거).
    await page.click('#settings-btn');
    await page.locator('#theme-list .tl-item', { hasText: 'GitHub Light' }).click();
    await page.click('#modal-close');

    const after = await page.evaluate(() => getComputedStyle(document.getElementById('sb-bg-btn')!).color);
    expect(after).not.toBe(before);
  });

  test('TC-BGU-5: 진입점이 상태바 지표 재생성으로 파괴되지 않는다', async ({ page, request }) => {
    await waitForInit(page);
    await makeBackgroundTool(page, request);
    await expect(page.locator('#sb-bg-btn')).toBeVisible();

    const survived = await page.evaluate(() => {
      const app = (window as any).app;
      const mark = Symbol.for('tc-bgu-5');
      const el = document.getElementById('sb-bg-btn') as any;
      el[mark] = true;
      for (let i = 0; i < 3; i++) app._updateStatusBar();
      const now = document.getElementById('sb-bg-btn') as any;
      return !!(now && now[mark]);
    });
    expect(survived, '_updateStatusBar 가 진입점을 재생성했다').toBe(true);
  });

  test('TC-BGU-9: 진입점은 상태바 지표가 아니다', async ({ page, request }) => {
    await waitForInit(page);
    await makeBackgroundTool(page, request);
    const btn = page.locator('#sb-bg-btn');
    await expect(btn).toBeVisible();
    await expect(btn).not.toHaveClass(/sb-item/);
    // 지표 컨테이너 밖에 있어야 구분선 규칙(.sb-item+.sb-item)이 닿지 않는다.
    const outside = await page.evaluate(() =>
      !document.getElementById('sb-items')!.contains(document.getElementById('sb-bg-btn')));
    expect(outside, '진입점이 지표 컨테이너 안에 있다').toBe(true);
  });
});

test.describe('FR-BGU-6..8: 백그라운드 목록 모달', () => {
  test('TC-BGU-7: 목록이 뷰포트 중앙 모달로 열린다', async ({ page, request }) => {
    await waitForInit(page);
    await makeBackgroundTool(page, request);

    await page.click('#sb-bg-btn');
    const modal = page.locator('#bg-modal .bg-box');
    await expect(modal).toBeVisible();

    const off = await page.evaluate(() => {
      const b = document.querySelector('#bg-modal .bg-box')!.getBoundingClientRect();
      return {
        dx: Math.abs((b.left + b.right) / 2 - window.innerWidth / 2),
        dy: Math.abs((b.top + b.bottom) / 2 - window.innerHeight / 2),
      };
    });
    expect(off.dx).toBeLessThanOrEqual(2);
    expect(off.dy).toBeLessThanOrEqual(2);
  });

  test('TC-BGU-8: Esc 와 배경 클릭으로 닫힌다', async ({ page, request }) => {
    await waitForInit(page);
    await makeBackgroundTool(page, request);

    await page.click('#sb-bg-btn');
    await expect(page.locator('#bg-modal')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('#bg-modal')).toHaveCount(0);

    await page.click('#sb-bg-btn');
    await expect(page.locator('#bg-modal')).toBeVisible();
    // 오버레이 자체(중앙 박스 밖)를 클릭한다.
    await page.locator('#bg-modal').click({ position: { x: 5, y: 5 } });
    await expect(page.locator('#bg-modal')).toHaveCount(0);
  });

  test('TC-BGU-9b: 모달 항목 클릭 시 현재 Pane 새 탭으로 복귀한다', async ({ page, request }) => {
    await waitForInit(page);
    const toolId = await makeBackgroundTool(page, request);

    const focusedTabCount = () => page.evaluate(() => {
      const app = (window as any).app;
      const w = app.ws.windows.find((x: any) => x.id === app.ws.activeWindow);
      const find = (n: any): any => {
        if (!n) return null;
        if (n.type === 'pane') return n.id === app.focused ? n : null;
        for (const c of n.children || []) { const r = find(c); if (r) return r; }
        return null;
      };
      const pn = find(w?.layout);
      return pn ? pn.tabs.length : -1;
    });
    const tabsBefore = await focusedTabCount();

    await page.click('#sb-bg-btn');
    await page.locator('#bg-modal .bg-row').first().click();

    await expect.poll(async () => {
      const bg = await (await request.get('/api/tools/background')).json();
      return (bg.background || []).some((b: any) => b.toolId === toolId);
    }, { timeout: 10000 }).toBe(false);

    const tabsAfter = await focusedTabCount();
    expect(tabsAfter).toBe(tabsBefore + 1);
    await expect(page.locator('#bg-modal')).toHaveCount(0);
  });
});
