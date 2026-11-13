import { test, expect, waitForInit } from './fixtures';

// AGENT_ACTIVITY_PANEL_SRS e2e: agent activity panel.
// Covers TC-AAP-11 (card with location/state/detail), TC-AAP-12 (toggle),
// TC-AAP-13 (click → jump), TC-AAP-14 (in-place update), TC-AAP-17 (attention
// alarm composited onto the card), TC-AAP-19 (new agent appends at bottom,
// status update keeps position), TC-AAP-20 (drag reorder persisted).

async function setActivity(page, toolId, state, tool, detail) {
  return page.evaluate(
    async (a) => {
      const r = await fetch('/api/tools/activity/set', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(a),
      });
      return r.status;
    },
    { toolId, state, tool, detail },
  );
}

test.describe('Agent activity panel', () => {
  test('card render, in-place update, toggle, jump', async ({ page }) => {
    await waitForInit(page);

    const pid = await page.locator('#area .pn.focused .pn-tab.active').getAttribute('data-toolid');
    expect(pid).toBeTruthy();

    // Expand the panel from its rail (UX_BATCH12_SRS FR-ACF-5).
    await page.locator('#agents-panel .ag-collapse').click();
    await expect(page.locator('#agents-panel.open')).toBeVisible();

    // Report a working activity → a card appears with the command detail.
    expect(await setActivity(page, pid, 'working', 'Bash', 'npm test')).toBe(200);
    const card = page.locator('#agents-panel .ag-card').first();
    await expect(card).toHaveCount(1, { timeout: 10000 });
    await expect(card.locator('.ag-detail')).toHaveText('npm test');
    await expect(card.locator('.ag-state')).toContainText('Bash');

    // A new signal overwrites the same card in place (TC-AAP-14).
    expect(await setActivity(page, pid, 'done', '', '')).toBe(200);
    await expect(page.locator('#agents-panel .ag-card')).toHaveCount(1);
    await expect(card.locator('.ag-state')).toContainText('done');

    // Clicking the card jumps to that pane (here the only pane → stays focused,
    // and the card click must not throw / panel still consistent).
    await card.click();
    await expect(page.locator('#area .pn.focused .pn-tab.active')).toHaveAttribute('data-toolid', pid!);
  });

  test('SessionEnd (ended) removes the card (FR-AAP-16)', async ({ page }) => {
    await waitForInit(page);
    const pid = await page.locator('#area .pn.focused .pn-tab.active').getAttribute('data-toolid');
    await page.locator('#agents-panel .ag-collapse').click();
    await expect(page.locator('#agents-panel.open')).toBeVisible();

    // done card present, then an `ended` signal removes it.
    expect(await setActivity(page, pid, 'done', '', 'x')).toBe(200);
    await expect(page.locator('#agents-panel .ag-card')).toHaveCount(1, { timeout: 10000 });
    expect(await setActivity(page, pid, 'ended', '', '')).toBe(200);
    await expect(page.locator('#agents-panel .ag-card')).toHaveCount(0, { timeout: 10000 });
  });

  test('new agent appends at bottom, status update keeps position (TC-AAP-19)', async ({ page }) => {
    await waitForInit(page);
    const pid1 = await page.locator('#area .pn.focused .pn-tab.active').getAttribute('data-toolid');

    // Second tab → a second pane.
    const before = await page.locator('#area .pn.focused .pn-tab').count();
    await page.locator('#area .pn.focused .pn-tab-add').click();
    await expect(page.locator('#area .pn.focused .pn-tab')).toHaveCount(before + 1, { timeout: 10000 });
    const pid2 = await page.locator('#area .pn.focused .pn-tab.active').getAttribute('data-toolid');
    expect(pid1).toBeTruthy();
    expect(pid2).toBeTruthy();

    await page.locator('#agents-panel .ag-collapse').click();
    await expect(page.locator('#agents-panel.open')).toBeVisible();

    // done state isn't pruned by the busy check, so ordering is stable.
    // pid1 reported first → top; pid2 reported second → appended at the bottom.
    expect(await setActivity(page, pid1, 'done', '', 'one')).toBe(200);
    expect(await setActivity(page, pid2, 'done', '', 'two')).toBe(200);
    await expect(page.locator('#agents-panel .ag-card')).toHaveCount(2, { timeout: 10000 });
    await expect(page.locator('#agents-panel .ag-card').first()).toHaveAttribute('data-toolid', pid1!);
    await expect(page.locator('#agents-panel .ag-card').last()).toHaveAttribute('data-toolid', pid2!);

    // Re-updating pid1 (status change) must NOT move it — order stays pid1, pid2.
    expect(await setActivity(page, pid1, 'working', 'Bash', 'again')).toBe(200);
    await expect(page.locator('#agents-panel .ag-card').first()).toHaveAttribute('data-toolid', pid1!);
    await expect(page.locator('#agents-panel .ag-card').last()).toHaveAttribute('data-toolid', pid2!);
  });

  test('drag reorders cards and persists to workspace (TC-AAP-20)', async ({ page }) => {
    await waitForInit(page);
    const pid1 = await page.locator('#area .pn.focused .pn-tab.active').getAttribute('data-toolid');

    const before = await page.locator('#area .pn.focused .pn-tab').count();
    await page.locator('#area .pn.focused .pn-tab-add').click();
    await expect(page.locator('#area .pn.focused .pn-tab')).toHaveCount(before + 1, { timeout: 10000 });
    const pid2 = await page.locator('#area .pn.focused .pn-tab.active').getAttribute('data-toolid');

    await page.locator('#agents-panel .ag-collapse').click();
    await expect(page.locator('#agents-panel.open')).toBeVisible();

    expect(await setActivity(page, pid1, 'done', '', 'one')).toBe(200);
    expect(await setActivity(page, pid2, 'done', '', 'two')).toBe(200);
    await expect(page.locator('#agents-panel .ag-card')).toHaveCount(2, { timeout: 10000 });
    // Initial order: pid1, pid2.
    await expect(page.locator('#agents-panel .ag-card').first()).toHaveAttribute('data-toolid', pid1!);

    // Drag pid2's card above pid1's card (native HTML5 DnD via synthetic events
    // sharing one DataTransfer — same path the sidebar session DnD uses). Full
    // browser sequence: drop commits immediately (no snap-back flicker), dragend
    // is a guarded fallback (must NOT double-move thanks to drag.done).
    await page.evaluate(
      ({ src, dst }) => {
        const dt = new DataTransfer();
        const s = document.querySelector(`#agents-panel .ag-card[data-toolid="${src}"]`)!;
        const d = document.querySelector(`#agents-panel .ag-card[data-toolid="${dst}"]`)!;
        const rect = d.getBoundingClientRect();
        const y = rect.top + 2; // upper half → insert before
        s.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
        d.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: dt, clientY: y }));
        d.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt, clientY: y }));
        s.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
      },
      { src: pid2, dst: pid1 },
    );

    // New order: pid2, pid1.
    await expect(page.locator('#agents-panel .ag-card').first()).toHaveAttribute('data-toolid', pid2!, {
      timeout: 10000,
    });
    await expect(page.locator('#agents-panel .ag-card').last()).toHaveAttribute('data-toolid', pid1!);

    // Persisted into ws.agentsOrder and survives a polling re-sync.
    const order = await page.evaluate(() => (window as any).app.ws.agentsOrder);
    expect(order.indexOf(pid2)).toBeLessThan(order.indexOf(pid1));
    await page.evaluate(() => (window as any).app.testing.activityRestore());
    await expect(page.locator('#agents-panel .ag-card').first()).toHaveAttribute('data-toolid', pid2!, {
      timeout: 10000,
    });

    // Dropping OUTSIDE the panel must also commit immediately (document-level
    // accept). Drag pid2 back below pid1 but release on document.body.
    await page.evaluate(
      ({ src, dst }) => {
        const dt = new DataTransfer();
        const s = document.querySelector(`#agents-panel .ag-card[data-toolid="${src}"]`)!;
        const d = document.querySelector(`#agents-panel .ag-card[data-toolid="${dst}"]`)!;
        const rect = d.getBoundingClientRect();
        // 경계에서 2px 만 들어오면 행 높이가 다른 OS 에서 위쪽 절반으로
        // 반올림될 수 있다 — 아래쪽 절반의 **한가운데**를 겨냥한다.
        const y = rect.top + rect.height * 0.75; // lower half → insert after
        s.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
        d.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: dt, clientY: y }));
        // Release far outside the panel — handled by the document-level drop.
        document.body.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt, clientY: 5 }));
        s.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
      },
      { src: pid2, dst: pid1 },
    );
    await expect(page.locator('#agents-panel .ag-card').first()).toHaveAttribute('data-toolid', pid1!, {
      timeout: 10000,
    });
    await expect(page.locator('#agents-panel .ag-card').last()).toHaveAttribute('data-toolid', pid2!);
  });

  test('attention alarm is composited onto the activity card (TC-AAP-17)', async ({ page }) => {
    await waitForInit(page);

    // Make a second tab so the first pane is in the background (foreground+active
    // panes suppress the attention highlight).
    const pid = await page.locator('#area .pn.focused .pn-tab.active').getAttribute('data-toolid');
    expect(pid).toBeTruthy();
    // done (not pruned by the busy check) so the card stays put through polling.
    //
    // **여기서는 턴을 시작하지 않는다** (AGENT_EVENT_ABSTRACTION_SRS FR-AEV-10).
    // 알람이 활동 보고에서 파생되므로, `working` 뒤의 `done` 은 **그 자리에서**
    // 알람이 된다 — 그런데 이 시점의 칸은 아직 포커스돼 있어서 그 알람은 바로
    // 걷힌다. 이 단계의 목적은 카드를 만드는 것뿐이므로 턴 없이 `done` 만 보고하고,
    // 알람은 칸이 배경으로 간 뒤에 세운다.
    expect(await setActivity(page, pid, 'done', '', 'finished')).toBe(200);

    await page.locator('#agents-panel .ag-collapse').click();
    await expect(page.locator('#agents-panel.open')).toBeVisible();
    const card = page.locator(`#agents-panel .ag-card[data-toolid="${pid}"]`);
    await expect(card).toHaveCount(1, { timeout: 10000 });

    // Move focus to a new tab so the first pane is background, then raise an
    // attention alarm on it via the server endpoint. Wait for the new tab to
    // actually become active first (else the pane is still focused-active and
    // the alarm is suppressed).
    const before = await page.locator('#area .pn.focused .pn-tab').count();
    await page.locator('#area .pn.focused .pn-tab-add').click();
    await expect(page.locator('#area .pn.focused .pn-tab')).toHaveCount(before + 1, { timeout: 10000 });
    // 턴을 하나 연다 — `done` 이 알람이 되는 전제다 (FR-ATN-4).
    expect(await setActivity(page, pid, 'working', '', '')).toBe(200);
    await page.evaluate(async (p) => {
      await fetch('/api/tools/attention/set', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ toolId: p, reason: 'done' }),
      });
    }, pid);

    await expect(card).toHaveClass(/attn/, { timeout: 10000 });
  });
});

// PANEL_SURFACE_SRS §3.1 (요구 ①) — agents 패널의 창 그룹.
// V-1(FR-AGG-1·2·4) · V-2(FR-AGG-3) · V-3(FR-AGG-6) · V-4(FR-AGG-7·8) ·
// V-5(FR-AGG-14).

// `#agents-panel` 의 자식을 위에서 아래로 읽는다. 그룹은 창 id, 카드는 도구 id 로
// 적는다 — 창 이름은 기본값이 서로 같아서(`Window`) 순서의 증거가 되지 못한다.
async function panelOrder(page: any): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll('#agents-body > *')]
      .map((e) => {
        const el = e as HTMLElement;
        if (el.classList.contains('ag-group')) return 'G:' + el.dataset.sid;
        if (el.classList.contains('ag-card')) return 'C:' + el.dataset.toolid;
        return '';
      })
      .filter(Boolean),
  );
}

// native HTML5 DnD 를 합성 이벤트로 재현한다 — 사이드바 창 재배치와 활동 카드가
// 같은 규약(dragstart→dragover→drop→dragend)을 쓴다.
async function dragOnto(page: any, srcSel: string, dstSel: string, half: 'top' | 'bottom') {
  await page.evaluate(
    ({ srcSel, dstSel, half }: { srcSel: string; dstSel: string; half: string }) => {
      const dt = new DataTransfer();
      const s = document.querySelector(srcSel)!;
      const d = document.querySelector(dstSel)!;
      const rect = d.getBoundingClientRect();
      const y = half === 'top' ? rect.top + rect.height * 0.25 : rect.top + rect.height * 0.75;
      s.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
      d.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: dt, clientY: y }));
      d.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt, clientY: y }));
      s.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
    },
    { srcSel, dstSel, half },
  );
}

/**
 * 창 둘을 만든다. 첫 창에 탭 둘(pidA·pidB), 둘째 창에 탭 하나(pidC).
 *
 * 첫 창의 탭이 둘인 것은 우연이 아니다 — FR-MOV-4 가 창의 **마지막** 탭은 내주지
 * 않으므로, V-3 이 탭을 옮기려면 내줄 수 있는 탭이 있어야 한다.
 */
async function twoWindows(page: any) {
  await waitForInit(page);
  const win1 = await page.evaluate(() => (window as any).app.ws.activeWindow);
  const pidA = await page.locator('#area .pn.focused .pn-tab.active').getAttribute('data-toolid');

  const before = await page.locator('#area .pn.focused .pn-tab').count();
  await page.locator('#area .pn.focused .pn-tab-add').click();
  await expect(page.locator('#area .pn.focused .pn-tab')).toHaveCount(before + 1, { timeout: 10000 });
  const pidB = await page.locator('#area .pn.focused .pn-tab.active').getAttribute('data-toolid');

  await page.locator('#add-window').click();
  await expect(page.locator('#windows .si')).toHaveCount(2, { timeout: 10000 });
  const win2 = await page.evaluate(() => (window as any).app.ws.activeWindow);
  expect(win2).not.toBe(win1);
  const pidC = await page.locator('#area .pn.focused .pn-tab.active').getAttribute('data-toolid');

  await page.locator('#agents-panel .ag-collapse').click();
  await expect(page.locator('#agents-panel.open')).toBeVisible();
  // done 은 busy 판정에 걸리지 않아 폴링을 지나도 카드가 남는다.
  for (const [pid, d] of [[pidA, 'a'], [pidB, 'b'], [pidC, 'c']] as Array<[string, string]>) {
    expect(await setActivity(page, pid, 'done', '', d)).toBe(200);
  }
  await expect(page.locator('#agents-panel .ag-card')).toHaveCount(3, { timeout: 10000 });
  return { win1, win2, pidA: pidA!, pidB: pidB!, pidC: pidC! };
}

test.describe('Agent panel window groups (FR-AGG)', () => {
  test('V-1: 그룹은 ws.windows 순서로 서고, 활동 없는 창은 머리도 없다 (FR-AGG-1·2·4)', async ({ page }) => {
    const { win1, win2, pidA, pidB, pidC } = await twoWindows(page);

    await expect(page.locator('#agents-panel .ag-group')).toHaveCount(2);
    expect(await panelOrder(page)).toEqual([
      'G:' + win1, 'C:' + pidA, 'C:' + pidB,
      'G:' + win2, 'C:' + pidC,
    ]);
    // 그룹 머리는 그 창의 이름을 말한다 (FR-AGG-1).
    const names = await page.evaluate(() => (window as any).app.ws.windows.map((w: any) => w.name));
    await expect(page.locator('#agents-panel .ag-group .ag-group-name').first()).toHaveText(names[0]);

    // FR-AGG-13: 카드에는 창 이름이 없다 — 머리가 그것을 말한다.
    await expect(page.locator(`#agents-panel .ag-card[data-toolid="${pidA}"] .ag-loc`)).not.toContainText(names[0]);

    // FR-AGG-4: 활동이 없는 셋째 창은 머리를 갖지 않는다.
    await page.evaluate(() => (window as any).app.addWindow());
    await expect(page.locator('#windows .si')).toHaveCount(3, { timeout: 10000 });
    await expect(page.locator('#agents-panel .ag-group')).toHaveCount(2);
  });

  test('V-2: 창 순서를 바꾸면 그룹 순서가 따라간다 (FR-AGG-3)', async ({ page }) => {
    const { win1, win2, pidA, pidB, pidC } = await twoWindows(page);
    expect((await panelOrder(page))[0]).toBe('G:' + win1);

    // 사이드바에서 둘째 창을 첫째 위로 끈다 — commit 이 그 자리에서 다시 그린다.
    await dragOnto(page, `#windows .si[data-sid="${win2}"]`, `#windows .si[data-sid="${win1}"]`, 'top');

    // 폴링을 기다리지 않는다: 끌어 놓은 그 자리에서 뒤집혀 있어야 한다.
    expect(await panelOrder(page)).toEqual([
      'G:' + win2, 'C:' + pidC,
      'G:' + win1, 'C:' + pidA, 'C:' + pidB,
    ]);
  });

  test('V-3: 탭을 다른 창으로 옮기면 카드가 그 그룹으로 간다 (FR-AGG-6)', async ({ page }) => {
    const { win1, win2, pidA, pidB, pidC } = await twoWindows(page);

    // `moveTabToWindow` 의 출발지는 **활성 창**이다 (`aw`) — 사이드바에서 끄는
    // 손은 언제나 보고 있는 창에서 출발하므로, 그 자리를 먼저 만든다.
    await page.evaluate(
      ({ win1, win2, pidB }: any) => {
        const app = (window as any).app;
        app.switchWindow(win1);
        const loc = app.testing.findToolLocation(pidB);
        app.testing.moveTabToWindow(loc.pane.id, loc.tab.id, win2);
      },
      { win1, win2, pidB },
    );

    await expect
      .poll(() => panelOrder(page), { timeout: 10000 })
      // 그룹 안 순서는 `ws.agentsOrder` 를 창으로 거른 것이다 (D-10) — 옮겨 온
      // pidB 는 그 평면 배열에서 pidC 보다 앞이므로 새 그룹에서도 앞이다.
      .toEqual(['G:' + win1, 'C:' + pidA, 'G:' + win2, 'C:' + pidB, 'C:' + pidC]);
  });

  test('V-4: 재배치는 그룹 안의 일이다 (FR-AGG-7·8)', async ({ page }) => {
    const { win1, win2, pidA, pidB, pidC } = await twoWindows(page);

    // 같은 그룹 안: pidB 를 pidA 위로 → 순서가 바뀐다.
    await dragOnto(page,
      `#agents-panel .ag-card[data-toolid="${pidB}"]`,
      `#agents-panel .ag-card[data-toolid="${pidA}"]`, 'top');
    await expect
      .poll(() => panelOrder(page), { timeout: 10000 })
      .toEqual(['G:' + win1, 'C:' + pidB, 'C:' + pidA, 'G:' + win2, 'C:' + pidC]);

    // 다른 그룹 위에 놓는 것은 아무 일도 아니다 — 원래 자리에 남는다.
    const orderBefore = await page.evaluate(() => (window as any).app.ws.agentsOrder.slice());
    await dragOnto(page,
      `#agents-panel .ag-card[data-toolid="${pidC}"]`,
      `#agents-panel .ag-card[data-toolid="${pidB}"]`, 'top');
    expect(await page.evaluate(() => (window as any).app.ws.agentsOrder)).toEqual(orderBefore);
    expect(await panelOrder(page)).toEqual(['G:' + win1, 'C:' + pidB, 'C:' + pidA, 'G:' + win2, 'C:' + pidC]);
  });

  test('V-5: 그룹 머리는 접히고, 알람과 함께 reconcile 을 지난다 (FR-AGG-10·11·14)', async ({ page }) => {
    const { win1, win2, pidA, pidB, pidC } = await twoWindows(page);

    // FR-AGG-14: 바깥 계기의 다시 그리기가 요소를 버리지 않는다.
    //
    // 세는 것은 **살아남은 비율**이지 절대수가 아니다. 종전에는 `6`(머리 + 그룹
    // 둘 + 카드 셋)을 박았는데, `UIUX_OVERHAUL_SRS` FR-ACT-1 이 패널에 구역 넷과
    // 그 빈 줄을 더하면서 그 수가 패널의 **구성**을 따라 움직이게 됐다. 이 검증이
    // 묻는 것은 "다시 그려도 그대로인가" 이므로 앞뒤를 견준다.
    const before = await page.locator('#agents-body > *').count();
    expect(before, '패널이 비었다 — 검증이 공회전한다').toBeGreaterThan(5);
    await page.evaluate(() => {
      for (const e of document.querySelectorAll('#agents-body > *')) (e as HTMLElement).dataset.mark = '1';
    });
    await page.evaluate(() => (window as any).app.render());
    await page.evaluate(() => (window as any).app.render());
    expect(await page.locator('#agents-body > *[data-mark="1"]').count()).toBe(before);

    // FR-AGG-10: 머리를 접으면 그 그룹의 카드만 사라진다.
    await page.locator(`#agents-panel .ag-group[data-sid="${win1}"] .ag-group-fold`).click();
    expect(await panelOrder(page)).toEqual(['G:' + win1, 'G:' + win2, 'C:' + pidC]);
    expect(await page.evaluate(() => localStorage.getItem('agentsGroupFold'))).toContain(win1);

    // FR-AGG-11: 접힌 채로도 알람 수가 보인다. 알람이 서려면 턴이 먼저 시작되어야
    // 한다 (FR-ATN-4).
    expect(await setActivity(page, pidA, 'working', '', 'a')).toBe(200);
    await page.evaluate(async (p) => {
      await fetch('/api/tools/attention/set', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ toolId: p, reason: 'done' }),
      });
    }, pidA);
    await expect(page.locator(`#agents-panel .ag-group[data-sid="${win1}"] .ag-group-attn`))
      .toHaveText('1', { timeout: 10000 });

    // 다시 누르면 펼쳐진다.
    await page.locator(`#agents-panel .ag-group[data-sid="${win1}"] .ag-group-fold`).click();
    expect(await panelOrder(page)).toEqual(['G:' + win1, 'C:' + pidA, 'C:' + pidB, 'G:' + win2, 'C:' + pidC]);
  });
});


/**
 * UIUX_OVERHAUL_SRS §4.3.1 (D-7) — **구역은 셋이고, 머리는 몸통으로 접힌다.**
 */
test.describe('FR-ACT-7·10 (D-7): 구역 셋과 몸통 접기', () => {
  // ACTIVITY_STATE_SUBAGENT_SRS FR-ASV-40: Usage 는 구역이 아니라 바닥이다 — 구역은 그대로 셋이다.
  test('FR-ACT-7: 구역이 셋이고 차례가 에이전트 · 백그라운드 · Run 이다', async ({ page }) => {
    await waitForInit(page);
    await page.locator('#agents-panel .ag-collapse').click();
    await expect(page.locator('#agents-panel.open')).toBeVisible();

    // 빈 구역도 머리를 갖는다 (FR-ACT-1) — 세는 것은 내용이 아니라 구역이다.
    const secs = await page.evaluate(() =>
      [...document.querySelectorAll('#agents-panel .ag-sec')].map((e) => (e as HTMLElement).dataset.sec));
    expect(secs, '주의 구역이 아직 패널에 있다').toEqual(['agents', 'bg', 'runs']);
  });

  test('FR-ACT-10: 그룹 머리의 몸통을 눌러 접고 편다', async ({ page }) => {
    const { win1, win2, pidA, pidB, pidC } = await twoWindows(page);

    const head = page.locator(`#agents-panel .ag-group[data-sid="${win1}"]`);
    const all = ['G:' + win1, 'C:' + pidA, 'C:' + pidB, 'G:' + win2, 'C:' + pidC];
    expect(await panelOrder(page)).toEqual(all);

    // 꺽쇠가 아니라 **이름 칸**을 누른다 — 종전에는 이것이 `switchWindow` 였다
    // (`PANEL_SURFACE_SRS` FR-AGG-12, 철회).
    await head.locator('.ag-group-name').click();
    expect(await panelOrder(page)).toEqual(['G:' + win1, 'G:' + win2, 'C:' + pidC]);
    expect(await page.evaluate(() => localStorage.getItem('agentsGroupFold'))).toContain(win1);

    // 창은 바뀌지 않았다 — 접기는 보는 방식이고 어디에 있는가가 아니다.
    expect(await page.evaluate(() => (window as any).app.ws.activeWindow)).not.toBe(win1);

    await head.locator('.ag-group-name').click();
    expect(await panelOrder(page)).toEqual(all);

    // 꺽쇠도 그대로 듣는다 — 몸통이 **더해진** 것이지 꺽쇠가 없어진 것이 아니다.
    await head.locator('.ag-group-fold').click();
    expect(await panelOrder(page)).toEqual(['G:' + win1, 'G:' + win2, 'C:' + pidC]);
  });
});

// ACTIVITY_CARD_USAGE_SRS TC-ACU-10: 사용량 줄이 보이고, 최소 폭에서 카드를 넘지 않는다
// (FR-ACU-10 · NFR-ACU-2).
test.describe('Agent card usage row', () => {
  // ACTIVITY_STATE_SUBAGENT_SRS FR-ASV-30: 모델·effort 가 왼쪽, 막대와 백분율이 오른쪽이다.
  test('TC-ACU-10: 모델 → 막대 → 백분율, 최소 폭에서 넘치지 않는다', async ({ page }) => {
    await waitForInit(page);
    const pid = await page.locator('#area .pn.focused .pn-tab.active').getAttribute('data-toolid');
    await page.locator('#agents-panel .ag-collapse').click();
    await expect(page.locator('#agents-panel.open')).toBeVisible();

    // 활동 목록은 에이전트가 없는 working 을 거른다 — 이 터미널에는 에이전트가 없다.
    expect(await setActivity(page, pid, 'done', '', 'app.js')).toBe(200);
    const status = await page.evaluate(async (toolId) => {
      const r = await fetch('/api/tools/usage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          toolId,
          usage: {
            model: { displayName: 'A Very Long Model Display Name For Overflow' },
            effort: 'high',
            contextWindow: { usedPct: 72.4 },
          },
        }),
      });
      return r.status;
    }, pid);
    expect(status).toBe(200);

    const row = page.locator(`#agents-panel .ag-card[data-toolid="${pid}"] .ag-usage`);
    // 사용량은 다음 활동 목록 응답에 실린다 (NFR-ACU-1).
    await page.evaluate(() => (window as any).app.testing.activityRestore());
    await expect(row).toHaveCount(1, { timeout: 10000 });
    await expect(row).toHaveClass(/lv-warn/);
    await expect(row.locator('.ag-usage-pct')).toHaveText('72%');
    await expect(row.locator('.ag-usage-model')).toHaveText('A Very Long Model Display Name For Overflow·high');
    const order = await row.evaluate((el) => [...el.children].map((c) => c.className));
    expect(order).toEqual(['ag-usage-model', 'ag-usage-bar', 'ag-usage-pct']);

    await page.evaluate(() => document.documentElement.style.setProperty('--ag-w', '160px'));
    const m = await row.evaluate((el) => {
      const card = el.closest('.ag-card') as HTMLElement;
      const pct = el.querySelector('.ag-usage-pct') as HTMLElement;
      return { cardScroll: card.scrollWidth, cardClient: card.clientWidth,
        pctRight: pct.getBoundingClientRect().right, cardRight: card.getBoundingClientRect().right };
    });
    expect(m.cardScroll, '사용량 줄이 카드를 가로로 밀었다').toBeLessThanOrEqual(m.cardClient);
    expect(m.pctRight, '백분율이 카드 밖으로 밀렸다').toBeLessThanOrEqual(m.cardRight);
  });
});

// SUBAGENT_USAGE_SRS TC-SAU-9: 서브에이전트 줄이 보이고, 최소 폭에서 카드를 넘지 않는다
// (FR-SAU-20 · NFR-SAU-2).
test.describe('Agent card subagent rows', () => {
  test('TC-SAU-9: 서브에이전트마다 한 줄, 끝난 줄은 흐림, 최소 폭에서 넘치지 않는다', async ({ page }) => {
    await waitForInit(page);
    const pid = await page.locator('#area .pn.focused .pn-tab.active').getAttribute('data-toolid');
    await page.locator('#agents-panel .ag-collapse').click();
    await expect(page.locator('#agents-panel.open')).toBeVisible();

    expect(await setActivity(page, pid, 'done', '', 'app.js')).toBe(200);
    const status = await page.evaluate(async (toolId) => {
      const r = await fetch('/api/tools/subagents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          toolId,
          tasks: [
            { id: 'a1', agentType: 'A-Very-Long-Agent-Type-Name-For-Overflow', status: 'running',
              model: 'claude-a-very-long-model-id-for-overflow', effort: 'high',
              windowTokens: 200000, tokens: 150000, startTime: 1000 },
            { id: 'a2', agentType: 'Plan', status: 'completed', tokens: 5, windowTokens: 1000, startTime: 2000 },
          ],
        }),
      });
      return r.status;
    }, pid);
    expect(status).toBe(200);

    // UX_BATCH12_SRS FR-SVL-1: 서브에이전트는 언제나 카드 안의 줄이다.
    const rows = page.locator(`#agents-panel .ag-card[data-toolid="${pid}"] .ag-sub`);
    await page.evaluate(() => (window as any).app.testing.activityRestore());
    await expect(rows).toHaveCount(2, { timeout: 10000 });
    await expect(rows.nth(0).locator('.ag-usage')).toHaveClass(/lv-warn/);
    await expect(rows.nth(0).locator('.ag-usage-pct')).toHaveText('75%');
    await expect(rows.nth(0).locator('.ag-usage-model')).toHaveText('a-very-long-model-id-for-overflow·high');
    await expect(rows.nth(1)).toHaveClass(/done/);
    await expect(rows.nth(1).locator('.ag-sub-type')).toHaveText('Plan');

    await page.evaluate(() => document.documentElement.style.setProperty('--ag-w', '160px'));
    const m = await rows.nth(0).evaluate((el) => {
      const card = el.closest('.ag-card') as HTMLElement;
      const pct = el.querySelector('.ag-usage-pct') as HTMLElement;
      return { cardScroll: card.scrollWidth, cardClient: card.clientWidth,
        pctRight: pct.getBoundingClientRect().right, cardRight: card.getBoundingClientRect().right };
    });
    expect(m.cardScroll, '서브에이전트 줄이 카드를 가로로 밀었다').toBeLessThanOrEqual(m.cardClient);
    expect(m.pctRight, '백분율이 카드 밖으로 밀렸다').toBeLessThanOrEqual(m.cardRight);
  });
});

// ACTIVITY_STATE_SUBAGENT_SRS TC-ASV-15 (UX_BATCH12_SRS FR-SVL-1·2 개정): 카드 안의 서브에이전트 줄·Usage 바닥이
// 보이고, 최소 폭에서 패널을 넘지 않는다. 폴더형 하위 카드·보기 전환·접기는 없다.
test.describe('Activity subagent views and usage limits', () => {
  test('TC-ASV-15: 카드 안의 서브에이전트 줄, 전환 버튼 없음, Usage 바닥', async ({ page }) => {
    await waitForInit(page);
    const pid = await page.locator('#area .pn.focused .pn-tab.active').getAttribute('data-toolid');
    await page.locator('#agents-panel .ag-collapse').click();
    await expect(page.locator('#agents-panel.open')).toBeVisible();

    expect(await setActivity(page, pid, 'done', '', 'app.js')).toBe(200);
    const codes = await page.evaluate(async (toolId) => {
      const post = (url: string, body: unknown) => fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      }).then((r) => r.status);
      return [
        await post('/api/tools/subagents', { toolId, tasks: [
          { id: 'a1', agentType: 'Explore', status: 'running', model: 'claude-haiku-5-5', effort: 'low',
            windowTokens: 1000000, tokens: 20000, startTime: 1000, description: 'Find the hook parser' },
        ] }),
        await post('/api/tools/activity/set', { toolId, agentId: 'a1', agentType: 'Explore',
          state: 'working', tool: 'A-Very-Long-Tool-Name-For-Overflow-Check', detail: 'grep -rn parseClaudeHook internal' }),
        await post('/api/tools/usage', { toolId, usage: { rateLimits: {
          five_hour: { usedPct: 72, resetsAt: Math.floor(Date.now() / 1000) + 7800 },
          seven_day: { usedPct: 21, resetsAt: Math.floor(Date.now() / 1000) + 368000 },
        } } }),
      ];
    }, pid);
    expect(codes).toEqual([200, 200, 200]);
    await page.evaluate(() => (window as any).app.testing.activityRestore());

    // FR-SVL-1·2: 카드 안의 줄이고, 하위 카드·전환 버튼·접기 단추는 없다
    const row = page.locator(`#agents-panel .ag-card[data-toolid="${pid}"] .ag-sub`);
    await expect(row).toHaveCount(1, { timeout: 10000 });
    await expect(row.locator('.ag-sub-state')).toHaveText('● working · A-Very-Long-Tool-Name-For-Overflow-Check');
    await expect(row.locator('.ag-usage-model')).toHaveText('haiku-5-5·low');
    await expect(page.locator('#agents-panel .ag-subcard')).toHaveCount(0);
    await expect(page.locator('#agents-panel .ag-subview')).toHaveCount(0);
    await expect(page.locator('#agents-panel .ag-sub-fold')).toHaveCount(0);

    // Usage 바닥 — 패널의 마지막 원소이고 패널 아랫변에 붙는다 (FR-ASV-40). statusLine 값은 한 줄이다 (CLAUDE_ACCOUNTS_SRS FR-CAC-93)
    const foot = page.locator('#agents-panel .act-usage-foot');
    await expect(foot).toHaveCount(1);
    const sl = foot.locator('.act-usage-sl');
    await expect(sl).toHaveCount(1);
    const segs = sl.locator('.act-usage-sl-seg');
    await expect(segs).toHaveCount(2);
    await expect(segs.nth(0)).toHaveClass(/lv-warn/);
    await expect(segs.nth(0)).toContainText('72%');
    await expect(segs.nth(1)).toContainText('21%');
    await expect(sl.locator('.act-usage-sl-reset')).toContainText(/(2h (9|10)m|2시간 (9|10)분)/);
    const pinned = await foot.evaluate((el) => {
      const p = el.parentElement as HTMLElement;
      return { last: p.lastElementChild === el,
        gap: Math.abs(p.getBoundingClientRect().bottom - el.getBoundingClientRect().bottom) };
    });
    expect(pinned.last, 'Usage 바닥이 패널의 마지막 원소가 아니다').toBe(true);
    expect(pinned.gap, 'Usage 바닥이 패널 아랫변에 붙지 않았다').toBeLessThanOrEqual(2);
    // FR-ASV-40 (D-ASV-12): 바닥은 스크롤 몸통 밖이다 — 몸통만 스크롤되고 바닥과 겹치지 않는다.
    const split = await page.evaluate(() => {
      const body = document.getElementById('agents-body');
      const f = document.querySelector('#agents-panel .act-usage-foot') as HTMLElement;
      const p = document.getElementById('agents-panel') as HTMLElement;
      return { body: !!body, inBody: !!body && body.contains(f),
        overlap: body ? body.getBoundingClientRect().bottom - f.getBoundingClientRect().top : NaN,
        panelScrolls: getComputedStyle(p).overflowY !== 'hidden' && p.scrollHeight > p.clientHeight };
    });
    expect(split.body, '스크롤 몸통이 없다').toBe(true);
    expect(split.inBody, 'Usage 바닥이 스크롤 몸통 안에 있다').toBe(false);
    expect(split.overlap, '스크롤 몸통이 바닥과 겹친다').toBeLessThanOrEqual(1);
    expect(split.panelScrolls, '패널 자체가 스크롤된다').toBe(false);

    // 최소 폭에서 패널을 넘지 않는다
    await page.evaluate(() => document.documentElement.style.setProperty('--ag-w', '160px'));
    const m = await page.evaluate(() => {
      const p = document.getElementById('agents-panel') as HTMLElement;
      const subEl = p.querySelector('.ag-sub') as HTMLElement;
      const win = p.querySelector('.act-usage-foot') as HTMLElement;
      return { panelScroll: p.scrollWidth, panelClient: p.clientWidth,
        subScroll: subEl.scrollWidth, subClient: subEl.clientWidth,
        winScroll: win.scrollWidth, winClient: win.clientWidth };
    });
    expect(m.panelScroll, '패널이 가로로 밀렸다').toBeLessThanOrEqual(m.panelClient);
    expect(m.subScroll, '서브에이전트 줄이 넘쳤다').toBeLessThanOrEqual(m.subClient);
    expect(m.winScroll, 'Usage 바닥이 넘쳤다').toBeLessThanOrEqual(m.winClient);

  });
});
