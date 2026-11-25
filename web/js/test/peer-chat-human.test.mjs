import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BASE, CHAT, SCREENS_LOADED, controllers, load, plain } from './harness.mjs';

/**
 * PEER_CHAT_SRS §3.12 — 사람 명령 화면 (TC-PCH-13 일부, FR-PCH-86·87).
 *
 *   고르기: Cmd 는 하나씩, Shift 는 범위, 보통 클릭은 지운다
 *   우클릭 대상: 고른 줄이면 고른 것 모두, 아니면 그 줄 하나
 *   도우미가 없으면 메뉴가 없다
 *   확인 창의 대상 문구
 */

function loadHuman(menus) {
  return load([...BASE, ...CHAT], {
    expose: ['chatPick', 'chatCtxTargets', 'chatCmdText'],
    globals: {
      App: class {},
      Screens: SCREENS_LOADED,
      UIKit: { menu: (items) => menus.push(items.map((i) => i.id)) },
      t: (k, p) => (p ? k + JSON.stringify(p) : k),
    },
  });
}

const ev = (o) => Object.assign({ metaKey: false, ctrlKey: false, shiftKey: false, clientX: 0, clientY: 0, preventDefault() {} }, o);

test('FR-PCH-86: Cmd 클릭은 하나씩 더하고 뺀다', () => {
  const { chatPick } = loadHuman([]);
  const sel = new Set();
  let r = chatPick(sel, null, ['a', 'b', 'c'], 'a', ev({ metaKey: true }));
  assert.equal(r.handled, true);
  r = chatPick(sel, r.anchor, ['a', 'b', 'c'], 'c', ev({ metaKey: true }));
  assert.deepEqual(plain([...sel]), ['a', 'c']);
  chatPick(sel, r.anchor, ['a', 'b', 'c'], 'a', ev({ metaKey: true }));
  assert.deepEqual(plain([...sel]), ['c']);
});

test('FR-PCH-86: Shift 클릭은 마지막으로 고른 줄부터 그 줄까지 고른다', () => {
  const { chatPick } = loadHuman([]);
  const sel = new Set();
  const order = ['a', 'b', 'c', 'd'];
  let r = chatPick(sel, null, order, 'd', ev({ metaKey: true }));
  r = chatPick(sel, r.anchor, order, 'b', ev({ shiftKey: true }));
  assert.equal(r.handled, true);
  assert.deepEqual(plain([...sel].sort()), ['b', 'c', 'd']);
});

test('FR-PCH-86: 보통 클릭은 고르기를 지우고 보통 동작에 넘긴다', () => {
  const { chatPick } = loadHuman([]);
  const sel = new Set(['a', 'b']);
  const r = chatPick(sel, 'a', ['a', 'b'], 'b', ev({}));
  assert.equal(r.handled, false);
  assert.equal(sel.size, 0);
});

test('FR-PCH-86: 우클릭한 줄이 고른 것 가운데 하나면 고른 것 모두가 대상이다', () => {
  const { chatCtxTargets } = loadHuman([]);
  const order = ['a', 'b', 'c'];
  assert.deepEqual(plain(chatCtxTargets(new Set(['c', 'a']), 'a', order)), ['a', 'c']);
  assert.deepEqual(plain(chatCtxTargets(new Set(['c', 'a']), 'b', order)), ['b']);
});

test('FR-PCH-87: 확인 창은 할 일과 대상 전체를 말한다', () => {
  const { chatCmdText } = loadHuman([]);
  assert.equal(chatCmdText('kill', ['#a', '#b', '#c']), 'chat.kill_what{"n":3,"list":"#a, #b, #c"}');
  assert.equal(chatCmdText('kick', ['x']), 'chat.kick_what{"n":1,"list":"x"}');
});

test('FR-PCH-86·78: 도우미가 없으면 강제 삭제·강퇴 메뉴가 없다', () => {
  const menus = [];
  const ctx = loadHuman(menus);
  const app = controllers(ctx, new ctx.App());
  app.agents.agentsRender = () => {};
  app._chat = { helper: false, me: { id: 'me' }, rooms: [{ id: 'r1', kind: 'group', name: 'ops', people: [] }] };
  app.chat.human._chatRoomCtx('r1', ev({}));
  app.chat.human._chatPersonCtx({ roomId: 'r1', sel: new Set(), people: [] }, { id: 'p1', label: 'x' }, ev({}));
  assert.equal(menus.length, 0);
  app._chat.helper = true;
  app.chat.human._chatRoomCtx('r1', ev({}));
  app.chat.human._chatPersonCtx({ roomId: 'r1', sel: new Set() }, { id: 'p1', label: 'x' }, ev({}));
  assert.deepEqual(plain(menus), [['kill'], ['kick']]);
});

test('FR-PCH-86: 내 사람 참가자는 강퇴 대상이 아니다', () => {
  const menus = [];
  const ctx = loadHuman(menus);
  const app = controllers(ctx, new ctx.App());
  app._chat = { helper: true, me: { id: 'me' }, rooms: [] };
  app.chat.human._chatPersonCtx({ roomId: 'r1', sel: new Set() }, { id: 'me', label: 'User' }, ev({}));
  assert.equal(menus.length, 0);
  assert.deepEqual(plain(app.chat.human._chatKickTargets({ roomId: 'r1', sel: new Set(['me', 'p1']), order: ['me', 'p1'] }, 'p1')), [{ room: 'r1', participant: 'p1' }]);
});
