import { Page } from '@playwright/test';

import { test, expect, waitForInit } from './fixtures';

/**
 * RAIL_CHAT_USAGE_SRS — 레일의 채팅 목록과 Claude 사용량.
 *
 *   TC-RCU-1  사이드바 레일의 채팅 탭: 보이는 채팅 요소는 레일 폭 안이고, 감춘 요소는 보이지 않으며,
 *             방·사람 이름은 두 줄 이하다 (FR-RCU-1·2)
 *   TC-RCU-2  Activity 레일: 사용량 요약 줄이 보이고 레일 폭 안이다. 계정 줄은 보이지 않는다.
 *             세션·주간 두 칸이 나란히 서고, 칸마다 아래부터 창 이름(5h·7d) · 세로 막대 · 값 순이다 (FR-RCU-3 개정)
 *             개정 2: 칸 위에 색 점과 계정 이름(두 줄 이하)이 서고, 값은 `%` 없이 숫자만이며 가로로 줄지 않는다.
 *             글자 상자끼리 1px 이상 떨어진다 — 짧은 이름과 긴 이름 둘 다
 *   TC-RCU-4  사이드바 레일: 고른 창과 고르지 않은 창의 이름이 같은 모양으로 서고, 들어가는 이름은 한 줄이다 (FR-RCU-6)
 *
 * 사용량은 `claude-accounts.spec` 처럼 브라우저에서 `/api/claude-accounts*` 응답을 위조한다 (D-CAC-32).
 */
const railW = (page: Page) =>
  page.evaluate(() => Math.round(parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sb-rail-w'))));

const NOW = () => Math.floor(Date.now() / 1000);
const win = (pct: number, inSec: number) =>
  ({ pct, resetsAt: NOW() + inSec, resetsInSec: inSec, level: pct >= 90 ? 'critical' : pct >= 70 ? 'warn' : '' });

async function installUsageMock(page: Page, alias = 'Work', five = 34) {
  const accounts = [
    { id: 'a', email: 'alice@x.com', alias, color: 'acct-3', disabled: false, priority: 0, active: true,
      usage: { status: 'ok', ageSeconds: 10, windows: { fiveHour: win(five, 7800), sevenDay: win(72, 368000) } } },
    { id: 'b', email: 'bob@y.org', color: 'acct-6', disabled: false, priority: 0, active: false,
      usage: { status: 'ok', ageSeconds: 10, windows: { fiveHour: win(5, 9000), sevenDay: win(10, 400000) } } },
  ];
  await page.route('**/api/claude-accounts**', async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname.replace('/api/claude-accounts', '') || '/';
    const json = (data: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });
    switch (req.method() + ' ' + path) {
      case 'GET /': return json({ activeId: 'a', autoswitch: { enabled: false, status: 'off' }, otherStatusLines: [], accounts });
      case 'GET /mappings': return json({ folders: {}, tabs: {} });
      case 'GET /resolve': return json({ source: 'none' });
      default: return route.fallback();
    }
  });
}

/** 보이는 요소들의 폭·높이·줄 높이를 잰다. */
async function boxes(page: Page, sel: string) {
  return page.locator(sel).evaluateAll((els) => els
    .filter((e) => e.checkVisibility())
    .map((e) => {
      const r = e.getBoundingClientRect();
      return { cls: e.getAttribute('class'), w: r.width, h: r.height, lh: parseFloat(getComputedStyle(e).lineHeight) || parseFloat(getComputedStyle(e).fontSize) * 1.3 };
    }));
}

test.describe('RAIL_CHAT_USAGE 레일의 채팅·사용량', () => {
  test('TC-RCU-1: 사이드바 레일의 채팅 탭은 레일 말씨다', async ({ page }) => {
    await waitForInit(page, { mode: 'desktop' });
    await page.locator('#sidebar .sb-collapse').click();
    await expect(page.locator('#sidebar')).toHaveAttribute('data-rail', /.*/);
    await page.locator('#sb-tabs [data-panel="chat"]').click();
    await expect(page.locator('#sb-panel-chat')).toBeVisible();
    const list = page.locator('#chat-list');
    // 기본 환경: 방이 없고 온라인에 이 PC 의 사람이 선다 — 빈 안내와 구역 제목이 함께 있다.
    await expect(list.locator('.chat-person')).not.toHaveCount(0, { timeout: 10000 });
    const rw = await railW(page);

    for (const sel of ['.chat-sub-h', '.chat-none', '.chat-row-sub', '.chat-act', '.chat-node', '.chat-down', '.chat-row-more', '.chat-row-n']) {
      const vis = await boxes(page, '#chat-list ' + sel);
      expect(vis, `${sel} 가 레일에 보인다`).toEqual([]);
    }
    const all = await boxes(page, '#chat-list *');
    for (const b of all) expect(b.w, `${b.cls} 의 폭`).toBeLessThanOrEqual(rw);
    const names = await boxes(page, '#chat-list .chat-row-name');
    expect(names.length).toBeGreaterThan(0);
    for (const b of names) expect(b.h, `${b.cls} 가 두 줄을 넘는다`).toBeLessThanOrEqual(b.lh * 2 + 1);
  });

  for (const acct of ['업무 계정', 'Claude Max 업무용 공유 계정 alice@example.com']) test(`TC-RCU-2: Activity 레일에 사용량 요약이 작게 보인다 (${acct})`, async ({ page }) => {
    await installUsageMock(page, acct, 100);
    await waitForInit(page, { mode: 'desktop' });
    const panel = page.locator('#agents-panel');
    if (await panel.evaluate((e) => e.classList.contains('open'))) await panel.locator('.ag-collapse').click();
    await expect(panel).not.toHaveClass(/\bopen\b/);
    await expect(panel).toHaveAttribute('data-rail', /.*/);
    const rw = await railW(page);

    const sum = panel.locator('.act-usage-sum');
    await expect(sum).toBeVisible({ timeout: 10000 });
    const check = async () => {
      expect((await sum.boundingBox())!.width).toBeLessThanOrEqual(rw);
      // 칸이 요약 줄 밖으로 넘쳐 잘리지 않는다 — 단추의 고정 높이가 세로로 쌓인 칸을 자르면 주간 % 가 화면 밖으로 간다.
      const sb = (await sum.boundingBox())!;
      const cb = (await sum.locator('.cacct-cells').boundingBox())!;
      expect(cb.y + cb.height).toBeLessThanOrEqual(sb.y + sb.height + 1);
      for (const b of await boxes(page, '#agents-panel .act-usage-foot *')) {
        expect(b.w, `${b.cls} 의 폭`).toBeLessThanOrEqual(rw);
      }
      for (const sel of ['.cacct', '.act-usage-head', '.act-usage-sl', '.act-usage-sl-h',
        '.act-usage-sum .cacct-cell-label', '.act-usage-sum .cacct-cell-left', '.act-usage-sum > .ui-icon']) {
        expect(await boxes(page, '#agents-panel ' + sel), `${sel} 가 레일에 보인다`).toEqual([]);
      }
      await expect(sum.locator('.cacct-cell-pct').first()).toBeVisible();
      // FR-RCU-3 (개정): 두 칸이 나란히 — 칸마다 아래부터 창 이름 · 세로 막대 · %.
      const cells = await sum.locator('.cacct-cell').evaluateAll((els) => els.map((c) => {
        const rect = (sel: string) => { const e = sel ? c.querySelector(sel) : c; if (!e || !e.checkVisibility()) return null; const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, b: r.bottom, rt: r.right }; };
        return { cell: rect(''), win: rect('.cacct-cell-win'), bar: rect('.cacct-cell-bar'), fill: rect('.cacct-cell-fill'), pct: rect('.cacct-cell-pct'),
          winText: c.querySelector('.cacct-cell-win')?.textContent, pctText: c.querySelector('.cacct-cell-pct')?.textContent,
          fillBg: getComputedStyle(c.querySelector('.cacct-cell-fill')!).backgroundColor, lv: c.className };
      }));
      expect(cells.length).toBe(2);
      expect(cells.map((c) => c.winText)).toEqual(['5h', '7d']);
      for (const c of cells) {
        expect(c.win && c.bar && c.pct && c.fill, `${c.winText} 칸의 이름·막대·% 가 보인다`).toBeTruthy();
        expect(c.pct!.b, '% 가 막대 위').toBeLessThanOrEqual(c.bar!.y + 1);
        expect(c.bar!.b, '막대가 창 이름 위').toBeLessThanOrEqual(c.win!.y + 1);
        expect(c.bar!.h, '막대가 세로로 길다').toBeGreaterThan(c.bar!.w * 2);
        expect(Math.abs(c.fill!.b - c.bar!.b), '채움이 막대 바닥에서 선다').toBeLessThanOrEqual(1);
        expect(Math.abs(c.fill!.h - c.bar!.h * parseInt(c.pctText!) / 100), '채움 높이가 % 를 따른다').toBeLessThanOrEqual(1.5);
        expect(c.cell!.rt).toBeLessThanOrEqual(sb.x + sb.width + 1);
      }
      const [s5, s7] = cells;
      expect(s5.cell!.rt, '두 칸이 나란히').toBeLessThanOrEqual(s7.cell!.x + 1);
      expect(Math.abs(s5.win!.y - s7.win!.y), '창 이름이 같은 바닥 줄').toBeLessThanOrEqual(1);
      expect(Math.abs(s5.bar!.y - s7.bar!.y)).toBeLessThanOrEqual(1);
      // 72% 는 주의 단계다 — 막대 색이 보통 칸과 다르다.
      expect(s7.lv).toContain('lv-warn');
      expect(s7.fillBg).not.toBe(s5.fillBg);
      // 색 점은 칸 위에 남는다.
      const dot = (await sum.locator('.cacct-dot').boundingBox())!;
      expect(dot.y + dot.height).toBeLessThanOrEqual(Math.min(s5.pct!.y, s7.pct!.y) + 1);
      // 개정 2: 값은 `%` 없는 숫자이고 가로로 줄지 않는다.
      expect(await sum.locator('.cacct-cell-pct').evaluateAll((els) => els.map((e) => (e as HTMLElement).innerText))).toEqual(['100', '72']);
      for (const t of await sum.locator('.cacct-cell-pct').evaluateAll((els) => els.map((e) => getComputedStyle(e).transform))) expect(t).toBe('none');
      // 개정 2: 계정 이름이 칸 위에 보이고 두 줄 이하이며, 전체 이름은 title 이다.
      const name = sum.locator('.cacct-name');
      await expect(name).toBeVisible();
      await expect(name).toHaveAttribute('title', acct);
      const [nb] = await boxes(page, '#agents-panel .act-usage-sum .cacct-name');
      expect(nb.h, '이름이 두 줄을 넘는다').toBeLessThanOrEqual(nb.lh * 2 + 1);
      expect(nb.h, '이름이 한 줄도 안 보인다').toBeGreaterThanOrEqual(nb.lh - 1);
      // 개정 2: 글자·점·막대 상자가 서로 닿지 않고(1px 이상), 모두 레일 안쪽(테두리 제외)이다.
      const rects = await panel.evaluate((p) => {
        const pr = p.getBoundingClientRect();
        const inner = { l: pr.left + parseFloat(getComputedStyle(p).borderLeftWidth), r: pr.right - parseFloat(getComputedStyle(p).borderRightWidth) };
        const els = [...p.querySelectorAll('.act-usage-sum :is(.cacct-dot,.cacct-name,.cacct-cell-pct,.cacct-cell-bar,.cacct-cell-win)')]
          .filter((e) => e.checkVisibility());
        return { inner, list: els.map((e) => { const r = e.getBoundingClientRect(); return { c: e.className + ':' + (e.textContent || ''), l: r.left, r: r.right, t: r.top, b: r.bottom }; }) };
      });
      expect(rects.list.length).toBe(8);
      for (const a of rects.list) {
        expect(a.l, `${a.c} 가 레일 왼쪽 밖`).toBeGreaterThanOrEqual(rects.inner.l - 0.5);
        expect(a.r, `${a.c} 가 레일 오른쪽 밖`).toBeLessThanOrEqual(rects.inner.r + 0.5);
      }
      for (let i = 0; i < rects.list.length; i++) for (let j = i + 1; j < rects.list.length; j++) {
        const a = rects.list[i], b = rects.list[j];
        const gap = Math.max(b.l - a.r, a.l - b.r, b.t - a.b, a.t - b.b);
        expect(gap, `${a.c} 와 ${b.c} 가 붙었다`).toBeGreaterThanOrEqual(1);
      }
    };
    await check();
    // 펼쳐 둔 상태여도 레일에서는 요약만 보인다 (D-RCU-2).
    const open = await sum.getAttribute('aria-expanded');
    await sum.click();
    await expect(panel.locator('.act-usage-sum')).toHaveAttribute('aria-expanded', open === 'true' ? 'false' : 'true');
    await check();
  });

  test('TC-RCU-4: 사이드바 레일의 창 이름은 고름과 무관하게 같은 모양이다', async ({ page }) => {
    await waitForInit(page, { mode: 'desktop' });
    const rows = page.locator('#sidebar .sbl-item.si');
    const n = await rows.count();
    await page.evaluate(() => (window as any).app.testing.execRemote('newWindow', {}));
    await expect(rows).toHaveCount(n + 1);
    // 첫 창을 `ccr#32` 로 — 활성은 새 창이다.
    await page.evaluate(() => (window as any).app.testing.execRemote('renameWindow', { location: 'W1.P1.T1', name: 'ccr#32' }));
    const target = rows.filter({ hasText: 'ccr#32' });
    await expect(target).toHaveCount(1);
    await expect(target).not.toHaveClass(/\bactive\b/);
    await page.locator('#sidebar .sb-collapse').click();
    await expect(page.locator('#sidebar')).toHaveAttribute('data-rail', /.*/);

    const measure = () => page.locator('#sidebar .sbl-item.si .sbl-name').evaluateAll((els) => els.map((e) => {
      const r = document.createRange();
      r.selectNodeContents(e);
      const cs = getComputedStyle(e);
      return { text: e.textContent, active: e.parentElement!.classList.contains('active'), lines: r.getClientRects().length,
        w: e.getBoundingClientRect().width, h: e.getBoundingClientRect().height, fw: cs.fontWeight };
    }));
    const before = await measure();
    const idle = before.find((b) => b.text === 'ccr#32')!;
    const sel = before.find((b) => b.active)!;
    expect(idle.lines, '고르지 않은 ccr#32 가 두 줄로 꺾인다').toBe(1);
    expect(idle.fw, '고름에 따라 글자 굵기가 달라 폭이 갈린다').toBe(sel.fw);
    expect(idle.w).toBe(sel.w);

    await target.click();
    await expect(target).toHaveClass(/\bactive\b/);
    const after = (await measure()).find((b) => b.text === 'ccr#32')!;
    expect(after.lines).toBe(1);
    expect(after.h).toBe(idle.h);
  });
});
