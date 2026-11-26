import assert from 'node:assert/strict';
import { test } from 'node:test';

import { load } from './harness.mjs';

/**
 * ISSUE_TREE_CHAT_SRS FR-CUX-9·10·14 — 참가자의 표시 이름과 색 (TC-ITH-8 이름 · TC-ITH-10).
 */
function ctx() {
  return load(['core/i18n.js', 'i18n/ko.js', 'i18n/chat.ko.js', 'core/constants.js', 'core/contrast.js',
    'core/constants-chat.js', 'core/chat-store.js', 'core/chat-log.js'], { expose: ['CHAT_AGENT_COLORS'] });
}

const DARK = { red: '#f7768e', green: '#9ece6a', yellow: '#e0af68', blue: '#7aa2f7', magenta: '#bb9af7', cyan: '#7dcfff' };
const LIGHT = { red: '#b91c1c', green: '#15803d', yellow: '#a16207', blue: '#1d4ed8', magenta: '#6d28d9', cyan: '#0f766e' };

test('TC-ITH-10 사람 색은 배경과 대비가 가장 큰 구문 색이고, 에이전트 목록에 없다', () => {
  const c = ctx();
  const v = c.deriveChatColors(DARK, '#1a1b26');
  const best = Object.values(DARK).reduce((a, x) => (c.contrastRatio(x, '#1a1b26') > c.contrastRatio(a, '#1a1b26') ? x : a));
  assert.equal(v['--chat-me'], best);
  const agents = [0, 1, 2, 3, 4].map((i) => v['--chat-a' + i]);
  assert.equal(agents.length, c.CHAT_AGENT_COLORS);
  assert.ok(!agents.includes(best));
  assert.deepEqual(new Set([...agents, best]), new Set(Object.values(DARK)));
});

test('TC-ITH-10 테마가 바뀌면 다시 계산한다', () => {
  const c = ctx();
  const d = c.deriveChatColors(DARK, '#1a1b26');
  const l = c.deriveChatColors(LIGHT, '#ffffff');
  assert.notEqual(d['--chat-me'], l['--chat-me']);
  assert.ok(Object.values(LIGHT).includes(l['--chat-me']));
});

test('TC-ITH-10 같은 구문 색이 둘이어도 에이전트 칸은 다섯이고, 구문 색이 모자라면 세우지 않는다', () => {
  const c = ctx();
  const v = c.deriveChatColors({ ...DARK, cyan: DARK.blue }, '#1a1b26');
  assert.equal([0, 1, 2, 3, 4].filter((i) => v['--chat-a' + i]).length, 5);
  assert.deepEqual({ ...c.deriveChatColors({ red: '#ff0000' }, '#000000') }, {});
  assert.deepEqual({ ...c.deriveChatColors(undefined, '#000000') }, {});
});

test('TC-ITH-10 같은 참가자 id 는 같은 색이고, 나는 사람 색이다', () => {
  const c = ctx();
  assert.equal(c.chatColorVar('fp-abc', 'fp-me'), c.chatColorVar('fp-abc', 'fp-me'));
  assert.equal(c.chatColorVar('fp-me', 'fp-me'), '--chat-me');
  assert.match(c.chatColorVar('fp-abc', 'fp-me'), /^--chat-a[0-4]$/);
  const used = new Set(Array.from({ length: 40 }, (_, i) => c.chatColorVar('fp-x' + i, 'fp-me')));
  assert.ok(used.size > 1, '여러 id 가 한 색으로 몰리지 않는다');
});

test('TC-ITH-8 내 노드의 참가자는 탭 이름, 다른 노드는 <노드> › <탭> 이다', () => {
  const c = ctx();
  assert.equal(c.chatName('mac/builder', 'NODEA-r1', 'NODEA-me'), 'builder');
  assert.equal(c.chatName('linux/api/v2', 'NODEB-r2', 'NODEA-me'), 'linux › api/v2');
  assert.equal(c.chatName('plain', 'NODEB-r2', 'NODEA-me'), 'plain');
  assert.equal(c.chatName('', 'NODEB-abcdef99', 'NODEA-me'), 'abcdef');
});

test('TC-ITH-8 방 이름의 # 는 겹치지 않고, 개인채팅은 상대의 표시 이름이다', () => {
  const c = ctx();
  assert.equal(c.chatRoomTitle({ kind: 'group', name: '#ops' }, 'A-me'), '#ops');
  assert.equal(c.chatRoomTitle({ kind: 'group', name: 'ops' }, 'A-me'), '#ops');
  const dm = { kind: 'direct', people: [{ id: 'A-me', label: 'mac/User' }, { id: 'B-x', label: 'linux/agent' }] };
  assert.equal(c.chatRoomTitle(dm, 'A-me'), 'linux › agent');
});

test('TC-ITH-8 부른 상대도 표시 이름으로 적는다', () => {
  const c = ctx();
  const people = [{ id: 'B-x', label: 'linux/agent' }, { id: 'A-y', label: 'mac/builder' }];
  assert.deepEqual([...c.chatCallTags({ call: ['B-x', 'A-y'] }, 'A-me', people)], ['@linux › agent', '@builder']);
});
