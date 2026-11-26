import assert from 'node:assert/strict';
import { test } from 'node:test';

import { load } from './harness.mjs';

/**
 * ISSUE_TREE_CHAT_SRS FR-CUX-13 — 입력칸의 `@` 자동완성과 답장이 `call` 을 채운다 (TC-ITH-8 단위).
 */
function ctx() {
  return load(['core/i18n.js', 'i18n/ko.js', 'i18n/chat.ko.js', 'core/chat-store.js', 'core/chat-mention.js'], {});
}

const ME = 'A-me';
const people = [
  { id: 'A-me', label: 'mac/User', kind: 'user' },
  { id: 'A-b', label: 'mac/builder', kind: 'agent' },
  { id: 'A-bb', label: 'mac/builder2', kind: 'agent' },
  { id: 'B-x', label: 'linux/reviewer', kind: 'agent' },
];

test('TC-ITH-8 커서 앞의 @질의를 찾는다 — 낱말 처음의 @ 만이다', () => {
  const c = ctx();
  assert.equal(c.chatMentionQuery('hi @bu'), 'bu');
  assert.equal(c.chatMentionQuery('@'), '');
  assert.equal(c.chatMentionQuery('line\n@re'), 're');
  assert.equal(c.chatMentionQuery('mail a@b'), null);
  assert.equal(c.chatMentionQuery('hi @bu now'), null);
  assert.equal(c.chatMentionQuery('no mention'), null);
});

test('TC-ITH-8 후보는 나를 빼고 이름이 질의를 품은 참가자다 — 앞이 맞는 것이 먼저다', () => {
  const c = ctx();
  const ids = (q) => [...c.chatMentionMatches(people, ME, q).map((m) => m.id)];
  assert.deepEqual(ids(''), ['A-b', 'A-bb', 'B-x']);
  assert.deepEqual(ids('BUI'), ['A-b', 'A-bb']);
  assert.deepEqual(ids('view'), ['B-x']);
  assert.deepEqual(ids('lin'), ['B-x']);
  assert.deepEqual(ids('user'), []);
  assert.equal(c.chatMentionMatches(people, ME, 'rev')[0].name, 'linux › reviewer');
});

test('TC-ITH-8 고르면 @질의를 @이름 과 빈칸으로 바꾸고 커서를 그 뒤에 둔다', () => {
  const c = ctx();
  const r = c.chatMentionPick('hi @bu tail', 6, 'builder');
  assert.equal(r.text, 'hi @builder  tail');
  assert.equal(r.caret, 12);
});

test('TC-ITH-8 답장은 입력칸 앞에 @이름 을 붙이고 이미 있으면 두 번 붙이지 않는다', () => {
  const c = ctx();
  assert.equal(c.chatReplyText('', 'builder'), '@builder ');
  assert.equal(c.chatReplyText('ok', 'builder'), '@builder ok');
  assert.equal(c.chatReplyText('@builder ok', 'builder'), '@builder ok');
});

test('TC-ITH-8 보낼 때 본문의 @이름 이 call 이 된다 — 긴 이름이 먼저 잡히고 나는 빠진다', () => {
  const c = ctx();
  assert.deepEqual([...c.chatCallsIn('@builder2 봐 주세요', people, ME)], ['A-bb']);
  assert.deepEqual([...c.chatCallsIn('@builder 와 @linux › reviewer', people, ME)], ['A-b', 'B-x']);
  assert.deepEqual([...c.chatCallsIn('@User 메모', people, ME)], []);
  assert.deepEqual([...c.chatCallsIn('mail@builder', people, ME)], []);
  assert.deepEqual([...c.chatCallsIn('부르지 않음', people, ME)], []);
});
