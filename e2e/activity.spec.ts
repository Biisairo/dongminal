import { test, expect, waitForInit } from './fixtures';

// AGENT_ACTIVITY_PANEL_SRS e2e: agent activity panel.
// Covers TC-AAP-11 (card with location/state/detail), TC-AAP-12 (toggle),
// TC-AAP-13 (click → jump), TC-AAP-14 (in-place update), TC-AAP-17 (attention
// alarm composited onto the card), TC-AAP-19 (new agent appends at bottom,
// status update keeps position), TC-AAP-20 (drag reorder persisted).

// userPrompt 는 이 턴이 사용자 프롬프트에서 시작되었다는 곁들이 값이다
// (ATTENTION_FIRING_SRS FR-ATN-2). 기본값이 거짓인 것은 활동 패널을 보는
// 테스트 대부분이 턴의 출처와 무관하기 때문이다.
async function setActivity(page, toolId, state, tool, detail, userPrompt = false) {
  return page.evaluate(
    async (a) => {
      const r = await fetch('/api/tools/activity/set', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(a),
      });
      return r.status;
    },
    { toolId, state, tool, detail, userPrompt },
  );
}

test.describe('Agent activity panel', () => {
  test('card render, in-place update, toggle, jump', async ({ page }) => {
    await waitForInit(page);

    const pid = await page.locator('#area .pn.focused .pn-tab.active').getAttribute('data-toolid');
    expect(pid).toBeTruthy();

    // Open the panel (toggle button next to Split V).
    await page.locator('#agents-toggle').click();
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
    await page.locator('#agents-toggle').click();
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

    await page.locator('#agents-toggle').click();
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

    await page.locator('#agents-toggle').click();
    await expect(page.locator('#agents-panel.open')).toBeVisible();

    expect(await setActivity(page, pid1, 'done', '', 'one')).toBe(200);
    expect(await setActivity(page, pid2, 'done', '', 'two')).toBe(200);
    await expect(page.locator('#agents-panel .ag-card')).toHaveCount(2, { timeout: 10000 });
    // Initial order: pid1, pid2.
    await expect(page.locator('#agents-panel .ag-card').first()).toHaveAttribute('data-toolid', pid1!);

    // Drag pid2's card above pid1's card (native HTML5 DnD via synthetic events
    // sharing one DataTransfer — same path the sidebar session DnD uses). Full
    // browser sequence: drop commits immediately (no snap-back flicker), dragend
    // is a guarded fallback (must NOT double-move thanks to _drag.done).
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
    await page.evaluate(() => (window as any).app._activityRestore());
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
    // **여기서는 사용자 턴을 말하지 않는다** (AGENT_EVENT_ABSTRACTION_SRS
    // FR-AEV-10). 알람이 활동 보고에서 파생되면서, `userPrompt` 를 실은 `done`
    // 은 **그 자리에서** 알람이 된다 — 그런데 이 시점의 칸은 아직 포커스돼
    // 있어서 그 알람은 바로 걷힌다. 이 단계의 목적은 카드를 만드는 것뿐이므로
    // 배경 턴의 종료로 보고하고, 알람은 칸이 배경으로 간 뒤에 세운다.
    expect(await setActivity(page, pid, 'done', '', 'finished', false)).toBe(200);

    await page.locator('#agents-toggle').click();
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
    // 사용자 턴을 하나 연다 — `done` 이 알람이 되는 전제다 (FR-ATN-4). 종전에는
    // 이 자리가 필요 없었다: 알람이 `dmctl notify` 라는 **별도 명령**에서 왔고
    // 활동 보고와 무관했기 때문이다. 이제 둘이 한 경로이므로 턴이 서야 한다.
    expect(await setActivity(page, pid, 'working', '', '', true)).toBe(200);
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
    [...document.querySelectorAll('#agents-panel > *')]
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

  await page.locator('#agents-toggle').click();
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

    // `_moveTabToWindow` 의 출발지는 **활성 창**이다 (`_aw`) — 사이드바에서 끄는
    // 손은 언제나 보고 있는 창에서 출발하므로, 그 자리를 먼저 만든다.
    await page.evaluate(
      ({ win1, win2, pidB }: any) => {
        const app = (window as any).app;
        app.switchWindow(win1);
        const loc = app._findToolLocation(pidB);
        app._moveTabToWindow(loc.pane.id, loc.tab.id, win2);
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
    await page.evaluate(() => {
      for (const e of document.querySelectorAll('#agents-panel > *')) (e as HTMLElement).dataset.mark = '1';
    });
    await page.evaluate(() => (window as any).app.render());
    await page.evaluate(() => (window as any).app.render());
    // `.ag-head` + 그룹 둘 + 카드 셋.
    expect(await page.locator('#agents-panel > *[data-mark="1"]').count()).toBe(6);

    // FR-AGG-10: 머리를 접으면 그 그룹의 카드만 사라진다.
    await page.locator(`#agents-panel .ag-group[data-sid="${win1}"] .ag-group-fold`).click();
    expect(await panelOrder(page)).toEqual(['G:' + win1, 'G:' + win2, 'C:' + pidC]);
    expect(await page.evaluate(() => localStorage.getItem('agentsGroupFold'))).toContain(win1);

    // FR-AGG-11: 접힌 채로도 알람 수가 보인다. 알람이 서려면 그 턴이 사용자
    // 프롬프트에서 시작되었다고 먼저 말해야 한다 (FR-ATN-2·4).
    expect(await setActivity(page, pidA, 'done', '', 'a', true)).toBe(200);
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
