import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CONSTANTS, BASE, CHAT, GIT, HELPERS, LAYOUT, controllers, load, plain } from './harness.mjs';

/**
 * CHAT_WINDOW_SRS — 채팅 창 (TC-CW-3~6).
 *
 *   FR-CW-2   채팅 창은 하나 — 여럿이면 첫 창으로 합치고 같은 방은 버린다
 *   FR-CW-10  채팅 창에는 채팅 탭만, 채팅 탭은 채팅 창에만
 *   FR-CW-11  분할은 채팅 창에서 아무 일도 하지 않는다
 *   FR-CW-14  채팅 창 밖의 채팅 탭은 불러올 때 닫는다
 *   FR-CW-5   창 목록(plainWindows)에 채팅 창이 없다
 */
function world() {
  const ctx = load([...BASE, 'core/pref-store.js', 'core/i18n.js', 'i18n/ko.js', ...CONSTANTS, 'core/server-meta.js', ...HELPERS, ...CHAT, ...LAYOUT, ...GIT], {
    globals: { App: function App() {}, ErrorLog: { push() {} }, crypto: { randomUUID: (() => { let n = 0; return () => 'id' + (++n) })() } },
  });
  const a = controllers(ctx, new ctx.App());
  a.isEditorWin = (s) => !!(s && s.type === 'editor');
  a.edOn = () => true;
  a.paneTabSet = (p, id) => { p.activeTab = id };
  return { ctx, a };
}

const pane = (id, tabs) => ({ type: 'pane', id, tabs, activeTab: tabs[0] && tabs[0].id });
const chat = (id, roomId) => ({ id, type: 'chat', roomId, name: roomId });
const term = (id) => ({ id, type: 'terminal', toolId: 't-' + id });

test('TC-CW-3: 채팅 창에는 채팅 탭만, 채팅 탭은 채팅 창에만 선다', () => {
  const { a } = world();
  const C = { id: 'C', type: 'chat', layout: null }, P = { id: 'P', layout: pane('p', []) }, E = { id: 'E', type: 'editor' };
  assert.equal(a.layout.tabAdd._tabTypeFits(C, 'chat'), true);
  assert.equal(a.layout.tabAdd._tabTypeFits(C, 'terminal'), false);
  assert.equal(a.layout.tabAdd._tabTypeFits(C, 'editor'), false);
  assert.equal(a.layout.tabAdd._tabTypeFits(P, 'chat'), false);
  assert.equal(a.layout.tabAdd._tabTypeFits(E, 'chat'), false);
  assert.equal(a.layout.tabAdd._tabTypeFits(P, 'terminal'), true, '일반 창의 터미널은 그대로다');
});

test('TC-CW-3b: 분할은 채팅 창에서 아무 일도 하지 않는다', async () => {
  const { a } = world();
  const C = { id: 'C', type: 'chat', layout: pane('p', [chat('t1', 'r1')]) };
  a.ws = { windows: [C], activeWindow: 'C' };
  a.focused = 'p';
  let made = 0;
  a._newTool = async () => { made++; return { id: 'x' } };
  await a.split('h');
  assert.equal(made, 0);
  assert.equal(C.layout.type, 'pane');
});

test('TC-CW-4: 채팅 창 밖의 채팅 탭은 닫는다 — 빈 칸은 붕괴하고 수를 돌려준다', () => {
  const { a } = world();
  const warn = console.warn; const warned = [];
  console.warn = (m) => warned.push(m);
  try {
    const P = { id: 'P', layout: { type: 'split', dir: 'h', children: [pane('a', [term('x'), chat('c1', 'r1')]), pane('b', [chat('c2', 'r2')])], sizes: [50, 50] } };
    const list = [P];
    assert.equal(a._chatNormalize(list), 2);
    const left = P.layout;
    assert.equal(left.type, 'pane', '탭이 0 이 된 칸은 사라진다');
    assert.deepEqual(plain(left.tabs.map((x) => x.id)), ['x']);
    assert.equal(left.activeTab, 'x');
    assert.equal(warned.length, 1);
    assert.match(warned[0], /closed 2 chat tab/);
  } finally { console.warn = warn }
});

test('TC-CW-5: 채팅 창이 둘이면 첫 창으로 합치고 같은 방은 하나다', () => {
  const { a } = world();
  const C1 = { id: 'C1', type: 'chat', layout: pane('p1', [chat('a', 'r1')]) };
  const C2 = { id: 'C2', type: 'chat', layout: pane('p2', [chat('b', 'r1'), chat('c', 'r2')]) };
  const list = [C1, C2];
  assert.equal(a._chatNormalize(list), 1);
  assert.deepEqual(plain(list.map((s) => s.id)), ['C1']);
  assert.deepEqual(plain(C1.layout.tabs.map((x) => x.roomId)), ['r1', 'r2']);
});

test('TC-CW-6: 창 목록(plainWindows)에 채팅 창이 없다', () => {
  const { a } = world();
  a.ws = { windows: [{ id: 'P', layout: pane('p', [term('x')]) }, { id: 'C', type: 'chat', layout: null }] };
  assert.deepEqual(plain(a.git.plainWindows().map((s) => s.id)), ['P']);
  assert.equal(a.git.isKindWin(a.ws.windows[1]), true);
});

test('FR-CW-3·12: 방을 열면 채팅 창이 생기고 칸이 생긴다. 같은 방은 한 탭이다', () => {
  const { a } = world();
  a.ws = { windows: [{ id: 'P', layout: pane('p', [term('x')]) }], activeWindow: 'P' };
  a.chat._chatRoom = () => ({ id: 'r1', kind: 'group', name: 'ops' });
  a.chat._chatMe = () => ({ id: 'me' });
  let revealed = 0;
  a.switchWindow = (id) => { a.ws.activeWindow = id };
  a._revealTab = () => { revealed++ };
  a.setFocusState = () => {};
  a.render = () => {};
  a.save = () => {};
  a.chat.window._chatOpenTab('r1');
  const C = a.chat.window.chatWindow();
  assert.ok(C);
  assert.equal(a.ws.activeWindow, C.id);
  assert.deepEqual(plain(C.layout.tabs.map((x) => [x.type, x.roomId, x.name])), [['chat', 'r1', '#ops']]);
  a.chat.window._chatOpenTab('r1');
  assert.equal(revealed, 1);
  assert.equal(C.layout.tabs.length, 1);
  assert.equal(a.ws.windows.filter((s) => s.type === 'chat').length, 1);
});
