import { test, expect, waitForInit } from './fixtures';
import { numberedLinesCmd } from './osenv';

// V-M9-3b — PTY 크기 통보 (M9_SRS FR-M9-3, D-M9-3)
//
// 접수한 증상은 "다른 기기에서 쓰고 돌아오면 위쪽 글의 렌더가 이상하다" 였고,
// 재감사가 기전을 확정했다 (SRS §2.3 M9-B3): 폭이 다른 두 클라이언트가 같은
// 도구를 볼 때, PTY 를 잡은 쪽 기준의 이스케이프를 다른 쪽이 **자기 폭으로**
// 해석한다. 실측에서 모바일에는 19줄이 온전했는데 데스크톱에는 앞 4줄이
// 사라졌다.
//
// 크로스 기기 프록시는 `browser.newContext()` 다 — `focus-owner.spec.ts` 가
// 이미 쓰는 패턴이며 clientId 와 BroadcastChannel 스코프가 모두 갈린다.
//
// 재는 것은 **두 xterm 이 같은 좌표계에 서는가** 하나다. 그것이 서면 같은
// 바이트가 같은 화면이 되고, 서지 않으면 무엇을 해도 어긋난다.

async function newClient(browser, size: { width: number; height: number }) {
  const ctx = await browser.newContext({ viewport: size });
  await ctx.addInitScript(() => sessionStorage.setItem('displayMode', 'desktop'));
  const page = await ctx.newPage();
  await waitForInit(page);
  return { ctx, page };
}

// 이 클라이언트가 그리는 첫 터미널의 크기와 그 패널이 아는 PTY 크기.
const sizeOf = (page) => page.evaluate(() => {
  const app = (window as any).app;
  const p = [...app.tools.values()][0] as any;
  if (!p || !p.term) return null;
  return { cols: p.term.cols, rows: p.term.rows, ptyCols: p._ptyCols, ptyRows: p._ptyRows };
});

// 화면에 그려진 글줄 (빈 줄 제외). 두 클라이언트의 해석을 견주는 값이다.
const linesOf = (page) => page.evaluate(() => {
  const app = (window as any).app;
  const p = [...app.tools.values()][0] as any;
  const b = p.term.buffer.active;
  const out: string[] = [];
  for (let i = 0; i < b.length; i++) {
    const s = (b.getLine(i)?.translateToString(true) || '').trim();
    if (s) out.push(s);
  }
  return out;
});

const typeInto = (page, text: string) => page.evaluate((t) => {
  const app = (window as any).app;
  const p = [...app.tools.values()][0] as any;
  p._sendText(t);
}, text);

test.describe('V-M9-3b — 크기는 서버가 통보하고 비소유자가 따른다', () => {
  test('TC-M9-3a: 폭이 다른 두 클라이언트의 cols·rows 가 같아진다 (FR-M9-3)', async ({ browser }) => {
    // 좁은 쪽을 **나중에** 띄운다 — 마지막으로 포커스를 주장한 쪽이 크기의
    // 주인이므로(FR-XDF-2 last-focus-wins), 그쪽이 PTY 를 잡는다.
    const wide = await newClient(browser, { width: 1440, height: 900 });
    const narrow = await newClient(browser, { width: 390, height: 844 });

    // 좁은 쪽이 잡은 크기로 넓은 쪽이 수렴한다. 수렴의 계기는 `OpSize` 하나다.
    await expect.poll(async () => {
      const w = await sizeOf(wide.page);
      const n = await sizeOf(narrow.page);
      if (!w || !n) return 'not-ready';
      return `${w.cols}x${w.rows} vs ${n.cols}x${n.rows}`;
    }, { timeout: 15000 }).toMatch(/^(\d+)x(\d+) vs \1x\2$/);

    // 그리고 그 값은 **통보받은 PTY 크기**여야 한다 — 우연히 같아진 것이 아니다.
    const w = await sizeOf(wide.page);
    expect(w!.cols).toBe(w!.ptyCols);
    expect(w!.rows).toBe(w!.ptyRows);

    await narrow.ctx.close();
    await wide.ctx.close();
  });

  test('TC-M9-3b: 두 클라이언트가 같은 글을 본다 — 앞줄이 사라지지 않는다 (M9-B3)', async ({ browser }) => {
    const wide = await newClient(browser, { width: 1440, height: 900 });
    const narrow = await newClient(browser, { width: 390, height: 844 });

    await expect.poll(async () => {
      const w = await sizeOf(wide.page);
      const n = await sizeOf(narrow.page);
      return w && n ? w.cols === n.cols : false;
    }, { timeout: 15000 }).toBe(true);

    // 좁은 폭에서 줄바꿈이 일어나는 길이로 낸다 — 폭 해석이 어긋나면 여기서
    // 갈린다. 실측에서 사라진 것이 정확히 이런 줄들의 앞부분이었다.
    // 반복 문법은 셸마다 다르다 — 재려는 것은 여러 줄이 두 클라이언트에 같게
    // 보이는가이지 그 문법이 아니다 (osenv 의 규약).
    await typeInto(narrow.page, numberedLinesCmd('ROW-', 8, ' ----------------------------') + '\r');

    await expect.poll(() => linesOf(narrow.page).then((l) => l.filter((s) => s.startsWith('ROW-')).length),
      { timeout: 15000 }).toBe(8);
    await expect.poll(() => linesOf(wide.page).then((l) => l.filter((s) => s.startsWith('ROW-')).length),
      { timeout: 15000 }).toBe(8);

    const nl = (await linesOf(narrow.page)).filter((s) => s.startsWith('ROW-'));
    const wl = (await linesOf(wide.page)).filter((s) => s.startsWith('ROW-'));
    expect(wl).toEqual(nl);

    await narrow.ctx.close();
    await wide.ctx.close();
  });
});
