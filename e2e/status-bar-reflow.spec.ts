import { Page } from '@playwright/test';

import { test, expect, waitForInit } from './fixtures';

// STATUS_BAR_REFLOW_SRS 묶음 W — 상태바는 좁아지면 줄을 늘린다. 잘라내지 않는다.
//
// 개정 전의 실측이 스펙 §2.1 에 있다: 560px 에서 지표 3개, 420px 에서 5개가
// **아무 표시 없이 사라졌다.** 여기서 재는 것은 그 수가 0 이 되었다는 사실이다.

// 사용자가 켤 수 있는 최대 상태 — 지표 전부.
async function enableAllItems(page: Page) {
  await page.evaluate(() => {
    const sb = (window as any).statusBar;
    for (const k of Object.keys(sb)) sb[k] = true;
    (window as any).app._updateStatusBar();
  });
}

async function measure(page: Page) {
  return page.evaluate(() => {
    const items = document.getElementById('sb-items')!;
    const bar = document.getElementById('status-bar')!;
    const kids = Array.from(items.children) as HTMLElement[];
    const box = items.getBoundingClientRect();
    return {
      barH: bar.getBoundingClientRect().height,
      total: kids.length,
      // 컨테이너 밖으로 밀려나 보이지 않는 지표.
      clipped: kids.filter((k) => {
        const r = k.getBoundingClientRect();
        return r.right > box.right + 0.5 || r.bottom > box.bottom + 0.5;
      }).map((k) => k.textContent!.slice(0, 12)),
      // 상자가 글자보다 좁아진 지표 (개정 전 겹침의 원인).
      squeezed: kids.filter((k) => k.scrollWidth > k.clientWidth + 0.5).map((k) => k.textContent!.slice(0, 12)),
      rows: (() => {
        const h = Math.max(...kids.map((k) => k.getBoundingClientRect().height), 1);
        const tops = kids.map((k) => k.getBoundingClientRect().top).sort((a, b) => a - b);
        let n = 0;
        let last = -Infinity;
        for (const t of tops) if (t - last > h * 0.5) { n++; last = t; }
        return n;
      })(),
      heights: [...new Set(kids.map((k) => Math.round(k.getBoundingClientRect().height)))],
    };
  });
}

test.describe('상태바 줄바꿈', () => {
  // V-SBR-1 · V-SBR-2
  test('좁혀도 지표가 잘리거나 눌리지 않고 줄이 늘어난다', async ({ page }) => {
    await waitForInit(page);
    await enableAllItems(page);

    for (const w of [560, 420]) {
      await page.setViewportSize({ width: w, height: 720 });
      await expect.poll(async () => (await measure(page)).rows, { timeout: 5000 })
        .toBeGreaterThan(1);
      const got = await measure(page);
      expect(got.clipped, `${w}px 에서 잘린 지표`).toEqual([]);
      expect(got.squeezed, `${w}px 에서 눌린 지표`).toEqual([]);
      expect(got.barH, `${w}px 에서 상태바가 커지지 않았다`).toBeGreaterThan(22);
    }
  });

  // V-SBR-3: 한 줄로 들어가는 폭에서는 종전과 같아야 한다.
  test('한 줄이면 높이는 22px 그대로다', async ({ page }) => {
    await waitForInit(page);
    await enableAllItems(page);
    await page.setViewportSize({ width: 1280, height: 720 });
    await expect.poll(async () => (await measure(page)).rows, { timeout: 5000 }).toBe(1);
    expect((await measure(page)).barH).toBe(22);
  });

  // V-SBR-4: 상태바가 커지면 #area 가 그만큼 준다. 창 크기는 그대로이므로
  // window.resize 는 오지 않는다 — ResizeObserver 가 유일한 계기다 (FR-SBR-7).
  test('상태바가 두 줄이 되면 터미널이 다시 맞춰진다', async ({ page }) => {
    await waitForInit(page);
    await page.setViewportSize({ width: 700, height: 720 });

    // 지표를 최소로 줄여 한 줄에서 출발한다.
    await page.evaluate(() => {
      const sb = (window as any).statusBar;
      for (const k of Object.keys(sb)) sb[k] = false;
      sb.connection = true;
      (window as any).app._updateStatusBar();
    });
    const termRows = () => page.evaluate(() => {
      const p = (window as any).app._focusedTerminal();
      return p && p.term ? p.term.rows : -1;
    });
    await expect.poll(async () => (await measure(page)).rows, { timeout: 5000 }).toBe(1);
    const before = { bar: (await measure(page)).barH, rows: await termRows() };
    expect(before.rows).toBeGreaterThan(0);

    await enableAllItems(page);
    await expect.poll(async () => (await measure(page)).rows, { timeout: 5000 })
      .toBeGreaterThan(1);
    const after = { bar: (await measure(page)).barH, rows: await termRows() };
    expect(after.bar).toBeGreaterThan(before.bar);
    await expect.poll(termRows, { timeout: 5000 }).toBeLessThan(before.rows);
    expect(after.rows).toBeLessThanOrEqual(before.rows);
  });
});
