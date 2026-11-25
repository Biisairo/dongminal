import { test, expect, waitForInit } from './fixtures';
import { cursorEndMarkCmd, ptyRecordsRawOutput } from './osenv';

// V-M10-4·5 — 돌아온 기기가 자기 폭을 되찾는다 (M10_SRS FR-M10-1·2)
//
// `term-size.spec.ts` 가 재는 것은 비소유자가 PTY 를 **따라가는가**(FR-M9-3)이고,
// 이 파일이 재는 것은 그 따라가기가 **끝나는 순간**이다 — 소유를 되찾은 창이
// 자기 폭으로 돌아오는가, 그리고 그 화면이 데몬 스냅숏으로 다시 서는가.
//
// 크로스 기기 프록시는 `browser.newContext()` 다. 소유권 주장은 `setFocus` 로
// 한다 — 두 컨텍스트가 동시에 OS 포커스를 보고할 수 있어 클릭은 결정론적이지
// 않다 (`focus-owner.spec.ts` 와 같은 근거).

async function newClient(browser, size: { width: number; height: number }) {
  const ctx = await browser.newContext({ viewport: size });
  await ctx.addInitScript(() => sessionStorage.setItem('displayMode', 'desktop'));
  const page = await ctx.newPage();
  await waitForInit(page);
  return { ctx, page };
}

const claim = (page) => page.evaluate(() => (window as any).app.focus.setFocus((window as any).app.focused));

const sizeOf = (page) => page.evaluate(() => {
  const app = (window as any).app;
  const p = [...app.tools.values()][0] as any;
  if (!p || !p.term) return null;
  return { cols: p.term.cols, rows: p.term.rows, ptyCols: p._ptyCols, ownCols: p._ownCols };
});

const typeInto = (page, text: string) => page.evaluate((t) => {
  const app = (window as any).app;
  const p = [...app.tools.values()][0] as any;
  p._sendText(t);
}, text);

// **논리 줄** — `isWrapped` 로 이어진 물리 줄을 한 줄로 합친다.
//
// 길이가 판정의 값이다. 폭에 맞게 다시 그려졌으면 절대 좌표가 그 폭으로
// 클램프되어 줄이 짧아지고, 옛 폭의 그림이 남았으면 길이가 그대로다.
const logicalLines = (page) => page.evaluate(() => {
  const app = (window as any).app;
  const p = [...app.tools.values()][0] as any;
  const b = p.term.buffer.active;
  const out: string[] = [];
  for (let i = 0; i < b.length; i++) {
    const l = b.getLine(i);
    if (!l) continue;
    const s = l.translateToString(true);
    if (l.isWrapped && out.length) out[out.length - 1] += s;
    else out.push(s);
  }
  return out.filter((s) => s.trim());
});

const markerLine = async (page, tag: string) =>
  (await logicalLines(page)).find((s) => s.startsWith(tag)) || '';

/**
 * 그 표식이 붙은 **모든** 논리 줄의 길이.
 *
 * `markerLine` 은 **첫 줄**을 집는다. 스냅숏이 화면을 갈아 끼웠다면 그 줄은 한 벌뿐이어야
 * 하므로, 모두 모아 몇 벌인지까지 본다 (PERF 4.15.2).
 */
const markerLens = async (page, tag: string) =>
  (await logicalLines(page)).filter((s) => s.startsWith(tag)).map((s) => s.length);

// 좁은 쪽 xterm 에만 써 넣는 줄의 머리 — PTY 를 거치지 않으므로 데몬 화면에는 없다.
const LOCAL_ONLY = 'LOCALONLY';

test.describe('V-M10-4·5 — 소유를 되찾은 창이 자기 폭으로 선다', () => {
  test('TC-M10-1: 되찾은 넓은 창의 cols 와 PTY 가 모두 자기 폭이 된다 (FR-M10-1)', async ({ browser }) => {
    // 좁은 쪽을 나중에 띄운다 — last-focus-wins 이므로 그쪽이 PTY 를 잡는다.
    const wide = await newClient(browser, { width: 1440, height: 900 });
    const narrow = await newClient(browser, { width: 390, height: 844 });

    // 넓은 쪽이 좁은 폭으로 수렴한 것을 먼저 확인한다 (FR-M9-3 — 여기까지는 M9 다).
    await expect.poll(async () => {
      const w = await sizeOf(wide.page);
      const n = await sizeOf(narrow.page);
      return w && n ? w.cols === n.cols : false;
    }, { timeout: 15000 }).toBe(true);

    const narrowCols = (await sizeOf(narrow.page))!.cols;
    const wideOwn = (await sizeOf(wide.page))!.ownCols;
    // 따라갔어도 자기 폭은 남아 있어야 한다 — 그것이 되찾을 때 되보낼 값이다.
    expect(wideOwn).toBeGreaterThan(narrowCols);

    // 넓은 쪽이 포커스를 되찾는다.
    await claim(wide.page);

    // 되찾은 창의 xterm 과 PTY 가 **모두** 자기 폭이어야 한다. 물려받은 폭이
    // 되돌아가면 PTY 는 그대로이고 사용자는 새로고침을 해야 한다 (M10-B1).
    await expect.poll(async () => {
      const w = await sizeOf(wide.page);
      return w ? `${w.cols}/${w.ptyCols}` : 'not-ready';
    }, { timeout: 15000 }).toMatch(/^(\d+)\/\1$/);

    const w = (await sizeOf(wide.page))!;
    expect(w.cols).toBeGreaterThan(narrowCols);

    await narrow.ctx.close();
    await wide.ctx.close();
  });

  /**
   * PERF 4.15.2: **재생은 데몬 스냅숏이다** (PERF 2.5, FR-TRM-3·4).
   *
   *   이전 전제: 전량 재생이 원본 바이트를 새 폭에서 다시 파싱해, `ESC[<W>G` 로 그린 줄이
   *             좁은 폭으로 다시 선다
   *   지금 동작: 데몬 에뮬레이터가 PTY 크기를 따라 리플로우한 화면을 스냅숏으로 보낸다.
   *             절대 좌표는 그린 순간에 해소되므로 그 줄은 옛 폭 그대로 접혀 남는다
   *
   * 그래서 재는 것은 *되찾은 화면이 데몬 스냅숏으로 바뀌었는가* 와 *그 줄이 한 벌뿐인가* 다.
   */
  test('TC-M10-2: 폭이 바뀐 되찾기는 데몬 스냅숏으로 화면을 다시 받는다 (FR-M10-2)', async ({ browser }) => {
    const wide = await newClient(browser, { width: 1440, height: 900 });
    const narrow = await newClient(browser, { width: 390, height: 844 });

    await expect.poll(async () => {
      const w = await sizeOf(wide.page);
      const n = await sizeOf(narrow.page);
      return w && n ? w.cols === n.cols : false;
    }, { timeout: 15000 }).toBe(true);

    // 넓은 쪽이 먼저 소유해 **넓은 폭 기준의 절대 좌표**를 스크롤백에 남긴다.
    await claim(wide.page);
    await expect.poll(async () => {
      const w = await sizeOf(wide.page);
      const n = await sizeOf(narrow.page);
      return w && n ? w.cols === n.cols && w.cols > 100 : false;
    }, { timeout: 15000 }).toBe(true);

    const wideCols = (await sizeOf(wide.page))!.cols;
    await typeInto(wide.page, cursorEndMarkCmd('WIDEMARK', 'R') + '\r');

    await expect.poll(() => markerLine(wide.page, 'WIDEMARK').then((s) => s.length),
      { timeout: 15000 }).toBe(wideCols);
    await expect.poll(() => markerLine(narrow.page, 'WIDEMARK').then((s) => s.length),
      { timeout: 15000 }).toBe(wideCols);

    // 좁은 쪽 xterm 에만 있는 줄이다 — PTY·데몬은 모른다. 스냅숏이 화면을 갈아 끼우면 사라지고,
    // 재생 없이 xterm 리플로우만 하면 남는다 (M10-B2 의 회귀).
    await narrow.page.evaluate((t) => {
      const p = [...(window as any).app.tools.values()][0] as any;
      p.term.write('\r\n' + t + '\r\n');
    }, LOCAL_ONLY);
    await expect.poll(async () => (await logicalLines(narrow.page)).some((s) => s.includes(LOCAL_ONLY)),
      { timeout: 5000 }).toBe(true);

    await claim(narrow.page);

    await expect.poll(async () => {
      const n = await sizeOf(narrow.page);
      return n ? n.cols : 0;
    }, { timeout: 15000 }).toBeLessThan(wideCols);

    const narrowCols = (await sizeOf(narrow.page))!.cols;

    // `_ptyCols` 는 **서버가 통보한 PTY 폭**이다 (FR-M9-3). 되찾은 폭이 PTY 까지 닿았는가를 먼저 묻는다.
    await expect.poll(async () => (await sizeOf(narrow.page))?.ptyCols,
      { timeout: 15000, message: '되찾은 폭이 PTY 까지 닿지 않았다 (FR-M10-1 의 뒷면)' })
      .toBe(narrowCols);

    await expect.poll(async () => (await logicalLines(narrow.page)).some((s) => s.includes(LOCAL_ONLY)),
      { timeout: 15000, message: '되찾은 화면이 데몬 스냅숏으로 바뀌지 않았다 (M10-B2)' })
      .toBe(false);

    /**
     * ConPTY 는 기록이 원본이 아니라 그 시점의 렌더링이고, 리사이즈 때 자기 버퍼를 새 폭으로
     * 다시 내보낸다 — 데몬 화면에 옛 그림과 새 그림이 함께 설 수 있다 (2026-09-16 실측 근거:
     * WINDOWS_TEST_PARITY_SRS §7). 줄의 모양은 원본을 기록하는 PTY 에서만 묻는다.
     */
    if (!ptyRecordsRawOutput) {
      test.info().annotations.push({
        type: 'platform-gap',
        description: 'FR-M10-2 의 줄 모양(옛 폭 그대로 한 벌)은 원본을 기록하는 PTY 에서만 묻는다 ' +
          '(ConPTY 는 렌더링을 준다) — WINDOWS_TEST_PARITY_SRS §7',
      });
      return;
    }

    // 절대 좌표는 데몬이 그린 순간에 해소됐다 — 그 줄은 옛 폭 그대로 접혀 **한 벌만** 남는다.
    const lens = await markerLens(narrow.page, 'WIDEMARK');
    expect(lens, '스냅숏의 WIDEMARK 줄이 한 벌이 아니거나 옛 폭이 아니다').toEqual([wideCols]);
    expect((await markerLine(narrow.page, 'WIDEMARK')).endsWith('R')).toBe(true);

    await narrow.ctx.close();
    await wide.ctx.close();
  });
});
