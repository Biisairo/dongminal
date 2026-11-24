/**
 * PERF_OPTIMIZATION_SRS FR-SPA-5 · OQ-2 (이슈 3.3) — 큰 파일에서 찾기 입력이 메인 스레드를 16 ms 넘게 잡지 않는다.
 *
 * 2만 줄 파일을 열고 찾기 칸에 글자를 하나씩 친다. 그동안 Chromium 트레이스(`devtools.timeline`)를 켜서
 * 렌더러 메인 스레드의 작업(`RunTask`) 길이를 잰다. 첫 글자부터 마지막 일치 수가 나올 때까지의 작업 중
 * 가장 긴 것이 16 ms 이하여야 한다.
 */
import * as fs from 'fs';
import * as path from 'path';

import { APIRequestContext, CDPSession, Page } from '@playwright/test';

import { ED_SEL } from './editor';
import { test, expect, rmTree, switchToEditorRoot, openExplorerSide } from './fixtures';
import { TMP, realPath } from './osenv';

const j = (...p: string[]) => path.join(...p);
const LINES = 20000;
const QUERY = 'value_1';
// value_1 · value_10~19 · value_100~199 · value_1000~1999 · value_10000~19999
const QUERY_HITS = 1 + 10 + 100 + 1000 + 10000;
const TASK_BUDGET_MS = 16;
const TYPE_DELAY_MS = 50;

let BASE = '';
let ROOT = '';

test.beforeAll(() => {
  BASE = realPath(fs.mkdtempSync(j(TMP, 'otter-efperf-')));
  ROOT = j(BASE, 'root');
  fs.mkdirSync(ROOT, { recursive: true });
  const body = Array.from({ length: LINES }, (_, i) => `line ${i + 1} const value_${i + 1} = recompute(${i + 1}) // some remark text`);
  fs.writeFileSync(j(ROOT, 'big.js'), body.join('\n') + '\n');
  ROOT = realPath(ROOT);
});
test.afterAll(() => {
  rmTree(BASE);
});

async function enter(page: Page, request: APIRequestContext) {
  const r = await request.post('/api/editors/add', { data: { path: ROOT } });
  expect(r.ok(), `editors/add 실패: ${await r.text()}`).toBeTruthy();
  await page.context().addInitScript(() => { sessionStorage.setItem('displayMode', 'desktop') });
  await page.context().addInitScript(() => { try { localStorage.removeItem('edFindOpts') } catch { /* 사생활 모드 */ } });
  await page.goto('/');
  await page.waitForSelector('#area .pn.focused .xterm-helper-textarea', { timeout: 15000 });
  await page.waitForFunction(
    () => !!(window as any).app?.testing.editors && (window as any).app.testing.edWindows().length > 0,
    undefined, { timeout: 15000 });
  await switchToEditorRoot(page, ROOT);
  await openExplorerSide(page);
  await expect(page.locator('.ed-tree .ed-row').first()).toBeVisible({ timeout: 10000 });
  await page.evaluate((p) => (window as any).app.testing.edOpenFile(p), j(ROOT, 'big.js'));
  await page.waitForFunction(() => {
    const v = (window as any).app.testing.edActiveEditor();
    return !!(v && edT.has(v) && /big\.js$/.test(String(v.filePath)) && v.el.offsetParent !== null);
  }, undefined, { timeout: 20000 });
  await page.locator(`.file-editor:visible ${ED_SEL.surface} ${ED_SEL.text}`).first().click();
}

type TraceEvent = { name: string; ph: string; pid: number; tid: number; ts: number; dur?: number; args?: { name?: string } };

async function traceStop(cdp: CDPSession): Promise<TraceEvent[]> {
  const done = new Promise<string>((res) => cdp.once('Tracing.tracingComplete', (e) => res(e.stream as string)));
  await cdp.send('Tracing.end');
  const stream = await done;
  let raw = '';
  for (;;) {
    const r = await cdp.send('IO.read', { handle: stream });
    raw += r.data;
    if (r.eof) break;
  }
  await cdp.send('IO.close', { handle: stream });
  return (JSON.parse(raw).traceEvents || []) as TraceEvent[];
}

// 렌더러 메인 스레드(`CrRendererMain`)의 작업 길이(ms), 긴 것부터.
function mainTasks(events: TraceEvent[]): number[] {
  const main = new Set(events
    .filter((e) => e.ph === 'M' && e.name === 'thread_name' && e.args?.name === 'CrRendererMain')
    .map((e) => `${e.pid}:${e.tid}`));
  return events
    .filter((e) => e.ph === 'X' && e.name === 'RunTask' && main.has(`${e.pid}:${e.tid}`))
    .map((e) => (e.dur || 0) / 1000)
    .sort((a, b) => b - a);
}

test.describe('큰 파일 찾기의 메인 스레드 작업', () => {
  test('2만 줄 파일에서 찾기 입력 글자마다 메인 스레드 작업이 16 ms 이하다', async ({ page, request }) => {
    test.setTimeout(120000);
    await enter(page, request);
    await page.keyboard.press('Control+f');
    const count = page.locator('.fe-find.vis:visible .fe-find-count');
    await expect(page.locator('.fe-find.vis:visible .fe-find-q')).toBeFocused({ timeout: 5000 });

    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Tracing.start', { categories: 'toplevel,devtools.timeline,disabled-by-default-devtools.timeline', transferMode: 'ReturnAsStream' });
    await page.keyboard.type(QUERY, { delay: TYPE_DELAY_MS });
    await expect(count).toHaveText(`1/${QUERY_HITS}`, { timeout: 20000 });
    const tasks = mainTasks(await traceStop(cdp));

    const over = tasks.filter((d) => d > TASK_BUDGET_MS).map((d) => d.toFixed(1));
    console.log(`find-main-task-ms max=${(tasks[0] || 0).toFixed(1)} top=${tasks.slice(0, 8).map((d) => d.toFixed(1)).join(',')}`);
    expect(over, `16 ms 를 넘은 작업: ${over.join(', ')}`).toEqual([]);
  });
});
