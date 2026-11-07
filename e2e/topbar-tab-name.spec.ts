import { test, expect, waitForInit } from './fixtures';

/**
 * ISSUE_TREE_OPS_SRS 묶음 W — 표시줄과 칸 머리글에 포커스 탭 이름 (TC-ITW-1).
 *
 * 형식은 `<창 종류> · <창 이름> · <포커스 탭 이름>` 이다. 포커스 칸이 바뀌거나 탭 이름이
 * 바뀌면 바로 따라가고, 전체 문자열은 `title` 에도 실린다.
 */

const rename = (page, name: string) => page.evaluate((n) => {
  const app = (window as any).app;
  const si = app.ws.windows.findIndex((x: any) => x.id === app.ws.activeWindow) + 1;
  app.testing.execRemote('renameTab', { location: `W${si}.P1.T1`, name: n });
}, name);

const winName = (page) => page.evaluate(() => {
  const app = (window as any).app;
  return app.ws.windows.find((w: any) => w.id === app.ws.activeWindow).name;
});

test('TC-ITW-1: 표시줄이 포커스 탭 이름을 따라가고 title 에 전체를 싣는다', async ({ page }) => {
  await waitForInit(page);
  await rename(page, 'ccr#32›33 피킹');
  const name = await winName(page);
  const top = page.locator('#window-name');
  await expect(top).toHaveText(`창 · ${name} · ccr#32›33 피킹`, { timeout: 10000 });
  await expect(top).toHaveAttribute('title', `창 · ${name} · ccr#32›33 피킹`);

  // 칸을 나누고 새 칸에 포커스가 가면 그 칸의 탭 이름이 된다 — 포커스를 따라간다 (FR-ITW-4).
  await page.evaluate(() => (window as any).app.executeAction('splitH'));
  const second = await page.evaluate(() => {
    const app = (window as any).app;
    const w = app.ws.windows.find((x: any) => x.id === app.ws.activeWindow);
    const panes = app.flattenPanes(w.layout);
    return { first: panes[0].id, focused: app.focused };
  });
  await expect(top).not.toHaveText(`창 · ${name} · ccr#32›33 피킹`, { timeout: 10000 });
  await page.evaluate((id) => (window as any).app.setFocus(id), second.first);
  await expect(top).toHaveText(`창 · ${name} · ccr#32›33 피킹`, { timeout: 10000 });
});

test('TC-ITW-1: 칸이 여럿이면 각 머리글이 자기 창의 포커스 탭 이름을 보인다', async ({ page }) => {
  await waitForInit(page);
  await rename(page, '첫 칸 탭');
  await page.evaluate(() => (window as any).app.slotAdd());
  const head0 = page.locator('#area .slot[data-slot="0"] .slot-head');
  await expect(head0).toContainText('· 첫 칸 탭', { timeout: 10000 });
  await expect(head0).toHaveAttribute('title', /· 첫 칸 탭$/);
  await expect(page.locator('#window-name')).toHaveText('');
  await page.evaluate(() => (window as any).app.slotRemove());
});
