import { Page } from '@playwright/test';

import { test, expect, waitForInit, stubTopic } from './fixtures';

// CHAT_TELEGRAM_UX_SRS 묶음 H — 입력칸 높이 (V-CTU-61).

const ME = 'AAAA-me';
const VIEW = '#area .chat-view.vis';

async function openRoom(page: Page) {
  const me = { id: ME, label: 'mac/User', kind: 'user', node: 'AAAA', online: true };
  const st = {
    me: { id: ME, label: 'mac/User' }, helper: false,
    rooms: [{ id: 'r1', kind: 'group', name: '#ops', purpose: '', joined: true, members: 1, notify: 'called', people: [me] }],
    online: { nodes: [], participants: [] },
  };
  await stubTopic(page, 'chat', () => st);
  await page.route('**/api/chat**', (route) => route.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify(route.request().method() === 'GET' ? st : {}) }));
  await waitForInit(page);
  await page.locator('#sb-tabs .sb-tab[data-panel="chat"]').click();
  await page.locator('#sb-panel-chat .chat-room[data-room="r1"]').click();
  await expect(page.locator(VIEW + ' .chat-title')).toHaveText('#ops');
}

const box = (page: Page) => page.locator(VIEW + ' .chat-input').evaluate((e) => {
  const view = e.closest('.chat-view') as HTMLElement;
  return { h: e.getBoundingClientRect().height, view: view.clientHeight, scroll: e.scrollHeight > e.clientHeight };
});

test('V-CTU-61 입력칸은 내용에 맞춰 커지고 탭 높이의 반에서 멈추며, 보낸 뒤 돌아온다', async ({ page }) => {
  await openRoom(page);
  const input = page.locator(VIEW + ' .chat-input');
  const first = await box(page);
  await input.click();
  for (let i = 0; i < 4; i++) await input.press('Shift+Enter');
  const grown = await box(page);
  expect(grown.h).toBeGreaterThan(first.h);
  expect(grown.scroll).toBe(false);
  for (let i = 0; i < 80; i++) await input.press('Shift+Enter');
  const top = await box(page);
  expect(Math.abs(top.h - Math.floor(top.view / 2))).toBeLessThanOrEqual(1);
  expect(top.scroll).toBe(true);
  await input.pressSequentially('끝');
  await input.press('Enter');
  await expect(input).toHaveValue('');
  await expect.poll(async () => (await box(page)).h).toBe(first.h);
});
