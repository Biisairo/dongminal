import { writeFileSync } from 'fs';
import { join } from 'path';

import { Page } from '@playwright/test';

import { test, expect, makeCopyFx, openGit, waitForInit, gitFixture, cleanGitFixture, clickGitView, clickRowAct } from './fixtures';
import { tmpPath } from './osenv';

// 묶음 Q — Console 탭 (GIT_UI_REVISION_SRS FR-GIT-218, 검증 V95).
//
// Console 은 터미널이 아니라 **dongminal 이 대신 실행한 git 명령의 기록**이다.
// 그 명령들은 서버 프로세스 안에서 돌아 사용자의 터미널에는 남지 않는다.

const FIXTURES = tmpPath('dm-git-fx-console-' + process.pid);

test.beforeAll(() => {
  gitFixture(FIXTURES);
});
test.afterAll(() => {
  cleanGitFixture(FIXTURES);
});

const copyFx = makeCopyFx(FIXTURES);
const tab = (page: Page, v: string) => page.locator(`#area .pn-tab[data-git-view="${v}"]`);
const con = (page: Page) => page.locator('#area .pn-body .git-view.git-console');
const rows = (page: Page) => con(page).locator('.git-con-row');
const argvs = (page: Page) => rows(page).locator('.git-con-argv').allTextContents();

async function openConsole(page: Page, repo: string) {
  await openGit(page, repo);
  await clickGitView(page, 'console');
  await expect(con(page)).toHaveClass(/vis/);
}

test.describe('묶음 Q — Console 탭', () => {
  test('K1 (V95): Console 은 준비 중이 아니라 실행 기록을 보인다', async ({ page }) => {
    const repo = copyFx('basic', 'k1');
    await waitForInit(page);
    await openConsole(page, repo);

    await expect(con(page).locator('.git-pending')).toHaveCount(0);
    await expect(con(page).locator('.git-con-list')).toBeVisible({ timeout: 10000 });
  });

  test('K2 (V95): 쓰기를 하면 그 명령이 맨 위에 나타난다', async ({ page }) => {
    const repo = copyFx('basic', 'k2');
    await waitForInit(page);
    await openGit(page, repo);

    // Changes 에서 파일 하나를 스테이지한다 — dongminal 이 `git add` 를 실행한다.
    const row = page.locator('#area .ed-side .git-group[data-group="working"] .git-file[data-path="tracked.txt"]');
    await expect(row).toBeVisible({ timeout: 10000 });
    await clickRowAct(page, row, 'stage');
    await expect(page.locator('#area .ed-side .git-group[data-group="staged"] .git-file[data-path="tracked.txt"]'))
      .toBeVisible({ timeout: 15000 });

    await clickGitView(page, 'console');
    await expect.poll(async () => (await argvs(page))[0], { timeout: 15000 })
      .toContain('add');
  });

  test('K3 (V95): 기본에서 폴링이 보이지 않고 토글하면 나타난다', async ({ page }) => {
    const repo = copyFx('basic', 'k3');
    await waitForInit(page);
    await openConsole(page, repo);

    // status 폴링은 1초에 한 번 기록된다 — 거르지 않으면 목록이 그것으로만 찬다.
    await expect.poll(async () => (await argvs(page)).some((a) => a.includes('status')),
      { timeout: 10000 }).toBe(false);

    await con(page).locator('.git-con-reads input').check();
    await expect.poll(async () => (await argvs(page)).some((a) => a.includes('status')),
      { timeout: 15000 }).toBe(true);
  });

  test('K4 (V95): 행을 펼치면 cwd 를 보이고, 파괴적 실행은 표식을 갖는다', async ({ page }) => {
    const repo = copyFx('basic', 'k4');
    await waitForInit(page);
    await openGit(page, repo);

    // discard 는 파괴적이다 (FR-GIT-95, 해석 I5) — 확인을 거친다.
    writeFileSync(join(repo, 'k4.txt'), 'x\n');
    const row = page.locator('#area .ed-side .git-group[data-group="working"] .git-file[data-path="k4.txt"]');
    await expect(row).toBeVisible({ timeout: 10000 });
    await clickRowAct(page, row, 'discard');
    // 파괴적 동작도 확인은 한 걸음이다 (FR-GIT-95~97, FR-COS-1).
    const box = page.locator('#git-confirm .gc-box');
    await expect(box).toBeVisible({ timeout: 10000 });
    await expect(box).toHaveAttribute('data-stage', '1');
    await page.locator('#git-confirm .gc-go').click();
    await expect(row).toHaveCount(0, { timeout: 15000 });

    await clickGitView(page, 'console');
    const destructive = con(page).locator('.git-con-row[data-destructive="1"]');
    await expect(destructive.first()).toBeVisible({ timeout: 15000 });

    // 펼치면 cwd 를 본다 — 어느 저장소에서 돌았는지가 이력의 절반이다.
    await destructive.first().click();
    await expect(con(page).locator('.git-con-detail').first()).toContainText(repo, { timeout: 10000 });
  });

  test('K5 (V95): 리포를 바꾸면 그 리포의 기록만 보인다', async ({ page }) => {
    const a = copyFx('basic', 'k5a');
    const b = copyFx('with-remote', 'k5b');
    await waitForInit(page);
    await openConsole(page, a);
    await expect.poll(async () => (await argvs(page)).length, { timeout: 15000 })
      .toBeGreaterThan(0);

    await page.evaluate((r) => (window as any).app.gitPanel.setRepo(r), b);
    // 앞 리포의 기록이 남아 있으면 이력이 아니라 잡음이다.
    await expect.poll(async () => {
      const d = await con(page).locator('.git-con-detail').allTextContents();
      return d.some((t) => t.includes(a));
    }, { timeout: 15000 }).toBe(false);
  });
});

// ── GIT_ACTIONS_SRS §3.8 / FR-GIT-281 (V207 의 Console 부분) ──
//
// 검색과 replay. **replay 의 핵심은 argv 를 클라이언트가 보내지 않는다는 것**이며,
// 그 사실은 Go 단위(handlers_git_replay_test.go)가 지킨다 — 여기서는 화면이 그
// 경로를 실제로 태우는지 본다.
test.describe('묶음 H — Console 의 검색·replay (FR-GIT-281)', () => {
  const search = (page: Page) => con(page).locator('.git-con-search');

  test('K10 (FR-GIT-281): 검색이 이미 받은 기록을 거른다 — 일치가 없으면 그 사실을 말한다', async ({ page }) => {
    const repo = copyFx('basic', 'k10');
    await waitForInit(page);
    await openConsole(page, repo);
    // 읽기까지 보이게 해 거를 것을 충분히 만든다.
    //
    // **한 번에 켜지지 않을 수 있다.** 이 체크박스는 `mount()` 가 만든다
    // (`console.js:32`) — 목록 다시 그리기(`_paintList`)는 건드리지 않지만, 뷰가
    // 다시 마운트되면 통째로 새로 만들어진다. 그 사이에 누르면 playwright 가
    // `element was detached from the DOM, retrying` 로 맴돌다 끝난다 (실측).
    // 눌러 보고, 켜졌는지 보고, 아니면 다시 — 이 저장소의 공용 골격이다.
    const reads = con(page).locator('.git-con-reads input');
    await expect(async () => {
      await reads.check({ timeout: 5000 });
      await expect(reads).toBeChecked({ timeout: 2000 });
    }).toPass({ timeout: 20000 });
    await expect.poll(() => rows(page).count(), { timeout: 15000 }).toBeGreaterThan(0);

    const all = await argvs(page);
    const token = (all.find((s) => s.includes('status')) || all[0]).split(' ')[1];
    await search(page).fill(token);
    await expect.poll(async () => {
      const shown = await argvs(page);
      return shown.length > 0 && shown.every((s) => s.includes(token));
    }, { timeout: 10000 }).toBe(true);

    // 없는 것을 찾으면 빈 목록이 아니라 **사유**가 뜬다.
    await search(page).fill('zzz-없는명령-zzz');
    await expect(rows(page)).toHaveCount(0, { timeout: 10000 });
    await expect(con(page).locator('.git-con-note')).toBeVisible();

    // 지우면 돌아온다 — 거르기는 화면 상태이지 데이터가 아니다.
    await search(page).fill('');
    await expect.poll(() => rows(page).count(), { timeout: 10000 }).toBeGreaterThan(0);
  });

  test('K11 (FR-GIT-281·89): 쓰기 기록의 replay 는 확인을 거치고 같은 명령을 다시 남긴다', async ({ page }) => {
    const repo = copyFx('basic', 'k11');
    await waitForInit(page);
    await openGit(page, repo);
    // 쓰기를 하나 만든다 — 스테이지는 파괴적이 아니므로 확인은 1단계다.
    await page.evaluate(async (r) => {
      await (window as any).app.gitPanel.post('/api/git/stage',
        { repo: r, paths: ['tracked.txt'] });
    }, repo);
    await clickGitView(page, 'console');
    await expect(con(page)).toHaveClass(/vis/);

    const row = rows(page).filter({ hasText: 'add' }).first();
    await expect(row, '쓰기 기록이 안 보인다').toBeVisible({ timeout: 15000 });
    const before = (await argvs(page)).filter((s) => s.includes('add')).length;

    await row.hover();
    await row.locator('.git-con-replay').click();
    // 쓰기이므로 확인을 거친다 (파괴적은 아니다).
    await expect(page.locator('#git-confirm .gc-box')).toBeVisible({ timeout: 10000 });
    await page.locator('#git-confirm .gc-go').click();
    await expect(page.locator('#git-confirm'), '성공했는데 확인 상자가 안 닫혔다')
      .toHaveCount(0, { timeout: 15000 });

    // 다시 실행된 것도 기록에 남는다 — 같은 문을 지났다는 증거다.
    await expect.poll(async () => (await argvs(page)).filter((s) => s.includes('add')).length,
      { timeout: 15000 }).toBeGreaterThan(before);
  });
});
