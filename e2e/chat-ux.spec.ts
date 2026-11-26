import { Page } from '@playwright/test';

import { test, expect, waitForInit, stubTopic } from './fixtures';

// ISSUE_TREE_CHAT_SRS 묶음 U — 채팅 화면 (TC-ITH-8 · TC-ITH-9 e2e).
//
// 채팅 상태는 가짜다(state 토픽과 /api/chat). 대화는 브라우저 메모리(ChatStore)에만 있으므로 글은 페이지에서 넣는다.

const ME = 'AAAA-me';
const ROOM = 'r1';

function state() {
  return {
    me: { id: ME, label: 'mac/User' }, helper: false,
    rooms: [{ id: ROOM, kind: 'group', name: '#ops', purpose: '배포 점검', joined: true, members: 4,
      creator: 'AAAA-b', creatorName: 'mac/builder', notify: 'called',
      people: [
        { id: ME, label: 'mac/User', kind: 'user', node: 'AAAA', online: true, notify: 'called' },
        { id: 'AAAA-b', label: 'mac/builder', kind: 'agent', node: 'AAAA', online: true, notify: 'all', tool: 't-b' },
        { id: 'BBBB-x', label: 'linux/reviewer', kind: 'agent', node: 'BBBB', online: true },
        { id: 'BBBB-u', label: 'linux/User', kind: 'user', node: 'BBBB', online: true },
      ] }],
    online: { nodes: [], participants: [] },
  };
}

/** 가짜 채팅을 걸고 방 탭을 연다. 보낸 요청 본문을 모은다. */
async function openRoom(page: Page) {
  const st = state();
  const posts: { op: string; body: any }[] = [];
  await stubTopic(page, 'chat', () => st);
  await page.route('**/api/chat**', (route) => {
    const req = route.request();
    if (req.method() !== 'GET') posts.push({ op: new URL(req.url()).pathname.split('/').pop() || '', body: req.postDataJSON() });
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(req.method() === 'GET' ? st : {}) });
  });
  await waitForInit(page);
  await page.locator('#sb-tabs .sb-tab[data-panel="chat"]').click();
  await page.locator('#sb-panel-chat .chat-room[data-room="r1"]').click();
  await expect(page.locator('#area .chat-view .chat-title')).toHaveText('#ops');
  return posts;
}

/** 글을 넣고 다시 그린다. at 은 지금으로부터의 분이다(음수는 과거). */
async function addMsgs(page: Page, msgs: any[]) {
  await page.evaluate(({ room, list }) => {
    const app = (window as any).app;
    const now = Date.now();
    for (const m of list) app.chat._chatS().add(room, { room, ...m, at: now + m.min * 60000 }, true);
    app.chat.views._chatViewsPaint(room);
  }, { room: ROOM, list: msgs });
}

const VIEW = '#area .chat-view.vis';

test('TC-ITH-8 보낸 이 묶음 · 이어진 글 · 내 글 바탕 · 날짜 구분선 · 부른 글', async ({ page }) => {
  await openRoom(page);
  await addMsgs(page, [
    { id: '1', from: 'AAAA-b', fromLabel: 'mac/builder', fromKind: 'agent', text: 'old', min: -60 * 24 * 2 },
    { id: '2', from: 'AAAA-b', fromLabel: 'mac/builder', fromKind: 'agent', text: 'a', min: -10 },
    { id: '3', from: 'AAAA-b', fromLabel: 'mac/builder', fromKind: 'agent', text: 'b', min: -9 },
    { id: '4', from: 'BBBB-x', fromLabel: 'linux/reviewer', fromKind: 'agent', text: 'to me', min: -8, called: true, call: ['user'] },
    { id: '5', from: 'BBBB-x', fromLabel: 'linux/reviewer', fromKind: 'agent', text: 'to b', min: -7, call: ['AAAA-b'] },
    { id: '6', from: ME, fromLabel: 'mac/User', fromKind: 'user', text: 'mine', min: -1 },
  ]);
  const msgs = page.locator(VIEW + ' .chat-log .chat-msg');
  await expect(msgs).toHaveCount(6);
  // 머리: 1(첫 글) · 2(날짜가 바뀜) · 4(보낸 이가 바뀜) · 6. 3·5 는 이어진 글이다.
  await expect(page.locator(VIEW + ' .chat-msg.head')).toHaveCount(4);
  await expect(msgs.nth(2)).not.toHaveClass(/\bhead\b/);
  await expect(msgs.nth(1).locator('.chat-msg-name')).toHaveText('builder');
  await expect(msgs.nth(3).locator('.chat-msg-name')).toHaveText('linux › reviewer');
  await expect(msgs.nth(1).locator('.chat-msg-kind')).toHaveText('에이전트');
  await expect(page.locator(VIEW + ' .chat-day')).toHaveCount(2);
  await expect(msgs.nth(3)).toHaveClass(/\bcalled\b/);
  await expect(msgs.nth(3).locator('.chat-msg-call')).toHaveText('@나');
  await expect(msgs.nth(4).locator('.chat-msg-call')).toHaveText('@builder');
  await expect(msgs.nth(5)).toHaveClass(/\bmine\b/);
  const bg = (i: number) => msgs.nth(i).evaluate((e) => getComputedStyle(e).backgroundColor);
  expect(await bg(5)).not.toBe(await bg(1));
  // 같은 참가자는 같은 색, 나는 사람 색이다.
  const color = (i: number) => msgs.nth(i).evaluate((e) => (e as HTMLElement).style.getPropertyValue('--chat-c'));
  expect(await color(1)).toBe(await color(0));
  expect(await color(5)).toBe('var(--chat-me)');
});

test('TC-ITH-8 방 머리 세 줄과 참가자 목록 행', async ({ page }) => {
  const posts = await openRoom(page);
  // 활동 사건이 오면 채팅 뷰가 참가자 행의 상태를 다시 그린다.
  await page.evaluate(() => (window as any).app.testing.onToolActivity({ toolId: 't-b', state: 'working' }));
  await expect(page.locator(VIEW + ' .chat-purpose')).toHaveText('배포 점검');
  await expect(page.locator(VIEW + ' .chat-meta-text')).toHaveText('만든 이 builder · 참가자 4');
  await expect(page.locator(VIEW + ' .chat-notify')).toHaveText('알림: 부른 글');
  const rows = page.locator(VIEW + ' .chat-people .chat-person');
  await expect(rows.locator('.chat-row-name')).toHaveText(['User', 'builder', 'linux › User', 'linux › reviewer']);
  await expect(rows.nth(1).locator('.chat-row-sub')).toHaveText('에이전트 · 작업 중 · 알림: 모든 글');
  await expect(rows.nth(3).locator('.chat-row-sub')).toHaveText('에이전트');
  await expect(page.locator(VIEW + ' .chat-people-node')).toHaveText(['mac', 'linux']);
  await page.locator(VIEW + ' .chat-notify').click();
  await page.locator('.chat-menu .ui-menu-item[data-id="all"]').click();
  await expect.poll(() => posts.filter((p) => p.op === 'notify').map((p) => p.body)).toEqual([{ room: ROOM, level: 'all' }]);
});

test('TC-ITH-8 @ 자동완성과 답장이 call 을 채운다', async ({ page }) => {
  const posts = await openRoom(page);
  await addMsgs(page, [{ id: '1', from: 'BBBB-x', fromLabel: 'linux/reviewer', fromKind: 'agent', text: 'hi', min: -1 }]);
  const input = page.locator(VIEW + ' .chat-input');
  await input.click();
  await input.pressSequentially('봐 주세요 @bu');
  const list = page.locator(VIEW + ' .chat-mention');
  await expect(list).toBeVisible();
  await expect(list.locator('.ui-menu-item')).toHaveText(['builder']);
  await input.press('Enter');
  await expect(list).toBeHidden();
  await expect(input).toHaveValue('봐 주세요 @builder ');
  await input.press('Enter');
  await expect.poll(() => posts.filter((p) => p.op === 'send').map((p) => p.body))
    .toEqual([{ room: ROOM, text: '봐 주세요 @builder ', call: ['AAAA-b'] }]);
  await page.locator(VIEW + ' .chat-msg').first().hover();
  await page.locator(VIEW + ' .chat-msg').first().locator('.chat-msg-reply').click();
  await expect(input).toHaveValue('@linux › reviewer ');
  await input.pressSequentially('ok');
  await input.press('Enter');
  await expect.poll(() => posts.filter((p) => p.op === 'send').length).toBe(2);
  expect(posts.filter((p) => p.op === 'send')[1].body).toEqual({ room: ROOM, text: '@linux › reviewer ok', call: ['BBBB-x'] });
  // 보낸 글은 바로 대화에 들고, 부른 상대가 머리에 적힌다.
  await expect(page.locator(VIEW + ' .chat-msg.mine .chat-msg-call').last()).toHaveText('@linux › reviewer');
});

test('TC-ITH-9 마크다운 — 코드 블록은 언어를 싣고 가로로 구르며, 원시 HTML 은 글자다', async ({ page }) => {
  await openRoom(page);
  const long = 'x'.repeat(400);
  await addMsgs(page, [{ id: '1', from: 'AAAA-b', fromLabel: 'mac/builder', fromKind: 'agent', min: -1,
    text: 'a <b>raw</b> <script>window.__x=1</script>\n\n\x60\x60\x60js\nconst v = "' + long + '";\n\x60\x60\x60\n\n[link](https://example.com)' }]);
  const body = page.locator(VIEW + ' .chat-msg .chat-msg-text');
  const pre = body.locator('pre.chat-code');
  await expect(pre).toHaveAttribute('data-lang', 'js');
  await expect(pre.locator('.hljs-keyword').first()).toHaveText('const');
  expect(await pre.evaluate((e) => e.scrollWidth > e.clientWidth)).toBe(true);
  await expect(body.locator('b, script')).toHaveCount(0);
  await expect(body).toContainText('<b>raw</b>');
  expect(await page.evaluate(() => (window as any).__x)).toBeUndefined();
  await expect(body.locator('a')).toHaveAttribute('target', '_blank');
  await expect(body.locator('a')).toHaveAttribute('rel', 'noopener noreferrer');
});
