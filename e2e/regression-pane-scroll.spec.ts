import { test, expect, waitForInit } from './fixtures';

// SRS: PANE_SCROLL_PRESERVE_SRS.md
//   FR-1/FR-2: _rLayout 을 거치는 모든 경로(세션 전환, 같은 pane 의 탭 전환)
//   에서 xterm viewport(viewportY) + .xterm-viewport.scrollTop 가 직전 위치로
//   복원되어야 한다.
//
// **고정 대기를 쓰지 않는다** (`TEST-16`). 이 파일이 기다리던 것은 전부 "전환이
// 화면에 서는 것" 과 "복원이 끝나는 것" 이었고, 둘 다 관측할 수 있는 값이다 —
// `paneUntil` 이 그 값을 되풀이해 읽는다. 재는 것은 "복원되는가" 이지 "80ms
// 안에 복원되는가" 가 아니며, 성공하면 즉시 지나가므로 벽시계는 줄어든다.

async function addWindow(page) {
  const before = await page.locator('#windows .si').count();
  await Promise.all([
    page.waitForResponse((r) => r.url().includes('/api/tools') && r.request().method() === 'POST'),
    page.click('#add-window'),
  ]);
  await expect(page.locator('#windows .si')).toHaveCount(before + 1, { timeout: 10000 });
}

/**
 * 포커스된 칸의 활성 터미널 상태. **없으면 `null` 이다** — 전환 도중에는 탭도
 * 도구도 잠시 비어 있고, 되풀이해 읽는 쪽(`paneUntil`)이 그 순간을 만난다.
 */
async function activePaneOfFocused(page) {
  return await page.evaluate(() => {
    const a = (window as any).app;
    const s = a.ws.windows.find((x: any) => x.id === a.ws.activeWindow);
    const find = (n: any, id: string): any => {
      if (!n) return null;
      if (n.type === 'pane' && n.id === id) return n;
      if (n.children) for (const c of n.children) { const r = find(c, id); if (r) return r; }
      return null;
    };
    const pn = s ? find(s.layout, a.focused) : null;
    const tab = pn ? pn.tabs.find((t: any) => t.id === pn.activeTab) : null;
    const pane = tab ? a.tools.get(tab.toolId) : null;
    if (!pane || !pane.term || !pane.el) return null;
    const vp = pane.el.querySelector('.xterm-viewport');
    return {
      viewportY: pane.term.buffer.active.viewportY,
      scrollTop: vp ? vp.scrollTop : -1,
      bufferLen: pane.term.buffer.active.length,
      // V-VSR-12: `ydisp × rowHeight` 를 공개 표면만으로 낸다 (D-8).
      baseY: pane.term.buffer.active.baseY,
      rows: pane.term.rows,
      scrollHeight: vp ? vp.scrollHeight : -1,
      clientHeight: vp ? vp.clientHeight : -1,
    };
  });
}

/** 포커스된 칸의 탭 id 목록. 셋이 같은 것을 따로 들고 있었다 (`TEST-17`). */
async function tabIdsOfFocused(page): Promise<string[]> {
  return await page.evaluate(() => {
    const a = (window as any).app;
    const s = a.ws.windows.find((x: any) => x.id === a.ws.activeWindow);
    const find = (m: any, id: string): any => {
      if (!m) return null;
      if (m.type === 'pane' && m.id === id) return m;
      if (m.children) for (const c of m.children) { const r = find(c, id); if (r) return r; }
      return null;
    };
    const pn = find(s.layout, a.focused);
    return pn ? pn.tabs.map((t: any) => t.id) : [];
  });
}

/** 터미널 탭을 하나 더 만들고 그 칸의 탭 id 들을 준다. */
async function twoTerminalTabs(page): Promise<string[]> {
  await page.evaluate(async () => {
    const a = (window as any).app;
    await a.addTab(a.focused, 'terminal');
  });
  return await tabIdsOfFocused(page);
}

/** 관측이 조건을 만족할 때까지 기다린다 — 고정 대기를 대신한다 (`TEST-16`). */
async function paneUntil(page, pred: (s: any) => boolean, why: string, timeout = 10000) {
  await expect
    .poll(async () => pred(await activePaneOfFocused(page)), { timeout, message: why })
    .toBe(true);
}

/** 탭을 전환하고 **그 전환이 선 것까지** 본다. */
async function switchTab(page, tid: string) {
  await page.evaluate((t) => (window as any).app.switchTab((window as any).app.focused, t), tid);
  await expect
    .poll(async () => {
      const ids = await page.evaluate(() => {
        const a = (window as any).app;
        const s = a.ws.windows.find((x: any) => x.id === a.ws.activeWindow);
        const find = (m: any, id: string): any => {
          if (!m) return null;
          if (m.type === 'pane' && m.id === id) return m;
          if (m.children) for (const c of m.children) { const r = find(c, id); if (r) return r; }
          return null;
        };
        const pn = find(s.layout, a.focused);
        return pn ? pn.activeTab : null;
      });
      return ids;
    }, { timeout: 10000, message: `탭 ${tid} 로 전환되지 않았다` })
    .toBe(tid);
}

async function fillScrollback(page, lines = 200) {
  const before = await activePaneOfFocused(page);
  const base = before ? before.bufferLen : 0;
  await page.evaluate((n) => {
    const a = (window as any).app;
    const s = a.ws.windows.find((x: any) => x.id === a.ws.activeWindow);
    const find = (m: any, id: string): any => {
      if (!m) return null;
      if (m.type === 'pane' && m.id === id) return m;
      if (m.children) for (const c of m.children) { const r = find(c, id); if (r) return r; }
      return null;
    };
    const pn = find(s.layout, a.focused);
    const tab = pn.tabs.find((t: any) => t.id === pn.activeTab);
    const pane = a.tools.get(tab.toolId);
    let payload = '';
    for (let i = 1; i <= n; i++) payload += `LINE-${i}\r\n`;
    pane.term.write(payload);
    pane.term.scrollToBottom();
  }, lines);
  /**
   * `write` 는 비동기다 — **다 들어오고, 바닥에 붙고, 뷰포트가 따라온 것까지** 본다.
   *
   * 셋을 다 보는 이유: 버퍼가 자라기 시작한 것만 보면 `scrollToBottom()` 이 아직
   * 서지 않은 순간을 지나가고, 바로 뒤에서 `viewportY === baseY`·`scrollTop > 0`
   * 을 단정하는 검사(V-VSR-12)가 그 자리에서 깨진다.
   *
   * **길이는 넣은 줄 수로 세지 않는다.** xterm 은 화면에 이미 있던 빈 줄을
   * 재사용하므로 200줄을 써도 `length` 는 `33 → 201` 이다 (실측) — `base+200`
   * 은 영영 오지 않는다.
   */
  await paneUntil(page,
    (s) => !!s && s.bufferLen > base && s.viewportY === s.baseY && s.scrollTop > 0,
    '스크롤백이 채워지고 바닥에 붙는 데까지 가지 못했다');
}

async function scrollUp(page, lines: number) {
  const before = await activePaneOfFocused(page);
  const from = before ? before.viewportY : 0;
  await page.evaluate((n) => {
    const a = (window as any).app;
    const s = a.ws.windows.find((x: any) => x.id === a.ws.activeWindow);
    const find = (m: any, id: string): any => {
      if (!m) return null;
      if (m.type === 'pane' && m.id === id) return m;
      if (m.children) for (const c of m.children) { const r = find(c, id); if (r) return r; }
      return null;
    };
    const pn = find(s.layout, a.focused);
    const tab = pn.tabs.find((t: any) => t.id === pn.activeTab);
    const pane = a.tools.get(tab.toolId);
    pane.term.scrollLines(-n);
  }, lines);
  await paneUntil(page, (s) => !!s && s.viewportY < from, '위로 굴렸는데 자리가 그대로다');
}

function rowHeightOf(st: any) {
  const span = st.bufferLen - st.rows;
  const room = st.scrollHeight - st.clientHeight;
  return span > 0 && room > 0 ? room / span : 0;
}

test.describe('Pane scroll preserve regression', () => {
  test('xterm scroll position survives session switch and return', async ({ page }) => {
    await waitForInit(page, { clearLocalStorage: true });

    const sidA = await page.evaluate(() => (window as any).app.ws.activeWindow);
    await fillScrollback(page, 200);
    await scrollUp(page, 80);
    const before = await activePaneOfFocused(page);
    expect(before.viewportY).toBeGreaterThan(0);

    // 세션 B 추가하여 활성 전환된 다음 다시 A 로 복귀.
    await addWindow(page);
    await page.evaluate((sid) => (window as any).app.switchWindow(sid), sidA);
    // doFit reflow 보정으로 viewportY 는 ±2, scrollTop 은 ±2*lineHeight 허용.
    await paneUntil(page,
      (s) => !!s && Math.abs(s.viewportY - before.viewportY) <= 2 && s.scrollTop > 0,
      '세션을 돌아왔는데 스크롤이 복원되지 않았다');

    const after = await activePaneOfFocused(page);
    expect(Math.abs(after.viewportY - before.viewportY)).toBeLessThanOrEqual(2);
    expect(after.scrollTop).toBeGreaterThan(0);
  });

  test('xterm scroll position survives same-pane tab switch', async ({ page }) => {
    await waitForInit(page, { clearLocalStorage: true });

    // 같은 pane 에 두 번째 터미널 탭 추가.
    const tabIds = await twoTerminalTabs(page);
    expect(tabIds.length).toBe(2);

    // 첫 탭으로 다시 전환하여 스크롤백 채우기.
    await switchTab(page, tabIds[0]);
    await fillScrollback(page, 200);
    await scrollUp(page, 80);
    const before = await activePaneOfFocused(page);
    expect(before.viewportY).toBeGreaterThan(0);

    // 두 번째 탭으로 전환했다가 첫 탭으로 복귀.
    await switchTab(page, tabIds[1]);
    await switchTab(page, tabIds[0]);
    await paneUntil(page,
      (s) => !!s && Math.abs(s.viewportY - before.viewportY) <= 2 && s.scrollTop > 0,
      '탭을 돌아왔는데 스크롤이 복원되지 않았다');

    const after = await activePaneOfFocused(page);
    expect(Math.abs(after.viewportY - before.viewportY)).toBeLessThanOrEqual(2);
    expect(after.scrollTop).toBeGreaterThan(0);
  });

  /**
   * V-VSR-11 (VIEW_SCROLL_RESTORE_SRS FR-VSR-22): **복원은 최상단을 결과로
   * 남기지 않는다.**
   *
   * 복원의 흔들기는 두 동작이다 — 먼저 자리를 옮겨 `_onScroll` 을 깨우고, 그 다음
   * 갈무리한 줄로 간다. 그 **두 번째가 듣지 않는 경우**가 `U-3`("최상단으로
   * 붙는다")·`U-17`("가끔")의 가설이며(SRS §2.7), 방금 붙은 요소는 행 수·높이가
   * 아직 측정되지 않은 프레임을 지나므로 "가끔" 이라는 성질과도 맞는다.
   *
   * 그 상태를 여기서 만든다 — `scrollToLine` 을 눌러 두고 왕복한다. 흔들기가
   * 실패해도 남는 자리는 **갈무리한 자리**여야 한다. 최상단이면 그것이 결함이다.
   *
   * `FR-VSR-23`: 이 검사는 `_restoreScrollOf` 의 **판정**(FR-PDR-11 bottom-follow)을
   * 재지 않는다. 재는 것은 흔들기의 착지점뿐이다.
   */
  test('V-VSR-11 (FR-VSR-22): 흔들기가 듣지 않아도 최상단에 남지 않는다',
    async ({ page }) => {
      await waitForInit(page, { clearLocalStorage: true });

      const tabIds = await twoTerminalTabs(page);
      expect(tabIds.length).toBe(2);

      await switchTab(page, tabIds[0]);
      await fillScrollback(page, 200);
      await scrollUp(page, 80);
      const before = await activePaneOfFocused(page);
      expect(before.viewportY).toBeGreaterThan(0);

      // 흔들기의 착지 동작을 눌러 둔다. `scrollToTop`·`scrollToBottom` 은 그대로
      // 둔다 — 그것들이 듣는데도 최상단에 남는다면 그 자리가 곧 결함이다.
      await page.evaluate(() => {
        for (const p of (window as any).app.tools.values()) {
          if (p && p.term) p.term.scrollToLine = () => {};
        }
      });

      await switchTab(page, tabIds[1]);
      await switchTab(page, tabIds[0]);
      await paneUntil(page,
        (s) => !!s && s.viewportY > 0 && Math.abs(s.viewportY - before.viewportY) <= 2,
        '흔들기가 실패한 뒤 갈무리한 자리로 돌아오지 않았다');

      const after = await activePaneOfFocused(page);
      expect(after.viewportY, '복원이 최상단을 결과로 남겼다 — U-3 이 그 자리다')
        .toBeGreaterThan(0);
      expect(Math.abs(after.viewportY - before.viewportY),
        '흔들기가 실패했는데 갈무리한 자리가 아니다').toBeLessThanOrEqual(2);
    });

  /**
   * V-VSR-12·13 (VIEW_SCROLL_RESTORE_SRS FR-VSR-24): **맨 아래에 붙은 채 왕복한다.**
   *
   * 위의 셋은 전부 `scrollUp` 뒤를 잰다 — 중간 스크롤 갈래이며, 그쪽은 흔들기가
   * `ydisp` 를 실제로 옮기므로 xterm 의 `Viewport` 가 따라온다. 결함은 **가지 않은
   * 갈래**에 있었다 (`SRS §2.8`): `ydisp === ybase` 면 `scrollToBottom()` 은
   * `scrollLines(0)` 이라 내부에서 즉시 반환하고, 요소가 떼였을 때 브라우저가 버린
   * `scrollTop=0` 이 **아무도 고치지 않은 채** 남는다.
   *
   * 보이는 것은 맨 아래인데(캔버스는 `ydisp` 를 그린다) 실제 스크롤은 맨 위다.
   * 그래서 휠을 올리면 브라우저가 이벤트를 내지 않고(이미 `0`), 내리면
   * `round(scrollTop / rowHeight) - ydisp` 가 큰 음수라 최상단으로 튄다.
   */
  test('V-VSR-12 (FR-VSR-24): 맨 아래에 붙은 채 왕복해도 DOM 스크롤이 ydisp 와 일치한다',
    async ({ page }) => {
      await waitForInit(page, { clearLocalStorage: true });

      const tabIds = await twoTerminalTabs(page);
      expect(tabIds.length).toBe(2);

      await switchTab(page, tabIds[0]);
      // **스크롤을 올리지 않는다.** 맨 아래에 붙은 상태가 이 검사의 전부다.
      await fillScrollback(page, 200);

      const before = await activePaneOfFocused(page);
      expect(before.viewportY, '맨 아래에 붙어 있어야 한다').toBe(before.baseY);
      expect(rowHeightOf(before), '스크롤백이 없으면 잴 것이 없다').toBeGreaterThan(0);
      expect(before.scrollTop).toBeGreaterThan(0);

      await switchTab(page, tabIds[1]);
      await switchTab(page, tabIds[0]);
      await paneUntil(page,
        (s) => !!s && s.viewportY === s.baseY
          && Math.abs(s.scrollTop - s.viewportY * rowHeightOf(s)) <= 2,
        '왕복 뒤 DOM 스크롤이 ydisp 와 맞지 않는다');

      const after = await activePaneOfFocused(page);
      expect(after.viewportY, 'bottom-follow 는 그대로다 (FR-PDR-11 무변경)').toBe(after.baseY);
      const want = after.viewportY * rowHeightOf(after);
      expect(Math.abs(after.scrollTop - want),
        `DOM 이 ydisp 와 어긋났다 — scrollTop=${after.scrollTop} want=${want}. ` +
        '보이는 것은 맨 아래인데 실제 스크롤은 맨 위다 (SRS §2.8)').toBeLessThanOrEqual(2);
    });

  test('V-VSR-13 (FR-VSR-24): 왕복 뒤에도 휠이 듣고, 최상단으로 튀지 않는다',
    async ({ page }) => {
      await waitForInit(page, { clearLocalStorage: true });

      const tabIds = await twoTerminalTabs(page);

      await switchTab(page, tabIds[0]);
      await fillScrollback(page, 200);
      await switchTab(page, tabIds[1]);
      await switchTab(page, tabIds[0]);
      await paneUntil(page, (s) => !!s && s.viewportY === s.baseY,
        '왕복 뒤 맨 아래에 붙어 있지 않다');

      const atBottom = await activePaneOfFocused(page);
      expect(atBottom.viewportY).toBe(atBottom.baseY);

      // 보이는 터미널 위에서 굴린다 — 휠은 좌표가 있는 실제 입력이다.
      const box = await page.locator('.pn .tp.vis .xterm-viewport').first().boundingBox();
      expect(box, '보이는 터미널 뷰포트를 찾지 못했다').not.toBeNull();
      await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);

      await page.mouse.wheel(0, -400);
      await paneUntil(page, (s) => !!s && s.viewportY < atBottom.viewportY,
        '휠을 올렸는데 움직이지 않았다');
      const up = await activePaneOfFocused(page);
      expect(up.viewportY,
        '휠을 올렸는데 움직이지 않았다 — scrollTop 이 이미 0 이라 이벤트가 나지 않는다')
        .toBeLessThan(atBottom.viewportY);

      await page.mouse.wheel(0, 200);
      await paneUntil(page, (s) => !!s && s.viewportY >= up.viewportY,
        '아래로 굴렸더니 최상단으로 튀었다');
      const down = await activePaneOfFocused(page);
      expect(down.viewportY, '아래로 굴렸더니 최상단으로 튀었다 (U-3)')
        .toBeGreaterThanOrEqual(up.viewportY);
    });
});
