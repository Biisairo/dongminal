import { test, expect, waitForInit } from './fixtures';
import { cursorEndMarkCmd } from './osenv';

// V-M10-4·5 — 돌아온 기기가 자기 폭을 되찾는다 (M10_SRS FR-M10-1·2)
//
// `term-size.spec.ts` 가 재는 것은 비소유자가 PTY 를 **따라가는가**(FR-M9-3)이고,
// 이 파일이 재는 것은 그 따라가기가 **끝나는 순간**이다 — 소유를 되찾은 창이
// 자기 폭으로 돌아오는가, 그리고 스크롤백이 그 폭으로 다시 서는가.
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

const claim = (page) => page.evaluate(() => (window as any).app.setFocus((window as any).app.focused));

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

  test('TC-M10-2: 옛 폭에서 그려진 스크롤백이 새 폭으로 다시 선다 (FR-M10-2)', async ({ browser }) => {
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
    // `\033[<W>G` 는 그 폭의 오른쪽 끝이다. 줄바꿈이 아니라 **좌표**이므로
    // xterm 의 리플로우로는 되돌아가지 않는다 — 다시 그리는 길은 전량 재생뿐이다.
    await typeInto(wide.page, cursorEndMarkCmd('WIDEMARK', 'R') + '\r');

    await expect.poll(() => markerLine(wide.page, 'WIDEMARK').then((s) => s.length),
      { timeout: 15000 }).toBe(wideCols);

    // 좁은 쪽이 소유권을 가져간다. PTY 가 좁아지고, 그 줄은 좁은 폭으로 다시
    // 그려져야 한다 — 다시 그리지 않으면 넓은 폭 그대로 남는다 (M10-B2).
    await claim(narrow.page);

    await expect.poll(async () => {
      const n = await sizeOf(narrow.page);
      return n ? n.cols : 0;
    }, { timeout: 15000 }).toBeLessThan(wideCols);

    const narrowCols = (await sizeOf(narrow.page))!.cols;
    await expect.poll(() => markerLine(narrow.page, 'WIDEMARK').then((s) => s.length),
      { timeout: 15000 }).toBe(narrowCols);

    await narrow.ctx.close();
    await wide.ctx.close();
  });
});
