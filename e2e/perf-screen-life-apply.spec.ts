import { execFileSync } from 'child_process';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

import { test, expect, waitForInit, openGit, freshDir, rmTree, selectTab, gotoSettled } from './fixtures';
import { tmpPath, realPath } from './osenv';

/**
 * PERF M3 3.5.2 (FR-SPA-3, M3_DESIGN §3.5) — 잠든 git·Run 화면은 구독·타이머가 0 이고, 깨면 서버 상태를 다시 받는다.
 *
 *   이전: 다른 탭 뒤에 가려진 git 탭·Run 탭도 관측 구독·`gitconsole:<root>`·`run:<id>` 를 쥐었다
 *   새:   가려지고 2초 뒤 잠들면 놓고, 다시 보이면 다시 구독해 최신을 받는다
 *   이유: 잠든 화면은 이벤트 구독·타이머·그리기를 하지 않는다
 */

const ROOT = tmpPath('otter-sl-' + process.pid);

function mkrepo(name: string): string {
  const d = join(ROOT, name);
  freshDir(d);
  const git = (...a: string[]) => execFileSync('git', ['-C', d, ...a]);
  git('init', '-q', '-b', 'main', '.');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(d, 'a.txt'), 'one\n');
  git('add', '-A');
  git('commit', '-qm', 'init');
  return realPath(d);
}

const has = (page: any, topic: string) =>
  page.evaluate((t: string) => (window as any).app.testing.channel._topics.has(t), topic);
const sleepers = (page: any) => page.evaluate(() => (window as any).app.testing.sleepers());

test.beforeAll(() => { mkdirSync(ROOT, { recursive: true }) });
test.afterAll(() => { rmTree(ROOT) });

test('git: 가려진 git 탭의 패널은 2초 뒤 타이머·관측기 구독·gitconsole 구독이 0 이고, 다시 열면 서버와 같다', async ({ page }) => {
  const repo = mkrepo('g');
  await waitForInit(page, { clearLocalStorage: true });
  await openGit(page, repo);
  // Repo 창의 사이드(Changes·Explorer)는 늘 `git:<root>` 를 본다 — 채널 토픽 자체는 창이 보이는 동안 남는다.
  // 그래서 패널 쪽의 것을 잰다: 관측기의 구독(`_topicRoot`), 패널의 타이머, 콘솔의 `gitconsole:<root>`.
  const obsRoot = () => page.evaluate((r: string) => {
    const o = (window as any).app.testing.gitObservers.get(r);
    return o ? o._topicRoot : null;
  }, repo);
  await selectTab(page.locator('#area .pn.focused .pn-tab[data-git-view="console"]'));
  await expect.poll(() => has(page, 'gitconsole:' + repo), { timeout: 15000 }).toBe(true);
  await expect.poll(obsRoot, { timeout: 15000 }).toBe(repo);

  await page.evaluate((f) => (window as any).app.testing.edOpenFile(f), join(repo, 'a.txt'));
  await expect(page.locator('#area .pn.focused .pn-tab.active:not([data-git-view])')).toHaveCount(1, { timeout: 15000 });
  await expect.poll(() => has(page, 'gitconsole:' + repo), { timeout: 8000 }).toBe(false);
  // 사이드가 Changes 이면 패널은 사이드 표면으로 남는다(잠들어도 관측). 사이드를 Explorer 로 두고 잰다.
  await page.evaluate(() => {
    const a = (window as any).app;
    a.testing.edSetSide(a.testing.aw(), 'explorer');
    a.render();
  });
  await expect.poll(obsRoot, { timeout: 8000 }).toBe('');
  const asleep = (await sleepers(page)).filter((s: any) => s.kind === 'GitPanel');
  expect(asleep.length).toBeGreaterThan(0);
  for (const s of asleep) expect(s).toEqual({ kind: 'GitPanel', timers: 0, subs: 0 });

  // 잠든 동안 저장소가 바뀐다 — 패널은 수집하지 않는다.
  writeFileSync(join(repo, 'b.txt'), 'two\n');
  execFileSync('git', ['-C', repo, 'add', '-A']);
  execFileSync('git', ['-C', repo, 'commit', '-qm', 'second']);
  const head = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

  await selectTab(page.locator('#area .pn.focused .pn-tab[data-git-view="history"]'));
  await expect.poll(obsRoot, { timeout: 8000 }).toBe(repo);
  await expect.poll(() => page.evaluate(() => ((window as any).app.gitPanel.views.statusOf() || {}).oid), { timeout: 15000 })
    .toBe(head);
  expect((await sleepers(page)).filter((s: any) => s.kind === 'GitPanel').length).toBeLessThan(asleep.length);
});

test('Run: 가려진 Run 탭은 2초 뒤 run:<id> 구독이 0 이고, 다시 보이면 다시 구독한다', async ({ page }) => {
  await gotoSettled(page);
  const termTab = await page.evaluate(() => {
    const app = (window as any).app;
    const w = app.ws.windows.find((x: any) => x.id === app.ws.activeWindow);
    return w.layout.tabs[0];
  });
  const runId = await page.evaluate(async (tid: string) => {
    const r = await fetch('/api/runs', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ objective: 'e2e sleep', projection: 'dedicated-window', toolId: tid }),
    });
    return (await r.json()).id;
  }, termTab.toolId);
  await page.evaluate(async (id: string) => {
    const app = (window as any).app;
    await app.layout.tabAdd.addTab(app.focused, 'run', { runId: id, short: String(id).slice(0, 8) });
  }, runId);
  await expect(page.locator('.run-view .run-graph')).toBeVisible({ timeout: 10000 });
  expect(await has(page, 'run:' + runId)).toBe(true);

  await selectTab(page.locator(`#area .pn.focused .pn-tab[data-tab-id="${termTab.id}"]`));
  await expect.poll(() => has(page, 'run:' + runId), { timeout: 8000 }).toBe(false);
  expect((await sleepers(page)).map((s: any) => s.kind)).toContain('RunView');

  await selectTab(page.locator('#area .pn.focused .pn-tab:not([data-tab-id="' + termTab.id + '"])'));
  await expect.poll(() => has(page, 'run:' + runId), { timeout: 8000 }).toBe(true);
  expect((await sleepers(page)).map((s: any) => s.kind)).not.toContain('RunView');
});
