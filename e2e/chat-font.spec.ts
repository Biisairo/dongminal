import { Page } from '@playwright/test';

import { test, expect, waitForInit, stubTopic } from './fixtures';

// CHAT_TELEGRAM_UX_SRS 묶음 F — 채팅 글자 크기 (V-CTU-52).

const ME = 'AAAA-me';
const VIEW = '#area .chat-view.vis';

test.afterEach(async ({ request }) => {
  const cur = await (await request.get('/api/settings')).json();
  await request.put('/api/settings', { data: { ...cur, uiFontSize: 14, chatFontSize: 14 } });
});

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
  await page.evaluate(() => {
    const app = (window as any).app;
    app.chat._chatS().add('r1', { id: 'm1', room: 'r1', from: 'AAAA-b', fromLabel: 'mac/b', fromKind: 'agent', text: 'hello', at: Date.now() }, true);
    app.chat.views._chatViewsPaint('r1');
  });
}

async function setNum(page: Page, sel: string, v: number) {
  await page.click('#settings-btn');
  await page.click('button.mtab[data-tab="display"]');
  const num = page.locator(sel);
  await expect(num).toBeVisible();
  await num.fill(String(v));
  await num.blur();
  await page.click('#modal-close');
  await expect(page.locator('#modal-overlay')).not.toHaveClass(/open/);
}

const px = (page: Page, sel: string) => page.locator(sel).first().evaluate((e) => parseFloat(getComputedStyle(e).fontSize));

test('V-CTU-52 채팅 글자 크기는 채팅 화면 전체에 걸리고 UI 글자 크기를 따르지 않는다', async ({ page }) => {
  await openRoom(page);
  const body = VIEW + ' .chat-msg-text';
  const name = VIEW + ' .chat-msg-name';
  expect(await px(page, body)).toBe(14);
  const name0 = await px(page, name);
  await setNum(page, '#ds-chatfs', 28);
  await expect.poll(() => px(page, body)).toBe(28);
  expect(await px(page, name)).toBe(name0 * 2);
  await setNum(page, '#ds-uifs', 20);
  expect(await px(page, body)).toBe(28);
});
