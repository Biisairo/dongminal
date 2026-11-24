import { test, expect, waitForInit } from './fixtures';

/**
 * 사용자 보고(2026-11-10): 이슈 트리가 탭·window 를 닫을 때 포커스가 튄다.
 *
 * 이슈 트리는 `otterctl close-tab --at <탭> --force` 와 `otterctl close-window --at <탭> --force`
 * 를 `-n` 없이 부른다(`commands/issue-tree.md`). 지목한 자리를 닫는 명령이므로 사용자가
 * 보던 window 와 칸은 그대로여야 한다.
 */
test.describe('원격 닫기는 사용자의 시선을 옮기지 않는다', () => {
  test('close-tab --at: 같은 window 의 다른 칸에 있는 탭을 닫아도 포커스 칸이 그대로다', async ({ page }) => {
    await waitForInit(page);
    const got = await page.evaluate(async () => {
      const a = (window as any).app;
      const mine = a.focused;
      await a.layout.tabOps.split('horizontal');
      const win = a.testing.aw();
      const other = win.layout.children.map((c: any) => c.id).find((id: string) => id !== mine);
      const pane = (id: string) => win.layout.children.find((c: any) => c.id === id);
      await a.layout.tabAdd.addTab(other, undefined, { keepFocus: true });
      a.focus.setFocusState(mine, win);
      const victim = pane(other).tabs[pane(other).tabs.length - 1].id;
      a.testing.execRemote('closeTab', { location: victim, force: true });
      await new Promise((r) => setTimeout(r, 800));
      return { mine, other, focused: a.focused, left: pane(other).tabs.map((t: any) => t.id), victim };
    });
    expect(got.left, '탭이 닫히지 않았다').not.toContain(got.victim);
    expect(got.focused, '다른 칸의 탭을 닫았는데 포커스가 그 칸으로 옮겨졌다').toBe(got.mine);
  });

  // 사용자 보고(2026-11-16): 에이전트 탭을 보다 돌아오니 다른 에이전트 탭이 보였다. 이슈 트리의 탭은
  // 한 칸에 모이므로, 보지 않는 자식 탭을 닫으면 그 칸의 보이는 탭이 닫힌 탭의 이웃으로 바뀌었다.
  for (const away of [false, true]) {
    test(`close-tab --at: 같은 칸에서 보이지 않는 탭을 닫아도 보이는 탭이 그대로다${away ? ' (다른 window 에 가 있을 때)' : ''}`, async ({ page }) => {
      await waitForInit(page);
      const got = await page.evaluate(async (goAway) => {
        const a = (window as any).app;
        const win = a.testing.aw();
        const rid = a.focused;
        await a.layout.tabAdd.addTab(rid, undefined, { keepFocus: true });
        await a.layout.tabAdd.addTab(rid, undefined, { keepFocus: true });
        await a.layout.tabAdd.addTab(rid, undefined, { keepFocus: true });
        const pn = a.testing.flattenPanes(win.layout).find((x: any) => x.id === rid);
        const watched = pn.tabs[1].id;
        a.layout.tabOps.switchTab(rid, watched);
        if (goAway) await a.layout.addWindow();
        const victim = pn.tabs[3].id;
        a.testing.execRemote('closeTab', { location: victim, force: true });
        await new Promise((r) => setTimeout(r, 800));
        if (goAway) { a.testing.execRemote('closeWindow', { force: true }); await new Promise((r) => setTimeout(r, 800)); }
        return { watched, victim, left: pn.tabs.map((t: any) => t.id), active: pn.activeTab, shown: a.slot.paneTab(pn) };
      }, away);
      expect(got.left, '탭이 닫히지 않았다').not.toContain(got.victim);
      expect(got.shown, '보이지 않는 탭을 닫았는데 보이는 탭이 바뀌었다').toBe(got.watched);
      expect(got.active).toBe(got.watched);
    });
  }

  test('close-window --at: 보고 있지 않은 window 를 닫아도 활성 window 가 그대로다', async ({ page }) => {
    await waitForInit(page);
    const got = await page.evaluate(async () => {
      const a = (window as any).app;
      const mine = a.ws.activeWindow;
      await a.layout.addWindow({ keepFocus: true });
      await a.layout.addWindow({ keepFocus: true });
      await a.layout.addWindow({ keepFocus: true });
      const wins = a.testing.plainWindows();
      const victim = wins[wins.length - 2];
      // 서버는 closeWindow 의 uuid 를 좌표로 바꿔 보낸다 (`translateLocationUUID`).
      const at = 'W' + (a.ws.windows.findIndex((w: any) => w.id === victim.id) + 1) + '.P1.T1';
      a.testing.execRemote('closeWindow', { location: at, force: true });
      await new Promise((r) => setTimeout(r, 1200));
      return { mine, active: a.ws.activeWindow, victim: victim.id, left: a.testing.plainWindows().map((w: any) => w.id) };
    });
    expect(got.left, 'window 가 닫히지 않았다').not.toContain(got.victim);
    expect(got.active, '보고 있지 않은 window 를 닫았는데 활성 window 가 바뀌었다').toBe(got.mine);
  });

  test('close-window --at: 자리를 찾지 못하면 아무 window 도 닫지 않는다', async ({ page }) => {
    await waitForInit(page);
    const got = await page.evaluate(async () => {
      const a = (window as any).app;
      await a.layout.addWindow({ keepFocus: true });
      const before = a.ws.windows.map((w: any) => w.id);
      a.testing.execRemote('closeWindow', { location: 'W99.P1.T1', force: true });
      await new Promise((r) => setTimeout(r, 800));
      return { before, after: a.ws.windows.map((w: any) => w.id) };
    });
    expect(got.after, '지목한 자리가 없는데 window 가 닫혔다').toEqual(got.before);
  });
});
