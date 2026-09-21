import { Page } from '@playwright/test';

import { test, expect, waitForInit } from './fixtures';

// 묶음 A (USER_CHECKLIST_FIXES_SRS §3.1 / §4.1) — 백그라운드 UI 일관화.
//
// 확인창의 "백그라운드로" 버튼만 형태 규약 밖에 있었고(§2.1), 백그라운드
// 진입점이 상태바 지표에 묻힌 채 폴링마다 재생성됐고(§2.2), 목록이 사라질
// 앵커에 매여 있었다(§2.3).

// 확인창을 직접 띄운다. busy 프로세스를 만들어 실제 경로를 타는 것보다
// 결정론적이고, 검증 대상이 버튼의 형태·색 규약이므로 충분하다.
async function openConfirm(page: Page, opts: Record<string, unknown>) {
  await page.evaluate((o) => {
    // Promise 는 의도적으로 버린다 — 닫힘까지 기다리면 evaluate 가 걸린다.
    void (window as any).app.testing.confirmClose('테스트', o);
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

  // 브라우저 목록에 '이 도구가' 올랐는지 확인한다. 개수만 보면 앞선 스펙이 남긴
  // 백그라운드 도구와 구별되지 않아 뒤의 선택이 엉뚱한 행을 짚는다.
  await expect.poll(
    async () => page.evaluate((tid) =>
      ((window as any).app.testing.bg || []).some((b: any) => b.toolId === tid), before),
    { timeout: 10000 },
  ).toBe(true);

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

// STATUS_BAR_REFLOW_SRS 묶음 B 가 이 묶음을 개정한다 — 진입점은 상태바를 떠나
// 상단바의 `Split H · Split V · Runs · BG · Agents` 자리에 서고(FR-SBR-8),
// 0개여도 숨지 않는다(FR-SBR-9, 구 FR-BGU-5 폐기).
test.describe('FR-SBR-8..13: 백그라운드 진입점', () => {
  // V-SBR-6
  test('TC-SBR-6: 도구가 0개여도 보이고, 하이라이트는 없다', async ({ page }) => {
    await waitForInit(page);
    await expect.poll(async () => page.evaluate(() => (window as any).app.testing.bg.length),
      { timeout: 10000 }).toBe(0);
    const btn = page.locator('#bg-btn');
    await expect(btn).toBeVisible();
    await expect(btn).toHaveText('Background');
    await expect(btn).not.toHaveClass(/\bon\b/);
  });

  // V-SBR-5
  test('TC-SBR-5: 진입점이 Runs 와 Agents 사이에 서고 상태바에는 없다', async ({ page }) => {
    await waitForInit(page);
    const got = await page.evaluate(() => {
      const bar = document.getElementById('topbar')!;
      const ids = Array.from(bar.children).map((e) => e.id).filter(Boolean);
      return {
        order: ids.filter((i) => ['runs-btn', 'bg-btn', 'agents-toggle'].includes(i)),
        inStatusBar: document.getElementById('status-bar')!.contains(document.getElementById('bg-btn')),
      };
    });
    /**
     * **재는 것은 `Runs` 와 `Agents` 사이다** (FR-SBR-8). 종전에는 앞에 분할 둘을
     * 함께 적었는데, `UIUX_OVERHAUL_SRS` FR-CHR-10 (D-6) 이 그 둘을 pane 탭줄로
     * 보냈다 — 분할은 이 pane 을 쪼개므로 전역 줄의 것이 아니다.
     *
     * 이 조항이 말하는 이웃 관계는 그대로다. 없어진 이웃을 기대값에서 뺀다.
     */
    expect(got.order).toEqual(['runs-btn', 'bg-btn', 'agents-toggle']);
    expect(got.inStatusBar, '진입점이 아직 상태바에 있다').toBe(false);
  });

  // V-SBR-7
  test('TC-SBR-7: 도구가 생기면 개수가 붙고 하이라이트된다', async ({ page, request }) => {
    await waitForInit(page);
    const plain = await page.evaluate(() => getComputedStyle(document.getElementById('bg-btn')!).borderColor);

    await makeBackgroundTool(page, request);
    const btn = page.locator('#bg-btn');
    await expect(btn).toHaveClass(/\bon\b/, { timeout: 10000 });
    await expect(btn).toHaveText('Background 1');
    const lit = await page.evaluate(() => getComputedStyle(document.getElementById('bg-btn')!).borderColor);
    expect(lit, '하이라이트가 평소와 같은 테두리색이다').not.toBe(plain);
  });

  // V-SBR-7 (FR-SBR-10): 하이라이트는 리터럴 색이 아니다.
  test('TC-BGU-4: 진입점 색이 테마 팔레트를 따른다', async ({ page, request }) => {
    await waitForInit(page);
    await makeBackgroundTool(page, request);
    await expect(page.locator('#bg-btn')).toBeVisible();

    const before = await page.evaluate(() => getComputedStyle(document.getElementById('bg-btn')!).color);

    // 테마를 바꾸면 진입점 색도 함께 바뀐다 (리터럴 색상이 아니라는 증거).
    await page.click('#settings-btn');
    await page.locator('#theme-list .tl-item', { hasText: 'GitHub Light' }).click();
    await page.click('#modal-close');

    const after = await page.evaluate(() => getComputedStyle(document.getElementById('bg-btn')!).color);
    expect(after).not.toBe(before);
  });

  test('TC-BGU-5: 진입점이 상태바 지표 재생성으로 파괴되지 않는다', async ({ page, request }) => {
    await waitForInit(page);
    await makeBackgroundTool(page, request);
    await expect(page.locator('#bg-btn')).toBeVisible();

    const survived = await page.evaluate(() => {
      const app = (window as any).app;
      const mark = Symbol.for('tc-bgu-5');
      const el = document.getElementById('bg-btn') as any;
      el[mark] = true;
      for (let i = 0; i < 3; i++) app.testing.updateStatusBar();
      const now = document.getElementById('bg-btn') as any;
      return !!(now && now[mark]);
    });
    expect(survived, 'updateStatusBar 가 진입점을 재생성했다').toBe(true);
  });

  test('TC-BGU-9: 진입점은 상태바 지표가 아니다', async ({ page, request }) => {
    await waitForInit(page);
    await makeBackgroundTool(page, request);
    const btn = page.locator('#bg-btn');
    await expect(btn).toBeVisible();
    await expect(btn).not.toHaveClass(/sb-item/);
    // 지표 컨테이너 밖에 있어야 구분선 규칙(.sb-item+.sb-item)이 닿지 않는다.
    const outside = await page.evaluate(() =>
      !document.getElementById('sb-items')!.contains(document.getElementById('bg-btn')));
    expect(outside, '진입점이 지표 컨테이너 안에 있다').toBe(true);
  });
});

/**
 * FR-BGU-6..8 (**UIUX_OVERHAUL_SRS FR-ACT-1·2 로 개정**): 목록은 모달이 아니라
 * 활동 패널의 백그라운드 구역이다.
 *
 * 사라진 검증 둘과 그 이유:
 *   TC-BGU-7 "뷰포트 중앙 모달로 열린다" — 중앙에 뜨는 것이 결함이었다 (§2.5).
 *     도킹 패널은 중앙에 뜨지 않으므로 이 문장은 뒤집힌 채로 남길 수 없다.
 *     그 자리를 **"차단하지 않는다"** 가 대신한다 (아래 TC-ACT-2).
 *   TC-BGU-8 "Esc 와 배경 클릭으로 닫힌다" — 백드롭이 있을 때만 성립한다.
 *     패널에는 배경이 없고, 닫는 길은 진입점 토글과 패널의 닫기다.
 */
test.describe('FR-BGU-6..8 (FR-ACT-1·2 개정): 백그라운드 구역', () => {
  test('TC-ACT-2: 목록이 앱을 막지 않는다 — 백드롭이 없다', async ({ page, request }) => {
    await waitForInit(page);
    await makeBackgroundTool(page, request);

    await page.click('#bg-btn');
    await expect(page.locator('#agents-panel.open .ag-sec[data-sec="bg"]')).toBeVisible();
    // 조회 경로에 **보이는** 오버레이가 없다 (FR-ACT-2 · §9 의 검증 항목).
    // `#modal-overlay` 는 설정의 것으로 항상 DOM 에 있고 숨어 있다 — 세는 것은
    // 존재가 아니라 화면을 덮었는가다.
    expect(await page.locator('.ui-modal:visible').count(), '조회가 백드롭을 띄웠다').toBe(0);
    // 막지 않는다는 것은 터미널이 그대로 닿는다는 뜻이다.
    await expect(page.locator('#area .pn.focused .xterm-helper-textarea')).toBeVisible();
  });

  test('TC-ACT-4: 진입점을 다시 누르면 닫힌다 — 토글이던 것은 토글로 남는다', async ({ page, request }) => {
    await waitForInit(page);
    await makeBackgroundTool(page, request);

    await page.click('#bg-btn');
    await expect(page.locator('#agents-panel.open')).toBeVisible();
    await page.click('#bg-btn');
    await expect(page.locator('#agents-panel.open')).toHaveCount(0);
  });

  test('TC-BGU-9b: 구역의 항목을 누르면 현재 Pane 새 탭으로 복귀한다', async ({ page, request }) => {
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

    await page.click('#bg-btn');
    await page.locator(`#agents-panel .bg-row[data-toolid="${toolId}"]`).click();

    // 배리어는 클라이언트 상태여야 한다. _restoreTool 은 서버의 백그라운드
    // 해제를 먼저 await 하고 그 뒤에 탭을 넣으므로, /api/tools/background 로
    // 폴링하면 해제와 탭 삽입 사이(약 3ms)를 관측한다. 그 폴 GET 은 브라우저의
    // POST 와 같은 서버에 파이프라인되어 그 창을 안정적으로 명중시킨다 —
    // 경합이 아니라 결정적 실패였다.
    await expect.poll(focusedTabCount, { timeout: 10000 }).toBe(tabsBefore + 1);

    const bg = await (await request.get('/api/tools/background')).json();
    expect((bg.background || []).some((b: any) => b.toolId === toolId),
      '탭은 복귀했는데 백그라운드 목록에 남아 있다').toBe(false);
    // FR-ACT-2: 조회는 남의 동작에 닫히지 않는다 — 행만 빠지고 패널은 산다.
    await expect(page.locator('#agents-panel.open')).toBeVisible();
  });
});
