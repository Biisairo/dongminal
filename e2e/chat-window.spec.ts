// CHAT_WINDOW_SRS — 채팅 창 (TC-CW-1·2·7·8·9·10)
import { Page } from '@playwright/test';

import { test, expect, waitForInit, refetchChat } from './fixtures';

const MOBILE = { width: 412, height: 839 };

/** `/api/chat` 를 가짜로 둔다. 방 둘(하나는 들어감), 나가기는 상태를 바꾼다. */
async function mockChat(page: Page) {
  const st = {
    me: { id: 'me', label: 'mac/User' }, helper: false,
    rooms: [
      { id: 'r1', kind: 'group', name: 'ops', purpose: '', joined: true, members: 2, people: [] },
      { id: 'r2', kind: 'group', name: 'dev', purpose: '', joined: false, members: 1, people: [] },
    ],
    online: { nodes: [], participants: [] },
  };
  await page.route('**/api/chat**', async (route) => {
    const url = new URL(route.request().url());
    const json = (d: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(d) });
    const op = url.pathname.replace('/api/chat', '').replace(/^\//, '');
    if (route.request().method() === 'GET' && op === '') return json(st);
    const body = JSON.parse(route.request().postData() || '{}');
    const room = st.rooms.find((r) => r.id === body.room);
    if (op === 'join' && room) { room.joined = true; return json({}) }
    if (op === 'leave' && room) { room.joined = false; return json({}) }
    return json({});
  });
}

const chatTab = (page: Page) => page.locator('#sb-tabs .sb-tab[data-panel="chat"]');
const activeType = (page: Page) => page.evaluate(() => {
  const a = (window as any).app;
  const w = a.testing.aw();
  return w && w.type || '';
});
const chatTabs = (page: Page) => page.locator('#area .pn-tab').filter({ hasText: '#ops' });

test.describe('채팅 창 (CHAT_WINDOW_SRS)', () => {
  test('TC-CW-1: 메인 패널의 셋째 탭이 채팅이고, 고르면 빈 채팅 창으로 간다', async ({ page }) => {
    await mockChat(page);
    await waitForInit(page);
    await refetchChat(page);
    const ids = await page.evaluate(() => [...document.querySelectorAll('#sb-tabs .sb-tab')].map((e) => (e as HTMLElement).dataset.panel));
    expect(ids).toEqual(['windows', 'repo', 'chat']);
    await chatTab(page).click();
    await expect.poll(() => activeType(page)).toBe('chat');
    await expect(page.locator('#area .chat-window-empty')).toBeVisible();
    await expect(page.locator('#sb-panel-chat .chat-room')).toHaveCount(2);
    await page.locator('#sb-tabs .sb-tab[data-panel="windows"]').click();
    await expect.poll(() => activeType(page)).toBe('');
  });

  test('TC-CW-2·9: 방을 누르면 채팅 창에 그 방 탭이 하나 열리고, 마지막 탭을 닫으면 빈 창이 남는다', async ({ page }) => {
    await mockChat(page);
    await waitForInit(page);
    await refetchChat(page);
    await chatTab(page).click();
    const row = page.locator('#sb-panel-chat .chat-room[data-room="r1"]');
    await row.click();
    await expect(chatTabs(page)).toHaveCount(1);
    await expect.poll(() => activeType(page)).toBe('chat');
    await row.click();
    await expect(chatTabs(page)).toHaveCount(1);
    await chatTabs(page).hover();
    await chatTabs(page).locator('.pn-tab-x').click();
    await expect(chatTabs(page)).toHaveCount(0);
    await expect.poll(() => activeType(page)).toBe('chat');
    await expect(page.locator('#area .chat-window-empty')).toBeVisible();
  });

  test('TC-CW-7: 방 행의 ⋯ → 나가기는 방에서 나가고 그 탭을 닫는다', async ({ page }) => {
    await mockChat(page);
    await waitForInit(page);
    await refetchChat(page);
    await chatTab(page).click();
    const row = page.locator('#sb-panel-chat .chat-room[data-room="r1"]');
    await row.click();
    await expect(chatTabs(page)).toHaveCount(1);
    await row.hover();
    await row.locator('.chat-row-more').click();
    await page.locator('.chat-menu .ui-menu-item[data-id="leave"]').click();
    await expect(chatTabs(page)).toHaveCount(0);
    await expect(page.locator('#sb-panel-chat .chat-room[data-room="r1"].joined')).toHaveCount(0);
  });

  test('TC-CW-10: 모바일은 서랍의 채팅 탭에서 방을 열고, 서랍이 닫힌다', async ({ page }) => {
    await mockChat(page);
    await waitForInit(page, { mode: 'mobile', viewport: MOBILE });
    await refetchChat(page);
    await page.click('#m-drawer-toggle');
    await expect(page.locator('body')).toHaveClass(/drawer-open/);
    await chatTab(page).click();
    await page.locator('#sb-panel-chat .chat-room[data-room="r1"]').click();
    await expect(page.locator('body')).not.toHaveClass(/drawer-open/);
    await expect.poll(() => activeType(page)).toBe('chat');
    await expect(page.locator('#area .chat-view').first()).toBeVisible();
  });
});
