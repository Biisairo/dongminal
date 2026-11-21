import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AGENTS, BASE, CHAT, LAYOUT, PANELS, controllers, load, plain } from './harness.mjs';

/**
 * PEER_CHAT_SRS §3.11 — 화면 (TC-PCH-13 일부).
 *
 *   Activity 탭 전환·탭 배지(FR-PCH-80·81)
 *   채팅 저장소: 방별 상한·안 읽은 수 (FR-PCH-85)
 *   채팅 탭 열기: 같은 방은 한 탭 (FR-PCH-83)
 *   사람에게 온 글: 탭이 보이지 않을 때만 안 읽은 수가 는다
 */

function memStore() {
  const m = new Map();
  return { m, get: (k) => (m.has(k) ? m.get(k) : null), set: (k, v) => { m.set(k, String(v)); return true } };
}

function loadUI() {
  const local = memStore();
  const ctx = load([...BASE, ...PANELS, 'core/helpers.js', ...AGENTS, ...CHAT, 'core/edges-mesh.js'], {
    expose: ['ACTIVITY_SECTIONS', 'ChatStore', 'chatRoomTitle', 'chatShortId'],
    globals: {
      App: class {},
      PrefStore: { local },
      STORE_KEYS: { activityTab: 'activityTab' },
      // FR-TIP-2: Activity 탭의 영어 툴팁 (constants.js).
      TIP_ACT_AGENTS: 'Show running agents', TIP_ACT_BG: 'Show background tools', TIP_ACT_RUNS: 'Show runs', TIP_ACT_CHATS: 'Show chat rooms',
      TAB_TYPE_CHAT: 'chat',
      TIMERS: { defer: (fn) => fn() },
      UIKit: { icon: () => ({}), button: () => ({}) },
      t: (k, p) => (p ? k + JSON.stringify(p) : k),
      claudeAcctFootViews: () => [],
      claudeAcctStatusLines: () => [],
      claudeAcctAutoView: () => ({}),
    },
  });
  ctx.document.getElementById = () => null;
  ctx._local = local;
  return ctx;
}

function rig(ctx) {
  const app = controllers(ctx, new ctx.App());
  app._agWindowItems = () => [{ t: 'group', attn: 0 }, { t: 'card', toolId: 'a' }];
  app._actBgRows = () => [{ t: 'row', id: 'b1' }, { t: 'row', id: 'b2' }];
  app._actRunsRows = () => [];
  app._agFolded = () => new Set();
  app._limits = [];
  app.renders = 0;
  app.agentsRender = () => {};
  // CHAT_WINDOW_SRS FR-CW-21: 채팅 상태가 바뀌면 다시 그리는 것은 메인 패널의 목록이다.
  app._chatRepaint = () => { app.renders++ };
  app._chatViewsPaint = () => {};
  app._claudeAcctFold = () => new Set();
  return app;
}

const tabsOf = (items) => plain(items[0].tabs.map((x) => [x.key, x.n, x.dot]));

test('FR-PCH-80: 탭 줄 하나와 고른 탭의 항목만 그린다', () => {
  const ctx = loadUI();
  const app = rig(ctx);
  let items = app.agents.list._actItems();
  assert.equal(items[0].t, 'tabs');
  assert.equal(items[0].cur, 'agents');
  // CHAT_WINDOW_SRS FR-CW-40 으로 개정: 이전 — 작업 패널 탭은 넷(…·chats)이었다 / 지금 — 셋이고 채팅은 메인 패널의 `채팅` 탭이다 / 이유 — 사용자 결정 D-7.
  assert.deepEqual(plain(items[0].tabs.map((x) => x.key)), ['agents', 'bg', 'runs']);
  assert.deepEqual(plain(items.slice(1).map((i) => i.t)), ['group', 'card']);
  app._actTabSelect('bg');
  items = app.agents.list._actItems();
  assert.equal(items[0].cur, 'bg');
  assert.deepEqual(plain(items.slice(1).map((i) => i.id)), ['b1', 'b2']);
  assert.equal(ctx._local.get('activityTab'), 'bg');
  app._actTabSelect('runs');
  assert.deepEqual(plain(app.agents.list._actItems().slice(1).map((i) => i.t)), ['secempty']);
});

test('FR-PCH-80: 저장 값이 모르는 탭이면 첫 탭이다. 모르는 탭으로는 바꾸지 않는다', () => {
  const ctx = loadUI();
  ctx._local.set('activityTab', 'usage');
  const app = rig(ctx);
  assert.equal(app.agents.list._actTab(), 'agents');
  app._actTabSelect('nope');
  assert.equal(app.agents.list._actTab(), 'agents');
  assert.equal(app.renders, 0);
});

test('FR-PCH-81: Agents 는 알람 점, Background·Runs 는 개수다. 안 읽은 수는 지금 있는 방의 합이다', () => {
  const ctx = loadUI();
  const app = rig(ctx);
  app._chat = { me: { id: 'me' }, rooms: [{ id: 'r1', joined: true }, { id: 'r2', joined: true }] };
  // CHAT_WINDOW_SRS FR-CW-40 으로 개정: 이전 — 작업 패널 탭은 넷(…·chats)이었다 / 지금 — 셋이고 채팅은 메인 패널의 `채팅` 탭이다 / 이유 — 사용자 결정 D-7.
  // 안 읽은 수는 메인 패널 `채팅` 탭의 배지가 쓴다 (FR-CW-20).
  assert.deepEqual(tabsOf(app.agents.list._actItems()), [['agents', 0, false], ['bg', 2, false], ['runs', 0, false]]);
  app._agWindowItems = () => [{ t: 'group', attn: 1 }];
  app.chat._chatS().add('r1', { id: 'm1' }, false);
  app.chat._chatS().add('r2', { id: 'm2' }, false);
  app.chat._chatS().add('gone', { id: 'm3' }, false);
  assert.deepEqual(tabsOf(app.agents.list._actItems()), [['agents', 0, true], ['bg', 2, false], ['runs', 0, false]]);
  assert.equal(app.chatUnreadTotal(), 2);
});

test('채팅 목록: 작업 패널은 채팅 항목을 만들지 않는다. 데몬이 준비되지 않으면 까닭 한 줄이다', () => {
  const ctx = loadUI();
  const app = rig(ctx);
  let built = 0;
  app._chatItems = () => { built++; return [] };
  // CHAT_WINDOW_SRS FR-CW-40 으로 개정: 이전 — 작업 패널 탭은 넷(…·chats)이었다 / 지금 — 셋이고 채팅은 메인 패널의 `채팅` 탭이다 / 이유 — 사용자 결정 D-7.
  // 저장된 고른 탭이 `chats` 여도 첫 탭이다 (FR-CW-40).
  ctx._local.set('activityTab', 'chats');
  app._actTabKey = null;
  assert.equal(app.agents.list._actTab(), 'agents');
  app.agents.list._actItems();
  assert.equal(built, 0);
  delete app._chatItems;
  app._chat = { down: 'chat_daemon_restart' };
  const rows = app._chatItems();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].el.textContent, 'chat.need_restart');
});

test('채팅 저장소: 같은 글은 한 번, 방별 상한, 보이지 않을 때만 안 읽음', () => {
  const { ChatStore } = loadUI();
  const s = new ChatStore(3);
  assert.equal(s.add('r', { id: 'a' }, false), true);
  assert.equal(s.add('r', { id: 'a' }, false), false);
  s.add('r', { id: 'b' }, true);
  s.add('r', { id: 'c' }, false);
  s.add('r', { id: 'd' }, false);
  assert.deepEqual(plain(s.list('r').map((m) => m.id)), ['b', 'c', 'd']);
  assert.equal(s.unread('r'), 3);
  assert.equal(s.add('r', { id: 'a' }, false), true, '밀려난 글의 id 는 잊는다');
  assert.equal(s.read('r'), true);
  assert.equal(s.unread('r'), 0);
  assert.equal(s.read('r'), false);
  assert.deepEqual(plain(s.list('없음')), []);
});

test('방 이름: 단체채팅은 #이름, 개인채팅은 상대의 표시 이름이다', () => {
  const { chatRoomTitle, chatShortId } = loadUI();
  assert.equal(chatRoomTitle({ kind: 'group', name: 'ops' }, 'me'), '#ops');
  const d = { kind: 'direct', people: [{ id: 'me', label: 'mac/User' }, { id: 'x', label: 'pc/claude' }] };
  assert.equal(chatRoomTitle(d, 'me'), 'pc/claude');
  assert.equal(chatRoomTitle({ kind: 'direct', people: [] }, 'me'), 'chat.direct');
  assert.equal(chatShortId('f'.repeat(64) + '-0123456789abcdef'), '012345');
});

test('사람에게 온 글: 그 방의 탭이 보이면 안 읽은 수가 늘지 않는다', () => {
  const ctx = loadUI();
  const app = rig(ctx);
  app._onChatMessage({ msg: { id: 'm1', room: 'r1', text: 'hi' } });
  assert.equal(app.chat._chatS().unread('r1'), 1);
  app.chat.views._chatViewMap().set('k', { roomId: 'r1', root: { isConnected: true, classList: { contains: (c) => c === 'vis' } } });
  app._onChatMessage({ msg: { id: 'm2', room: 'r1', text: 'hi' } });
  assert.equal(app.chat._chatS().unread('r1'), 1);
  app._onChatMessage({ msg: { id: 'm2', room: 'r1', text: 'hi' } });
  assert.equal(app.chat._chatS().list('r1').length, 2, '같은 글은 다시 넣지 않는다');
  app._onChatMessage({});
  assert.equal(app.renders, 2);
});

test('FR-PCH-83: 같은 방의 채팅 탭은 하나다 — 이미 있으면 그리로 간다', () => {
  const ctx = load([...BASE, ...LAYOUT, ...CHAT], {
    globals: {
      App: class {}, TAB_TYPE_RUN: 'run', TAB_TYPE_GIT: 'git', TAB_TYPE_EDITOR: 'editor', TAB_TYPE_TERMINAL: 'terminal', TAB_TYPE_CHAT: 'chat',
      newEntityId: (() => { let n = 0; return () => 'tab' + (++n) })(),
      clampEntityName: (s) => s,
      findTabWhere: (wins, f) => {
        for (const win of wins) for (const pane of win.panes) for (const tab of pane.tabs) if (f(tab)) return { win, pane, tab };
        return null;
      },
    },
  });
  const app = controllers(ctx, new ctx.App());
  const pane = { id: 'p', tabs: [] };
  app.ws = { windows: [{ id: 'w', panes: [pane] }] };
  let revealed = null;
  app._revealTab = (f) => { revealed = f.tab.id };
  app.paneTabSet = () => {};
  app.setFocusState = () => {};
  app.render = () => {};
  app.save = () => {};
  const first = app._addChatTab(app.ws.windows[0], pane, { roomId: 'r1', name: '#ops' });
  assert.equal(first.uuid, 'tab1');
  assert.deepEqual(plain(pane.tabs), [{ id: 'tab1', name: '#ops', type: 'chat', roomId: 'r1' }]);
  assert.equal(app._addChatTab(app.ws.windows[0], pane, { roomId: 'r1' }), undefined);
  assert.equal(revealed, 'tab1');
  assert.equal(pane.tabs.length, 1);
  assert.equal(app._addChatTab(app.ws.windows[0], pane, {}), undefined);
});
