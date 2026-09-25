import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { Page } from '@playwright/test';

import { test, expect, rmTree, enterExplorer } from './fixtures';
import { TMP, realPath, cssPath } from './osenv';

/**
 * OPTIMIZE_REFACTOR_SRS 묶음 O4a — 편집기 창의 정상 상태 트래픽 (FR-OPT-4-1 · 4-2 · 4-7).
 *
 * 세는 것은 요청이다 (FR-OPT-0-4). 탐색기가 저장소 루트를 보고 파일 하나가 열린 채
 * **아무것도 하지 않는 30초**의 요청 타임라인을 종단별로 센다.
 *
 *   이전 (0bbd3485): git/status 10 · fs/stamp 10 · file/stamps 10  = 30
 *   이후 (실측):     git/status 0  · fs/stamps 10                   = 10
 *                    (안전망 30초가 창 안에 들면 status 가 1 이다)
 *
 * **고정 대기의 예외 (`TEST-16`).** 창 안에 요청이 몇 건 나가는가가 답이므로 기다릴
 * 신호가 없다 — 시간을 주고 그 사이의 수를 센다.
 */

const WINDOW_MS = 30000;

let BASE = '';
let REPO = '';

const git = (d: string, ...a: string[]) => execFileSync('git', ['-C', d, ...a], { stdio: 'ignore' });

test.beforeAll(() => {
  BASE = realPath(fs.mkdtempSync(path.join(TMP, 'dm-o4a-')));
  REPO = path.join(BASE, 'repo');
  fs.mkdirSync(REPO);
  git(REPO, 'init', '-q', '-b', 'main', '.');
  git(REPO, 'config', 'user.name', 'Fixture');
  git(REPO, 'config', 'user.email', 'fixture@example.invalid');
  git(REPO, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(REPO, 'a.txt'), 'one\n');
  git(REPO, 'add', '-A');
  git(REPO, 'commit', '-qm', 'base');
  fs.appendFileSync(path.join(REPO, 'a.txt'), 'two\n');
  REPO = realPath(REPO);
});
test.afterAll(() => rmTree(BASE));

function timeline(page: Page) {
  const box: { at: number; path: string; query: string }[] = [];
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (u.pathname.startsWith('/api/')) box.push({ at: Date.now(), path: u.pathname, query: u.search });
  });
  return box;
}

const count = (box: { path: string }[], p: string) => box.filter((x) => x.path === p).length;
const row = (page: Page, p: string) => page.locator(`.ed-tree .ed-row[data-path="${cssPath(p)}"]`);

test.describe('편집기 창의 정상 상태 트래픽 (FR-OPT-4-1 · 4-2)', () => {
  test('30초 동안: 스탬프는 틱당 한 요청, status 는 안전망뿐이다', async ({ page, request }) => {
    test.setTimeout(WINDOW_MS + 60000);
    await enterExplorer(page, request, REPO);
    await expect(row(page, path.join(REPO, 'a.txt'))).toHaveAttribute('data-st', 'M', { timeout: 15000 });
    await page.evaluate((p) => (window as any).app.testing.edOpenFile(p), path.join(REPO, 'a.txt'));
    await page.waitForSelector('.file-editor .monaco-editor', { timeout: 20000 });
    // 열 때의 요청(read·diff-content·첫 status)이 가라앉은 뒤부터 센다.
    await expect.poll(() => page.evaluate(() => {
      const a = (window as any).app;
      return [...a.testing.edDocs.values()].some((d: any) => d && d.stamp);
    }), { timeout: 15000 }).toBe(true);

    const box = timeline(page);
    await page.waitForTimeout(WINDOW_MS);
    const poll = await page.evaluate(() => (window as any).gitReposInterval);
    const ticks = Math.ceil(WINDOW_MS / poll);
    const got = {
      status: count(box, '/api/git/status'),
      stamps: count(box, '/api/fs/stamps'),
      fsStamp: count(box, '/api/fs/stamp'),
      fileStamps: count(box, '/api/file/stamps'),
    };
    test.info().annotations.push({ type: 'traffic-30s', description: JSON.stringify(got) });
    // 옛 종단 둘은 더는 부르지 않는다 — 한 요청으로 합쳤다 (FR-OPT-4-2).
    expect(got.fsStamp).toBe(0);
    expect(got.fileStamps).toBe(0);
    // 틱당 하나다. 경계에서 한 틱이 더 들 수 있다.
    expect(got.stamps).toBeGreaterThanOrEqual(ticks - 1);
    expect(got.stamps).toBeLessThanOrEqual(ticks + 1);
    // 안전망(30초) 한 번까지다. 종전에는 틱마다(≈10) 나갔다.
    expect(got.status, JSON.stringify(got)).toBeLessThanOrEqual(1);
  });

  test('탐색기는 git_changed 로 색을 받는다 — 안전망을 기다리지 않는다 (IPC-8)', async ({ page, request }) => {
    test.setTimeout(60000);
    await enterExplorer(page, request, REPO);
    await expect(row(page, path.join(REPO, 'a.txt'))).toHaveAttribute('data-st', 'M', { timeout: 15000 });
    const box = timeline(page);
    const made = path.join(REPO, 'pushed.txt');
    fs.writeFileSync(made, 'x\n');
    try {
      // 서버 감시의 워크트리 회차(≈4초) + 방송 + 한 요청. 안전망(30초)보다 한참 짧다.
      await expect(row(page, made)).toHaveAttribute('data-st', '?', { timeout: 15000 });
      const asked = box.filter((x) => x.path === '/api/git/status');
      expect(asked.length).toBeGreaterThan(0);
      // 요청은 이 탭의 신원을 싣는다 — 서버 감시의 임대다 (GIT_WATCH_LEASE_SRS FR-GWL-9).
      const cid = await page.evaluate(() => (window as any).app.clientId);
      expect(asked.every((x) => new URLSearchParams(x.query).get('clientId') === cid)).toBe(true);
    } finally {
      fs.rmSync(made, { force: true });
    }
  });
});

test.describe('조건부 status (FR-OPT-4-7)', () => {
  test('같은 mark 면 목록 없이 unchanged 만 온다', async ({ request }) => {
    await request.post('/api/editors/add', { data: { path: REPO } });
    const q = '/api/git/status?repo=' + encodeURIComponent(REPO);
    const full = await (await request.get(q)).json();
    expect(full.mark).toBeTruthy();
    const same = await (await request.get(q + '&ifMark=' + encodeURIComponent(full.mark))).json();
    expect(same.unchanged).toBe(true);
    expect(same.status).toBeUndefined();
    expect(same.mark).toBe(full.mark);
    const other = await (await request.get(q + '&ifMark=nope')).json();
    expect(other.unchanged).toBeUndefined();
    expect(other.status).toBeTruthy();
  });
});
