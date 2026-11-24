import { test, expect, waitForInit, stubEmptyLimits, stubTopic } from './fixtures';

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
  await stubEmptyLimits(page); // QUALITY_FLAKY_SRS FR-FLK-12: 같은 워커의 앞 시험이 남긴 한도가 바닥에 줄을 세우지 않게
  const list = () => ({ activeId: st.activeId, autoswitch: { enabled: false, status: 'off' }, otherStatusLines: [],
    accounts: st.accounts.map((a) => ({ ...a, active: a.id === st.activeId })) });
  // 목록은 `claude.accounts` 토픽으로 온다(CHANNEL_PROTOCOL C2b). 조작 뒤의 GET 은 아래 route 가 받는다.
  await stubTopic(page, 'claude.accounts', list);
  await page.route('**/api/claude-accounts**', async (route: any) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname.replace('/api/claude-accounts', '') || '/';
    const body = req.postData() ? JSON.parse(req.postData()) : {};
    const json = (data: any, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
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
    // MOBILE_UX_OVERHAUL_SRS FR-MUX-81 로 개정: 등록 계정(Work)의 statusLine 줄은 없다 — 묶음 막대가 이미
    // OAuth·statusLine 중 큰 값이다 (D-CAC-35). 이전: statusLine 한 줄이 `Work` 를 보였다.
    await expect(foot.locator('.act-usage-sl')).toHaveCount(0);
    await expect(foot.locator('.cacct-history-btn')).toHaveCount(0); // FR-CAC-111

    // 모양: 활성만 넓다. ▸ 로 바꾼다 (FR-CAC-91)
    await expect(foot.locator('.cacct.wide')).toHaveAttribute('data-id', 'a');
    await foot.locator('.cacct[data-id="b"] .cacct-bar').click();
    await expect(foot.locator('.cacct[data-id="b"]')).toHaveClass(/\bwide\b/);
    await foot.locator('.cacct[data-id="b"] .cacct-bar').click();
    await expect(foot.locator('.cacct[data-id="b"]')).not.toHaveClass(/\bwide\b/);

    // 오버레이: 칸을 누르면 Activity 패널 바깥 옆에 뜨고, 칸 높이는 그대로다. 바깥을 누르면 닫힌다 (FR-CAC-91)
    const boxB = foot.locator('.cacct[data-id="b"]');
    const h0 = (await boxB.boundingBox())!.height;
    await boxB.locator('.cacct-head').click();
    await expect(boxB.locator('.cacct-pop')).toBeVisible();
    expect((await boxB.boundingBox())!.height).toBe(h0);
    const panelBox = (await page.locator('#agents-panel').boundingBox())!;
    const popBox = (await boxB.locator('.cacct-pop').boundingBox())!;
    expect(popBox.x + popBox.width).toBeLessThanOrEqual(panelBox.x);
    await boxB.locator('.cacct-head').click();
    await expect(foot.locator('.cacct-pop')).toHaveCount(0);
    await boxB.locator('.cacct-head').click();
    await foot.locator('.cacct[data-id="a"] .cacct-head').click();
    await expect(foot.locator('.cacct[data-id="a"] .cacct-pop')).toBeVisible();
    await expect(boxB.locator('.cacct-pop')).toHaveCount(0);
    await page.locator('#agents-body').click({ position: { x: 5, y: 5 } });
    await expect(foot.locator('.cacct-pop')).toHaveCount(0);

    // 전환 → 활성 표식이 옮겨 간다 (FR-CAC-30·91)
    await boxB.locator('.cacct-head').click();
    await foot.locator('.cacct[data-id="b"] .cacct-switch').click();
    await expect(foot.locator('.cacct.active')).toHaveAttribute('data-id', 'b');
    await expect(foot.locator('.cacct-pop')).toHaveCount(0);

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
    await page.locator('#cacct-set .cacct-set-row[data-id="a"] .cacct-swatch[data-color="acct-5"]').click();
    await expect.poll(() => st.puts.find((p) => p.color !== undefined)).toEqual({ id: 'a', color: 'acct-5' });
    await expect(page.locator('#cacct-set .cacct-set-row[data-id="a"] .cacct-swatch-name')).toHaveText(/청록|Teal/);
    // 전환 기록은 설정의 "기록" 단추로 연다 (FR-CAC-111)
    await page.locator('#cacct-set .cacct-history-btn').click();
    const hist = page.locator('.cacct-history');
    await expect(hist.locator('.cacct-hist-empty')).toBeVisible();
    await hist.locator('button').last().click();
    await expect(hist).toHaveCount(0);
    await page.keyboard.press('Escape');

    // 설정을 닫은 사이 다른 곳(Explorer 등)에서 폴더를 연결하면, 다시 열 때 Claude 계정 탭이 새 값을 보인다 (FR-CAC-94a)
    st.maps.folders['/work/proj'] = { accountId: 'b' };
    await page.click('#settings-btn');
    await expect(page.locator('#cacct-set .cacct-set-folder')).toHaveCount(1);
    await expect(page.locator('#cacct-set .cacct-set-folder .cacct-set-path')).toHaveText('/work/proj');
    // 입력 중에 변경 신호가 와도 입력한 값과 포커스를 지우지 않는다 (FR-CAC-94a)
    const thr = page.locator('#cacct-set .cacct-set-auto input.ds-num').first();
    await thr.fill('77');
    const pathIn = page.locator('#cacct-set .cacct-set-link input.sbx-input');
    await pathIn.fill('/typing');
    await page.evaluate(() => (window as any).app.testing.onClaudeAccountsChanged());
    // **예외 (`TEST-16`)**: 다시 그리기가 **오지 않음**을 잰다 — 기다릴 조건이 없다. 목록 응답은 위조라 즉시 온다.
    await page.waitForTimeout(300);
    await expect(pathIn).toBeFocused();
    await expect(pathIn).toHaveValue('/typing');
    await expect(thr).toHaveValue('77');
    // 포커스가 떠나도 저장하지 않은 입력이 있으면 계속 미룬다
    await page.locator('#cacct-set .ds-sec').first().click();
    await page.evaluate(() => (window as any).app.testing.onClaudeAccountsChanged());
    // **예외 (`TEST-16`)**: 위와 같다 — 다시 그리기가 오지 않음을 잰다.
    await page.waitForTimeout(300);
    await expect(thr).toHaveValue('77');
    await page.locator('#modal-close').click();
    await expect(page.locator('#modal-overlay.open')).toHaveCount(0);
    delete st.maps.folders['/work/proj'];

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
