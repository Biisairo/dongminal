import { execFileSync } from 'child_process';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { realpathSync } from 'fs';

import { Page } from '@playwright/test';

import { test, expect, openGitTab, makeCopyFx, waitForInit, GIT_VIEW_TABS } from './fixtures';

// GIT_REVIEW4_SRS §3.2·§3.5 — 바깥 계기의 다시 그리기.
// 검증 V104~V113 (FR-RPT-1~7, FR-GIT-227).
//
// 요소가 새로 만들어졌는지는 **값으로 알 수 없다** — 같은 값을 그리면 화면이
// 똑같다. 그래서 요소에 JS 표식을 심고, 폴링 주기를 넘겨 기다린 뒤 표식이
// 남았는지를 본다. 표식은 DOM 속성이 아니라 객체 프로퍼티라 재생성에서 살아남지
// 않는다.

const FIXTURES = '/tmp/dm-git-fx-repaint-' + process.pid;

test.beforeAll(() => {
  execFileSync('bash', ['e2e/git_fixture.sh', FIXTURES], { stdio: 'ignore' });
});
test.afterAll(() => {
  execFileSync('bash', ['e2e/git_fixture.sh', '--clean', FIXTURES], { stdio: 'ignore' });
});

const fx = (name: string) => realpathSync(join(FIXTURES, name));

const copyFx = makeCopyFx(FIXTURES);
async function openGit(page: Page, repo: string) {
  await page.evaluate((r) => (window as any).app.openGitWindow(r), repo);
  await expect(page.locator('#area .pn-tab[data-git-view]')).toHaveCount(GIT_VIEW_TABS);
  await expect(page.locator('#area .pn-body .git-view.vis')).toHaveClass(/git-changes/);
}

// 선택자에 걸리는 요소 전부에 표식을 심는다. 반환은 심은 개수다.
const markAll = (page: Page, sel: string) =>
  page.evaluate((s: string) => {
    const els = [...document.querySelectorAll(s)];
    for (const e of els) (e as any).__rptMark = 1;
    return els.length;
  }, sel);

// 표식이 남아 있는 요소 수 / 전체 수.
const markCount = (page: Page, sel: string) =>
  page.evaluate((s: string) => {
    const els = [...document.querySelectorAll(s)];
    return { kept: els.filter(e => (e as any).__rptMark === 1).length, total: els.length };
  }, sel);

// 폴링 회차를 확실히 넘긴다. GIT_STATUS_POLL_MS 는 1000 이다.
const POLLS = 2600;

test.describe('FR-RPT — Changes 목록 (V104~V107)', () => {
  test('P1 (V104 / FR-GIT-227): 관측이 같으면 행을 다시 만들지 않는다', async ({ page }) => {
    await waitForInit(page);
    await openGit(page, fx('basic'));
    const sel = '.git-view.git-changes .git-file';
    await expect(page.locator(sel).first()).toBeVisible();
    const n = await markAll(page, sel);
    expect(n).toBeGreaterThan(0);
    await page.waitForTimeout(POLLS);
    // 폴링이 실제로 돌았다는 근거: 상태 요청이 여러 번 갔다는 것은 서버 로그가
    // 갖고 있고, 여기서는 행 수가 그대로인 것과 표식이 남은 것을 본다.
    expect(await markCount(page, sel)).toEqual({ kept: n, total: n });
  });

  test('P2 (V106): hover 중인 행의 버튼 요소가 폴링에 살아남는다', async ({ page }) => {
    await waitForInit(page);
    await openGit(page, fx('basic'));
    const row = page.locator('.git-view.git-changes .git-file').first();
    await expect(row).toBeVisible();
    await row.hover();
    const acts = row.locator('.git-file-acts');
    await expect(acts).toHaveCSS('opacity', '1');
    // `opacity` 단정만으로는 E1 을 잡지 못한다 — 요소가 새로 만들어져도 다음 마우스
    // 이동이나 hover 재평가로 곧 1 로 돌아오고, 눈에 보이는 것은 그 사이의 100ms
    // 페이드인이다(`transition:opacity .1s`). 잡아야 하는 것은 **요소가 버려지는
    // 것** 자체다.
    const n = await markAll(page, '.git-view.git-changes .git-file .git-file-acts');
    expect(n).toBeGreaterThan(0);
    await page.waitForTimeout(POLLS);
    expect(await markCount(page, '.git-view.git-changes .git-file .git-file-acts'))
      .toEqual({ kept: n, total: n });
    await expect(acts).toHaveCSS('opacity', '1');
  });

  test('P3 (V105 / FR-RPT-3): 관측이 바뀌어도 바뀌지 않은 행은 유지된다', async ({ page }) => {
    const repo = copyFx('basic', 'p3');
    await waitForInit(page);
    await openGit(page, repo);
    const sel = '.git-view.git-changes .git-file';
    await expect(page.locator(sel).first()).toBeVisible();
    const before = await markAll(page, sel);
    // 새 파일 하나가 관측을 바꾼다.
    writeFileSync(join(repo, 'rpt-new.txt'), 'x\n');
    await expect(page.locator(sel)).toHaveCount(before + 1, { timeout: 5000 });
    const m = await markCount(page, sel);
    // 새 행 하나만 새 요소다.
    expect(m).toEqual({ kept: before, total: before + 1 });
  });

  test('P4 (V113 / FR-RPT-2): 값이 바뀌면 화면이 따라온다 — 조용히 멈추지 않는다', async ({ page }) => {
    const repo = copyFx('basic', 'p4');
    await waitForInit(page);
    await openGit(page, repo);
    const untracked = page.locator('.git-view.git-changes .git-group[data-group="untracked"]');
    await expect(untracked.locator('.git-file').first()).toBeVisible();
    const count = untracked.locator('.git-group-count');
    const was = (await count.textContent())!;
    writeFileSync(join(repo, 'rpt-visible.txt'), 'y\n');
    await expect(untracked.locator('.git-file[data-path="rpt-visible.txt"]')).toBeVisible({ timeout: 5000 });
    expect(await count.textContent()).not.toBe(was);
  });

  test('P5 (V107 / FR-GIT-52): 폴링이 도는 동안 행 더블클릭이 Diff 탭을 연다', async ({ page }) => {
    await waitForInit(page);
    await openGit(page, fx('basic'));
    const row = page.locator('.git-view.git-changes .git-file').first();
    await expect(row).toBeVisible();
    // 폴링 회차 경계에 걸리도록 한 박자 기다린 뒤 더블클릭한다.
    await page.waitForTimeout(1100);
    await row.dblclick();
    await expect(page.locator('#area .pn-body .git-view.vis')).toHaveClass(/git-diff/);
  });
});

test.describe('FR-RPT — 같은 원인의 다른 자리 (V108~V112)', () => {
  test('P6 (V108 / FR-RPT-7 #2): GIT 섹션 핀 행이 폴링에 살아남는다', async ({ page }) => {
    await waitForInit(page);
    await page.evaluate(async (r) => {
      await fetch('/api/git/repos/pin', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: r }),
      });
      await (window as any).app._gitReposRefresh();
    }, fx('basic'));
    // 요소 보존을 보려면 요소가 화면에 있어야 한다 — GIT 패널은 탭 뒤다 (FR-SBT-2).
    await openGitTab(page);
    const sel = '#git-repos .git-repo';
    await expect(page.locator(sel).first()).toBeVisible();
    const n = await markAll(page, sel);
    expect(n).toBeGreaterThan(0);
    // GIT_REPOS_POLL_MS 는 3000 이다 — 한 회차를 확실히 넘긴다.
    await page.waitForTimeout(4200);
    expect(await markCount(page, sel)).toEqual({ kept: n, total: n });
  });

  test('P7 (V109 / FR-RPT-7 #3): 상태바 지표가 폴링에 살아남는다', async ({ page }) => {
    await waitForInit(page);
    await openGit(page, fx('basic'));
    const sel = '#sb-items .sb-item';
    await expect(page.locator(sel).first()).toBeVisible();
    // 값이 스스로 바뀌지 않는 지표 하나를 대표로 삼는다. git chip 이 그 자리였으나
    // 철회됐고(FR-FLW-12), 연결 상태는 같은 성질이면서 늘 켜져 있다.
    const stable = '#sb-items .sb-item:has(.sb-dot)';
    await expect(page.locator(stable)).toHaveCount(1);
    const n = await markAll(page, sel);
    expect(n).toBeGreaterThan(0);
    await page.waitForTimeout(POLLS);
    // 지표에는 값이 스스로 바뀌는 것(지연·CPU·업타임)이 섞여 있다. 그런 값이 바뀌면
    // 그 항목은 다시 만들어지는 것이 맞다 (FR-RPT-2). 지켜야 하는 것은 **값이
    // 그대로인 항목**이다.
    const m = await markCount(page, sel);
    expect(m.kept).toBeGreaterThan(0);
    expect(await markCount(page, stable)).toEqual({ kept: 1, total: 1 });
  });

  test('P8 (V110 / FR-RPT-7 #4): Console 기록 행과 펼친 상세가 폴링에 살아남는다', async ({ page }) => {
    const repo = copyFx('basic', 'p8');
    await waitForInit(page);
    await openGit(page, repo);
    // 쓰기 하나가 기록을 만든다 — Console 은 쓰기와 실패만 기본으로 보인다.
    await page.locator('.git-view.git-changes .git-group[data-group="untracked"] .git-file')
      .first().locator('.git-file-act[data-act="stage"]').click();
    await page.locator('#area .pn-tab[data-git-view="console"]').click();
    const sel = '#area .pn-body .git-view.git-console .git-con-row';
    await expect(page.locator(sel).first()).toBeVisible();
    // 상세를 펼친다 — 그 안의 stderr 는 복사해 쓰는 자리다 (FR-GIT-225).
    await page.locator(sel).first().click();
    await expect(page.locator('#area .pn-body .git-view.git-console .git-con-detail')).toHaveCount(1);
    const n = await markAll(page, sel);
    const d = await markAll(page, '#area .pn-body .git-view.git-console .git-con-detail');
    expect(n).toBeGreaterThan(0);
    expect(d).toBe(1);
    // GIT_CON_POLL_MS 는 2000 이다.
    await page.waitForTimeout(3200);
    expect(await markCount(page, sel)).toEqual({ kept: n, total: n });
    expect(await markCount(page, '#area .pn-body .git-view.git-console .git-con-detail'))
      .toEqual({ kept: 1, total: 1 });
  });

  test('P9 (V111 / FR-RPT-7 #5): Agents 카드가 폴링에 살아남는다', async ({ page }) => {
    await waitForInit(page);
    const pid = await page.locator('#area .pn.focused .pn-tab.active').getAttribute('data-toolid');
    await page.locator('#agents-toggle').click();
    await expect(page.locator('#agents-panel.open')).toBeVisible();
    await page.evaluate(async (a) => {
      await fetch('/api/tools/activity/set', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(a),
      });
      // `working` 은 서버가 pgrep 으로 정리한다 (FR-AAP-20) — 에이전트 프로세스가
      // 없는 테스트 도구에서는 다음 스냅샷에서 사라진다. 그래서 `waiting` 을 쓴다.
    }, { toolId: pid, state: 'waiting', tool: 'Bash', detail: 'npm test' });
    const sel = '#agents-panel .ag-card';
    await expect(page.locator(sel)).toHaveCount(1, { timeout: 10000 });
    const n = await markAll(page, sel);
    // agentsPollMs 의 기본값을 모르지 않도록 짧게 바꿔 회차를 확실히 지나게 한다.
    await page.evaluate(() => { (window as any).app.agentsPollMs = 1000; (window as any).app._agentsStartPoll() });
    await page.waitForTimeout(2600);
    expect(await markCount(page, sel)).toEqual({ kept: n, total: n });
  });

  test('P10 (V112 / FR-RPT-7 #6): WINDOWS 행이 바깥 계기의 render 에 살아남는다', async ({ page }) => {
    await waitForInit(page);
    await page.locator('#add-window').click();
    const sel = '#windows .si';
    await expect(page.locator(sel)).toHaveCount(2);
    const n = await markAll(page, sel);
    // SSE `workspace_changed` 가 하는 일과 같다 — 사용자가 만들지 않은 render 다.
    await page.evaluate(() => (window as any).app.render());
    await page.evaluate(() => (window as any).app.render());
    expect(await markCount(page, sel)).toEqual({ kept: n, total: n });
  });

  test('P11 (V113 / FR-RPT-2): 창 이름이 바뀌면 목록이 따라온다', async ({ page }) => {
    await waitForInit(page);
    const sel = '#windows .si';
    await expect(page.locator(sel).first()).toBeVisible();
    await markAll(page, sel);
    await page.evaluate(() => {
      const app = (window as any).app;
      app.ws.windows[0].name = 'renamed-by-test';
      app.render();
    });
    await expect(page.locator(sel).first().locator('.si-name')).toHaveText('renamed-by-test');
    // 값이 바뀐 행은 새 요소여야 한다 — 그것이 갱신이 멈추지 않았다는 증거다.
    const m = await markCount(page, sel);
    expect(m.kept).toBe(m.total - 1);
  });
});
