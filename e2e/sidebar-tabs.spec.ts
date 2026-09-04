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
/**
 * **개정 (REPO_TAB_UNIFY_SRS FR-RTU-70 / D-RTU-1).** 옛 `WINDOW_TYPE_GIT` 창은
 * 로드에 사라진다. `Repo` 탭이 여는 창은 타입이 `editor` 이고 **저장소마다 하나**
 * 이므로, "탭이 창을 만들었는가" 는 그 루트의 창이 있는가로 잰다.
 */
const repoWinFor = (page: Page, root: string) =>
  page.evaluate((r) => !!(window as any).app._edWindowFor(r), root);

async function pin(page: Page, repo: string) {
  await page.evaluate(async (p) => { await (window as any).app._gitPin(p) }, repo);
}

test.describe('묶음 T — 탭 바와 영속 (FR-SBT-1~8)', () => {
  test('T1 (V-SBT-1): 최초 접속은 Windows 활성이고 Git 패널은 숨는다', async ({ page }) => {
    await waitForInit(page);
    await expect(tab(page, 'windows')).toHaveClass(/active/);
    await expect(tab(page, 'repo')).not.toHaveClass(/active/);
    await expect(page.locator('#sb-panel-windows')).toBeVisible();
    await expect(page.locator('#sb-panel-repo')).toBeHidden();
    // FR-SBT-4: ⚙ 은 탭 밖이다 — 어느 탭에서나 보인다.
    await expect(page.locator('#settings-btn')).toBeVisible();
    await tab(page, 'repo').click();
    await expect(page.locator('#settings-btn')).toBeVisible();
  });

  /**
   * **개정 (REPO_TAB_UNIFY_SRS FR-RTU-1 / FR-EDT-7 / D-RTU-18).**
   *
   * 옛 V-SBT-25 는 "Git 창이 없으므로 탭만 복원되고 콘텐츠는 그대로" 였다. `Repo`
   * 탭의 목록에는 항상 `~`(홈)이 있으므로(FR-EDT-13) 탭을 고르는 것이 곧 그 창으로
   * 가는 일이고(FR-EDT-7), 새로고침은 **탭과 창 둘 다** 되살려야 한다.
   *
   * 그 창의 id 는 재조정이 다시 만들 수 있으므로 신원은 루트다 (D-RTU-18) —
   * 그것을 적어 두지 않아 새로고침 뒤 `Windows` 로 돌아갔다 (실측).
   */
  test('T2 (V-SBT-4): Repo 탭 활성 상태로 새로고침하면 그 탭과 그 창으로 돌아온다', async ({ page }) => {
    await waitForInit(page);
    await tab(page, 'repo').click();
    expect(await activeTab(page)).toBe('repo');
    const root = await page.evaluate(() => {
      const a = (window as any).app;
      return a._isEditorWin(a._aw()) ? a._edRootOf(a._aw()) : null;
    });
    expect(root, 'Repo 탭이 창으로 데려가지 않았다').toBeTruthy();

    await page.reload();
    await page.waitForSelector('#area .ed-win .ed-side', { timeout: 15000 });
    expect(await activeTab(page)).toBe('repo');
    expect(await activeWinType(page)).toBe('editor');
    // **같은 루트의 창이다** — id 가 바뀌어도 사용자에게는 같은 창이다.
    expect(await page.evaluate(() => {
      const a = (window as any).app;
      return a._edRootOf(a._aw());
    })).toBe(root);
  });

  test('T3 (V-SBT-16): 사이드바 100px 에서도 두 탭이 겹치지 않는다', async ({ page }) => {
    await waitForInit(page);
    await page.evaluate(() =>
      document.documentElement.style.setProperty('--sb-w', '100px'));
    const w = (await tab(page, 'windows').boundingBox())!;
    const g = (await tab(page, 'repo').boundingBox())!;
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

    await tab(page, 'repo').click();
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
    // FR-RTU-21: 뷰 탭은 Changes 사이드의 아이콘 줄이 연다 — 창을 여는 것만으로는
    // 서지 않는다. 창이 섰는지는 사이드로 확인한다.
    await page.waitForSelector('#area .ed-win .ed-side', { timeout: 15000 });
    await expect(tab(page, 'repo')).toHaveClass(/active/);
    expect(await activeTab(page)).toBe('repo');

    // V-SBT-9 (I6 해소): Windows 탭이 **직전 일반 창**으로 콘텐츠까지 되돌린다.
    await tab(page, 'windows').click();
    expect(await page.evaluate(() => (window as any).app.ws.activeWindow)).toBe(from);
    expect(await activeTab(page)).toBe('windows');
    // FR-SBT-35: 떠난 것이지 닫은 것이 아니다.
    expect(await repoWinFor(page, fx('basic'))).toBe(true);

    // V-SBT-21: 다시 Git 탭이면 Git 창으로 돌아간다.
    await tab(page, 'repo').click();
    expect(await activeWinType(page)).toBe('editor');
    expect(await repoWinFor(page, fx('basic'))).toBe(true);
  });

  test('T6 (V-SBT-22): 직전 일반 창이 닫혔으면 첫 일반 창으로 간다', async ({ page }) => {
    await waitForInit(page);
    const from = await page.evaluate(async () => {
      const a = (window as any).app;
      await a.addWindow();
      return a.ws.activeWindow;
    });
    await page.evaluate((r) => (window as any).app.openGitWindow(r), fx('basic'));
    // FR-RTU-21: 뷰 탭은 Changes 사이드의 아이콘 줄이 연다 — 창을 여는 것만으로는
    // 서지 않는다. 창이 섰는지는 사이드로 확인한다.
    await page.waitForSelector('#area .ed-win .ed-side', { timeout: 15000 });
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

  /**
   * **개정 (FR-RTU-70·72).** 옛 규칙은 "Git 창이 없으면 Git 탭이 창을 만들지
   * 않는다" 였다 — 그 창이 워크스페이스에 하나뿐이고 사용자가 리포를 고르기
   * 전에는 없었기 때문이다. 지금 `Repo` 탭의 대상은 **목록의 행**이고, 목록에는
   * 항상 `~`(홈)이 있으므로(FR-EDT-13) 갈 창이 늘 있다.
   *
   * 남는 계약은 "탭을 누른 것만으로 **새 창이 생기지 않는다**" 다 — 창 수가 그대로다.
   */
  test('T7 (V-SBT-24): Repo 탭을 눌러도 새 창이 생기지 않는다', async ({ page }) => {
    await waitForInit(page);
    const before = await page.evaluate(() => (window as any).app.ws.windows.length);
    await tab(page, 'repo').click();
    expect(await page.evaluate(() => (window as any).app.ws.windows.length),
      'Repo 탭이 창을 만들었다').toBe(before);
    expect(await activeTab(page)).toBe('repo');
  });

  test('T8 (V-SBT-10): 탭 ↔ 창 동기화가 한 번에 멈춘다', async ({ page }) => {
    await waitForInit(page);
    await page.evaluate((r) => (window as any).app.openGitWindow(r), fx('basic'));
    // FR-RTU-21: 뷰 탭은 Changes 사이드의 아이콘 줄이 연다 — 창을 여는 것만으로는
    // 서지 않는다. 창이 섰는지는 사이드로 확인한다.
    await page.waitForSelector('#area .ed-win .ed-side', { timeout: 15000 });

    // 왕복을 여러 번 돌려도 상태가 어긋나거나 멈추지 않는다.
    for (let i = 0; i < 3; i++) {
      await tab(page, 'windows').click();
      expect(await activeTab(page)).toBe('windows');
      expect(await activeWinType(page)).toBe('terminal');
      await tab(page, 'repo').click();
      expect(await activeTab(page)).toBe('repo');
      expect(await activeWinType(page)).toBe('editor');
    }
    expect(await page.evaluate(() => (window as any).app._sbBusy)).toBe(false);
  });
});

test.describe('묶음 T — 배지 (FR-SBT-13 · FR-GOB-13·14)', () => {
  // ATTENTION_LIFECYCLE_GIT_OBSERVE_SRS V-GOB-5 (FR-GOB-13): 옛 FR-SBT-12 의
  // Git 탭 헤더 배지는 **없어졌다.** 그 숫자를 채우던 관측이 활성 리포 하나에만
  // 있었으므로, 다른 탭에서 보이는 값은 근거가 없었다 (D-2).
  test('T9 (V-GOB-5): Git 탭에는 헤더 배지가 없다', async ({ page, request }) => {
    await waitForInit(page);
    const repo = fx('basic');
    await pin(page, repo);
    const st = await request.get('/api/git/status?repo=' + encodeURIComponent(repo));
    expect(st.ok(), `status 실패: ${await st.text()}`).toBeTruthy();
    await page.evaluate(() => (window as any).app._gitReposRefresh());

    // 목록의 **행** 배지는 그대로다 (FR-GOB-14). 행 배지는 변경 **파일 수**이므로
    // 픽스처의 값을 못박지 않고 보이는 것만 본다 — 옛 헤더 배지(변경 있는 리포
    // 수)와 세는 것이 다르다.
    await tab(page, 'repo').click();
    await expect(page.locator('#repo-entries [data-git-repo="' + repo + '"] .git-badge'))
      .toHaveText(/^[1-9][0-9]*$/, { timeout: 15000 });

    // 헤더 배지는 활성이든 아니든 뜨지 않는다.
    const badge = tab(page, 'repo').locator('.sb-tab-badge');
    await expect(badge).toBeHidden();
    await tab(page, 'windows').click();
    await expect(badge).toBeHidden();
  });

  // V-GOB-4 (FR-GOB-7·8·9): 관측은 Git 탭을 보고 있는 동안으로 묶인다.
  test('T9b (V-GOB-4): observe=1 은 Git 탭이 활성일 때만 붙는다', async ({ page }) => {
    await waitForInit(page);
    await pin(page, fx('basic'));

    const urls: string[] = [];
    page.on('request', r => { if (r.url().includes('/api/git/repos')) urls.push(r.url()) });

    await tab(page, 'windows').click();
    urls.length = 0;
    await page.evaluate(() => (window as any).app._gitReposRefresh());
    await expect.poll(() => urls.length).toBeGreaterThan(0);
    expect(urls.every(u => !u.includes('observe=1')), `windows 탭에서 관측했다: ${urls}`).toBeTruthy();

    // FR-GOB-9: 들어가는 순간 관측이 한 번 돈다 — 다음 폴링을 기다리지 않는다.
    urls.length = 0;
    await tab(page, 'repo').click();
    await expect.poll(() => urls.filter(u => u.includes('observe=1')).length,
      { timeout: 10000 }).toBeGreaterThan(0);
  });

  test('T10 (V-SBT-12): 알람 있는 창 수가 비활성 Windows 탭의 배지가 된다', async ({ page }) => {
    await waitForInit(page);
    await tab(page, 'repo').click();
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
    // FR-RTU-21: 뷰 탭은 Changes 사이드의 아이콘 줄이 연다 — 창을 여는 것만으로는
    // 서지 않는다. 창이 섰는지는 사이드로 확인한다.
    await page.waitForSelector('#area .ed-win .ed-side', { timeout: 15000 });
    // 단축키 핸들러는 INPUT/TEXTAREA 에 포커스가 있으면 먼저 빠진다.
    await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());

    // V-SBT-28: Ctrl+Shift+1 → Windows 탭 + 직전 일반 창.
    await page.keyboard.press('Control+Shift+Digit1');
    await expect.poll(() => activeTab(page)).toBe('windows');
    expect(await activeWinType(page)).toBe('terminal');

    // V-SBT-26: Ctrl+Shift+2 → Git 탭 + Git 창.
    await page.keyboard.press('Control+Shift+Digit2');
    await expect.poll(() => activeTab(page)).toBe('repo');
    expect(await activeWinType(page)).toBe('editor');

    // V-SBT-27: 같은 키를 다시 눌러도 **아무 일도 없다** (토글이 아니다).
    await page.keyboard.press('Control+Shift+Digit2');
    await page.waitForTimeout(300);
    expect(await activeTab(page)).toBe('repo');
    expect(await activeWinType(page)).toBe('editor');
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

  /**
   * **개정 (REPO_TAB_UNIFY_SRS FR-RTU-8).** 옛 시험은 "리포가 1개면 아무 일도
   * 하지 않는다" 를 함께 쟀다. `Repo` 목록은 핀만이 아니라 **고정 행**(`~`·메모장)
   * 도 포함하고(FR-EDT-13·14) 순회 대상도 그 둘을 이어 붙인 것이므로, 핀이
   * 하나여도 돌 자리가 있다 — 그 조건 자체가 성립하지 않는다.
   *
   * 남는 계약은 그보다 강하다: 순회가 **목록의 순서 그대로** 돌고 끝에서 감싼다.
   */
  test('T14 (V-SBT-32·34): Repo 탭의 순회 키는 목록 순서로 돌고 끝에서 감싼다', async ({ page }) => {
    await waitForInit(page);
    const a = fx('basic'), b = fx('with-remote');
    await pin(page, a);
    await pin(page, b);
    await page.evaluate((r) => (window as any).app.openGitWindow(r), a);
    await page.waitForSelector('#area .ed-win .ed-side', { timeout: 15000 });
    expect(await activeTab(page)).toBe('repo');

    // 순회의 순서는 `items` 뒤에 `fixed` 를 이어 붙인 것이다 (FR-RTU-8) — 화면의
    // 두 컨테이너가 그 순서를 그대로 그린다.
    const order = await page.evaluate(() => [
      ...document.querySelectorAll('#repo-entries .ed-entry'),
      ...document.querySelectorAll('#repo-root .ed-entry'),
    ].map((e) => (e as HTMLElement).dataset.edRoot!));
    expect(order.length, '순회할 행이 둘 이상이어야 한다').toBeGreaterThan(1);
    expect(order).toContain(a);

    const cur = () => page.evaluate(() => {
      const app = (window as any).app;
      const w = app._aw();
      return app._isEditorWin(w) ? app._edRootOf(w) : null;
    });
    await expect.poll(cur, { timeout: 10000 }).toBe(a);

    // 목록을 한 바퀴 돌면 제자리로 온다 — 끝에서 감싼다 (V-SBT-34).
    let i = order.indexOf(a);
    for (let n = 0; n < order.length; n++) {
      await page.evaluate(() => (window as any).app.executeAction('windowNext'));
      i = (i + 1) % order.length;
      await expect.poll(cur, { timeout: 10000 }).toBe(order[i]);
    }
    await expect.poll(cur, { timeout: 10000 }).toBe(a);
  });

  test('T15 (V-SBT-35·36): 설정에 직행 키가 보이고 재바인딩이 영속된다', async ({ page }) => {
    await waitForInit(page);
    await page.click('#settings-btn');
    await page.click('.mtab[data-tab="shortcuts"]');

    // 라벨의 탭 이름 부분이 서술자에서 나온다 (FR-SBT-30).
    const rows = page.locator('#sc-list .sc-row');
    await expect(rows.filter({ hasText: '사이드바 탭: Windows' })).toHaveCount(1);
    await expect(rows.filter({ hasText: '사이드바 탭: Repo' })).toHaveCount(1);
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

    // EDITOR_TAB_SRS 로 사이드바 탭이 셋(windows·git·editor)이 됐다 — 절대
    // 개수는 그 구성에 종속되므로, 데모 서술자를 더하기 **전** 개수를 기준선으로
    // 잡고 증분만 잰다.
    const before = await page.locator('.sb-tab').count();

    const demoIndex = await page.evaluate(() => {
      const p = document.createElement('div');
      p.className = 'sb-panel'; p.id = 'sb-panel-demo'; p.hidden = true;
      document.getElementById('sidebar')!.appendChild(p);
      // 서술자 1개 — cycle 은 일부러 주지 않는다 (FR-SBT-20).
      (SB_TAB_DEFS as any[]).push({ id: 'demo', label: 'Demo', panelId: 'sb-panel-demo' });
      // 탭 바는 다시 만들지 않는다 — 새 서술자를 그리도록 비우고 한 번 그린다.
      document.getElementById('sb-tabs')!.innerHTML = '';
      (window as any).app.render();
      return (SB_TAB_DEFS as any[]).length;
    });

    await expect(page.locator('.sb-tab')).toHaveCount(before + 1);
    // 직행 키는 데모 탭이 배열에서 서는 자리(1-based)에서 자동으로 나온다
    // (FR-SBT-26) — 고정된 `sidebarTab3` 은 editor 탭이 셋째 자리를 차지한
    // 지금 더 이상 데모 탭을 가리키지 않는다.
    await page.evaluate((n) => (window as any).app.executeAction(`sidebarTab${n}`), demoIndex);
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
