import { Page } from '@playwright/test';

import { test, expect, waitForInit } from './fixtures';

/**
 * RAIL_CHAT_USAGE_SRS — 레일의 채팅 목록과 Claude 사용량.
 *
 *   TC-RCU-1  사이드바 레일의 채팅 탭: 보이는 채팅 요소는 레일 폭 안이고, 감춘 요소는 보이지 않으며,
 *             방·사람 이름은 두 줄 이하다 (FR-RCU-1·2)
 *   TC-RCU-2  Activity 레일: 사용량 요약 줄이 보이고 `%` 가 있으며 레일 폭 안이다. 계정 줄은 보이지 않는다 (FR-RCU-3)
 *
 * 사용량은 `claude-accounts.spec` 처럼 브라우저에서 `/api/claude-accounts*` 응답을 위조한다 (D-CAC-32).
 */
const railW = (page: Page) =>
  page.evaluate(() => Math.round(parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sb-rail-w'))));

const NOW = () => Math.floor(Date.now() / 1000);
const win = (pct: number, inSec: number) =>
  ({ pct, resetsAt: NOW() + inSec, resetsInSec: inSec, level: pct >= 90 ? 'critical' : pct >= 70 ? 'warn' : '' });

async function installUsageMock(page: Page) {
  const accounts = [
    { id: 'a', email: 'alice@x.com', alias: 'Work', color: 'acct-3', disabled: false, priority: 0, active: true,
      usage: { status: 'ok', ageSeconds: 10, windows: { fiveHour: win(34, 7800), sevenDay: win(72, 368000) } } },
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

  test('TC-RCU-2: Activity 레일에 사용량 요약이 작게 보인다', async ({ page }) => {
    await installUsageMock(page);
    await waitForInit(page, { mode: 'desktop' });
    const panel = page.locator('#agents-panel');
    if (await panel.evaluate((e) => e.classList.contains('open'))) await panel.locator('.ag-collapse').click();
    await expect(panel).not.toHaveClass(/\bopen\b/);
    await expect(panel).toHaveAttribute('data-rail', /.*/);
    const rw = await railW(page);

    const sum = panel.locator('.act-usage-sum');
    await expect(sum).toBeVisible({ timeout: 10000 });
    await expect(sum).toContainText('%');
    const check = async () => {
      expect((await sum.boundingBox())!.width).toBeLessThanOrEqual(rw);
      // 칸이 요약 줄 밖으로 넘쳐 잘리지 않는다 — 단추의 고정 높이가 세로로 쌓인 칸을 자르면 주간 % 가 화면 밖으로 간다.
      const sb = (await sum.boundingBox())!;
      const cb = (await sum.locator('.cacct-cells').boundingBox())!;
      expect(cb.y + cb.height).toBeLessThanOrEqual(sb.y + sb.height + 1);
      for (const b of await boxes(page, '#agents-panel .act-usage-foot *')) {
        expect(b.w, `${b.cls} 의 폭`).toBeLessThanOrEqual(rw);
      }
      for (const sel of ['.cacct', '.act-usage-head', '.act-usage-sl', '.act-usage-sl-h', '.act-usage-sum .cacct-name',
        '.act-usage-sum .cacct-cell-label', '.act-usage-sum .cacct-cell-left', '.act-usage-sum > .ui-icon']) {
        expect(await boxes(page, '#agents-panel ' + sel), `${sel} 가 레일에 보인다`).toEqual([]);
      }
      await expect(sum.locator('.cacct-cell-pct').first()).toBeVisible();
    };
    await check();
    // 펼쳐 둔 상태여도 레일에서는 요약만 보인다 (D-RCU-2).
    const open = await sum.getAttribute('aria-expanded');
    await sum.click();
    await expect(panel.locator('.act-usage-sum')).toHaveAttribute('aria-expanded', open === 'true' ? 'false' : 'true');
    await check();
  });
});
