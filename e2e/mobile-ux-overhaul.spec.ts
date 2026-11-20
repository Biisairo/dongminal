// MOBILE_UX_OVERHAUL_SRS — 모바일 결함 교정과 전체 높이 시트 (TC-MUX-*)
import { Page } from '@playwright/test';

import {
  test, expect, waitForInit, gitFixture, cleanGitFixture, makeCopyFx,
} from './fixtures';
import { tmpPath } from './osenv';

const VIEW = { width: 412, height: 839 };
const FIXTURES = tmpPath('dm-git-fx-mux-' + process.pid);
const copyFx = makeCopyFx(FIXTURES);

test.beforeAll(() => { gitFixture(FIXTURES) });
test.afterAll(() => { cleanGitFixture(FIXTURES) });

const mobile = (page: Page) => waitForInit(page, { mode: 'mobile', viewport: VIEW });

async function openRepoExplorer(page: Page, tag: string) {
  const repo = copyFx('basic', tag);
  await page.evaluate((r: string) => (window as any).app.openGitWindow(r), repo);
  await page.waitForSelector('#area .ed-win .ed-side', { timeout: 15000 });
  await page.evaluate(() => {
    const a = (window as any).app;
    a.testing.edSetSide(a.testing.aw(), 'explorer');
  });
  await expect(page.locator('#area .ed-side .ed-explorer')).toBeVisible({ timeout: 10000 });
  return repo;
}

const visible = (page: Page, sel: string) => page.locator(sel).first().isVisible();

async function openDrawer(page: Page) {
  await page.locator('#m-drawer-toggle').click();
  await expect(page.locator('body')).toHaveClass(/drawer-open/);
  // 슬라이드 전이가 끝날 때까지 기다린다.
  await expect.poll(() => page.locator('#sidebar').evaluate((el) => Math.round(el.getBoundingClientRect().left))).toBe(0);
}

test.describe('결함 교정 (FR-MUX-1~6)', () => {
  test('TC-MUX-1: 모바일 탐색기는 사이드 자리의 전체 폭을 쓴다', async ({ page }) => {
    await mobile(page);
    await openRepoExplorer(page, 'mux-1');
    const [ex, body] = await page.evaluate(() => [
      document.querySelector('#area .ed-side .ed-explorer')!.getBoundingClientRect().width,
      document.querySelector('#area .ed-side .ed-side-body')!.getBoundingClientRect().width,
    ]);
    expect(ex).toBeGreaterThanOrEqual(body - 1);
  });

  test('TC-MUX-2·3: 키바는 터미널 칸에서만 보이고, 감춰지면 본문이 늘어난다', async ({ page }) => {
    await mobile(page);
    await expect(page.locator('#mobile-keybar')).toBeVisible();
    const before = await page.locator('#content').evaluate((el) => el.getBoundingClientRect().bottom);

    await openRepoExplorer(page, 'mux-2');
    await expect(page.locator('#mobile-keybar')).toBeHidden();
    const after = await page.locator('#content').evaluate((el) => el.getBoundingClientRect().bottom);
    expect(after).toBeGreaterThan(before + 20);

    // 터미널 창으로 돌아오면 다시 보인다.
    await page.evaluate(() => {
      const a = (window as any).app;
      a.switchWindow(a.testing.plainWindows()[0].id);
    });
    await expect(page.locator('#mobile-keybar')).toBeVisible();
  });

  test('TC-MUX-4: 모바일에서는 편집기 미니맵을 그리지 않는다', async ({ page }) => {
    await mobile(page);
    const repo = await openRepoExplorer(page, 'mux-4');
    // 미니맵 설정은 기본으로 켜져 있다 (`editorMinimap=true`) — 켜진 채로 감춰져야 한다.
    expect(await page.evaluate(() => (window as any).editorMinimap)).toBe(true);
    await page.evaluate((p: string) => (window as any).app.testing.edOpenFile(p, { pin: true }), repo + '/tracked.txt');
    await expect(page.locator('#area .cm-editor').first()).toBeVisible({ timeout: 15000 });
    const w = await page.evaluate(() => {
      const g = document.querySelector('#area .cm-editor .cm-minimap-gutter') as HTMLElement | null;
      return g ? g.getBoundingClientRect().width : 0;
    });
    expect(w).toBe(0);
  });

  test('TC-MUX-5: 칸 하나인 터미널 창에서 칸 순회와 상단바 + 가 보이지 않는다', async ({ page }) => {
    await mobile(page);
    expect(await visible(page, '#topbar .m-pane-nav')).toBe(false);
    expect(await visible(page, '#m-add-tab')).toBe(false);
    // 탭바의 + 는 그대로다.
    await expect(page.locator('#area .pn.focused .pn-tab-add')).toBeVisible();
  });
});

test.describe('전체 높이 시트 (FR-MUX-10~14)', () => {
  test('TC-MUX-6: 서랍은 왼쪽 전체 높이 시트이고 하단 줄이 맨 아래에 붙는다', async ({ page }) => {
    await mobile(page);
    await openDrawer(page);
    const r = await page.evaluate(() => {
      const s = document.getElementById('sidebar')!.getBoundingClientRect();
      const b = document.getElementById('sb-bottom')!.getBoundingClientRect();
      return { top: s.top, left: s.left, w: s.width, h: s.height, bb: b.bottom, vh: innerHeight };
    });
    expect(r.top).toBe(0);
    expect(r.left).toBe(0);
    // PANEL_TEMPLATE_SRS FR-PNT-10·14 로 개정: 이전 폭 `min(86vw,360px)` + 배경 막(누르면 닫힘) /
    // 지금 화면 전체 — 막이 보일 자리가 없다. 닫기는 머리의 `×` 다 / 이유 두 패널이 같은 시트다 (D-2).
    expect(Math.abs(r.w - VIEW.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(r.h - r.vh)).toBeLessThanOrEqual(1);
    expect(r.vh - r.bb).toBeLessThanOrEqual(16);
    await page.locator('#drawer-close').click();
    await expect(page.locator('body')).not.toHaveClass(/drawer-open/);
  });

  test('TC-MUX-7: Activity 는 화면 전체를 덮고 Escape 로 닫힌다', async ({ page }) => {
    await mobile(page);
    await page.evaluate(() => (window as any).app.actPanelOpen());
    const panel = page.locator('#agents-panel');
    await expect(panel).toHaveClass(/open/);
    // PANEL_TEMPLATE_SRS FR-PNT-11: 시트는 오른쪽에서 미끄러져 들어온다 — 전환이 끝난 자리를 잰다.
    await expect.poll(() => panel.evaluate((el) => el.getBoundingClientRect().left)).toBe(0);
    const r = await panel.evaluate((el) => {
      const b = el.getBoundingClientRect();
      return { top: b.top, left: b.left, w: b.width, h: b.height, vw: innerWidth, vh: innerHeight };
    });
    expect(r.top).toBe(0);
    expect(r.left).toBe(0);
    expect(Math.abs(r.w - r.vw)).toBeLessThanOrEqual(1);
    expect(Math.abs(r.h - r.vh)).toBeLessThanOrEqual(1);
    await page.keyboard.press('Escape');
    await expect(panel).not.toHaveClass(/open/);
  });

  test('TC-MUX-8: 시트가 열려 있으면 키바·상태바가 보이지 않는다', async ({ page }) => {
    await mobile(page);
    await expect(page.locator('#mobile-keybar')).toBeVisible();
    await openDrawer(page);
    await expect(page.locator('#mobile-keybar')).toBeHidden();
    await expect(page.locator('#status-bar')).toBeHidden();
    // PANEL_TEMPLATE_SRS FR-PNT-14 로 개정: 배경 막이 없다 — 머리의 `×` 로 닫는다.
    await page.locator('#drawer-close').click();
    await expect(page.locator('#mobile-keybar')).toBeVisible();

    await page.evaluate(() => (window as any).app.actPanelOpen());
    await expect(page.locator('#mobile-keybar')).toBeHidden();
    await expect(page.locator('#status-bar')).toBeHidden();
    await page.keyboard.press('Escape');
    await expect(page.locator('#mobile-keybar')).toBeVisible();
  });
});

test.describe('설정 — 전체 화면, 목록 → 상세 (FR-MUX-20~25)', () => {
  async function openSettings(page: Page) {
    await page.evaluate(() => (window as any).app.testing.openSettings());
    await expect(page.locator('#modal-overlay')).toHaveClass(/open/);
  }

  test('TC-MUX-9: 모바일 설정은 뷰포트를 덮고 섹션 목록부터 보인다', async ({ page }) => {
    await mobile(page);
    await openSettings(page);
    const r = await page.locator('#modal').evaluate((el) => {
      const b = el.getBoundingClientRect();
      return { l: b.left, t: b.top, w: b.width, h: b.height, vw: innerWidth, vh: innerHeight };
    });
    expect(r.l).toBe(0);
    expect(r.t).toBe(0);
    expect(Math.abs(r.w - r.vw)).toBeLessThanOrEqual(1);
    expect(Math.abs(r.h - r.vh)).toBeLessThanOrEqual(1);
    await expect(page.locator('#modal .modal-tabs')).toBeVisible();
    await expect(page.locator('#modal .modal-body')).toBeHidden();
    // 섹션 하나가 한 줄이다 — 왼쪽 끝이 하나이고 행마다 터치 하한 이상이다.
    const rows = await page.evaluate(() => [...document.querySelectorAll('#modal .mtab')]
      .map((t) => t.getBoundingClientRect()).map((b) => ({ l: Math.round(b.left), h: b.height, w: b.width })));
    expect(new Set(rows.map((x) => x.l)).size).toBe(1);
    for (const x of rows) { expect(x.h).toBeGreaterThanOrEqual(44); expect(x.w).toBeGreaterThan(VIEW.width - 4) }
  });

  test('TC-MUX-10: 섹션을 누르면 상세, 뒤로·Escape 로 목록, 목록에서 Escape 는 닫는다', async ({ page }) => {
    await mobile(page);
    await openSettings(page);
    await page.locator('#modal .mtab[data-tab="display"]').click();
    await expect(page.locator('#panel-display')).toBeVisible();
    await expect(page.locator('#modal .modal-tabs')).toBeHidden();
    await expect(page.locator('#modal-back')).toBeVisible();
    // UX_AUDIT_FIX_SRS FR-UXF-40 로 개정: 이전 'Display' / 지금 '화면' / 이유 설정 탭 이름 (§3.5.2)
    await expect(page.locator('#modal .modal-section')).toHaveText('화면');

    await page.locator('#modal-back').click();
    await expect(page.locator('#modal .modal-tabs')).toBeVisible();
    await expect(page.locator('#panel-display')).toBeHidden();

    await page.locator('#modal .mtab[data-tab="theme"]').click();
    await expect(page.locator('#panel-theme')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('#modal .modal-tabs')).toBeVisible();
    await expect(page.locator('#modal-overlay')).toHaveClass(/open/);
    await page.keyboard.press('Escape');
    await expect(page.locator('#modal-overlay')).not.toHaveClass(/open/);
  });

  test('TC-MUX-10b: 딥링크(`_openSettings(tab)`)는 곧바로 그 상세를 연다', async ({ page }) => {
    await mobile(page);
    await page.evaluate(() => (window as any).app.testing.openSettings('terminal'));
    await expect(page.locator('#panel-terminal')).toBeVisible();
    await expect(page.locator('#modal-back')).toBeVisible();
  });

  test('TC-MUX-10c: 목록에서 검색해도 상세로 넘어가지 않는다', async ({ page }) => {
    await mobile(page);
    await openSettings(page);
    await page.locator('#modal-search').fill('sandbox');
    await expect(page.locator('#modal .mtab[data-tab="sandbox"]')).toBeVisible();
    // 고른 탭(Profile)이 걸러지면 데스크톱은 남은 첫 탭을 누른다 — 모바일 목록에서는 그러지 않는다.
    const total = await page.locator('#modal .mtab').count();
    await expect.poll(() => page.locator('#modal .mtab:visible').count()).toBeLessThan(total);
    await expect(page.locator('#modal .modal-body')).toBeHidden();
  });

  test('TC-MUX-11: 데스크톱 설정은 종전대로 탭과 패널이 함께 보인다', async ({ page }) => {
    await waitForInit(page);
    await page.click('#settings-btn');
    await expect(page.locator('#modal .modal-tabs')).toBeVisible();
    await expect(page.locator('#modal .modal-body')).toBeVisible();
    await expect(page.locator('#modal-back')).toBeHidden();
  });
});

// UX_AUDIT_FIX_SRS FR-UXF-90 으로 개정: 이전 모바일 상태바는 연결·cwd 항목만 보였다 / 지금 상태바 줄이 없고
// 연결·cwd 는 상단바가 말한다(TC-UXF-90) / 이유 진단 M1, D-30 — 키바 위 한 줄이 터미널 세로를 먹었다.
test('TC-MUX-12: 모바일에는 상태바 줄이 없고 연결 점이 상단바에 있다', async ({ page }) => {
  await mobile(page);
  await expect(page.locator('#status-bar')).toBeHidden();
  await expect(page.locator('#topbar .m-conn-dot')).toBeVisible();
});

// FR-MUX-60: 가로로 돌린 휴대폰(터치, 낮은 높이)은 폭이 기준을 넘어도 Auto 에서 모바일이다.
test.describe('가로 휴대폰 (FR-MUX-60~61)', () => {
  async function gotoAuto(page: Page) {
    await page.context().addInitScript(() => { sessionStorage.setItem('displayMode', 'auto') });
    await page.goto('/');
    await page.waitForSelector('#area', { timeout: 15000 });
  }

  test.describe('터치 기기', () => {
    test.use({ hasTouch: true, isMobile: true, viewport: { width: 839, height: 412 } });
    test('TC-MUX-13: 가로 휴대폰은 Auto 에서 모바일이다', async ({ page }) => {
      await gotoAuto(page);
      await expect(page.locator('body')).toHaveClass(/\bmobile\b/);
    });
  });

  test.describe('터치 기기 — 태블릿 높이', () => {
    test.use({ hasTouch: true, isMobile: true, viewport: { width: 1024, height: 768 } });
    test('TC-MUX-14: 높이가 넉넉한 터치 기기는 종전대로 데스크톱이다', async ({ page }) => {
      await gotoAuto(page);
      await expect(page.locator('body')).not.toHaveClass(/\bmobile\b/);
    });
  });

  test.describe('마우스 기기', () => {
    test.use({ viewport: { width: 839, height: 412 } });
    test('TC-MUX-15: 낮은 데스크톱 창은 종전대로 데스크톱이다', async ({ page }) => {
      await gotoAuto(page);
      await expect(page.locator('body')).not.toHaveClass(/\bmobile\b/);
    });
  });
});

test.describe('터치 메뉴·편집기 (FR-MUX-43·46·50·51)', () => {
  test.use({ hasTouch: true });

  test('TC-MUX-16: 파일 행을 길게 누르면 메뉴가 한 번 열리고 행은 열리지 않는다', async ({ page }) => {
    await mobile(page);
    const repo = copyFx('basic', 'mux-16');
    await page.evaluate((r: string) => (window as any).app.openGitWindow(r), repo);
    const row = page.locator('#area .ed-side .git-file', { hasText: 'untracked.txt' }).first();
    await expect(row).toBeVisible({ timeout: 20000 });
    await page.evaluate(() => {
      (window as any).__ctx = 0;
      document.addEventListener('contextmenu', () => { (window as any).__ctx++ }, true);
    });
    const idx0 = await page.evaluate(() => (window as any).app.mPaneIdx);
    const b = (await row.boundingBox())!;
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: b.x + 40, y: b.y + b.height / 2 }] });
    await expect(page.locator('.ui-menu')).toBeVisible();
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    // **예외 (`TEST-16`)**: 재는 것이 "두 번째 contextmenu·행 열기가 일어나지 않음" 이다 —
    // 기다릴 신호가 없으므로 그것이 올 수 있는 시간을 준다.
    await page.waitForTimeout(400);
    expect(await page.evaluate(() => (window as any).__ctx)).toBe(1);
    await expect(page.locator('.ui-menu')).toBeVisible();
    expect(await page.evaluate(() => (window as any).app.mPaneIdx)).toBe(idx0);
  });

  test('TC-MUX-17·18: 편집기 칸의 돋보기는 편집기 찾기를 열고, 줄은 바뀐다', async ({ page }) => {
    await mobile(page);
    const repo = await openRepoExplorer(page, 'mux-17');
    expect(await page.evaluate(() => (window as any).editorWordWrap)).toBe(false);
    await page.evaluate((p: string) => (window as any).app.testing.edOpenFile(p, { pin: true }), repo + '/tracked.txt');
    await expect(page.locator('#area .cm-editor').first()).toBeVisible({ timeout: 15000 });
    await expect(page.locator('#area .cm-editor .cm-content.cm-lineWrapping').first()).toBeAttached();
    await page.locator('#m-search-btn').click();
    await expect(page.locator('#area .fe-find.vis')).toBeVisible();
    await expect(page.locator('#search-bar')).toBeHidden();
    const r = await page.locator('#area .fe-find.vis').evaluate((el) => {
      const b = el.getBoundingClientRect();
      return { l: b.left, r: b.right, vw: innerWidth };
    });
    expect(r.l).toBeGreaterThanOrEqual(0);
    expect(r.r).toBeLessThanOrEqual(r.vw);
  });
});

// ── 2차 (FR-MUX-70~82) ──────────────────────────────────────────────

const NOW = () => Math.floor(Date.now() / 1000);
const win = (pct: number, inSec: number) =>
  ({ pct, resetsAt: NOW() + inSec, resetsInSec: inSec, level: pct >= 90 ? 'critical' : pct >= 70 ? 'warn' : '' });

/** 계정 셋 — 실측(270px)과 같은 바닥이 나온다. 활성 계정 `a` 는 statusLine 값도 갖는다 (FR-MUX-81). */
async function mockAccounts(page: Page) {
  const acct = (id: string, alias: string, color: string, active: boolean, extra: object = {}) => ({
    id, email: id + '@x.com', alias, color, active, disabled: false, priority: 0,
    usage: { status: 'ok', ageSeconds: 10, windows: { fiveHour: win(34, 7800), sevenDay: win(72, 368000) } }, ...extra,
  });
  const list = {
    activeId: 'a', autoswitch: { enabled: false, status: 'off' }, otherStatusLines: [],
    accounts: [
      acct('a', 'Work', 'acct-3', true,
        { statusLine: { windows: { fiveHour: win(40, 7000), sevenDay: win(21, 360000) }, observedAt: NOW(), ageSeconds: 5, stale: false } }),
      acct('b', 'Home', 'acct-6', false),
      acct('c', 'Spare', 'acct-1', false),
    ],
  };
  await page.route('**/api/claude-accounts**', async (route) => {
    const path = new URL(route.request().url()).pathname.replace('/api/claude-accounts', '') || '/';
    const json = (data: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });
    if (route.request().method() !== 'GET') return route.fallback();
    if (path === '/') return json(list);
    if (path === '/mappings') return json({ folders: {}, tabs: {} });
    return route.fallback();
  });
}

test.describe('2차 — 사용량 한 줄 요약 (FR-MUX-70~73)', () => {
  test('TC-MUX-20·21: 모바일 바닥은 요약 한 줄이고, 누르면 펼쳐지고 다시 누르면 접힌다', async ({ page }) => {
    await mockAccounts(page);
    await mobile(page);
    await page.evaluate(() => (window as any).app.actPanelOpen());
    const foot = page.locator('#agents-foot');
    const sum = foot.locator('.act-usage-sum');
    await expect(sum).toHaveCount(1, { timeout: 10000 });
    await expect(sum).toContainText('Work');
    await expect(sum.locator('.cacct-cell')).toHaveCount(2);
    await expect(sum).toHaveAttribute('aria-expanded', 'false');
    await expect(foot.locator('.cacct')).toHaveCount(0);
    const h = await page.evaluate(() => ({
      sum: document.querySelector('#agents-foot .act-usage-sum')!.getBoundingClientRect().height,
      foot: document.getElementById('agents-foot')!.getBoundingClientRect().height,
      min: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--touch-min')),
    }));
    expect(h.sum).toBeGreaterThanOrEqual(h.min - 0.5);
    expect(h.foot).toBeLessThan(100);

    await sum.click();
    await expect(foot.locator('.cacct')).toHaveCount(3);
    await expect(foot.locator('.act-usage-sum')).toHaveAttribute('aria-expanded', 'true');
    await foot.locator('.act-usage-sum').click();
    await expect(foot.locator('.cacct')).toHaveCount(0);
  });

  test('TC-MUX-22·28·29: 데스크톱 바닥은 펼친 채 시작하고, 색 띠는 단색·사용 중은 테두리 없음·등록 계정 statusLine 줄 없음', async ({ page }) => {
    await mockAccounts(page);
    await waitForInit(page);
    await page.evaluate(() => (window as any).app.actPanelOpen());
    const foot = page.locator('#agents-foot');
    await expect(foot.locator('.cacct')).toHaveCount(3, { timeout: 10000 });
    // UX_AUDIT_FIX_SRS FR-UXF-73·74 로 개정: 이전 — 데스크톱 바닥에는 요약 줄이 없었다 / 지금 — 요약 줄이 있고 저장값이
    // 없으면 펼친 채 시작한다 / 이유 — 진단 D17·X8, 사용자 결정 D-25.
    await expect(foot.locator('.act-usage-sum')).toHaveAttribute('aria-expanded', 'true');
    // FR-MUX-81: 등록 계정의 statusLine 줄(`.cacct-sl`)이 없다. 계정을 모르는 보고 줄은 서버를 함께 쓰는 다른 시험이
    // 보고할 수 있어 세지 않는다 (그 줄은 FR-MUX-81 이 남기는 줄이다).
    await expect(foot.locator('.act-usage-sl.cacct-sl')).toHaveCount(0);
    const st = await page.evaluate(() => {
      const bar = getComputedStyle(document.querySelector('#agents-foot .cacct-bar')!);
      const act = getComputedStyle(document.querySelector('#agents-foot .cacct-active')!);
      return { mask: bar.maskImage || (bar as any).webkitMaskImage, border: act.borderTopWidth };
    });
    // 이전: `#000 4px, rgba(0,0,0,.28) 4px, transparent` (번짐 띠). 지금: 3px 에서 끊기는 단색.
    expect(st.mask).not.toContain('0.28');
    expect(st.mask).toContain('3px');
    expect(st.border).toBe('0px');
  });
});

test.describe('2차 — 상단바 Activity 단추 (FR-MUX-74~76)', () => {
  test('TC-MUX-23: ☰ 바로 앞의 단추가 Activity 를 열고, 서랍의 단추는 없다', async ({ page }) => {
    await mobile(page);
    const btn = page.locator('#m-act-btn');
    await expect(btn).toBeVisible();
    expect(await page.evaluate(() => document.getElementById('m-act-btn')!.nextElementSibling!.id)).toBe('m-drawer-toggle');
    await expect(page.locator('#m-drawer-acts')).toHaveCount(0);
    await openDrawer(page);
    await btn.evaluate((el: HTMLElement) => el.click());
    await expect(page.locator('#agents-panel')).toHaveClass(/open/);
    await expect(page.locator('body')).not.toHaveClass(/drawer-open/);
  });

  test('TC-MUX-24: 작업 중인 에이전트가 있으면 상태 점과 수를 보인다', async ({ page }) => {
    await mobile(page);
    const id = await page.evaluate(() => (window as any).app.testing.focusedTerminal().id);
    const n = page.locator('#m-act-btn .m-act-n');
    await expect(n).toBeHidden();
    await page.evaluate((t: string) => (window as any).app.testing.onToolActivity({ toolId: t, state: 'working' }), id);
    await expect(n).toHaveText('1');
    await expect(page.locator('#m-act-btn .m-act-dot')).toBeVisible();
    await expect(page.locator('#m-act-btn')).toHaveAttribute('aria-label', /1/);
    await page.evaluate((t: string) => (window as any).app.testing.onToolActivity({ toolId: t, state: 'done' }), id);
    await expect(n).toBeHidden();
  });

  test('TC-MUX-25: 데스크톱으로 연 앱에는 단추가 없다', async ({ page }) => {
    await waitForInit(page);
    await expect(page.locator('#m-act-btn')).toHaveCount(0);
  });
});

test.describe('2차 — Repo 세그먼트 (FR-MUX-77~79)', () => {
  test('TC-MUX-26: 세그먼트로 Changes·Explorer·Editor 를 한 번에 오간다', async ({ page }) => {
    await mobile(page);
    const repo = await openRepoExplorer(page, 'mux-26');
    const seg = page.locator('#topbar .m-repo-seg');
    await expect(seg).toBeVisible();
    await expect(page.locator('#topbar .m-pane-nav')).toBeHidden();
    await expect(page.locator('#area .ed-side .ed-side-tab:visible')).toHaveCount(0);
    const cell = (k: string) => seg.locator(`[data-seg="${k}"]`);
    await expect(cell('explorer')).toHaveAttribute('aria-pressed', 'true');
    await expect(cell('editor')).toBeDisabled();

    await cell('changes').click();
    await expect(cell('changes')).toHaveAttribute('aria-pressed', 'true');
    expect(await page.evaluate(() => { const a = (window as any).app; return a.testing.edSideOf(a.testing.aw()) })).toBe('changes');

    await page.evaluate((p: string) => (window as any).app.testing.edOpenFile(p, { pin: true }), repo + '/tracked.txt');
    await expect(page.locator('#area .cm-editor').first()).toBeVisible({ timeout: 15000 });
    await expect(cell('editor')).toHaveAttribute('aria-pressed', 'true');
    await expect(cell('editor')).toContainText('1');

    await cell('explorer').click();
    await expect(page.locator('#area .ed-side .ed-explorer')).toBeVisible();
    await expect(page.locator('#area .cm-editor').first()).toBeHidden();
    await cell('editor').click();
    await expect(page.locator('#area .cm-editor').first()).toBeVisible();
    await cell('changes').click();
    await expect(cell('changes')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#area .cm-editor').first()).toBeHidden();
  });

  test('TC-MUX-27: 일반 터미널 창에는 세그먼트가 보이지 않는다', async ({ page }) => {
    await mobile(page);
    await expect(page.locator('#topbar .m-repo-seg')).toBeHidden();
  });
});
