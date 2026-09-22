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

/**
 * UIUX_OVERHAUL_SRS FR-CHR-18 (D-7): 백그라운드 구역으로 **직행하는 길**은 이제
 * `Ctrl+Shift+B` 다. 버튼이 없어졌다고 외운 키를 뺏지 않는다 (NFR-4) — 오히려
 * 그 구역을 직접 부르는 유일한 길이 됐다.
 */
async function pressBgKey(page: Page) {
  await page.keyboard.press('Control+Shift+KeyB');
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
/**
 * **재개정 2026-09-22 (`UIUX_OVERHAUL_SRS` FR-CHR-14~18 / D-7).**
 *
 * `#bg-btn` 이 없어졌다. 묶음 B 가 상태바에서 상단바로 옮겨 놓은 그 진입점은
 * `Runs`·`Agents` 와 **같은 패널**을 열고 있었고, 문이 셋이면 방도 셋으로
 * 읽힌다. 셋은 `Activity`(`#agents-toggle`) 하나가 됐다.
 *
 * **재는 대상이 바뀐 것이지 조항이 느슨해진 것이 아니다** — FR-SBR-8·9 가
 * 말하던 *"상단바에 있고 항상 보인다"* 는 그 하나가 그대로 진다. FR-SBR-10·11
 * (하이라이트와 `Background n`)은 **철회**됐고, 그 자리를 뒤집은 단정이
 * 대신한다 (TC-CHR-16).
 */
test.describe('FR-SBR-8·9 (D-7 개정): 활동 진입점', () => {
  // V-SBR-6
  test('TC-SBR-6: 도구가 0개여도 보이고, 하이라이트는 없다', async ({ page }) => {
    await waitForInit(page);
    await expect.poll(async () => page.evaluate(() => (window as any).app.testing.bg.length),
      { timeout: 10000 }).toBe(0);
    const btn = page.locator('#agents-toggle');
    await expect(btn).toBeVisible();
    await expect(btn).toHaveText('Activity');
    await expect(btn).not.toHaveClass(/\bon\b/);
  });

  // V-SBR-5 · FR-CHR-14: 오른쪽 차례가 `알림 · 슬롯 ± · Activity` 다.
  test('TC-SBR-5: 진입점이 이 줄의 끝에 서고 상태바에는 없다', async ({ page }) => {
    await waitForInit(page);
    const got = await page.evaluate(() => {
      const bar = document.getElementById('topbar')!;
      const ids = Array.from(bar.querySelectorAll('[id]'))
        .filter((e) => (e as HTMLElement).offsetParent !== null)
        .map((e) => e.id);
      return {
        gone: ['runs-btn', 'bg-btn'].filter((i) => document.getElementById(i)),
        tail: ids.slice(-3),
        inStatusBar: document.getElementById('status-bar')!.contains(document.getElementById('agents-toggle')),
      };
    });
    expect(got.gone, '없어진 버튼이 아직 DOM 에 있다').toEqual([]);
    // 알림 배지는 알림이 없으면 서지 않으므로(`display:none`) 보이는 꼬리는 셋이
    // 아니라 슬롯 둘과 `Activity` 다.
    expect(got.tail).toEqual(['slot-remove', 'slot-add', 'agents-toggle']);
    expect(got.inStatusBar, '진입점이 아직 상태바에 있다').toBe(false);
  });

  // FR-CHR-16: 종전 TC-SBR-7 을 **뒤집는다.** 수를 세려면 Run 을 세야 하고,
  // 그것은 `RunsPanel` 규약을 다시 깬다 — 부분만 센 수는 수가 아니다.
  test('TC-CHR-16: 도구가 생겨도 개수가 붙지 않고 하이라이트도 없다', async ({ page, request }) => {
    await waitForInit(page);
    const btn = page.locator('#agents-toggle');
    await makeBackgroundTool(page, request);
    await expect.poll(async () => page.evaluate(() => (window as any).app.testing.bg.length),
      { timeout: 10000 }).toBe(1);
    await expect(btn).toHaveText('Activity');
    await expect(btn).not.toHaveClass(/\bon\b/);
  });

  /**
   * FR-CHR-18 · NFR-4: 버튼이 없어졌다고 외운 키를 뺏지 않는다. 셋이 **문
   * 하나**를 열고, 앞의 둘은 제 구역을 펴 준다.
   *
   * 스크롤 자체가 아니라 **접힌 구역이 펴지는 것**을 잰다 (`_actScrollTo`) —
   * 스크롤 위치는 패널 높이에 따라 흔들리지만 접힘은 결정적이다.
   */
  test('TC-CHR-18: 단축키 셋이 살아 각자의 구역을 연다', async ({ page }) => {
    await waitForInit(page);
    const folded = (sec: string) => page.locator(`#agents-panel .ag-sec[data-sec="${sec}"].folded`);

    // 세 구역을 **화면에서** 접어 둔다 — 펴지는 것이 키의 일이었음을 드러낸다.
    // 접기는 머리의 몸통으로 한다 (FR-ACT-10).
    await page.click('#agents-toggle');
    await expect(page.locator('#agents-panel.open')).toBeVisible();
    for (const sec of ['agents', 'bg', 'runs']) {
      await page.locator(`#agents-panel .ag-sec[data-sec="${sec}"] .ag-sec-name`).click();
      await expect(folded(sec)).toHaveCount(1);
    }
    await page.click('#agents-toggle');
    await expect(page.locator('#agents-panel.open')).toHaveCount(0);

    await page.keyboard.press('Control+Shift+KeyB');
    await expect(page.locator('#agents-panel.open')).toBeVisible();
    await expect(folded('bg')).toHaveCount(0);
    await expect(folded('runs'), '부르지 않은 구역까지 폈다').toHaveCount(1);

    await page.keyboard.press('Control+Shift+KeyO');
    await expect(folded('runs')).toHaveCount(0);

    // `Ctrl+Shift+A` 는 구역을 지정하지 않는 **문 그 자체**다 — 토글로 닫힌다.
    await page.keyboard.press('Control+Shift+KeyA');
    await expect(page.locator('#agents-panel.open')).toHaveCount(0);
    await page.keyboard.press('Control+Shift+KeyA');
    await expect(page.locator('#agents-panel.open')).toBeVisible();
    await expect(folded('agents'), '문만 여는 키가 구역까지 폈다').toHaveCount(1);
  });

  test('TC-BGU-5: 진입점이 상태바 지표 재생성으로 파괴되지 않는다', async ({ page, request }) => {
    await waitForInit(page);
    await makeBackgroundTool(page, request);
    await expect(page.locator('#agents-toggle')).toBeVisible();

    const survived = await page.evaluate(() => {
      const app = (window as any).app;
      const mark = Symbol.for('tc-bgu-5');
      const el = document.getElementById('agents-toggle') as any;
      el[mark] = true;
      for (let i = 0; i < 3; i++) app.testing.updateStatusBar();
      const now = document.getElementById('agents-toggle') as any;
      return !!(now && now[mark]);
    });
    expect(survived, 'updateStatusBar 가 진입점을 재생성했다').toBe(true);
  });

  test('TC-BGU-9: 진입점은 상태바 지표가 아니다', async ({ page, request }) => {
    await waitForInit(page);
    await makeBackgroundTool(page, request);
    const btn = page.locator('#agents-toggle');
    await expect(btn).toBeVisible();
    await expect(btn).not.toHaveClass(/sb-item/);
    // 지표 컨테이너 밖에 있어야 구분선 규칙(.sb-item+.sb-item)이 닿지 않는다.
    const outside = await page.evaluate(() =>
      !document.getElementById('sb-items')!.contains(document.getElementById('agents-toggle')));
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

    await pressBgKey(page);
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

    await pressBgKey(page);
    await expect(page.locator('#agents-panel.open')).toBeVisible();
    await pressBgKey(page);
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

    await pressBgKey(page);
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
