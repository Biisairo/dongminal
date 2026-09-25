import { execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync } from 'fs';
import { join } from 'path';

import { APIRequestContext, Page } from '@playwright/test';

import { test, expect, openGitTab, waitForInit, waitSettled, rmTree } from './fixtures';
import { TMP, cssPath } from './osenv';

/**
 * OPTIMIZE_REFACTOR_SRS FR-OPT-4-3 (IPC-7 · FEC-13) — 저장소 목록의 배지는 **push** 로 선다.
 *
 * Repo 탭이 보이는 동안 핀 전부를 임대하고(`observe=1&clientId`), 배지의 변화는 서버
 * 감시자의 `git_changed` 가 알린다. 목록의 주기는 안전망(`gitStatusInterval`)이다 — 여기서는
 * 안전망을 꺼서(0) push 만으로 배지가 서는지를 잰다. 탭을 떠나면 임대를 놓는다(`observe=0`).
 *
 * **고정 대기의 예외 (`TEST-16`).** 변화가 없는 동안 목록 요청이 **나가지 않음**을 잰다 —
 * 일어나지 않는 일에는 기다릴 신호가 없으므로 종전 주기(3초)를 두 번 넘겨 본다.
 */

const dirs: string[] = [];
test.afterAll(() => { for (const d of dirs) rmTree(d) });

function makeRepo(prefix: string) {
  const dir = mkdtempSync(join(TMP, prefix));
  dirs.push(dir);
  execFileSync('git', ['init', '-q', dir]);
  writeFileSync(join(dir, 'a.txt'), 'x');
  return dir;
}

async function pin(request: APIRequestContext, path: string) {
  const r = await request.post('/api/git/repos/pin', { data: { path } });
  expect(r.ok(), `pin 실패: ${await r.text()}`).toBeTruthy();
  return (await r.json()).root as string;
}

const pinned = (page: Page, root: string) =>
  page.locator(`#repo-entries .ed-entry[data-git-repo="${cssPath(root)}"]`);

function reposLog(page: Page) {
  const box: string[] = [];
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (u.pathname === '/api/git/repos') box.push(u.searchParams.get('observe') || '');
  });
  return box;
}

test.describe('저장소 목록의 push (FR-OPT-4-3)', () => {
  test('안전망이 꺼져 있어도 핀 저장소의 변화가 배지에 선다', async ({ page, request }) => {
    const dir = makeRepo('dm-o4b-push-');
    const root = await pin(request, dir);
    await waitForInit(page);
    await page.evaluate(() => { (window as any).gitStatusInterval = 0; (window as any).app.timers.refreshChanged() });
    const log = reposLog(page);
    await openGitTab(page);
    const badge = pinned(page, root).locator('.git-badge');
    await expect(badge).toHaveText('1', { timeout: 15000 });
    expect(log[0], JSON.stringify(log)).toBe('1');

    // 변화가 없으면 목록을 묻지 않는다 — 종전에는 3초마다 핀 전부를 관측했다.
    const quiet = log.length;
    await page.waitForTimeout(7000);
    expect(log.length - quiet, JSON.stringify(log)).toBe(0);

    writeFileSync(join(dir, 'b.txt'), 'y');
    // 서버 감시자의 워크트리 회차(≈4초)가 잡아 `git_changed` 를 민다.
    await expect(badge).toHaveText('2', { timeout: 20000 });
  });

  test('탭을 떠나면 임대를 놓고, 목록이 같으면 다시 칠하지 않는다', async ({ page, request }) => {
    const root = await pin(request, makeRepo('dm-o4b-leave-'));
    await waitForInit(page);
    await waitSettled(page);
    await openGitTab(page);
    await expect(pinned(page, root).locator('.git-badge')).toHaveText('1', { timeout: 15000 });

    // FEC-13: 응답이 같으면 목록을 다시 그리지 않는다.
    const painted = await page.evaluate(async () => {
      const app = (window as any).app;
      const r = app.renderer;
      const orig = r._rGitSection;
      let n = 0;
      r._rGitSection = function (...a: any[]) { n++; return orig.apply(this, a) };
      await app.testing.gitReposRefresh();
      await app.testing.gitReposRefresh();
      r._rGitSection = orig;
      return n;
    });
    expect(painted, '같은 목록을 다시 칠했다').toBe(0);

    const log = reposLog(page);
    await page.locator('.sb-tab[data-panel="windows"]').click();
    await expect.poll(() => log.slice(), { timeout: 10000 }).toContain('0');
  });
});
