import { test, expect } from './fixtures';

// 창 슬롯 — WINDOW_SLOTS_SRS §5 TC-WSL-*
//
// 슬롯은 클라이언트의 것이다 (FR-WSL-2). 그래서 대부분의 검증은 DOM 과
// sessionStorage 로 하고, 서버를 보는 것은 소유권(§3.2)뿐이다 — 그것만이 서버가
// 슬롯의 존재를 겪는 지점이다.
//
// 서버의 활성 탭 판정은 검증 대상이 아니다. `_save()` 가 PUT 에서
// activeWindow·focusedPane 을 벗기므로(app.js:293) 그 판정은 슬롯 이전에도
// 클라이언트의 현재 포커스를 따라오지 않았다 (SRS §2.7).

async function waitForInit(page) {
  await page.context().addInitScript(() => {
    sessionStorage.setItem('displayMode', 'desktop');
  });
  await page.goto('/');
  await page.waitForSelector('#area .pn.focused .xterm-helper-textarea', { timeout: 15000 });
}

const slotCount = (page) => page.evaluate(() => (window as any).app.slotCount());
const slotsState = (page) => page.evaluate(() => (window as any).app.slots);
const slotAdd = (page) => page.evaluate(() => (window as any).app.slotAdd());
const slotRemove = (page) => page.evaluate(() => (window as any).app.slotRemove());
const focusSlot = (page, i: number) => page.evaluate((n) => (window as any).app.slotFocusTo(n), i);
const openInSlot = (page, i: number, winId: string) =>
  page.evaluate(([n, id]) => (window as any).app.slotOpen(n, id), [i, winId] as const);
const activeWindowOf = (page) => page.evaluate(() => (window as any).app.ws.activeWindow);
const toolKeys = (page) => page.evaluate(() => [...(window as any).app.tools.keys()]);
const slotDirOf = (page) => page.evaluate(() => (window as any).app.slotDir);
const setSlotDir = (page, d: string) => page.evaluate((v) => ((window as any).app.slotDir = v), d);

// 새 일반 창을 만들고 그 id 를 준다. _mkWindow 는 생성한 엔터티 id 를 돌려준다
// (app-layout.js, FR-RCR-6/7).
const addWindow = (page) =>
  page.evaluate(async () => {
    const r = await (window as any).app._mkWindow();
    (window as any).app.render();
    return r.win;
  });

// 칸이 실제로 어느 축으로 놓였는지 — 스타일이 아니라 **화면 위치**로 본다.
async function slotAxis(page) {
  const a = await page.locator('#area .slot[data-slot="0"]').boundingBox();
  const b = await page.locator('#area .slot[data-slot="1"]').boundingBox();
  return Math.abs(b.x - a.x) > Math.abs(b.y - a.y) ? 'horizontal' : 'vertical';
}

// 칸 n 개를 서로 다른 창으로 채운다. 포커스는 칸 0 으로 되돌린다.
//
// `addWindow()` 가 activeWindow 를 새 창으로 옮기고 `+` 는 포커스 칸의 창을
// 복제하므로(FR-WSL-52), 칸마다 다른 창을 보려면 명시적으로 놓아야 한다.
async function slotsWith(page, n: number) {
  const wins = [await activeWindowOf(page)];
  for (let i = 1; i < n; i++) wins.push(await addWindow(page));
  for (let i = 1; i < n; i++) await slotAdd(page);
  for (let i = 0; i < n; i++) await openInSlot(page, i, wins[i]);
  await focusSlot(page, 0);
  return wins;
}

async function owners(request) {
  const r = await request.get('/api/focus');
  expect(r.ok()).toBeTruthy();
  return (await r.json()).owners || {};
}

test.describe('묶음 S·R — 슬롯 모델과 렌더링', () => {
  test('TC-WSL-1: 슬롯 1개일 때 DOM 은 본 SRS 이전과 같다 (FR-WSL-4)', async ({ page }) => {
    await waitForInit(page);
    expect(await slotCount(page)).toBe(1);
    expect(await slotsState(page)).toBeNull();
    await expect(page.locator('#area .slot')).toHaveCount(0);
    await expect(page.locator('#area .slot-handle')).toHaveCount(0);
    // 분할 트리는 #area 의 직속 자식이다 — 슬롯 컨테이너가 끼지 않는다.
    await expect(page.locator('#area > .pn, #area > .sp')).not.toHaveCount(0);
  });

  test('TC-WSL-2: + 를 누르면 칸 둘과 손잡이 하나가 생긴다 (FR-WSL-1/30)', async ({ page }) => {
    await waitForInit(page);
    await slotAdd(page);
    expect(await slotCount(page)).toBe(2);
    await expect(page.locator('#area .slot')).toHaveCount(2);
    await expect(page.locator('#area .slot-handle')).toHaveCount(1);
    await expect(page.locator('#area .slot[data-slot="0"] .pn')).not.toHaveCount(0);
    await expect(page.locator('#area .slot[data-slot="1"] .pn')).not.toHaveCount(0);
    await expect(page.locator('#area .slot.slot-focused')).toHaveCount(1);
  });

  test('TC-WSL-2b: 칸은 넷까지 늘어나고 손잡이는 하나 적다 (FR-WSL-1)', async ({ page }) => {
    await waitForInit(page);
    for (let i = 0; i < 3; i++) await slotAdd(page);
    expect(await slotCount(page)).toBe(4);
    await expect(page.locator('#area .slot')).toHaveCount(4);
    await expect(page.locator('#area .slot-handle')).toHaveCount(3);
    await expect(page.locator('#area .slot.slot-focused')).toHaveCount(1);
  });

  test('TC-WSL-2c: 한계에서 버튼이 비활성이다 (FR-WSL-1/50)', async ({ page }) => {
    await waitForInit(page);
    // 칸이 1개면 `−` 를 쓸 수 없다.
    await expect(page.locator('#slot-remove')).toBeDisabled();
    await expect(page.locator('#slot-add')).toBeEnabled();

    for (let i = 0; i < 3; i++) await slotAdd(page);
    await expect(page.locator('#slot-add')).toBeDisabled();
    await expect(page.locator('#slot-remove')).toBeEnabled();

    // 상한을 넘겨 부르면 무동작이다.
    await slotAdd(page);
    expect(await slotCount(page)).toBe(4);
  });

  test('TC-WSL-3: 슬롯은 workspace.json 에 새지 않는다 (FR-WSL-2)', async ({ page, request }) => {
    await waitForInit(page);
    await slotAdd(page);
    await slotAdd(page);
    await expect(page.locator('#area .slot')).toHaveCount(3);

    const r = await request.get('/api/workspace');
    expect(r.ok()).toBeTruthy();
    const ws = await r.json();
    expect(ws.schemaVersion).toBe(2);
    expect(ws.slots).toBeUndefined();
    expect(ws.focusedSlot).toBeUndefined();
  });

  test('TC-WSL-4: 칸 배치가 새로고침 후 복원된다 (FR-WSL-2/61)', async ({ page }) => {
    await waitForInit(page);
    const wins = await slotsWith(page, 3);
    await expect(page.locator('#area .slot')).toHaveCount(3);

    await page.reload();
    await page.waitForSelector('#area .slot[data-slot="2"]', { timeout: 15000 });
    expect(await slotCount(page)).toBe(3);
    expect((await slotsState(page)).windows).toEqual(wins);
  });

  test('TC-WSL-22: 손잡이를 끌면 이웃 두 칸의 배분이 바뀐다 (FR-WSL-32)', async ({ page }) => {
    await waitForInit(page);
    await slotsWith(page, 3);
    const handle = page.locator('#area .slot-handle[data-slot-handle="0"]');
    await expect(handle).toHaveCount(1);

    const before = (await slotsState(page)).sizes.slice();
    const box = await handle.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 - 150, box.y + box.height / 2, { steps: 10 });
    await page.mouse.up();

    const after = (await slotsState(page)).sizes;
    expect(after[0]).toBeLessThan(before[0]);
    // 손잡이가 가르지 않는 칸은 그대로다.
    expect(after[2]).toBeCloseTo(before[2], 5);

    await page.reload();
    await page.waitForSelector('#area .slot-handle', { timeout: 15000 });
    expect((await slotsState(page)).sizes[0]).toBeCloseTo(after[0], 3);
  });

  test('TC-WSL-28: 칸마다 창 이름 머리글이 서고 포커스 칸만 강조된다 (FR-WSL-35)', async ({ page }) => {
    await waitForInit(page);
    const wins = await slotsWith(page, 3);

    await expect(page.locator('#area .slot .slot-head')).toHaveCount(3);
    const names = await page.evaluate(
      (ids) =>
        ids.map((id) => (window as any).app.ws.windows.find((w) => w.id === id).name),
      wins,
    );
    for (let i = 0; i < 3; i++) {
      await expect(page.locator(`#area .slot[data-slot="${i}"] .slot-head`)).toContainText(names[i]);
    }
    // 강조는 포커스 칸 하나뿐이다.
    await expect(page.locator('#area .slot.slot-focused .slot-head')).toHaveCount(1);
    await focusSlot(page, 2);
    await expect(page.locator('#area .slot[data-slot="2"].slot-focused')).toHaveCount(1);
    await expect(page.locator('#area .slot[data-slot="0"].slot-focused')).toHaveCount(0);
  });
});

test.describe('묶음 I — 슬롯 신원과 소유권', () => {
  test('TC-WSL-5: 포커스 슬롯이 activeWindow 를 정한다 (FR-WSL-3)', async ({ page }) => {
    await waitForInit(page);
    const [w1, , w3] = await slotsWith(page, 3);

    expect(await activeWindowOf(page)).toBe(w1);
    await focusSlot(page, 2);
    expect(await activeWindowOf(page)).toBe(w3);
    const awId = await page.evaluate(() => (window as any).app._aw().id);
    expect(awId).toBe(w3);

    await focusSlot(page, 0);
    expect(await activeWindowOf(page)).toBe(w1);
  });

  test('TC-WSL-6: 서로 다른 창이면 어느 pane 도 dim 되지 않는다 (FR-WSL-12/13)', async ({ page }) => {
    await waitForInit(page);
    await slotsWith(page, 3);

    for (let i = 0; i < 3; i++) {
      await expect(page.locator(`#area .slot[data-slot="${i}"] .pn`)).not.toHaveCount(0);
    }
    await expect(page.locator('#area .pn.pn-dimmed')).toHaveCount(0, { timeout: 10000 });
  });

  test('TC-WSL-7: 같은 창이면 비포커스 칸만 dim 된다 (FR-WSL-14)', async ({ page }) => {
    await waitForInit(page);
    await slotAdd(page); // FR-WSL-52: 새 칸에 같은 창이 들어간다
    await focusSlot(page, 0);

    await expect(page.locator('#area .slot[data-slot="1"] .pn.pn-dimmed')).not.toHaveCount(0, {
      timeout: 10000,
    });
    await expect(page.locator('#area .slot[data-slot="0"] .pn.pn-dimmed')).toHaveCount(0);
  });

  test('TC-WSL-8: 칸이 여럿이어도 창 하나에 소유자는 하나다 (FR-WSL-15)', async ({ page, request }) => {
    await waitForInit(page);
    await slotsWith(page, 3);

    await expect
      .poll(async () => Object.keys(await owners(request)).length, { timeout: 10000 })
      .toBeGreaterThanOrEqual(1);
    const map = await owners(request);
    for (const v of Object.values(map)) expect(typeof v).toBe('string');
  });

  test('TC-WSL-9: 한 신원은 여전히 한 창만 소유한다 (FR-WSL-15, TC-XDF-3)', async ({ page, request }) => {
    await waitForInit(page);
    await slotsWith(page, 3);
    await focusSlot(page, 1);

    const map = await owners(request);
    const byClient = new Map<string, number>();
    for (const cid of Object.values(map) as string[]) {
      byClient.set(cid, (byClient.get(cid) || 0) + 1);
    }
    for (const [, n] of byClient) expect(n).toBe(1);
  });

  test('TC-WSL-10: 칸을 없애면 그 신원의 소유가 해제된다 (FR-WSL-11)', async ({ page, request }) => {
    await waitForInit(page);
    const [, w2] = await slotsWith(page, 2);
    await focusSlot(page, 1);
    await expect.poll(async () => (await owners(request))[w2], { timeout: 10000 }).toBeTruthy();

    await slotRemove(page); // 포커스 칸(1)이 사라진다
    expect(await slotCount(page)).toBe(1);
    await expect.poll(async () => (await owners(request))[w2], { timeout: 10000 }).toBeUndefined();
  });
});

test.describe('묶음 N — 슬롯 간 이동', () => {
  test('TC-WSL-11: 창의 끝에서 한 번 더 누르면 옆 칸으로 간다 (FR-WSL-40/43)', async ({ page }) => {
    await waitForInit(page);
    const [, w2] = await slotsWith(page, 2);

    await page.evaluate(() => (window as any).app.paneNavigate('right'));
    expect((await slotsState(page)).focused).toBe(1);
    expect(await activeWindowOf(page)).toBe(w2);

    await page.evaluate(() => (window as any).app.paneNavigate('left'));
    expect((await slotsState(page)).focused).toBe(0);
  });

  test('TC-WSL-11b: 칸이 셋이면 한 칸씩 건너간다 (FR-WSL-40)', async ({ page }) => {
    await waitForInit(page);
    await slotsWith(page, 3);

    for (const want of [1, 2]) {
      await page.evaluate(() => (window as any).app.paneNavigate('right'));
      expect((await slotsState(page)).focused).toBe(want);
    }
    for (const want of [1, 0]) {
      await page.evaluate(() => (window as any).app.paneNavigate('left'));
      expect((await slotsState(page)).focused).toBe(want);
    }
  });

  test('TC-WSL-12: 분할 없는 창(Git)에서도 경계를 넘는다 (FR-WSL-41)', async ({ page }) => {
    await waitForInit(page);
    await slotAdd(page);
    // `_mkGitWindow` 는 GIT_VIEWS 고정 탭을 갖춘 pane **하나짜리** 창을 만든다
    // (app-git.js) — 여기서 필요한 "분할이 없는 창" 을 얻는 데 저장소가 필요없다.
    const gitWin = await page.evaluate(() => {
      const app = (window as any).app;
      const w = app._gitWindow() || app._mkGitWindow(null);
      app.render();
      return w.id;
    });

    await openInSlot(page, 1, gitWin);
    await focusSlot(page, 1);
    await page.evaluate(() => (window as any).app.paneNavigate('left'));
    expect((await slotsState(page)).focused).toBe(0);
  });

  test('TC-WSL-13: 가로 배치에서 위아래는 칸을 넘지 않는다 (FR-WSL-42)', async ({ page }) => {
    await waitForInit(page);
    await slotsWith(page, 2);

    await page.evaluate(() => (window as any).app.paneNavigate('down'));
    expect((await slotsState(page)).focused).toBe(0);
    await page.evaluate(() => (window as any).app.paneNavigate('up'));
    expect((await slotsState(page)).focused).toBe(0);
  });

  test('TC-WSL-14: 단일 칸·가장자리에서는 무동작이고 순환하지 않는다 (FR-WSL-44/46)', async ({ page }) => {
    await waitForInit(page);
    const before = await activeWindowOf(page);
    await page.evaluate(() => (window as any).app.paneNavigate('right'));
    expect(await slotCount(page)).toBe(1);
    expect(await activeWindowOf(page)).toBe(before);

    await slotsWith(page, 2);
    await focusSlot(page, 1);
    // 마지막 칸에서 오른쪽 — 첫 칸으로 돌아오지 않는다.
    await page.evaluate(() => (window as any).app.paneNavigate('right'));
    expect((await slotsState(page)).focused).toBe(1);
  });

  test('TC-WSL-15: 경계 넘침이 activeWindow 와 포커스 pane 을 옮긴다 (FR-WSL-45)', async ({ page }) => {
    await waitForInit(page);
    const [, w2] = await slotsWith(page, 2);

    await page.evaluate(() => (window as any).app.paneNavigate('right'));
    expect(await activeWindowOf(page)).toBe(w2);

    const inTarget = await page.evaluate((id) => {
      const app = (window as any).app;
      const win = app.ws.windows.find((w) => w.id === id);
      return app._flattenPanes(win.layout).some((p) => p.id === app.focused);
    }, w2);
    expect(inTarget).toBe(true);
  });
});

test.describe('묶음 T — 도구 인스턴스', () => {
  test('TC-WSL-16: 칸의 창을 바꾸면 이전 인스턴스가 회수된다 (FR-WSL-21/24)', async ({ page }) => {
    await waitForInit(page);
    const [, w2] = await slotsWith(page, 2);
    const w3 = await addWindow(page);

    // FR-WSL-75: 칸 1 의 키는 `${toolId}@1` 이다.
    await expect.poll(async () => (await toolKeys(page)).filter((k) => k.endsWith('@1')).length, {
      timeout: 10000,
    }).toBeGreaterThan(0);

    await openInSlot(page, 1, w3);
    const keysAfter = await toolKeys(page);
    const w2Tools = await page.evaluate((id) => {
      const app = (window as any).app;
      const win = app.ws.windows.find((w) => w.id === id);
      return app._flattenPanes(win.layout).flatMap((p) => p.tabs.map((t) => t.toolId));
    }, w2);
    for (const t of w2Tools) expect(keysAfter).not.toContain(`${t}@1`);

    await focusSlot(page, 1);
    await slotRemove(page);
    expect((await toolKeys(page)).filter((k) => k.includes('@'))).toHaveLength(0);
  });

  test('TC-WSL-17: 도구를 지우면 모든 칸의 인스턴스가 사라진다 (FR-WSL-22)', async ({ page }) => {
    await waitForInit(page);
    await slotAdd(page); // 같은 창이 두 칸에 — 도구가 두 벌이다
    const toolId = await page.evaluate(() => {
      const app = (window as any).app;
      const pn = app._flattenPanes(app._aw().layout)[0];
      return pn.tabs.find((t) => t.id === pn.activeTab).toolId;
    });
    await expect.poll(async () => (await toolKeys(page)).includes(`${toolId}@1`), {
      timeout: 10000,
    }).toBe(true);

    await page.evaluate((id) => (window as any).app._killTool(id), toolId);
    const keys = await toolKeys(page);
    expect(keys).not.toContain(toolId);
    expect(keys).not.toContain(`${toolId}@1`);
  });
});

test.describe('묶음 U·M — 진입점과 모바일', () => {
  test('TC-WSL-18: + 는 포커스 칸 뒤에 같은 창으로 서고 포커스를 가져간다 (FR-WSL-52)', async ({ page }) => {
    await waitForInit(page);
    const wins = await slotsWith(page, 3);
    await focusSlot(page, 1);

    await slotAdd(page);
    const st = await slotsState(page);
    expect(st.windows).toHaveLength(4);
    expect(st.focused).toBe(2);                 // 포커스 칸 **바로 뒤**
    expect(st.windows[2]).toBe(wins[1]);        // 같은 창
    expect(st.windows[3]).toBe(wins[2]);        // 뒤의 칸은 밀린다
  });

  test('TC-WSL-18b: − 는 포커스 칸을 없애고 포커스를 이웃으로 옮긴다 (FR-WSL-53)', async ({ page }) => {
    await waitForInit(page);
    const wins = await slotsWith(page, 3);
    await focusSlot(page, 1);

    await slotRemove(page);
    const st = await slotsState(page);
    expect(st.windows).toEqual([wins[0], wins[2]]);
    expect(st.focused).toBe(1);
    expect(await activeWindowOf(page)).toBe(wins[2]);
  });

  test('TC-WSL-19: 사이드바 클릭은 포커스 칸에만 연다 (FR-WSL-54)', async ({ page }) => {
    await waitForInit(page);
    const wins = await slotsWith(page, 3);
    const w4 = await addWindow(page);
    await focusSlot(page, 1);

    await page.click(`#windows .si[data-sid="${w4}"]`);
    const st = await slotsState(page);
    expect(st.windows[0]).toBe(wins[0]); // 건드려지지 않는다
    expect(st.windows[1]).toBe(w4);
    expect(st.windows[2]).toBe(wins[2]);
  });

  test('TC-WSL-20: 칸의 창이 사라지면 칸은 남고 비워진다 (FR-WSL-6)', async ({ page }) => {
    await waitForInit(page);
    const wins = await slotsWith(page, 3);
    await focusSlot(page, 1);

    await page.evaluate((id) => (window as any).app.delWindow(id), wins[1]);
    await expect(page.locator('#area .slot[data-slot="1"].slot-empty')).toHaveCount(1, {
      timeout: 10000,
    });
    // 칸 자체는 남는다 — 사용자가 만든 칸을 앱이 없애지 않는다.
    expect(await slotCount(page)).toBe(3);
    expect((await slotsState(page)).focused).not.toBe(1);
  });

  test('TC-WSL-21: 모바일은 칸을 그리지 않고 버튼도 숨는다 (FR-WSL-60/62)', async ({ page }) => {
    await waitForInit(page);
    await slotsWith(page, 2);
    await expect(page.locator('#area .slot')).toHaveCount(2);

    await page.evaluate(() => ((window as any).app.displayMode = 'mobile'));
    await page.evaluate(() => (window as any).app.render());

    // FR-WSL-60: 칸이 하나면 칸을 나누는 요소를 두지 않는다 — 단일 슬롯 모드와
    // 같은 DOM 이다 (D-4).
    await expect(page.locator('#area .slot')).toHaveCount(0);
    await expect(page.locator('#area .slot-handle')).toHaveCount(0);
    await expect(page.locator('#area > .pn, #area > .sp')).not.toHaveCount(0);
    await expect(page.locator('#slot-add')).toBeHidden();
    await expect(page.locator('#slot-remove')).toBeHidden();
    // FR-WSL-61: 상태는 보존된다.
    expect((await slotsState(page)).windows).toHaveLength(2);
  });

  test('TC-WSL-21b: 버튼과 단축키가 같은 일을 한다 (FR-WSL-50/51)', async ({ page }) => {
    await waitForInit(page);
    await expect(page.locator('#slot-add')).toBeVisible();

    await page.click('#slot-add');
    await expect(page.locator('#area .slot')).toHaveCount(2);

    await page.evaluate(() => (window as any).app.executeAction('slotAdd'));
    await expect(page.locator('#area .slot')).toHaveCount(3);

    await page.click('#slot-remove');
    await expect(page.locator('#area .slot')).toHaveCount(2);

    await page.evaluate(() => (window as any).app.executeAction('slotRemove'));
    await expect(page.locator('#area .slot')).toHaveCount(0);
  });

  test('TC-WSL-21c: 토프바에서 Agents 가 가장 오른쪽이다 (FR-WSL-50)', async ({ page }) => {
    await waitForInit(page);
    const order = await page.evaluate(() =>
      [...document.querySelectorAll('#topbar button')]
        .filter((b: any) => b.offsetParent !== null)
        .map((b: any) => b.id),
    );
    expect(order[order.length - 1]).toBe('agents-toggle');
    // 슬롯 버튼은 창 **안** 분할과 떨어져 있다 (§7 R-3).
    expect(order.indexOf('slot-add')).toBeGreaterThan(order.indexOf('split-v') + 1);
  });
});

test.describe('묶음 D — 슬롯 방향', () => {
  test('TC-WSL-23: 기본 방향은 가로다 (FR-WSL-80)', async ({ page }) => {
    await waitForInit(page);
    expect(await slotDirOf(page)).toBe('horizontal');
    await slotAdd(page);
    await expect(page.locator('#area .slot')).toHaveCount(2);
    expect(await page.getAttribute('#area', 'data-slotdir')).toBe('horizontal');
    expect(await slotAxis(page)).toBe('horizontal');
  });

  test('TC-WSL-24: 세로로 바꾸면 즉시 재배치되고 배분이 유지된다 (FR-WSL-83)', async ({ page }) => {
    await waitForInit(page);
    await slotsWith(page, 3);
    const sizes = (await slotsState(page)).sizes.slice();

    await setSlotDir(page, 'vertical');
    await expect(page.locator('#area[data-slotdir="vertical"]')).toHaveCount(1);
    expect(await slotAxis(page)).toBe('vertical');
    expect((await slotsState(page)).sizes).toEqual(sizes);
  });

  test('TC-WSL-25: 방향은 새로고침과 칸 제거를 건너 유지된다 (FR-WSL-82/84)', async ({ page }) => {
    await waitForInit(page);
    await setSlotDir(page, 'vertical');

    await page.reload();
    await page.waitForSelector('#area .pn.focused', { timeout: 15000 });
    expect(await slotDirOf(page)).toBe('vertical');

    // 단일 슬롯 모드에서도 값이 남는다 (FR-WSL-84).
    await slotAdd(page);
    await expect(page.locator('#area .slot')).toHaveCount(2);
    await slotRemove(page);
    await expect(page.locator('#area .slot')).toHaveCount(0);
    expect(await slotDirOf(page)).toBe('vertical');
  });

  test('TC-WSL-26: 세로에서는 위아래가 칸을 넘는다 (FR-WSL-42)', async ({ page }) => {
    await waitForInit(page);
    await setSlotDir(page, 'vertical');
    await slotsWith(page, 2);

    // 좌우는 넘지 않는다 — 칸이 위아래로 놓였다.
    await page.evaluate(() => (window as any).app.paneNavigate('right'));
    expect((await slotsState(page)).focused).toBe(0);

    await page.evaluate(() => (window as any).app.paneNavigate('down'));
    expect((await slotsState(page)).focused).toBe(1);
    await page.evaluate(() => (window as any).app.paneNavigate('up'));
    expect((await slotsState(page)).focused).toBe(0);
  });

  test('TC-WSL-27: 설정의 토글로 방향을 바꾼다 (FR-WSL-81)', async ({ page }) => {
    await waitForInit(page);
    await slotAdd(page);
    await page.click('#settings-btn');
    await page.click('.mtab[data-tab="display"]');

    const t = page.locator('#ds-slotdir');
    await expect(t).toBeVisible();
    // 버튼에 적힌 것은 **지금 값**이다 — 다음 값이 아니다.
    await expect(t).toHaveAttribute('data-v', 'horizontal');
    await expect(t).toHaveText(/가로/);

    await t.click();
    await expect(t).toHaveAttribute('data-v', 'vertical');
    await expect(t).toHaveText(/세로/);

    // 누를 때마다 뒤집힌다 — 되돌아오는 길도 같은 버튼이다.
    await t.click();
    await expect(t).toHaveAttribute('data-v', 'horizontal');
    await t.click();

    await page.click('#modal-close');
    expect(await slotDirOf(page)).toBe('vertical');
    expect(await slotAxis(page)).toBe('vertical');
  });
});
