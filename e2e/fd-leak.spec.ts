import { spawnSync } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

import { Page } from '@playwright/test';

import {
  test, expect, waitForInit, addEditorRoot, switchToEditorRoot, openExplorerSide, openGit, gitFixture,
  cleanGitFixture, waitShellReady, rmTree,
} from './fixtures';
import { isWin, realPath, TMP, tmpPath } from './osenv';

// PERF 1.20: 편집기 루트·터미널·git 창 열기/닫기와 채널 재연결을 되풀이한 뒤 서버·데몬의 fd 가 처음 수준으로
// 돌아오는지 종류별로 잰다. 수는 lsof 의 열린 fd(번호가 있는 항목)만 센다 — txt·cwd 같은 매핑은 뺀다.

const CYCLES = 5;
// 닫힌 자원이 놓일 때까지 기다리는 상한. 감시 해제·자식 수확은 비동기다.
const SETTLE_MS = 30_000;
// 디렉터리 감시가 fd 를 쓰게 할 편집기 루트의 크기.
const ROOT_DIRS = 20;
const ROOT_FILES = 5;

const FIXTURES = tmpPath('otter-git-fx-fdleak-' + process.pid);
let BASE = '';

type Counts = Record<string, number>;

function fdCounts(pid: number): Counts {
  const r = spawnSync('lsof', ['-nP', '-p', String(pid), '-F', 'ft'], { encoding: 'utf8', timeout: 10_000 });
  const out: Counts = {};
  let numbered = false;
  for (const line of (r.stdout || '').split('\n')) {
    if (line.startsWith('f')) numbered = /^f\d+$/.test(line);
    else if (line.startsWith('t') && numbered) out[line.slice(1)] = (out[line.slice(1)] || 0) + 1;
  }
  return out;
}

const total = (c: Counts) => Object.values(c).reduce((a, b) => a + b, 0);

function serverPid(port: number): number {
  const r = spawnSync('lsof', ['-nP', '-t', '-iTCP:' + port, '-sTCP:LISTEN'], { encoding: 'utf8', timeout: 10_000 });
  return parseInt((r.stdout || '').trim().split('\n')[0], 10);
}

function daemonPid(home: string): number {
  return parseInt(readFileSync(join(home, 'paned.pid'), 'utf8').trim(), 10);
}

function diff(before: Counts, after: Counts): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const b = before[k] || 0;
    const a = after[k] || 0;
    out[k] = b === a ? String(a) : `${b}→${a}`;
  }
  return out;
}

function mkRoot(name: string): string {
  const root = join(BASE, name);
  for (let d = 0; d < ROOT_DIRS; d++) {
    const dir = join(root, 'd' + d);
    mkdirSync(dir, { recursive: true });
    for (let f = 0; f < ROOT_FILES; f++) writeFileSync(join(dir, `f${f}.txt`), 'x');
  }
  return root;
}

async function closeActiveWindow(page: Page) {
  await page.evaluate(async () => {
    const a = (window as any).app;
    await a.layout.delWindow(a.ws.activeWindow, { force: true });
  });
}

// 열려 있는 동안의 수. 시험이 감시·PTY 를 실제로 세우는지 보인다.
const peak: Record<string, Counts> = {};
let watched = 0;

function notePeak(what: string) {
  const c = fdCounts(watched);
  if (total(c) > total(peak[what] || {})) peak[what] = c;
}

async function editorCycle(page: Page, request: any, i: number) {
  const saved = await addEditorRoot(request, mkRoot('root' + i));
  await switchToEditorRoot(page, saved);
  await openExplorerSide(page);
  notePeak('editor');
  const rm = await request.post('/api/editors/remove', { data: { path: saved } });
  expect(rm.ok(), await rm.text()).toBeTruthy();
  await page.waitForFunction((r: string) => !(window as any).app.testing.edWindowFor(r), saved, { timeout: 15_000 });
}

async function terminalCycle(page: Page) {
  await page.evaluate(() => (window as any).app.layout.addWindow());
  await waitShellReady(page);
  await closeActiveWindow(page);
}

async function gitCycle(page: Page) {
  await openGit(page, realPath(join(FIXTURES, 'basic')));
  notePeak('git');
  await closeActiveWindow(page);
}

async function reconnect(page: Page) {
  await page.reload();
  await waitShellReady(page);
}

async function cycle(page: Page, request: any, i: number) {
  await editorCycle(page, request, i);
  await terminalCycle(page);
  await gitCycle(page);
  await reconnect(page);
}

test.describe('PERF 1.20 — fd 누수', () => {
  test.skip(isWin, 'lsof 로 잰다');

  test.beforeAll(() => {
    gitFixture(FIXTURES);
    BASE = realPath(mkdtempSync(join(TMP, 'otter-fdleak-')));
  });
  test.afterAll(() => {
    cleanGitFixture(FIXTURES);
    rmTree(BASE);
  });

  test('열기/닫기·재연결을 되풀이해도 서버·데몬의 fd 가 처음 수준으로 돌아온다', async ({ page, request, otterServer }) => {
    test.setTimeout(300_000);
    await waitForInit(page);
    const pids = { server: serverPid(otterServer.port), daemon: daemonPid(otterServer.home) };
    expect(pids.server > 0 && pids.daemon > 0, JSON.stringify(pids)).toBeTruthy();
    watched = pids.server;

    const first = { server: fdCounts(pids.server), daemon: fdCounts(pids.daemon) };
    // 첫 바퀴는 처음 한 번만 세우는 자원(풀·캐시)을 채운다. 기준선은 그 뒤에 잡는다.
    await cycle(page, request, 0);
    const base = { server: fdCounts(pids.server), daemon: fdCounts(pids.daemon) };
    for (let i = 1; i <= CYCLES; i++) await cycle(page, request, i);

    let after = base;
    await expect(async () => {
      after = { server: fdCounts(pids.server), daemon: fdCounts(pids.daemon) };
      expect(total(after.server)).toBeLessThanOrEqual(total(base.server));
      expect(total(after.daemon)).toBeLessThanOrEqual(total(base.daemon));
    // 기다려도 내려오지 않으면 아래에서 보고와 함께 실패한다.
    }).toPass({ timeout: SETTLE_MS }).catch(() => {});

    const report = {
      cycles: CYCLES,
      serverPeak: peak,
      server: { first: first.server, base: base.server, after: after.server, diff: diff(base.server, after.server) },
      daemon: { first: first.daemon, base: base.daemon, after: after.daemon, diff: diff(base.daemon, after.daemon) },
    };
    console.log('[fd-leak] ' + JSON.stringify(report));
    test.info().annotations.push({ type: 'fd-leak', description: JSON.stringify(report) });

    // 시험이 감시를 실제로 세웠는가 — 루트와 그 아래 디렉터리마다 fd 하나다.
    expect(peak.editor?.DIR || 0, '편집기 루트를 열었는데 디렉터리 감시가 없다').toBeGreaterThanOrEqual(ROOT_DIRS);
    expect(total(after.server), JSON.stringify(report.server.diff)).toBeLessThanOrEqual(total(base.server));
    expect(total(after.daemon), JSON.stringify(report.daemon.diff)).toBeLessThanOrEqual(total(base.daemon));
  });
});
