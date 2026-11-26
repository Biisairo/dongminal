import assert from 'node:assert/strict';
import { test } from 'node:test';

import { load } from './harness.mjs';

/**
 * `web/js/core/chat-log.js` — 대화 그리기의 순수 판정 (ISSUE_TREE_CHAT_SRS FR-CUX-1·2·6·7, TC-ITH-8 단위).
 */
function ctx() {
  return load(['core/i18n.js', 'i18n/ko.js', 'i18n/chat.ko.js', 'core/constants.js', 'core/constants-chat.js', 'core/chat-store.js', 'core/chat-log.js'], { expose: ['CHAT_GROUP_GAP_MS'] });
}

const MIN = 60 * 1000;
const at = (h, m, d = 26) => new Date(2026, 10, d, h, m).getTime();
const msg = (from, when, extra = {}) => ({ from, at: when, ...extra });

test('TC-ITH-8 첫 글은 날짜 구분선과 머리를 갖는다', () => {
  const c = ctx();
  assert.deepEqual({ ...c.chatMsgPlace(null, msg('a', at(9, 0))) }, { day: true, head: true });
});

test('TC-ITH-8 같은 보낸 이의 5분 안 글은 머리 없이 잇는다', () => {
  const c = ctx();
  const p = msg('a', at(9, 0));
  assert.deepEqual({ ...c.chatMsgPlace(p, msg('a', at(9, 5))) }, { day: false, head: false });
  assert.equal(c.CHAT_GROUP_GAP_MS, 5 * MIN);
});

test('TC-ITH-8 5분을 넘거나 보낸 이가 바뀌면 새 머리다', () => {
  const c = ctx();
  const p = msg('a', at(9, 0));
  assert.equal(c.chatMsgPlace(p, msg('a', at(9, 0) + 5 * MIN + 1)).head, true);
  assert.equal(c.chatMsgPlace(p, msg('b', at(9, 1))).head, true);
});

test('TC-ITH-8 날짜가 바뀌면 구분선과 새 머리다', () => {
  const c = ctx();
  const p = msg('a', at(23, 58, 25));
  assert.deepEqual({ ...c.chatMsgPlace(p, msg('a', at(0, 1, 26))) }, { day: true, head: true });
});

test('TC-ITH-8 나를 부른 글은 @나 이고, 다른 상대는 이름으로 적는다', () => {
  const c = ctx();
  const people = [{ id: 'n-me', label: '나의 탭' }, { id: 'n-b', label: 'builder' }];
  assert.deepEqual([...c.chatCallTags(msg('x', 0, { called: true, call: ['n-me'] }), 'n-me', people)], ['@나']);
  assert.deepEqual([...c.chatCallTags(msg('x', 0, { call: ['n-b'] }), 'n-me', people)], ['@builder']);
  assert.deepEqual([...c.chatCallTags(msg('x', 0, { called: true, call: ['user', 'n-b'] }), 'n-me', people)], ['@나', '@builder']);
  assert.deepEqual([...c.chatCallTags(msg('x', 0, { call: ['user'] }), 'n-me', people)], ['@사람']);
});

test('TC-ITH-8 목록에 없는 상대는 짧은 id 로 적고, 부르지 않은 글은 표시가 없다', () => {
  const c = ctx();
  assert.deepEqual([...c.chatCallTags(msg('x', 0, { call: ['fp-abcdef123'] }), 'n-me', [])], ['@abcdef']);
  assert.deepEqual([...c.chatCallTags(msg('x', 0), 'n-me', [])], []);
});

test('TC-ITH-8 날짜 구분선의 글은 같은 날이면 같다', () => {
  const c = ctx();
  assert.equal(c.chatDayLabel(at(0, 1)), c.chatDayLabel(at(23, 59)));
  assert.notEqual(c.chatDayLabel(at(9, 0, 25)), c.chatDayLabel(at(9, 0, 26)));
});

test('TC-ITH-8 동그라미의 머리글자는 이름의 첫 글자다', () => {
  const c = ctx();
  assert.equal(c.chatInitial('builder'), 'B');
  assert.equal(c.chatInitial(' 한컴'), '한');
  assert.equal(c.chatInitial('😀x'), '😀');
  assert.equal(c.chatInitial(''), '?');
});
