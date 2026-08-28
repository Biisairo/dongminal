import { execFileSync } from 'child_process';
import { realpathSync } from 'fs';
import { join } from 'path';

import { Page } from '@playwright/test';

import { test, expect } from './fixtures';

// GIT_SIDEBAR_TABS_SRS §4.2 — 검증 V-SBT-*.
//
// 사이드바를 세로 분할에서 **탭 전환**으로 바꾼다. 탭은 서술자 배열이고(§3.6),
// 탭 선택이 콘텐츠 창까지 전환하며(§3.7), 직행 키와 순회 키 재해석이 붙는다(§3.8).
//
// 기존 Git 스펙의 가시성 전제 수정은 `fixtures.ts` 의 `openGitTab` 이 맡는다 (§4.1).
// 여기는 **탭 자체의 계약**만 본다.

const FIXTURES = '/tmp/dm-git-fx-sbt-' + process.pid;

test.beforeAll(() => {
  execFileSync('bash', ['e2e/git_fixture.sh', FIXTURES], { stdio: 'ignore' });
});
test.afterAll(() => {
  execFileSync('bash', ['e2e/git_fixture.sh', '--clean', FIXTURES], { stdio: 'ignore' });
});

const fx = (name: string) => realpathSync(join(FIXTURES, name));

async function waitForInit(page: Page) {
  await page.context().addInitScript(() => {
    sessionStorage.setItem('displayMode', 'desktop');
    // 활성 탭은 localStorage 에 산다 (FR-SBT-6). 앞선 테스트의 값이 남으면
    // "최초 접속" 을 단정하는 항목이 오염된다.
    //
    // **첫 로드에서만 지운다.** initScript 는 reload 에서도 실행되므로 그냥
    // 지우면 "탭을 고르고 새로고침하면 돌아온다"(T2)를 재는 순간 테스트가
    // 자기 검증 대상을 지운다. sessionStorage 는 reload 를 넘어 살고 새
    // 컨텍스트에서는 비어 있으므로, 테스트 간 격리는 그대로다.
    if (!sessionStorage.getItem('sbTabCleared')) {
      localStorage.removeItem('sidebarTab');
      sessionStorage.setItem('sbTabCleared', '1');
    }
  });
  await page.goto('/');
  await page.waitForSelector('#area .pn.focused .xterm-helper-textarea', { timeout: 15000 });
}

const tab = (page: Page, id: string) => page.locator(`.sb-tab[data-panel="${id}"]`);
const activeTab = (page: Page) => page.evaluate(() => (window as any).app._sbTab);
const activeWinType = (page: Page) =>
  page.evaluate(() => {
    const a = (window as any).app;
    return (a.ws.windows.find((w: any) => w.id === a.ws.activeWindow) || {}).type || 'terminal';
  });
const gitWinCount = (page: Page) =>
  page.evaluate(() => (window as any).app.ws.windows.filter((w: any) => w.type === 'git').length);

async function pin(page: Page, repo: string) {
  await page.evaluate(async (p) => { await (window as any).app._gitPin(p) }, repo);
}

test.describe('묶음 T — 탭 바와 영속 (FR-SBT-1~8)', () => {
  test('T1 (V-SBT-1): 최초 접속은 Windows 활성이고 Git 패널은 숨는다', async ({ page }) => {
    await waitForInit(page);
    await expect(tab(page, 'windows')).toHaveClass(/active/);
    await expect(tab(page, 'git')).not.toHaveClass(/active/);
    await expect(page.locator('#sb-panel-windows')).toBeVisible();
    await expect(page.locator('#sb-panel-git')).toBeHidden();
    // FR-SBT-4: ⚙ 은 탭 밖이다 — 어느 탭에서나 보인다.
    await expect(page.locator('#settings-btn')).toBeVisible();
    await tab(page, 'git').click();
    await expect(page.locator('#settings-btn')).toBeVisible();
  });

  test('T2 (V-SBT-4): Git 탭 활성 상태로 새로고침하면 그 탭으로 돌아온다', async ({ page }) => {
    await waitForInit(page);
    await tab(page, 'git').click();
    expect(await activeTab(page)).toBe('git');

    await page.reload();
    await page.waitForSelector('#area .pn.focused .xterm-helper-textarea', { timeout: 15000 });
    // V-SBT-25: Git 창이 없으므로 탭만 복원되고 콘텐츠는 그대로다 (FR-SBT-25).
    expect(await activeTab(page)).toBe('git');
    expect(await gitWinCount(page)).toBe(0);
    expect(await activeWinType(page)).toBe('terminal');
  });

  test('T3 (V-SBT-16): 사이드바 100px 에서도 두 탭이 겹치지 않는다', async ({ page }) => {
    await waitForInit(page);
    await page.evaluate(() =>
      document.documentElement.style.setProperty('--sb-w', '100px'));
    const w = (await tab(page, 'windows').boundingBox())!;
    const g = (await tab(page, 'git').boundingBox())!;
    expect(w.width, '탭이 너비를 나눠 갖지 않는다').toBeGreaterThan(30);
    expect(Math.abs(w.width - g.width), '두 탭이 균등 분할되지 않는다').toBeLessThan(2);
    expect(g.x, '두 탭이 겹친다').toBeGreaterThanOrEqual(w.x + w.width - 1);
  });

  test('T4 (V-SBT-7): 패널을 떠났다 돌아와도 스크롤 위치가 남는다', async ({ page }) => {
    await waitForInit(page);
    // 목록이 넘치도록 창을 늘리고 뷰포트를 줄인다.
    await page.setViewportSize({ width: 1280, height: 400 });
    for (let i = 0; i < 14; i++) await page.evaluate(() => (window as any).app.addWindow());
    await expect(page.locator('#windows .si')).toHaveCount(15);

    const top = await page.evaluate(() => {
      const el = document.getElementById('windows')!;
      el.scrollTop = 80;
      return el.scrollTop;
    });
    expect(top, '목록이 스크롤되지 않는다 — 전제가 성립하지 않았다').toBeGreaterThan(0);

    await tab(page, 'git').click();
    await tab(page, 'windows').click();
    expect(await page.evaluate(() => document.getElementById('windows')!.scrollTop)).toBe(top);
  });
});

test.describe('묶음 T — 탭과 콘텐츠 창 (FR-SBT-14·22~25)', () => {
  test('T5 (V-SBT-8·21): 리포를 열면 탭이 따라오고, Windows 탭이 직전 창으로 돌린다', async ({ page }) => {
    await waitForInit(page);
    await page.evaluate(async () => { await (window as any).app.addWindow() });
    const from = await page.evaluate(() => (window as any).app.ws.activeWindow);

    // V-SBT-8 (FR-SBT-14): Git 창으로 들어가면 사이드바가 따라간다.
    await page.evaluate((r) => (window as any).app.openGitWindow(r), fx('basic'));
    await expect(page.locator('#area .pn-tab[data-git-view]')).toHaveCount(7);
    await expect(tab(page, 'git')).toHaveClass(/active/);
    expect(await activeTab(page)).toBe('git');

    // V-SBT-9 (I6 해소): Windows 탭이 **직전 일반 창**으로 콘텐츠까지 되돌린다.
    await tab(page, 'windows').click();
    expect(await page.evaluate(() => (window as any).app.ws.activeWindow)).toBe(from);
    expect(await activeTab(page)).toBe('windows');
    // FR-SBT-35: 떠난 것이지 닫은 것이 아니다.
    expect(await gitWinCount(page)).toBe(1);

    // V-SBT-21: 다시 Git 탭이면 Git 창으로 돌아간다.
    await tab(page, 'git').click();
    expect(await activeWinType(page)).toBe('git');
    expect(await gitWinCount(page)).toBe(1);
  });

  test('T6 (V-SBT-22): 직전 일반 창이 닫혔으면 첫 일반 창으로 간다', async ({ page }) => {
    await waitForInit(page);
    const from = await page.evaluate(async () => {
      const a = (window as any).app;
      await a.addWindow();
      return a.ws.activeWindow;
    });
    await page.evaluate((r) => (window as any).app.openGitWindow(r), fx('basic'));
    await expect(page.locator('#area .pn-tab[data-git-view]')).toHaveCount(7);
    expect(await page.evaluate(() => (window as any).app._lastPlainWindow)).toBe(from);

    // 직전 창을 워크스페이스에서 들어낸다 — 복귀 대상이 사라진 상태다.
    await page.evaluate((id) => {
      const a = (window as any).app;
      a.ws.windows = a.ws.windows.filter((w: any) => w.id !== id);
    }, from);

    await tab(page, 'windows').click();
    const [first, active] = await page.evaluate(() => {
      const a = (window as any).app;
      return [a._plainWindows()[0].id, a.ws.activeWindow];
    });
    expect(active, '첫 일반 창으로 가지 않았다').toBe(first);
  });

  test('T7 (V-SBT-24): Git 창이 없으면 Git 탭이 창을 만들지 않는다', async ({ page }) => {
    await waitForInit(page);
    const before = await page.evaluate(() => (window as any).app.ws.activeWindow);
    await tab(page, 'git').click();
    expect(await gitWinCount(page), 'Git 탭이 창을 만들었다').toBe(0);
    expect(await page.evaluate(() => (window as any).app.ws.activeWindow)).toBe(before);
    expect(await activeTab(page)).toBe('git');
  });

  test('T8 (V-SBT-10): 탭 ↔ 창 동기화가 한 번에 멈춘다', async ({ page }) => {
    await waitForInit(page);
    await page.evaluate((r) => (window as any).app.openGitWindow(r), fx('basic'));
    await expect(page.locator('#area .pn-tab[data-git-view]')).toHaveCount(7);

    // 왕복을 여러 번 돌려도 상태가 어긋나거나 멈추지 않는다.
    for (let i = 0; i < 3; i++) {
      await tab(page, 'windows').click();
      expect(await activeTab(page)).toBe('windows');
      expect(await activeWinType(page)).toBe('terminal');
      await tab(page, 'git').click();
      expect(await activeTab(page)).toBe('git');
      expect(await activeWinType(page)).toBe('git');
    }
    expect(await page.evaluate(() => (window as any).app._sbBusy)).toBe(false);
  });
});

test.describe('묶음 T — 배지 (FR-SBT-12·13)', () => {
  test('T9 (V-SBT-11·13): 변경 있는 핀 수가 비활성 Git 탭의 배지가 된다', async ({ page, request }) => {
    await waitForInit(page);
    const repo = fx('basic');
    await pin(page, repo);
    // 배지는 서버의 마지막 관측값이다 (FR-GIT-24) — 관측을 한 번 일으킨다.
    const st = await request.get('/api/git/status?repo=' + encodeURIComponent(repo));
    expect(st.ok(), `status 실패: ${await st.text()}`).toBeTruthy();
    await page.evaluate(() => (window as any).app._gitReposRefresh());

    const badge = tab(page, 'git').locator('.sb-tab-badge');
    await expect(badge).toHaveText('1', { timeout: 15000 });

    // V-SBT-13: 활성 탭에는 배지를 띄우지 않는다 — 목록에 이미 있다.
    await tab(page, 'git').click();
    await expect(badge).toBeHidden();
  });

  test('T10 (V-SBT-12): 알람 있는 창 수가 비활성 Windows 탭의 배지가 된다', async ({ page }) => {
    await waitForInit(page);
    await tab(page, 'git').click();
    const badge = tab(page, 'windows').locator('.sb-tab-badge');
    await expect(badge).toBeHidden();

    // 알람은 도구에 붙고 창 배지는 그것에서 파생한다 (FR-PAN-16).
    await page.evaluate(() => {
      const a = (window as any).app;
      const id = [...a.tools.keys()][0];
      a._attn.set(id, { reason: 'test' });
      a._attnRefresh();
    });
    await expect(badge).toHaveText('1', { timeout: 10000 });
  });
});

test.describe('묶음 T — 단축키 (FR-SBT-26~33)', () => {
  test('T11 (V-SBT-26·27·28): 직행 키는 탭으로 가고 토글하지 않는다', async ({ page }) => {
    await waitForInit(page);
    await page.evaluate((r) => (window as any).app.openGitWindow(r), fx('basic'));
    await expect(page.locator('#area .pn-tab[data-git-view]')).toHaveCount(7);
    // 단축키 핸들러는 INPUT/TEXTAREA 에 포커스가 있으면 먼저 빠진다.
    await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());

    // V-SBT-28: Ctrl+Shift+1 → Windows 탭 + 직전 일반 창.
    await page.keyboard.press('Control+Shift+Digit1');
    await expect.poll(() => activeTab(page)).toBe('windows');
    expect(await activeWinType(page)).toBe('terminal');

    // V-SBT-26: Ctrl+Shift+2 → Git 탭 + Git 창.
    await page.keyboard.press('Control+Shift+Digit2');
    await expect.poll(() => activeTab(page)).toBe('git');
    expect(await activeWinType(page)).toBe('git');

    // V-SBT-27: 같은 키를 다시 눌러도 **아무 일도 없다** (토글이 아니다).
    await page.keyboard.press('Control+Shift+Digit2');
    await page.waitForTimeout(300);
    expect(await activeTab(page)).toBe('git');
    expect(await activeWinType(page)).toBe('git');
  });

  test('T12 (V-SBT-29): 등록된 탭 수를 넘는 번호 키는 아무 일도 하지 않는다', async ({ page }) => {
    await waitForInit(page);
    const before = await activeTab(page);
    await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
    await page.keyboard.press('Control+Shift+Digit5');
    await page.waitForTimeout(300);
    expect(await activeTab(page)).toBe(before);
  });

  test('T13 (V-SBT-31): Windows 탭의 순회 키는 창을 돈다 — 현행 동작', async ({ page }) => {
    await waitForInit(page);
    const ids = await page.evaluate(async () => {
      const a = (window as any).app;
      await a.addWindow();
      return a._plainWindows().map((w: any) => w.id);
    });
    expect(ids.length).toBeGreaterThanOrEqual(2);
    await page.evaluate((id) => (window as any).app.switchWindow(id), ids[0]);

    await page.evaluate(() => (window as any).app.executeAction('windowNext'));
    await expect.poll(() => page.evaluate(() => (window as any).app.ws.activeWindow)).toBe(ids[1]);
    // 끝에서 감싼다.
    await page.evaluate(() => (window as any).app.executeAction('windowNext'));
    await expect.poll(() => page.evaluate(() => (window as any).app.ws.activeWindow)).toBe(ids[0]);
  });

  test('T14 (V-SBT-32·33·34): Git 탭의 순회 키는 리포를 돈다', async ({ page }) => {
    await waitForInit(page);
    const a = fx('basic'), b = fx('with-remote');

    // V-SBT-33: 리포가 1개면 아무 일도 하지 않는다.
    await pin(page, a);
    await page.evaluate((r) => (window as any).app.openGitWindow(r), a);
    await expect(page.locator('#area .pn-tab[data-git-view]')).toHaveCount(7);
    expect(await activeTab(page)).toBe('git');
    await page.evaluate(() => (window as any).app.executeAction('windowNext'));
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => (window as any).app.gitPanel.repo)).toBe(a);

    // 둘이 되면 순회한다 — 활성 리포가 바뀌고 Git 창이 그것을 연다.
    await pin(page, b);
    await expect.poll(() =>
      page.evaluate(() => document.querySelectorAll('#git-repos .git-repo').length),
      { timeout: 20000 }).toBe(2);

    await page.evaluate(() => (window as any).app.executeAction('windowNext'));
    await expect.poll(() => page.evaluate(() => (window as any).app.gitPanel.repo),
      { timeout: 10000 }).toBe(b);
    expect(await activeWinType(page)).toBe('git');

    // V-SBT-34: 끝에서 감싼다.
    await page.evaluate(() => (window as any).app.executeAction('windowNext'));
    await expect.poll(() => page.evaluate(() => (window as any).app.gitPanel.repo),
      { timeout: 10000 }).toBe(a);
  });

  test('T15 (V-SBT-35·36): 설정에 직행 키가 보이고 재바인딩이 영속된다', async ({ page }) => {
    await waitForInit(page);
    await page.click('#settings-btn');
    await page.click('.mtab[data-tab="shortcuts"]');

    // 라벨의 탭 이름 부분이 서술자에서 나온다 (FR-SBT-30).
    const rows = page.locator('#sc-list .sc-row');
    await expect(rows.filter({ hasText: '사이드바 탭: Windows' })).toHaveCount(1);
    await expect(rows.filter({ hasText: '사이드바 탭: Git' })).toHaveCount(1);
    // 순회 키 라벨이 모드 의존을 설명한다 (FR-SBT-33).
    await expect(rows.filter({ hasText: '다음 항목 (활성 탭 기준)' })).toHaveCount(1);

    // 재바인딩 → 서버 설정에 실려 새로고침 뒤에도 남는다 (V-SBT-36).
    await page.click('.sc-key[data-action="sidebarTab2"]');
    await page.keyboard.press('Control+Shift+Digit8');
    await expect.poll(() => page.evaluate(() => (window as any).shortcuts.sidebarTab2),
      { timeout: 10000 }).toBe('Ctrl+Shift+Digit8');

    await page.reload();
    await page.waitForSelector('#area .pn.focused .xterm-helper-textarea', { timeout: 15000 });
    await expect.poll(() => page.evaluate(() => (window as any).shortcuts.sidebarTab2),
      { timeout: 10000 }).toBe('Ctrl+Shift+Digit8');

    // 설정은 **서버에 산다** — fixtures 의 워크스페이스 초기화가 되돌려 주지
    // 않으므로 여기서 기본값으로 되돌린다. 남기면 뒤따르는 스펙이 오염된다.
    await page.evaluate(async () => {
      const w = window as any;
      w.shortcuts.sidebarTab2 = SHORTCUT_DEFAULTS.sidebarTab2;
      await w.app._saveSettings();
    });
  });
});

test.describe('묶음 T — 인터페이스화 (FR-SBT-18~21)', () => {
  // V-SBT-19: 셋째 탭의 비용이 **서술자 1개**인지를 본다. 여기서는 배열에 하나를
  // 밀어 넣고 패널 래퍼만 만든다 — `index.html` 의 탭 바도, 순회 디스패치도,
  // `executeAction` 의 맵도 손대지 않는다.
  test('T16 (V-SBT-19·20): 서술자를 하나 더하면 탭이 늘고, cycle 이 없으면 순회가 멈춘다', async ({ page }) => {
    await waitForInit(page);
    const ids = await page.evaluate(async () => {
      const a = (window as any).app;
      await a.addWindow();
      return a._plainWindows().map((w: any) => w.id);
    });
    expect(ids.length).toBeGreaterThanOrEqual(2);

    await page.evaluate(() => {
      const p = document.createElement('div');
      p.className = 'sb-panel'; p.id = 'sb-panel-demo'; p.hidden = true;
      document.getElementById('sidebar')!.appendChild(p);
      // 서술자 1개 — cycle 은 일부러 주지 않는다 (FR-SBT-20).
      (SB_TAB_DEFS as any[]).push({ id: 'demo', label: 'Demo', panelId: 'sb-panel-demo' });
      // 탭 바는 다시 만들지 않는다 — 새 서술자를 그리도록 비우고 한 번 그린다.
      document.getElementById('sb-tabs')!.innerHTML = '';
      (window as any).app.render();
    });

    await expect(page.locator('.sb-tab')).toHaveCount(3);
    // 직행 키 3번의 대상이 배열 순서에서 자동으로 나온다 (FR-SBT-26).
    await page.evaluate(() => (window as any).app.executeAction('sidebarTab3'));
    expect(await activeTab(page)).toBe('demo');
    await expect(page.locator('#sb-panel-demo')).toBeVisible();

    // FR-SBT-20: cycle 이 없는 탭에서는 순회 키가 **아무 일도 하지 않는다** —
    // 보이지 않는 창 목록을 대신 돌지 않는다.
    const active = await page.evaluate(() => (window as any).app.ws.activeWindow);
    await page.evaluate(() => (window as any).app.executeAction('windowNext'));
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => (window as any).app.ws.activeWindow)).toBe(active);
  });
});

// 두 값 모두 classic script 의 최상위 `const` 다 — window 의 속성이 아니라 전역
// 렉시컬 바인딩이므로 `page.evaluate` 안에서 이름으로 직접 읽는다.
declare const SB_TAB_DEFS: unknown[];
declare const SHORTCUT_DEFAULTS: Record<string, string>;
