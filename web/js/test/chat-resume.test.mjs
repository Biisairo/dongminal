import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BASE, load } from './harness.mjs';

/**
 * 채팅의 읽던 자리 (CHAT_TELEGRAM_UX_SRS 묶음 R, V-CTU-1~4).
 */
function ctx() {
  return load(['core/i18n.js', 'i18n/ko.js', 'i18n/chat.ko.js', 'core/constants.js', 'core/constants-chat.js', 'core/chat-store.js', 'core/chat-log.js'], { expose: ['ChatStore'] });
}

const BOXES = [[0, 40], [40, 100], [100, 130]];

test('V-CTU-1 맨 위에 걸친 글과 그 안의 거리를 고른다', () => {
  const c = ctx();
  assert.deepEqual({ ...c.chatAnchorAt(BOXES.length, (i) => BOXES[i], 0) }, { idx: 0, offset: 0 });
  assert.deepEqual({ ...c.chatAnchorAt(BOXES.length, (i) => BOXES[i], 55) }, { idx: 1, offset: 15 });
  assert.deepEqual({ ...c.chatAnchorAt(BOXES.length, (i) => BOXES[i], 129) }, { idx: 2, offset: 29 });
});

test('V-CTU-1 아래변이 scrollTop 과 같은 글은 이미 지나갔다', () => {
  const c = ctx();
  assert.deepEqual({ ...c.chatAnchorAt(BOXES.length, (i) => BOXES[i], 40) }, { idx: 1, offset: 0 });
});

test('V-CTU-1 빈 목록은 자리가 없고, 마지막 글 너머는 마지막 글이다', () => {
  const c = ctx();
  assert.equal(c.chatAnchorAt(0, () => [0, 0], 10), null);
  assert.deepEqual({ ...c.chatAnchorAt(BOXES.length, (i) => BOXES[i], 200) }, { idx: 2, offset: 100 });
});

test('V-CTU-2 자리가 없으면 맨 아래(null)다', () => {
  const c = ctx();
  assert.equal(c.chatResumeTop([{}, {}], null, () => 0), null);
});

test('V-CTU-2 적힌 글의 위치에 거리를 더한다', () => {
  const c = ctx();
  const a = {}, b = {}, d = {};
  assert.equal(c.chatResumeTop([a, b, d], { msg: b, offset: 15 }, (i) => [0, 40, 100][i]), 55);
});

test('V-CTU-2 적힌 글이 버려졌으면 맨 위(0)다', () => {
  const c = ctx();
  assert.equal(c.chatResumeTop([{}, {}], { msg: {}, offset: 15 }, () => 99), 0);
});

test('V-CTU-3 ChatStore 는 방마다 자리를 적고 읽는다', () => {
  const c = ctx();
  const s = new c.ChatStore();
  const m = { msg: { id: 'x' }, offset: 3 };
  assert.equal(s.markOf('r1'), null);
  s.mark('r1', m);
  assert.equal(s.markOf('r1'), m);
  assert.equal(s.markOf('r2'), null);
  s.mark('r1', null);
  assert.equal(s.markOf('r1'), null);
});

test('V-CTU-3 자리를 적어도 안 읽은 수는 그대로다', () => {
  const c = ctx();
  const s = new c.ChatStore();
  s.add('r1', { id: 'a' }, false);
  s.mark('r1', { msg: { id: 'a' }, offset: 0 });
  assert.equal(s.unread('r1'), 1);
});

function views() {
  const c = load([...BASE, 'core/chat-views.js'], {
    globals: { t: (k) => k, panesOf: () => [] },
    expose: ['ChatViews'],
  });
  const marks = new Map();
  const store = { mark: (r, m) => marks.set(r, m) };
  const app = { chat: { _chatS: () => store }, slot: { slotKey: (id) => id } };
  const vs = new c.ChatViews(app);
  vs._chatLogMark = (v) => ({ msg: v.key, offset: 1 });
  return { vs, marks };
}

const view = (key, roomId, connected, vis) => ({
  key, roomId, root: { isConnected: connected, classList: { contains: (k) => k === 'vis' && vis } },
});

test('V-CTU-4 붙어 보이는 뷰만 자리를 적는다', () => {
  const { vs, marks } = views();
  vs._chatViewMap().set('a', view('a', 'ra', true, true));
  vs._chatViewMap().set('b', view('b', 'rb', false, true));
  vs._chatViewMap().set('c', view('c', 'rc', true, false));
  vs.chatViewsKeep();
  assert.deepEqual([...marks.keys()], ['ra']);
  assert.deepEqual({ ...marks.get('ra') }, { msg: 'a', offset: 1 });
});

test('V-CTU-60 입력칸 높이는 아래 한계와 탭 높이의 반 사이다', () => {
  const c = ctx();
  assert.equal(c.chatInputHeight(20, 36, 600), 36);
  assert.equal(c.chatInputHeight(120, 36, 600), 120);
  assert.equal(c.chatInputHeight(900, 36, 600), 300);
  assert.equal(c.chatInputHeight(301, 36, 601), 300);
});

test('V-CTU-60 탭이 아래 한계의 두 배보다 작으면 아래 한계가 이긴다', () => {
  const c = ctx();
  assert.equal(c.chatInputHeight(500, 36, 40), 36);
});
