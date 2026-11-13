import { test, expect, waitForInit } from './fixtures';

/**
 * CLAUDE_ACCOUNTS_SRS TC-CAC-27 — 계정 둘 → foot 두 묶음 + statusLine 줄 → 전환 → 활성 표식 이동 →
 * 초기화 확인 대화상자 → 설정에서 별칭·색 → 탭 지정 시 틴트.
 *
 * D-CAC-32: 브라우저에서 `/api/claude-accounts*` 응답을 위조한다. 실행 파일에는 시험용 입구가 없다.
 * 서버 동작은 Go 시험(TC-CAC-1~26·29·30)이 가짜 키체인·가짜 Anthropic 서버로 잰다.
 */

const NOW = () => Math.floor(Date.now() / 1000);

function win(pct: number, inSec: number) {
  return { pct, resetsAt: NOW() + inSec, resetsInSec: inSec, level: pct >= 90 ? 'critical' : pct >= 70 ? 'warn' : '' };
}

function mockState() {
  return {
    activeId: 'a',
    accounts: [
      { id: 'a', email: 'alice@x.com', organizationName: 'Org A', alias: 'Work', color: 'acct-3', disabled: false, priority: 0,
        usage: { status: 'ok', ageSeconds: 10, windows: { fiveHour: win(34, 7800), sevenDay: win(72, 368000) },
          resets: { juniperTide: { eligible: true, available: true }, fetchedAt: NOW() } },
        statusLine: { windows: { fiveHour: win(40, 7000), sevenDay: win(21, 360000) }, observedAt: NOW(), ageSeconds: 5, stale: false } },
      { id: 'b', email: 'bob@y.org', color: 'acct-6', disabled: false, priority: 0,
        usage: { status: 'ok', ageSeconds: 10, windows: { fiveHour: win(5, 9000), sevenDay: win(10, 400000) } } },
    ] as any[],
    maps: { folders: {} as Record<string, any>, tabs: {} as Record<string, any> },
    puts: [] as any[],
  };
}

type Mock = ReturnType<typeof mockState>;

async function installMock(page: any, st: Mock) {
  await page.route('**/api/claude-accounts**', async (route: any) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname.replace('/api/claude-accounts', '') || '/';
    const body = req.postData() ? JSON.parse(req.postData()) : {};
    const json = (data: any, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
    const list = () => ({ activeId: st.activeId, autoswitch: { enabled: false, status: 'off' }, otherStatusLines: [],
      accounts: st.accounts.map((a) => ({ ...a, active: a.id === st.activeId })) });
    switch (req.method() + ' ' + path) {
      case 'GET /': return json(list());
      case 'POST /switch': { const from = st.activeId; st.activeId = body.id; return json({ from, to: body.id, outgoing: 'same' }) }
      case 'POST /refresh': return json({ code: 'claude_too_soon', message: 'too soon' }, 409);
      case 'POST /reset': return json({ result: 'reset' });
      case 'GET /history': return json({ entries: [] });
      case 'GET /unclaimed': return json({ entries: [] });
      case 'GET /autoswitch': return json({ settings: { enabled: false, threshold: 90, intervalSeconds: 60, cooldownSeconds: 300,
        hysteresisPct: 10, strategy: 'best', unhealthyTicks: 3 }, state: { status: 'off', quarantined: [] } });
      case 'GET /mappings': return json(st.maps);
      case 'PUT /mappings': {
        st.puts.push(body);
        const m = body.toolId ? st.maps.tabs : st.maps.folders;
        const k = body.toolId || body.folder;
        if (body.accountId) m[k] = { accountId: body.accountId }; else delete m[k];
        return json(st.maps);
      }
      case 'GET /resolve': return json({ source: 'none', path: url.searchParams.get('cwd') });
      case 'PUT /item': {
        st.puts.push(body);
        const a = st.accounts.find((x) => x.id === body.id);
        if (body.alias !== undefined) a.alias = body.alias;
        if (body.color !== undefined) a.color = body.color;
        return json(a);
      }
      default: return route.fallback();
    }
  });
}

test.describe('Claude 계정 (TC-CAC-27)', () => {
  test('foot 묶음 → 전환 → 초기화 확인 → 설정의 별칭·색 → 탭 지정 틴트', async ({ page }) => {
    const st = mockState();
    await installMock(page, st);
    await waitForInit(page);

    await page.locator('#agents-panel .ag-collapse').click();
    await expect(page.locator('#agents-panel.open')).toBeVisible();

    // foot: 계정 둘의 묶음과 statusLine 한 줄 (FR-CAC-90·93)
    const foot = page.locator('#agents-panel .act-usage-foot');
    await expect(foot.locator('.cacct')).toHaveCount(2, { timeout: 10000 });
    await expect(foot.locator('.cacct.active')).toHaveAttribute('data-id', 'a');
    await expect(foot.locator('.act-usage-sl')).toHaveCount(1);
    await expect(foot.locator('.act-usage-sl')).toContainText('Work');

    // 전환 → 활성 표식이 옮겨 간다 (FR-CAC-30·91)
    await foot.locator('.cacct[data-id="b"] .cacct-head').click();
    await foot.locator('.cacct[data-id="b"] .cacct-switch').click();
    await expect(foot.locator('.cacct.active')).toHaveAttribute('data-id', 'b');

    // 초기화 확인 대화상자 — 취소하면 보내지 않는다 (FR-CAC-62)
    let resets = 0;
    page.on('request', (r: any) => { if (r.url().endsWith('/api/claude-accounts/reset')) resets++ });
    await foot.locator('.cacct[data-id="a"] .cacct-head').click();
    await foot.locator('.cacct[data-id="a"] .cacct-rs-use').click();
    const dlg = page.locator('.cacct-reset-confirm');
    await expect(dlg).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dlg).toHaveCount(0);
    expect(resets).toBe(0);

    // 설정: 별칭과 색 (FR-CAC-94·94a)
    await page.click('#settings-btn');
    await page.click('button.mtab[data-tab="claude"]');
    const row = page.locator('#cacct-set .cacct-set-row[data-id="a"]');
    await expect(page.locator('#cacct-set .cacct-set-row')).toHaveCount(2, { timeout: 10000 });
    const alias = row.locator('.cacct-set-field input.sbx-input');
    await alias.fill('Home');
    await alias.press('Tab');
    await expect.poll(() => st.puts.find((p) => p.alias !== undefined)).toEqual({ id: 'a', alias: 'Home' });
    await expect(page.locator('#cacct-set .cacct-set-row[data-id="a"] .cacct-set-name')).toHaveText('Home');
    await page.locator('#cacct-set .cacct-set-row[data-id="a"] select.cacct-set-color').selectOption('acct-5');
    await expect.poll(() => st.puts.find((p) => p.color !== undefined)).toEqual({ id: 'a', color: 'acct-5' });
    await page.keyboard.press('Escape');

    // 탭 지정 → 진한 틴트 (FR-CAC-85·95)
    const tab = page.locator('#area .pn.focused .pn-tab.active');
    const toolId = await tab.getAttribute('data-toolid');
    await tab.click({ button: 'right' });
    await page.locator('.ui-menu.tab-menu .ui-menu-item[data-id="claudeAccount"]').click();
    await page.locator('.ui-menu.cacct-pick-menu .ui-menu-item[data-id="acct:b"]').click();
    await expect.poll(() => st.puts.find((p) => p.toolId)).toEqual({ toolId, accountId: 'b' });
    await expect(tab).toHaveClass(/cacct-tint/);
    expect(await tab.evaluate((el: HTMLElement) => el.style.getPropertyValue('--cacct-tint'))).toContain('var(--acct-6) 28%');
    await expect(tab).toHaveAttribute('title', /bob@y\.org/);
  });
});
