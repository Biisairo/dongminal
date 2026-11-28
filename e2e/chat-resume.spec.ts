import { Page } from '@playwright/test';

import { test, expect, waitForInit, stubTopic } from './fixtures';

// CHAT_TELEGRAM_UX_SRS 묶음 R — 읽던 자리 (V-CTU-5~8).
//
// 채팅 상태는 가짜다(state 토픽과 /api/chat). 대화는 브라우저 메모리(ChatStore)에만 있으므로 글은 페이지에서 넣는다.

const ME = 'AAAA-me';
const ROOM = 'r1';
const VIEW = '#area .chat-view.vis';
const LOG = VIEW + ' .chat-log';

function state() {
  const me = { id: ME, label: 'mac/User', kind: 'user', node: 'AAAA', online: true };
  return {
    me: { id: ME, label: 'mac/User' }, helper: false,
    rooms: [
      { id: ROOM, kind: 'group', name: '#ops', purpose: '', joined: true, members: 2, notify: 'called',
        people: [me, { id: 'AAAA-b', label: 'mac/builder', kind: 'agent', node: 'AAAA', online: true }] },
      { id: 'r2', kind: 'group', name: 'dev', purpose: '', joined: true, members: 1, notify: 'called', people: [me] },
    ],
    online: { nodes: [], participants: [] },
  };
}

async function stubChat(page: Page) {
  const st = state();
  await stubTopic(page, 'chat', () => st);
  await page.route('**/api/chat**', (route) => route.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify(route.request().method() === 'GET' ? st : {}) }));
  await waitForInit(page);
}

/** 글 n 개를 방에 넣는다. 그 방의 열린 뷰가 있으면 다시 그린다. */
async function addMsgs(page: Page, from: number, n: number) {
  await page.evaluate(({ room, from, n }) => {
    const app = (window as any).app;
    const now = Date.now();
    for (let i = from; i < from + n; i++)
      app.chat._chatS().add(room, { id: 'm' + i, room, from: 'AAAA-b', fromLabel: 'mac/builder', fromKind: 'agent',
        text: 'msg ' + i + '\n둘째 줄\n셋째 줄', at: now + i }, true);
    app.chat.views?._chatViewsPaint(room);
  }, { room: ROOM, from, n });
}

async function openRoom(page: Page, room: string, title: string) {
  if (!(await page.locator('#sb-panel-chat').isVisible())) await page.locator('#sb-tabs .sb-tab[data-panel="chat"]').click();
  await page.locator('#sb-panel-chat .chat-room[data-room="' + room + '"]').click();
  await expect(page.locator(VIEW + ' .chat-title')).toHaveText(title);
}

/** 대화칸 맨 위에 걸친 글의 본문과 그 글 안의 거리. */
function topMsg(page: Page) {
  return page.locator(LOG).evaluate((log) => {
    const top = log.getBoundingClientRect().top;
    for (const m of log.querySelectorAll('.chat-msg')) {
      const r = m.getBoundingClientRect();
      if (r.bottom > top) return { text: m.querySelector('.chat-msg-text')!.textContent!.split('\n')[0], offset: Math.round(top - r.top) };
    }
    return null;
  });
}

const atEnd = (page: Page) => page.locator(LOG).evaluate((l) => l.scrollHeight - l.scrollTop - l.clientHeight < 4);
const scrollTo = (page: Page, frac: number) => page.locator(LOG).evaluate((l, f) => { l.scrollTop = Math.round((l.scrollHeight - l.clientHeight) * f) }, frac);

test('V-CTU-5 중간을 읽다가 다른 탭에 갔다 오면 같은 글이 맨 위다', async ({ page }) => {
  await stubChat(page);
  await openRoom(page, ROOM, '#ops');
  await addMsgs(page, 0, 60);
  await scrollTo(page, 0.4);
  const before = await topMsg(page);
  expect(before!.text).not.toBe('msg 0');
  await openRoom(page, 'r2', '#dev');
  await openRoom(page, ROOM, '#ops');
  await expect.poll(() => topMsg(page)).toEqual(before);
});

test('V-CTU-6 맨 아래에서 떠난 뒤 새 글이 와도 보던 글이 그대로 보인다', async ({ page }) => {
  await stubChat(page);
  await openRoom(page, ROOM, '#ops');
  await addMsgs(page, 0, 60);
  await scrollTo(page, 1);
  expect(await atEnd(page)).toBe(true);
  const before = await topMsg(page);
  await openRoom(page, 'r2', '#dev');
  await addMsgs(page, 60, 10);
  await openRoom(page, ROOM, '#ops');
  await expect(page.locator(VIEW + ' .chat-msg')).toHaveCount(70);
  await expect.poll(() => topMsg(page)).toEqual(before);
  expect(await atEnd(page)).toBe(false);
});

test('V-CTU-7 채팅 탭을 닫고 같은 방을 다시 열면 읽던 자리다', async ({ page }) => {
  await stubChat(page);
  await openRoom(page, ROOM, '#ops');
  await addMsgs(page, 0, 60);
  await scrollTo(page, 0.5);
  const before = await topMsg(page);
  const tab = page.locator('#area .pn-tab').filter({ hasText: '#ops' });
  await tab.hover();
  await tab.locator('.pn-tab-x').click();
  await expect(tab).toHaveCount(0);
  await openRoom(page, ROOM, '#ops');
  await expect.poll(() => topMsg(page)).toEqual(before);
});

test('V-CTU-8 처음 여는 방은 맨 아래에서 시작한다', async ({ page }) => {
  await stubChat(page);
  await page.evaluate('Screens.load("chat")');
  await addMsgs(page, 0, 60);
  await openRoom(page, ROOM, '#ops');
  await expect(page.locator(VIEW + ' .chat-msg')).toHaveCount(60);
  await expect.poll(() => atEnd(page)).toBe(true);
});
