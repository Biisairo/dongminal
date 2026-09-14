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

/** 창을 갔다 온다. `view-scroll-restore.spec.ts` 의 `winRoundTrip` 과 같은 골격이다. */
async function winRoundTripHere(page) {
  const ids = await page.evaluate(() => {
    const a = (window as any).app;
    const other = a.ws.windows.find((w: any) => w.id !== a.ws.activeWindow);
    return { cur: a.ws.activeWindow, other: other ? other.id : '' };
  });
  expect(ids.other, '왕복할 다른 창이 없다').not.toBe('');
  await page.evaluate((id) => (window as any).app.switchWindow(id), ids.other);
  await paneUntil(page, (s) => !!s, '다른 창이 서지 않았다');
  await page.evaluate((id) => (window as any).app.switchWindow(id), ids.cur);
  await paneUntil(page, (s) => !!s, '돌아온 창이 서지 않았다');
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
  /**
   * V-M10-6 (M10_SRS FR-M10-3 · D-M10-4 — 옛 이름 V-M9-29): **복원의 바닥 갈래가
   * xterm 을 실제로 흔든다.**
   *
   * 원래 결함은 이것이다 (M9-B2, 사용자 `?diag=1` 로그의 산수가 확정했다 —
   * `M9_PROGRESS` §1-14): `.xterm-scroll-area` 의 높이가 **낡은 버퍼 길이**로 남아
   * 스크롤바를 끝까지 내려도 **정확히 한 화면 위**에서 멎었다 — 영역 `28652px` =
   * 낡은 길이 `1508` × 행높이 `19.0`, 버퍼는 `1557` 줄.
   *
   * **이 검사는 그 증상을 재지 않는다.** 재려다 **네 번 미끄러졌다** — 첫 판은
   * 버퍼를 키우지 않아서, 둘째 판은 *다른 창의* 터미널을 키워서, 셋째 판은
   * 조건을 다 맞췄는데도, 그리고 2026-09-15 의 실측에서 `_nudgeScrollArea` 에
   * `if(1) return;` 프로브를 넣어도 `1 passed` 였다. 영역 높이는 **브라우저의
   * 레이아웃 결과**이고, 헤드리스에서 그것이 낡는 조건이 실물과 같다는 보장이
   * 없다 (`M9_PROGRESS` §2-22 · `M10_SRS` §2.4).
   *
   * 그래서 재는 대상을 조항이 **명시한 수단**으로 옮긴다 (D-M10-4). FR-M9-29 는
   * "무엇이 되어야 한다" 만이 아니라 그 방법까지 적었다 — *"한 줄 올렸다 내린다.
   * 진짜 스크롤이므로 `onScroll` 이 나고 xterm 이 스크롤 영역을 다시 잰다."*
   * 그 `onScroll` 이 복원의 **바닥 갈래**에서 나는가가 이 검사의 전부다.
   *
   * `M9_PROGRESS` §2-12("증상을 재라")의 **예외**인 것이 요점이다. 그 규칙은
   * 증상을 재는 검사가 *아무 경로에나* 초록을 준다는 것인데, 여기서는 *아무
   * 경로도 없는데* 초록을 줬다. 증상 판정을 남기지 않고 **지우는** 이유도
   * 그것이다 — 두 판정이 함께 있으면 초록의 출처가 흐려지고, 다음 사람은 통과한
   * 검사를 "증상이 없다" 로 읽는다 (§2-22 에서 실제로 그렇게 읽혔다).
   *
   * **조건은 그대로 "떨어져 있는 동안 버퍼가 자란다" 이다.** 그것이 없으면 복원이
   * 흔들 이유도 없다.
   */
  test('V-M10-6 (FR-M10-3): 떨어져 있는 동안 버퍼가 자라면 복원이 xterm 을 흔든다',
    async ({ page }) => {
      await waitForInit(page, { clearLocalStorage: true });
      await addWindow(page);

      // **도구를 id 로 붙든다.** 창을 떠난 뒤에도 그 도구를 키워야 하는데,
      // `fillScrollback` 은 *지금 포커스된 창*의 터미널을 키운다 — 이 검사의
      // 첫 판에서 그것이 다른 창의 터미널을 키웠고, 그래서 **깨진 코드에서도
      // 초록**이었다 (§2-4 를 또 밟았다).
      const toolId = await page.evaluate(() => {
        const a = (window as any).app;
        const s = a.ws.windows.find((x: any) => x.id === a.ws.activeWindow);
        const find = (m: any, id: string): any => {
          if (!m) return null;
          if (m.type === 'pane' && m.id === id) return m;
          if (m.children) for (const c of m.children) { const r = find(c, id); if (r) return r }
          return null;
        };
        const pn = find(s.layout, a.focused);
        const tab = pn ? pn.tabs.find((t: any) => t.id === pn.activeTab) : null;
        return tab ? tab.toolId : '';
      });
      expect(toolId, '잴 도구가 없다').not.toBe('');

      const grow = (n: number) => page.evaluate(({ id, k }) => {
        const p = (window as any).app.tools.get(id);
        for (let i = 0; i < k; i++) p.term.write('vsr-' + i + '\r\n');
      }, { id: toolId, k: n });

      const bufLen = () => page.evaluate((id) => {
        const p = (window as any).app.tools.get(id);
        return p && p.term ? p.term.buffer.active.length : 0;
      }, toolId);

      /**
       * 복원이 xterm 을 **실제로 흔들었는가.** `onScroll` 은 `ydisp` 가 옮겨질
       * 때만 나므로, `scrollToBottom()` 이 `scrollLines(0)` 으로 즉시 반환하는
       * 갈래에서는 **한 번도 나지 않는다** — 그것이 이 결함이었다.
       *
       * 복원 **직전**에 센다. 떨어져 있는 동안 출력이 만든 자동 스크롤은 이
       * 조항의 것이 아니다.
       */
      const armScrollProbe = () => page.evaluate((id) => {
        const w = window as any;
        const p = w.app.tools.get(id);
        if (w.__vsrOff) { try { w.__vsrOff.dispose() } catch { /* 이미 떼였다 */ } }
        w.__vsrTrace = [];
        w.__vsrOff = p.term.onScroll(() => {
          const b = p.term.buffer.active;
          w.__vsrTrace.push({ y: b.viewportY, b: b.baseY });
        });
      }, toolId);

      /**
       * 흔들기의 **고유한 궤적**: `scrollLines(-1)` 이 `ydisp` 를 `ybase-1` 로
       * 내리고 `scrollToBottom()` 이 되돌린다.
       *
       * 발화 **수**로는 가를 수 없다 — 실측(2026-09-15)에서 고침이 없어도 발화가
       * 하나 있었다(`{y:0,b:0}`). 그 자리에 `fires >= 1` 을 두면 그 잡음이 초록을
       * 준다. 궤적은 갈린다:
       *
       *   고침 있음: `387/388` → `388/388` → `0/0`
       *   고침 없음: `0/0`
       *
       * `ybase > 0` 을 함께 묻는 것이 그 잡음을 거르는 자리다.
       */
      const nudged = () => page.evaluate(() =>
        ((window as any).__vsrTrace || []).some((t: any) => t.b > 0 && t.y === t.b - 1));

      await grow(300);
      const grown = await bufLen();
      expect(grown, '버퍼가 자라지 않았다 — 조건이 서지 않는다').toBeGreaterThan(300);

      // **조건**: 떠나 있는 동안 그 도구의 버퍼가 자란다. 이것이 없으면 복원이
      // 흔들 이유도 없다.
      const ids = await page.evaluate(() => {
        const a = (window as any).app;
        const other = a.ws.windows.find((w: any) => w.id !== a.ws.activeWindow);
        return { cur: a.ws.activeWindow, other: other ? other.id : '' };
      });
      expect(ids.other, '왕복할 다른 창이 없다').not.toBe('');
      await page.evaluate((id) => (window as any).app.switchWindow(id), ids.other);
      await expect.poll(async () => page.evaluate((id) => {
        const p = (window as any).app.tools.get(id);
        return !!p && !p.el.classList.contains('vis');
      }, toolId), { timeout: 10000, message: '그 도구가 떨어지지 않았다' }).toBe(true);

      await grow(120);
      expect(await bufLen(), '떨어져 있는 동안 버퍼가 자라지 않았다').toBeGreaterThan(grown);

      await armScrollProbe();
      await page.evaluate((id) => (window as any).app.switchWindow(id), ids.cur);
      await expect.poll(async () => page.evaluate((id) => {
        const p = (window as any).app.tools.get(id);
        return !!p && p.el.classList.contains('vis') && p.el.isConnected;
      }, toolId), { timeout: 10000, message: '그 도구가 돌아오지 않았다' }).toBe(true);

      // 여기가 판정이다. 흔들기가 없으면 `scrollToBottom()` 은 바닥에서 아무
      // 일도 하지 않고, `ydisp` 가 `ybase-1` 을 지나는 일도 없다.
      await expect.poll(nudged,
        { timeout: 10000, message: '복원이 xterm 을 흔들지 않았다 — 스크롤 영역을 다시 잴 계기가 없다' })
        .toBe(true);
    });

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
