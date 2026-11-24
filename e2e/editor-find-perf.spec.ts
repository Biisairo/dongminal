/**
 * PERF_OPTIMIZATION_SRS FR-SPA-5 · OQ-2 (이슈 3.3·3.8) — 큰 파일에서 찾기 입력이 메인 스레드를 16 ms 넘게 잡지 않는다.
 *
 * 2만 줄 파일을 열고 찾기 칸에 글자를 하나씩 친다. 그동안 Chromium 트레이스(`devtools.timeline`)를 켜서
 * 렌더러 메인 스레드의 작업(`RunTask`) 길이를 잰다. 첫 글자부터 마지막 일치 수가 나온 뒤 프레임 둘까지,
 * 찾기 계산 작업(입력 처리·디바운스 뒤의 조각)과 화면 프레임(`FireAnimationFrame` 을 품은 작업 — 다 센 일치를
 * 칠한 뒤 눈금·미니맵을 다시 그리는 프레임 포함) 모두 16 ms 이하여야 한다.
 *
 * 유휴 콜백(`FireIdleCallback`)을 품은 작업은 재기만 한다. 큰 파일을 연 뒤 CodeMirror 언어 파서가 유휴 시간에
 * 배경 파싱을 이어 가며(한 번에 최대 약 50 ms), 찾기와 무관하게 측정 창에 걸린다(이슈 3.8 진행 기록).
 *
 * 시간을 재는 시험이라 기계 부하에 흔들린다. 평소 e2e 에서는 건너뛰고 `OTTER_E2E_PERF=1` 일 때만 돈다(이슈 3.8).
 */
import * as fs from 'fs';
import * as path from 'path';

import { APIRequestContext, CDPSession, Page } from '@playwright/test';

import { ED_SEL } from './editor';
import { test, expect, rmTree, switchToEditorRoot, openExplorerSide, nextFrames } from './fixtures';
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

// 렌더러 메인 스레드(`CrRendererMain`)의 작업 길이(ms)를 화면 프레임·유휴 콜백·그 밖으로 나눈다. 긴 것부터.
function mainTasks(events: TraceEvent[]): { work: number[]; frame: number[]; idle: number[] } {
  const main = new Set(events
    .filter((e) => e.ph === 'M' && e.name === 'thread_name' && e.args?.name === 'CrRendererMain')
    .map((e) => `${e.pid}:${e.tid}`));
  const on = (e: TraceEvent) => main.has(`${e.pid}:${e.tid}`);
  const inside = (name: string) => {
    const xs = events.filter((e) => e.name === name && on(e));
    return (t: TraceEvent) => xs.some((f) => f.ts >= t.ts && f.ts <= t.ts + (t.dur || 0));
  };
  const isFrame = inside('FireAnimationFrame');
  const isIdle = inside('FireIdleCallback');
  const out = { work: [] as number[], frame: [] as number[], idle: [] as number[] };
  for (const t of events.filter((e) => e.ph === 'X' && e.name === 'RunTask' && on(e))) {
    (isFrame(t) ? out.frame : isIdle(t) ? out.idle : out.work).push((t.dur || 0) / 1000);
  }
  for (const xs of Object.values(out)) xs.sort((a, b) => b - a);
  return out;
}

test.describe('큰 파일 찾기의 메인 스레드 작업', () => {
  test.skip(process.env.OTTER_E2E_PERF !== '1', '성능 시험은 OTTER_E2E_PERF=1 일 때만 돈다');

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
    await nextFrames(page, 2);
    const { work, frame, idle } = mainTasks(await traceStop(cdp));

    const top = (xs: number[]) => xs.slice(0, 5).map((d) => d.toFixed(1)).join(',');
    console.log(`find-main-task-ms work=${top(work)} frame=${top(frame)} idle=${top(idle)}`);
    const over = (xs: number[]) => xs.filter((d) => d > TASK_BUDGET_MS).map((d) => d.toFixed(1));
    expect(over(work), `16 ms 를 넘은 찾기 계산 작업: ${over(work).join(', ')}`).toEqual([]);
    expect(over(frame), `16 ms 를 넘은 화면 프레임: ${over(frame).join(', ')}`).toEqual([]);
  });
});
