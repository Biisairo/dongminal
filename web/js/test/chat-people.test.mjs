import assert from 'node:assert/strict';
import { test } from 'node:test';

import { load } from './harness.mjs';

/**
 * ISSUE_TREE_CHAT_SRS FR-CUX-11·12 — 방 머리 셋째 줄과 참가자 목록 (TC-ITH-8 단위).
 */
function ctx() {
  return load(['core/i18n.js', 'i18n/ko.js', 'i18n/chat.ko.js', 'core/constants.js', 'core/constants-chat.js',
    'core/chat-store.js', 'core/chat-log.js'], {});
}

const ME = 'A-me';
const people = [
  { id: 'B-x', label: 'linux/zeta', kind: 'agent', node: 'B' },
  { id: 'A-b', label: 'mac/builder', kind: 'agent', node: 'A', tool: 't-b', notify: 'all' },
  { id: 'B-u', label: 'linux/User', kind: 'user', node: 'B' },
  { id: 'A-me', label: 'mac/User', kind: 'user', node: 'A', notify: 'called' },
  { id: 'A-a', label: 'mac/api', kind: 'agent', node: 'A', tool: 't-a', notify: 'off' },
];

test('TC-ITH-8 참가자는 노드별로 묶이고 내 노드가 먼저, 묶음 안에서는 사람이 먼저다', () => {
  const c = ctx();
  const g = c.chatPeopleGroups(people, ME);
  assert.deepEqual([...g.map((x) => x.name)], ['mac', 'linux']);
  assert.deepEqual([...g[0].people.map((p) => p.id)], ['A-me', 'A-a', 'A-b']);
  assert.deepEqual([...g[1].people.map((p) => p.id)], ['B-u', 'B-x']);
});

test('TC-ITH-8 행의 부제는 종류 · 상태 · 알림 단계다', () => {
  const c = ctx();
  const act = new Map([['t-b', { state: 'working' }], ['t-a', { state: 'waiting' }]]);
  assert.equal(c.chatPersonSub(people[1], ME, act), '에이전트 · 작업 중 · 알림: 모든 글');
  assert.equal(c.chatPersonSub(people[4], ME, act), '에이전트 · 대기 · 알림: 끔');
  assert.equal(c.chatPersonSub(people[3], ME, act), '사람 · 알림: 부른 글');
});

test('TC-ITH-8 다른 노드의 상태와 모르는 단계는 적지 않는다', () => {
  const c = ctx();
  const act = new Map([['t-b', { state: 'working' }]]);
  assert.equal(c.chatPersonSub({ ...people[0], tool: 't-b' }, ME, act), '에이전트');
  assert.equal(c.chatPersonSub(people[2], ME, act), '사람');
  assert.equal(c.chatPersonSub({ ...people[1], tool: 't-gone' }, ME, act), '에이전트 · 알림: 모든 글');
});

test('TC-ITH-8 방 머리 셋째 줄은 만든 이 · 참가자 수다', () => {
  const c = ctx();
  assert.equal(c.chatRoomMeta({ creator: 'A-b', creatorName: 'mac/builder', members: 3 }, ME), '만든 이 builder · 참가자 3');
  assert.equal(c.chatRoomMeta({ creator: 'B-x', creatorName: 'linux/zeta', members: 1 }, ME), '만든 이 linux › zeta · 참가자 1');
  assert.equal(c.chatRoomMeta({ members: 2 }, ME), '참가자 2');
});

test('TC-ITH-8 알림 단계 이름', () => {
  const c = ctx();
  assert.deepEqual(['all', 'called', 'off', ''].map((l) => c.chatNotifyLabel(l)), ['모든 글', '부른 글', '끔', '부른 글']);
});
