import { writeFileSync } from 'fs';
import { join } from 'path';

import { Page } from '@playwright/test';

import { test, expect, makeCopyFx, openGit, waitForInit, waitSettled, gitFixture, cleanGitFixture } from './fixtures';
import { tmpPath } from './osenv';

// GIT_PUSH_OBSERVE_SRS §4.2 — 브라우저 쪽 계약 (B-1~B-5).
//
// 종전에는 브라우저가 signature 를 500ms 마다 물어 변화를 스스로 찾았다. 이제
// 서버가 그것을 확인하고 바뀌었을 때만 `git_changed` 를 방송한다.
//
// **재는 것은 "누가 찾는가" 가 아니라 "화면이 따라오는가" 다.** 그래서 아래
// 검사들은 대부분 파일을 만들고 목록에 나타나기를 기다린다 — 그 사이에 무엇이
// 오갔는지는 B-5 만 본다.

const FIXTURES = tmpPath('dm-git-fx-push-' + process.pid);

test.beforeAll(() => {
  gitFixture(FIXTURES);
});
test.afterAll(() => {
  cleanGitFixture(FIXTURES);
});

const copyFx = makeCopyFx(FIXTURES);
const changes = (page: Page) => page.locator('#area .ed-side .git-view.git-changes');
// 새 파일은 untracked 그룹에 선다.
const untracked = (page: Page) =>
  changes(page).locator('.git-group[data-group="working"] .git-file');

// 변화 한 번을 만든다 — 작업 트리에 파일을 더하면 index 와 무관하게 status 가 바뀐다.
function touch(repo: string, name: string) {
  writeFileSync(join(repo, name), 'x\n');
}

test.describe('GIT_PUSH_OBSERVE — 서버가 밀어 준다', () => {
  // B-1: 서버가 알리면 화면이 따라온다.
  //
  // 브라우저에는 signature 폴링 계층이 **없으므로**(POLL_INTERVAL_SETTINGS_SRS
  // FR-PIS-1 — 종전에는 주기 0 으로 꺼 두었을 뿐이었다), 이 검사가 통과한다는
  // 것은 **방송이 실제로 도착해 수집을 불렀다**는 뜻이다.
  // status 안전망은 30초라 그 안에 끼어들지 못한다.
  test('B-1 파일이 생기면 방송을 받아 목록에 나타난다', async ({ page }) => {
    const repo = copyFx('basic', 'b1');
    await waitForInit(page);
    await openGit(page, repo);
    await waitSettled(page);

    const before = await untracked(page).count();
    touch(repo, 'pushed.txt');

    // 종전 주기(500ms)와 같은 감각이어야 한다 (NFR-2). 넉넉히 잡되 30초
    // 안전망보다는 훨씬 짧게 — 그보다 오래 걸리면 폴링이 구한 것이다.
    await expect
      .poll(() => untracked(page).count(), { timeout: 8000 })
      .toBeGreaterThan(before);
    await expect(changes(page).getByText('pushed.txt')).toBeVisible();
  });

  // B-2: 남의 저장소 이벤트는 무시한다.
  //
  // 방송은 모든 브라우저에 가고 저마다 다른 저장소를 볼 수 있다. 다른 저장소의
  // 변화가 이 창의 요청을 만들면 종전에 없던 요청이 생긴다.
  test('B-2 다른 저장소의 방송은 이 창의 요청을 만들지 않는다', async ({ page }) => {
    const mine = copyFx('basic', 'b2a');
    const other = copyFx('basic', 'b2b');
    await waitForInit(page);
    await openGit(page, mine);
    await waitSettled(page);

    let statusReqs = 0;
    await page.route('**/api/git/status*', (route) => {
      statusReqs++;
      return route.continue();
    });

    // 남의 저장소를 가리키는 방송을 직접 먹인다 — 서버를 거치지 않고 그
    // 갈림길만 시험한다.
    await page.evaluate((repo) => {
      (window as any).app.bus.publish('git_changed', { repo, mark: 'zzz' });
    }, other);
    await page.waitForTimeout(500);

    expect(statusReqs, '남의 저장소 방송에 status 를 냈다 (FR-GPO-21)').toBe(0);
  });

  // B-3: 이미 본 알림의 재방송은 수집을 부르지 않는다.
  //
  // 재연결 직후 서버가 현재 상태를 다시 알릴 수 있다. 그때 방금 받은 화면을 또
  // 받으면 요청이 배로 는다.
  //
  // 거르는 근거는 `mark` 다 — 서버가 방송을 내보내게 만든 그 판단과 같은 값이다.
  // signature 로 거르면 작업 트리 변화가 통째로 삼켜진다 (§2.9).
  test('B-3 같은 알림의 재방송은 수집을 부르지 않는다', async ({ page }) => {
    const repo = copyFx('basic', 'b3');
    await waitForInit(page);
    await openGit(page, repo);
    await waitSettled(page);

    // 첫 알림을 받아 `mark` 를 세운다 — 그것이 "이미 본 것" 의 기준이다.
    await page.evaluate((repo) => {
      (window as any).app.bus.publish('git_changed', { repo, mark: 'M1' });
    }, repo);
    await page.waitForTimeout(300);

    let statusReqs = 0;
    await page.route('**/api/git/status*', (route) => {
      statusReqs++;
      return route.continue();
    });

    await page.evaluate((repo) => {
      (window as any).app.bus.publish('git_changed', { repo, mark: 'M1' });
    }, repo);
    await page.waitForTimeout(500);
    expect(statusReqs, '이미 본 알림으로 다시 받았다 (FR-GPO-22)').toBe(0);

    // 다른 mark 면 받는다 — 위 0 이 "그냥 안 도는 것" 이 아님을 보인다.
    await page.evaluate((repo) => {
      (window as any).app.bus.publish('git_changed', { repo, mark: 'M2' });
    }, repo);
    await expect.poll(() => statusReqs, { timeout: 5000 }).toBeGreaterThan(0);
  });

  // B-5: 변화 없는 동안의 요청이 준다 (NFR-1).
  //
  // 종전 10초에 sig 20 + status 10 = 30 회였다. 이제 안전망(30초)만 남으므로
  // 그 창에서 한 자릿수여야 한다.
  test('B-5 변화 없는 10초의 git 요청이 한 자릿수다', async ({ page }) => {
    const repo = copyFx('basic', 'b5');
    await waitForInit(page);
    await openGit(page, repo);
    await waitSettled(page);

    let reqs = 0;
    await page.route('**/api/git/{status,signature}*', (route) => {
      reqs++;
      return route.continue();
    });
    await page.waitForTimeout(10000);

    // 종전이라면 30 회 안팎이다.
    expect(reqs, `변화 없는 10초에 ${reqs} 회 나갔다 (NFR-1)`).toBeLessThan(10);
  });
});

// B-4 는 실앱의 SSE 를 끊고 안전망만 남기는 검사다. 30초 안전망을 그대로 기다리면
// 스펙 하나가 30초를 먹으므로, **주기를 줄여** 같은 계약을 잰다 — 재는 것은
// "푸시가 없어도 갱신되는가" 이지 30 이라는 값이 아니다.
test('B-4 푸시가 끊겨도 안전망 폴링이 화면을 따라잡는다', async ({ page }) => {
  const repo = copyFx('basic', 'b4');
  await waitForInit(page);
  await openGit(page, repo);
  await waitSettled(page);

  await page.evaluate(() => {
    const app = (window as any).app;
    // 안전망을 1초로 줄이고 주기를 다시 건다 (FR-GIT-22: 참이 되면 즉시 1회).
    (window as any).gitStatusInterval = 1000;
    for (const p of app._gitPanels.values()) p._reschedule();
    // 푸시를 끊는다 — 이제 화면을 살리는 것은 안전망뿐이다.
    app.bus.closeChannel('commands');
    try { app._sse.close() } catch { /* 이미 닫힘 */ }
  });

  const before = await untracked(page).count();
  writeFileSync(join(repo, 'fallback.txt'), 'x\n');

  await expect
    .poll(() => untracked(page).count(), { timeout: 10000 })
    .toBeGreaterThan(before);
});
