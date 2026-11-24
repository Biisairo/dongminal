import { test, expect, waitForInit, JSON_HDR } from './fixtures';

/**
 * ISSUE_AGENT_TREE_SRS 묶음 G·O — window 그룹과 순서 명령
 * (TC-WGR-2 · TC-WGR-3 · TC-WGR-4 · TC-ORD-2 · TC-ORD-3).
 *
 * 위치 해석의 규칙 자체는 단위 시험(`window-order.test.mjs`)이 잰다. 여기서 재는 것은
 * **명령이 브라우저에 닿아 상태가 바뀌고, 결과가 호출자에게 돌아오는가**와 사이드바다.
 */

const cmd = (request, action: string, args: Record<string, unknown> = {}) =>
  request.post('/api/commands', { headers: JSON_HDR, data: { action, args } });

const ws = (page) => page.evaluate(() => {
  const a = (window as any).app;
  return { windows: a.ws.windows.map((w) => ({ id: w.id, groupId: w.groupId || null, type: w.type || null })),
    groups: (a.ws.windowGroups || []).map((g) => ({ id: g.id, name: g.name, tree: g.tree || null })) };
});

const plainIds = async (page) => (await ws(page)).windows.filter((w) => !w.type).map((w) => w.id);

async function newWindow(request, args: Record<string, unknown> = {}) {
  const r = await cmd(request, 'newWindow', { keepFocus: true, ...args });
  expect(r.ok()).toBeTruthy();
  const j = await r.json();
  expect(j.newWindows?.[0], '창이 만들어지지 않았다').toBeTruthy();
  return { win: j.newWindows[0] as string, tab: j.newTabs[0].uuid as string };
}

async function newGroup(request, name: string, tree?: { repo: string; root: number }) {
  const r = await cmd(request, 'newGroup', tree ? { name, tree } : { name });
  const j = await r.json();
  expect(j.newGroups?.[0], JSON.stringify(j)).toBeTruthy();
  return j.newGroups[0] as string;
}

test.describe('window 그룹 · 순서 명령 (ISSUE_AGENT_TREE_SRS)', () => {
  test.beforeEach(async ({ page }) => {
    await waitForInit(page);
  });

  test('TC-WGR-4: newGroup → newWindow --group 은 그 그룹의 끝에 선다', async ({ page, request }) => {
    const g = await newGroup(request, 'G1');
    const a = await newWindow(request, { group: g });
    const b = await newWindow(request, { group: g });
    await expect.poll(async () => (await ws(page)).windows.filter((w) => w.groupId === g).map((w) => w.id))
      .toEqual([a.win, b.win]);
  });

  // SERVER_DRIVEN_ACTIONS_SRS F-4 (FR-SDA-54): 이름의 길이 상한은 서버가 정하고 otterctl 길에서 거절한다.
  //   이전 동작: 서버는 받고, 받은 브라우저가 64자로 잘랐다
  test('SDF6 (FR-SDA-54): 상한을 넘는 이름의 명령은 400 name_too_long 이고 아무것도 만들지 않는다', async ({ page, request }) => {
    const meta = await (await request.get('/api/meta')).json();
    const max = meta.entityNameMax as number;
    expect(max).toBeGreaterThan(0);
    const before = (await ws(page)).groups.length;
    const r = await cmd(request, 'newGroup', { name: 'g'.repeat(max + 1) });
    expect(r.status()).toBe(400);
    expect(r.headers()['x-error-code']).toBe('name_too_long');
    expect(await r.text()).toContain('name_too_long');
    expect((await ws(page)).groups.length).toBe(before);

    // 상한 길이는 그대로 받는다.
    const g = await newGroup(request, 'g'.repeat(max));
    await expect.poll(async () => (await ws(page)).groups.find((x) => x.id === g)?.name.length).toBe(max);
  });

  test('TC-WGR-4: 같은 트리 표지의 그룹은 둘이 될 수 없다', async ({ request }) => {
    const tree = { repo: 'o/r', root: 7 };
    await newGroup(request, 'T', tree);
    const j = await (await cmd(request, 'newGroup', { name: 'T2', tree })).json();
    expect(j.error).toBe('tree_exists');
  });

  test('TC-WGR-4: 없는 그룹으로 newWindow 는 만들지 않고 오류를 돌려준다', async ({ page, request }) => {
    const before = (await plainIds(page)).length;
    const j = await (await cmd(request, 'newWindow', { keepFocus: true, group: '01a1a425-0000-7000-8000-000000000000' })).json();
    expect(j.error).toBe('not_found');
    expect((await plainIds(page)).length).toBe(before);
  });

  test('TC-ORD-3: moveWindow 는 최종 위치를 돌려주고, 범위 밖은 오류다', async ({ page, request }) => {
    const g = await newGroup(request, 'G2');
    const a = await newWindow(request, { group: g });
    const b = await newWindow(request, { group: g });
    const j = await (await cmd(request, 'moveWindow', { window: b.win, index: 1 })).json();
    expect(j.position).toEqual({ container: g, index: 1, count: 2 });
    await expect.poll(async () => (await ws(page)).windows.filter((w) => w.groupId === g).map((w) => w.id))
      .toEqual([b.win, a.win]);
    const bad = await (await cmd(request, 'moveWindow', { window: b.win, index: 9 })).json();
    expect(bad.error).toBe('out_of_range');
    const edge = await (await cmd(request, 'moveWindow', { window: b.win, prev: true })).json();
    expect(edge.error).toBe('at_edge');
  });

  test('TC-ORD-3: moveWindow --ungroup 과 moveGroup 은 불변식을 지킨다', async ({ page, request }) => {
    const g = await newGroup(request, 'G3');
    const a = await newWindow(request, { group: g });
    const b = await newWindow(request, { group: g });
    const c = await newWindow(request);
    let j = await (await cmd(request, 'moveWindow', { window: a.win, to: 'top' })).json();
    expect(j.position.container).toBe('top');
    j = await (await cmd(request, 'moveGroup', { group: g, index: 1 })).json();
    expect(j.position).toMatchObject({ container: 'top', index: 1 });
    const ids = await plainIds(page);
    expect(ids.indexOf(b.win)).toBe(0);
    expect(ids.indexOf(c.win)).toBeGreaterThan(ids.indexOf(b.win));
  });

  test('TC-WGR-2: 그룹을 지워도 창은 남고, 그룹 안 창을 닫았다 되돌리면 그룹으로 돌아간다', async ({ page, request }) => {
    const g = await newGroup(request, 'G4');
    const a = await newWindow(request, { group: g });
    await newWindow(request, { group: g });
    const row = page.locator(`#windows .si[data-sid="${a.win}"]`);
    await row.hover();
    await row.locator('.sbl-x').click();
    await expect(row).toHaveCount(0);
    await page.locator('#win-undo .toast-act').click();
    await expect.poll(async () => (await ws(page)).windows.find((w) => w.id === a.win)?.groupId).toBe(g);

    await cmd(request, 'deleteGroup', { group: g });
    await expect.poll(async () => (await ws(page)).groups.some((x) => x.id === g)).toBe(false);
    const after = await ws(page);
    expect(after.windows.find((w) => w.id === a.win)?.groupId ?? null).toBeNull();
  });

  test('TC-ORD-2: moveTab 은 같은 칸 안의 자리, --to 로 다른 window 로 간다', async ({ page, request }) => {
    const a = await newWindow(request);
    const t2 = (await (await cmd(request, 'newTab', { location: a.tab, keepFocus: true })).json()).newTabs[0].uuid;
    let j = await (await cmd(request, 'moveTab', { tab: t2, index: 1 })).json();
    expect(j.position).toMatchObject({ index: 1, count: 2 });
    const b = await newWindow(request);
    j = await (await cmd(request, 'moveTab', { tab: t2, to: b.win })).json();
    expect(j.position).toMatchObject({ index: 2, count: 2 });
    const inB = await page.evaluate(([w, t]) => {
      const win = (window as any).app.ws.windows.find((x) => x.id === w);
      const f = (n) => (n.type === 'pane' ? n : (n.children || []).map(f).find(Boolean));
      return f(win.layout).tabs.map((x) => x.id).includes(t);
    }, [b.win, t2]);
    expect(inB).toBe(true);
  });

  test('TC-ORD-2: newTab --after 는 그 탭 바로 뒤에 선다', async ({ page, request }) => {
    const a = await newWindow(request);
    const t2 = (await (await cmd(request, 'newTab', { location: a.tab, keepFocus: true })).json()).newTabs[0].uuid;
    const t3 = (await (await cmd(request, 'newTab', { location: a.tab, keepFocus: true, after: a.tab })).json()).newTabs[0].uuid;
    await expect.poll(() => page.evaluate((w) => {
      const win = (window as any).app.ws.windows.find((x) => x.id === w);
      const f = (n) => (n.type === 'pane' ? n : (n.children || []).map(f).find(Boolean));
      return f(win.layout).tabs.map((x) => x.id);
    }, a.win)).toEqual([a.tab, t3, t2]);
  });

  test('TC-WGR-3: 사이드바에 그룹 머리가 서고, 접으면 그 창들이 숨는다', async ({ page, request }) => {
    const g = await newGroup(request, 'Fold me', { repo: 'o/r', root: 99 });
    const a = await newWindow(request, { group: g });
    await newWindow(request, { group: g });
    const head = page.locator(`#windows .si-group[data-group-id="${g}"]`);
    await expect(head).toBeVisible();
    await expect(head.locator('.sbl-badge')).toHaveText('2');
    await expect(head).toHaveClass(/si-group-tree/);
    await expect(page.locator(`#windows .si[data-sid="${a.win}"]`)).toHaveClass(/si-in-group/);
    await head.click();
    await expect(head).toHaveClass(/folded/);
    await expect(page.locator(`#windows .si[data-sid="${a.win}"]`)).toHaveCount(0);
    await head.click();
    await expect(page.locator(`#windows .si[data-sid="${a.win}"]`)).toBeVisible();
  });

  test('그룹 이름은 더블클릭으로 고친다 — 첫 클릭의 접기가 행을 다시 그려도 편집칸이 선다', async ({ page, request }) => {
    const g = await newGroup(request, 'G1');
    const head = page.locator(`#windows .si-group[data-group-id="${g}"]`);
    await expect(head).toBeVisible();
    await head.locator('.sbl-name').dblclick();
    const input = page.locator('#windows .si-group .rename-input');
    await expect(input).toBeVisible();
    await input.fill('Renamed');
    await input.press('Enter');
    await expect.poll(async () => (await ws(page)).groups.find((x) => x.id === g)?.name).toBe('Renamed');
  });

  test('그룹이 있어도 window 이름은 Enter 로 확정된다', async ({ page, request }) => {
    // 그룹에 window 가 들면 워크스페이스를 받을 때마다 정규화가 돈다 — 그 뒤에도 행이 쥔
    // window 가 워크스페이스의 것이어야 한다.
    const g = await newGroup(request, 'G1');
    await newWindow(request, { group: g });
    await newWindow(request, { group: g });
    await expect.poll(async () => (await ws(page)).windows.filter((w) => w.groupId === g).length).toBe(2);
    const row = page.locator('#windows .si.active');
    await expect(row).toHaveCount(1);
    const id = await row.getAttribute('data-sid');
    await row.locator('.si-name').dblclick();
    const input = page.locator('#windows .rename-input');
    await expect(input).toBeVisible();
    await input.fill('Named');
    await input.press('Enter');
    await expect(input).toHaveCount(0);
    await expect.poll(() => page.evaluate((i) => (window as any).app.ws.windows.find((w) => w.id === i)?.name, id)).toBe('Named');
  });

  // 사용자 보고(2026-11-13): 편집 중에 행의 값(알람)이 바뀌면 이름 바꾸기가 사라졌다.
  test('window 이름 편집 중 행의 값이 바뀌어도 편집칸이 남고 확정된다', async ({ page }) => {
    const row = page.locator('#windows .si.active');
    const id = await row.getAttribute('data-sid');
    await row.locator('.si-name').dblclick();
    const input = page.locator('#windows .rename-input');
    await expect(input).toBeVisible();
    await page.keyboard.type('Mid');
    await page.evaluate(() => { const a = (window as any).app; a.attn.windowHasAttn = () => true; a.render() });
    await expect(input).toBeFocused();
    await page.keyboard.type('Done');
    await page.keyboard.press('Enter');
    await expect(input).toHaveCount(0);
    await expect.poll(() => page.evaluate((i) => (window as any).app.ws.windows.find((w) => w.id === i)?.name, id)).toBe('MidDone');
    await expect(page.locator(`#windows .si[data-sid="${id}"]`)).toHaveClass(/attn/);
  });

  // 사용자 보고(2026-11-10): 이름을 고친 뒤 다른 window 를 누르기 전까지 편집칸이 남았다.
  for (const kind of ['window', 'group'] as const) {
    for (const how of ['Enter-새이름', 'Enter-같은이름', 'Escape', '바깥클릭'] as const) {
      test(`${kind} 이름 편집은 ${how} 로 끝난다 — 편집칸이 남지 않는다`, async ({ page, request }) => {
        let name;
        if (kind === 'group') {
          const g = await newGroup(request, 'G1');
          name = page.locator(`#windows .si-group[data-group-id="${g}"] .sbl-name`);
        } else {
          const g = await newGroup(request, 'G1');
          await newWindow(request, { group: g });
          name = page.locator('#windows .si.active .si-name');
        }
        await expect(name).toHaveCount(1);
        const old = (await name.textContent()) || '';
        await name.dblclick();
        const input = page.locator('#windows .rename-input');
        await expect(input).toBeVisible();
        if (how === 'Enter-새이름') { await input.fill(old + 'X'); await input.press('Enter') }
        else if (how === 'Enter-같은이름') await input.press('Enter');
        else if (how === 'Escape') { await input.fill(old + 'Y'); await input.press('Escape') }
        else { await input.fill(old + 'Z'); await page.locator('#term-area, body').first().click({ position: { x: 5, y: 5 } }) }
        await expect(input).toHaveCount(0);
      });
    }
  }

  test('TC-WGR-3: 그룹 버튼은 빈 그룹을 만들고 이름을 고치게 한다', async ({ page }) => {
    const before = (await ws(page)).groups.length;
    await page.locator('#add-group').click();
    const input = page.locator('#windows .si-group .rename-input');
    await expect(input).toBeVisible();
    await input.fill('My group');
    await input.press('Enter');
    await expect.poll(async () => (await ws(page)).groups.map((x) => x.name)).toContain('My group');
    expect((await ws(page)).groups.length).toBe(before + 1);
  });
});

/**
 * UX_BATCH12_SRS TC-RGT-1 (FR-RGT-1) — 접힌 사이드바(레일)에서 그룹 머리의 삼각형은 삼각형이다.
 * 레일의 "배지 있는 항목은 점을 강조색으로" 규칙(FR-RAL-7)이 그룹 머리의 삼각형까지 칠해
 * 파란 사각형(선택 블록처럼 보임)이 되던 결함이다.
 */
test('TC-RGT-1: 레일에서 그룹 머리의 삼각형은 배경을 칠하지 않는다 (펼침·접힘 둘 다)', async ({ page, request }) => {
  await waitForInit(page);
  const g = await newGroup(request, 'G1');
  await newWindow(request, { group: g });
  await page.evaluate(() => (window as any).app.testing.setSidebarCollapsed(true));
  const head = page.locator(`#windows .si-group[data-group-id="${g}"]`);
  await expect(head).toBeVisible();
  const bg = () => head.locator('.sbl-dot').evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(await bg()).toBe('rgba(0, 0, 0, 0)');
  await head.click();
  await expect(head).toHaveClass(/folded/);
  expect(await bg()).toBe('rgba(0, 0, 0, 0)');
});

test('TC-RGT-1: 그룹에 알람이 서면 머리가 알람을 보이고(다시 그려도 같다), 삼각형은 칠하지 않는다', async ({ page, request }) => {
  await waitForInit(page);
  const g = await newGroup(request, 'G1');
  const w = await newWindow(request, { group: g });
  const head = page.locator(`#windows .si-group[data-group-id="${g}"]`);
  await expect(head).toBeVisible();
  const tool = await page.evaluate((id) => {
    const win = (window as any).app.ws.windows.find((x) => x.id === id);
    const walk = (n) => (n.type === 'pane' ? (n.tabs || [])[0]?.toolId : (n.children || []).map(walk).find(Boolean));
    return walk(win.layout);
  }, w.win);
  expect((await request.post('/api/tools/attention/set', { headers: JSON_HDR, data: { toolId: tool, reason: 'signaled' } })).ok()).toBeTruthy();
  await expect(head).toHaveClass(/\battn\b/);
  await page.evaluate(() => (window as any).app.render());
  await expect(head).toHaveClass(/\battn\b/);
  const got = await head.locator('.sbl-dot').evaluate((el) => ({
    bg: getComputedStyle(el).backgroundColor, before: getComputedStyle(el, '::before').content,
  }));
  expect(got).toEqual({ bg: 'rgba(0, 0, 0, 0)', before: 'none' });
  await request.post('/api/tools/attention/clear-all', { headers: JSON_HDR });
});

/**
 * ISSUE_AGENT_TREE_SRS TC-WGR-3b — FR-WGR-24 (개정 2026-11-20): **실제 마우스 끌기**로 그룹 안·밖을 잰다.
 * 위의 시험들은 명령 API 로 순서를 바꾸므로 끌기 제스처 자체는 지키지 않았다(사용자 보고: 그룹 아래에 두면 늘 안으로 들어갔다).
 * 놓을 자리는 포인터 높이로 고르고, 패널 밖에서도 따라온다. 안·밖은 행의 가로 가운데로 가르고, 목록 끝 아래는 늘 맨 뒤 그룹 밖이다.
 */
test.describe('TC-WGR-3b: 실제 끌기로 그룹 안·밖 (FR-WGR-24 개정)', () => {
  // 평창 b 를 먼저, 그다음 그룹 G(a, c)를 만든다 — 그룹이 목록의 맨 끝이다.
  async function setup(page, request) {
    await waitForInit(page);
    const b = (await newWindow(request)).win;
    const g = await newGroup(request, 'GD');
    const a = (await newWindow(request, { group: g })).win;
    const c = (await newWindow(request, { group: g })).win;
    await page.waitForSelector(`#windows .sbl-item[data-sid="${c}"]`);
    return { b, g, a, c };
  }
  const row = (page, id: string) => page.locator(`#windows .sbl-item[data-sid="${id}"]`);
  async function drag(page, src: string, to: { x: number; y: number }, during?: () => Promise<void>) {
    const s = (await row(page, src).boundingBox())!;
    await page.mouse.move(s.x + s.width / 2, s.y + s.height / 2);
    await page.mouse.down();
    await page.mouse.move(s.x + s.width / 2 + 4, s.y + s.height / 2 + 4, { steps: 2 });
    await page.mouse.move(to.x, to.y, { steps: 8 });
    // 실제 브라우저는 포인터가 멈춰도 dragover 를 되풀이한다. 합성 끌기는 마지막 이동의 것을 놓칠 때가 있어 한 번 더 움직인다.
    await page.mouse.move(to.x + 1, to.y);
    await page.mouse.move(to.x, to.y);
    if (during) await during();
    await page.mouse.up();
  }
  const where = async (page, id: string) => {
    const w = await ws(page);
    const me = w.windows.find((x) => x.id === id)!;
    const plain = w.windows.filter((x) => !x.type);
    return { groupId: me.groupId, last: plain[plain.length - 1].id === id };
  };

  test('마지막 창 아래, 왼쪽 절반에 놓으면 그룹 밖(맨 뒤)이다', async ({ page, request }) => {
    const { b, c } = await setup(page, request);
    const r = (await row(page, c).boundingBox())!;
    await drag(page, b, { x: r.x + r.width * 0.4, y: r.y + r.height - 3 }, async () => {
      await expect(row(page, c)).toHaveClass(/\bdrag-out\b/);
    });
    await expect.poll(() => where(page, b)).toEqual({ groupId: null, last: true });
  });

  test('마지막 창 아래, 오른쪽 절반에 놓으면 그룹 안이다', async ({ page, request }) => {
    const { b, g, c } = await setup(page, request);
    const r = (await row(page, c).boundingBox())!;
    await drag(page, b, { x: r.x + r.width - 10, y: r.y + r.height - 3 });
    await expect.poll(() => where(page, b)).toEqual({ groupId: g, last: true });
  });

  test('목록 끝 아래로 내려 놓으면 가로 위치와 상관없이 그룹 밖(맨 뒤)이다', async ({ page, request }) => {
    const { b, c } = await setup(page, request);
    const r = (await row(page, c).boundingBox())!;
    await drag(page, b, { x: r.x + r.width - 10, y: r.y + r.height + 60 }, async () => {
      await expect(row(page, c)).toHaveClass(/\bdrag-out\b/);
    });
    await expect.poll(() => where(page, b)).toEqual({ groupId: null, last: true });
  });

  test('패널 오른쪽 밖에서도 표시선이 따라오고 그 자리에 놓인다', async ({ page, request }) => {
    const { b, g, c } = await setup(page, request);
    const r = (await row(page, c).boundingBox())!;
    const sb = (await page.locator('#sidebar').boundingBox())!;
    await drag(page, b, { x: sb.x + sb.width + 150, y: r.y + r.height - 3 }, async () => {
      await expect(row(page, c)).toHaveClass(/\bdrag-below\b/);
      await expect(row(page, c)).not.toHaveClass(/\bdrag-out\b/);
    });
    await expect.poll(() => where(page, b)).toEqual({ groupId: g, last: true });
  });
});
