import { test, expect } from './fixtures';

// PANE_ATTENTION_NOTIFY_SRS e2e: terminal-monitoring attention.
// Covers TC-PAN-15 (background tab highlight, distinct from focus),
// TC-PAN-18 (title/badge count), TC-PAN-21 (notification center list),
// TC-PAN-22 (center item click → jump + clear).

async function waitForInit(page) {
  await page.context().addInitScript(() => {
    sessionStorage.setItem('displayMode', 'desktop');
  });
  await page.goto('/');
  await page.waitForSelector('#area .pn.focused .xterm-helper-textarea', { timeout: 15000 });
}

test.describe('Pane attention', () => {
  test('background pane attention: highlight, center, jump-to-clear', async ({ page }) => {
    await waitForInit(page);

    // In the focused pane, run a foreground command that fires `dmctl notify`
    // (the real agent-facing primitive) after a delay. Foreground mirrors how a
    // real agent hook runs (the agent owns the pane's foreground), while we
    // switch away so the signalling pane is in the background — not the
    // focused-active tab, which would be suppressed.
    await page.waitForSelector('#area .pn.focused .xterm-screen', { state: 'visible', timeout: 15000 });
    // Absolute path: a stale dmctl earlier in PATH would not understand `notify`
    // (the real wrappers also call dmctl by absolute path for this reason).
    await page.keyboard.type('sleep 2 && "$DONGMINAL_HOME/bin/dmctl" notify done');
    await page.keyboard.press('Enter');

    // Add a new tab → it becomes the focused/active tab; the first tab's pane
    // is now in the background.
    const before = await page.locator('#area .pn.focused .pn-tab').count();
    const [resp] = await Promise.all([
      page.waitForResponse((r) => r.url().includes('/api/tools') && r.status() === 200),
      page.locator('#area .pn.focused .pn-tab-add').click(),
    ]);
    expect(resp.status()).toBe(200);
    await expect(page.locator('#area .pn.focused .pn-tab')).toHaveCount(before + 1, { timeout: 10000 });

    // The background (first) tab gains the attention highlight; it must NOT be
    // the focus/active styling (distinct class).
    const firstTab = page.locator('#area .pn.focused .pn-tab').first();
    await expect(firstTab).toHaveClass(/attn/, { timeout: 10000 });
    await expect(firstTab).not.toHaveClass(/active/);

    // Badge appears with count 1; title gets the count badge.
    const badge = page.locator('#attn-badge');
    await expect(badge).toBeVisible();
    await expect(badge.locator('.attn-count')).toHaveText('1');
    await expect.poll(() => page.title()).toContain('(1)');

    // The alarm must PERSIST until the user attends — it must not auto-clear
    // (regression guard: raw terminal input/echo must not dismiss it).
    await page.waitForTimeout(500);
    await expect(firstTab).toHaveClass(/attn/);
    await expect(badge).toBeVisible();

    // Open the notification center: one item listed.
    await badge.click();
    await expect(page.locator('#attn-center.open')).toBeVisible();
    await expect(page.locator('#attn-center .attn-item')).toHaveCount(1);

    // Clicking the item jumps to that pane → attention clears everywhere.
    await page.locator('#attn-center .attn-item').first().click();
    await expect(page.locator('#area .pn.focused .pn-tab').first()).not.toHaveClass(/attn/, { timeout: 10000 });
    await expect(badge).toBeHidden();
    await expect.poll(() => page.title()).not.toContain('(1)');
  });
  // ATTENTION_LIFECYCLE_GIT_OBSERVE_SRS V-ATL-1·6·7·8: 도구가 사라지면 알람도
  // 사라진다. 지금까지 이 자리에서 배지가 남았고, 그 항목은 이름이 UUID 였으며
  // 클릭해도 아무 데도 가지 않았다 — `모두 제거` 말고는 없앨 방법이 없었다.
  test('알람이 뜬 탭을 닫으면 알람도 사라진다 (V-ATL-1·6·7·8)', async ({ page }) => {
    await waitForInit(page);
    await page.waitForSelector('#area .pn.focused .xterm-screen', { state: 'visible', timeout: 15000 });
    await page.keyboard.type('sleep 2 && "$DONGMINAL_HOME/bin/dmctl" notify done');
    await page.keyboard.press('Enter');

    const before = await page.locator('#area .pn.focused .pn-tab').count();
    await page.locator('#area .pn.focused .pn-tab-add').click();
    await expect(page.locator('#area .pn.focused .pn-tab')).toHaveCount(before + 1, { timeout: 10000 });

    const badge = page.locator('#attn-badge');
    await expect(badge).toBeVisible({ timeout: 15000 });
    const firstTab = page.locator('#area .pn.focused .pn-tab').first();
    await expect(firstTab).toHaveClass(/attn/, { timeout: 10000 });

    // 알람이 붙은 탭을 닫는다 — 도구가 죽는다.
    const toolId = await firstTab.getAttribute('data-toolid');
    await firstTab.locator('.pn-tab-x').click();
    // 실행 중이면 확인이 뜬다 (FR-BG-3) — `닫기` 가 곧 도구 종료다.
    const ok = page.locator('.confirm-overlay .confirm-ok');
    if (await ok.count()) await ok.first().click();

    // FR-ATL-7: 배지가 즉시 내려간다.
    await expect(badge).toBeHidden({ timeout: 10000 });
    await expect.poll(() => page.title()).not.toContain('(1)');

    // FR-ATL-1·6: 서버도 잊었다 — 새로고침해도 되살아나지 않는다 (FR-ATL-8).
    const ids = await page.evaluate(async () => {
      const r = await fetch('/api/tools/attention');
      return (await r.json()).toolIds || [];
    });
    expect(ids, `죽은 도구의 알람이 서버에 남았다: ${ids}`).not.toContain(toolId);

    await page.reload();
    await page.waitForSelector('#area .pn.focused .xterm-helper-textarea', { timeout: 15000 });
    await expect(page.locator('#attn-badge')).toBeHidden({ timeout: 10000 });
  });
  // V-ATL-7 (FR-ATL-11): 복원은 **요청을 떠나기 전에** 지울 후보를 확정한다.
  // 응답이 도는 동안 SSE 로 올라온 알람까지 지우면, 합류 직후에 부른 도구의
  // 알람이 태어나자마자 사라진다. `/api/tools/attention` 을 느리게 만들어 그
  // 창을 결정론적으로 연다 — 실제 레이스를 기다리면 재현되지 않는다.
  test('복원 중 도착한 알람을 지우지 않는다 (V-ATL-7)', async ({ page }) => {
    await waitForInit(page);

    const cleared = await page.evaluate(async () => {
      const app = (window as any).app;
      app._attn.clear();
      const real = window.fetch;
      // 복원 응답을 붙잡아 둔다 — 그 사이에 새 알람이 도착하는 상황이다.
      let release: () => void;
      const gate = new Promise<void>(r => { release = r });
      (window as any).fetch = (u: any, o: any) => {
        if (String(u).includes('/api/tools/attention') && !String(u).includes('clear')) {
          return gate.then(() => new Response(JSON.stringify({ toolIds: [] }),
            { headers: { 'Content-Type': 'application/json' } }));
        }
        return real(u, o);
      };

      app._attnRestore();                          // 요청 출발 (후보 = 빈 집합)
      app._onToolAttention({ toolId: 'late', reason: 'done' }); // SSE 로 새 알람
      release!();
      await new Promise(r => setTimeout(r, 100));  // 응답 처리 완료 대기
      (window as any).fetch = real;
      return !app._attn.has('late');
    });

    expect(cleared, '복원 응답이 그 사이 도착한 알람을 지웠다').toBe(false);
  });
});
