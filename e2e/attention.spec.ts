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
  // ATTENTION_FIRING_SRS V-ATV-1·2 / V-ATA-1·2: 포커스된 칸에서 뜬 알람은
  // **화면에 남는다**. 개정 전에는 이 자리에서 알람이 즉시 해제되어 소리와
  // 데스크톱 알림만 지나갔고, 사용자가 다른 앱에서 돌아왔을 때 남는 것이
  // 아무것도 없었다 (B4·B6). 해제는 이제 실제 상호작용에서만 온다 (D-1).
  test('포커스된 칸의 알람이 남고, 포커스 표식과 함께 보인다 (V-ATV-1·2, V-ATA-1)', async ({ page }) => {
    await waitForInit(page);
    await page.waitForSelector('#area .pn.focused .xterm-screen', { state: 'visible', timeout: 15000 });

    // 포커스된 활성 탭에서 알람을 낸다. 탭을 옮기지 않는다 — 개정 전이라면
    // 이것만으로 알람이 즉시 사라졌다.
    await page.keyboard.type('sleep 2 && "$DONGMINAL_HOME/bin/dmctl" notify done');
    await page.keyboard.press('Enter');

    const pane = page.locator('#area .pn.focused');
    const tab = pane.locator('.pn-tab.active').first();
    await expect(pane).toHaveClass(/attn/, { timeout: 15000 });
    await expect(tab).toHaveClass(/attn/);
    await expect(page.locator('#attn-badge')).toBeVisible();

    // V-ATV-2: 포커스 테두리와 알람 링이 **둘 다** 그려진다. 링이 테두리 자리를
    // 덮던 것이 "알림이 포커스에 가려 보이지 않는다" 의 원인이었다 (B5).
    const paint = await page.evaluate(() => {
      const pn = document.querySelector('#area .pn.focused')!;
      return {
        border: getComputedStyle(pn).borderTopColor,
        ring: getComputedStyle(pn, '::after').boxShadow,
        accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
      };
    });
    expect(paint.ring, '알람 링이 없다').toContain('inset');
    expect(paint.border, '포커스 테두리가 투명하다').not.toContain('rgba(0, 0, 0, 0)');

    // V-ATA-1: 포커스를 다시 주장해도(창 focus 이벤트) 알람은 남는다.
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.waitForTimeout(300);
    await expect(pane).toHaveClass(/attn/);

    // V-ATA-2: 그 칸을 클릭하면 — 실제 상호작용 — 사라진다.
    await pane.locator('.xterm-screen').click();
    await expect(pane).not.toHaveClass(/attn/, { timeout: 10000 });
    await expect(page.locator('#attn-badge')).toBeHidden();
  });

  // V-ATA-3 · V-ATA-4(개정): 키 입력은 알람을 해제한다. 그리고 **보고 있어도**
  // 소리와 데스크톱 알림이 난다 (FR-ATA-7 개정 / §1.7).
  //
  // 종전에는 반대를 쟀다 — 보고 있으면 내지 않는 것이 AS-2 였다. 그 가정이
  // 반증됐다: 이 앱에서 알람이 서는 가장 흔한 순간이 **에이전트가 도는 것을
  // 지켜보다 끝나는 순간**이고, 그때 사용자는 그 탭을 보고 있어 배너가 한 번도
  // 뜨지 않았다. 방해를 막으려던 조건이 기능 자체를 막고 있었다.
  test('키 입력이 알람을 해제하고, 보고 있어도 알림이 난다 (V-ATA-3·4)', async ({ page }) => {
    await waitForInit(page);
    await page.waitForSelector('#area .pn.focused .xterm-screen', { state: 'visible', timeout: 15000 });

    // 비프와 데스크톱 알림을 가로챈다. 실제 소리·배너 대신 호출만 센다 —
    // 실제 배너는 Playwright 가 보지 못하므로 "우리가 띄우려 했는가" 까지가
    // 우리 몫이고 그 뒤는 브라우저와 OS 의 몫이다.
    await page.evaluate(() => {
      const app = (window as any).app;
      (window as any).__beeps = 0;
      app._attnBeep = () => { (window as any).__beeps++; };
      (window as any).__notifs = [];
      const Spy: any = function (this: any, title: string) {
        (window as any).__notifs.push(title);
        return { close() {} };
      };
      Spy.permission = 'granted';
      Spy.requestPermission = () => Promise.resolve('granted');
      (window as any).Notification = Spy;
    });

    await page.keyboard.type('sleep 2 && "$DONGMINAL_HOME/bin/dmctl" notify done');
    await page.keyboard.press('Enter');

    const pane = page.locator('#area .pn.focused');
    await expect(pane).toHaveClass(/attn/, { timeout: 15000 });
    // 표식이 서고, **보고 있는데도** 소리와 데스크톱 알림이 난다.
    await expect.poll(() => page.evaluate(() => (window as any).__beeps), { timeout: 10000 })
      .toBeGreaterThan(0);
    expect(await page.evaluate(() => (window as any).__notifs.length),
      '보고 있는 탭의 알람에 데스크톱 알림이 나지 않았다').toBeGreaterThan(0);

    // V-ATA-3: 키를 누르면 사라진다.
    await page.keyboard.press('a');
    await expect(pane).not.toHaveClass(/attn/, { timeout: 10000 });
    await expect(page.locator('#attn-badge')).toBeHidden();
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
