import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AGENTS, BASE, CHAT, LAYOUT, PANELS, SCREENS_LOADED, controllers, load, plain } from './harness.mjs';

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
      Screens: SCREENS_LOADED,
      PrefStore: { local },
      STORE_KEYS: { activityTab: 'activityTab' },
      // FR-TIP-2: Activity 탭의 영어 툴팁 (constants-tips.js).
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
  app.agents._agWindowItems = () => [{ t: 'group', attn: 0 }, { t: 'card', toolId: 'a' }];
  app.agents.list._actBgRows = () => [{ t: 'row', id: 'b1' }, { t: 'row', id: 'b2' }];
  app.agents.list._actRunsRows = () => [];
  app.agents._agFolded = () => new Set();
  app._limits = [];
  app.renders = 0;
  app.agents.agentsRender = () => {};
  // CHAT_WINDOW_SRS FR-CW-21: 채팅 상태가 바뀌면 다시 그리는 것은 메인 패널의 목록이다.
  app.chat.window._chatRepaint = () => { app.renders++ };
  app.chat.views._chatViewsPaint = () => {};
  app.claude._claudeAcctFold = () => new Set();
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
  app.agents.list._actTabSelect('bg');
  items = app.agents.list._actItems();
  assert.equal(items[0].cur, 'bg');
  assert.deepEqual(plain(items.slice(1).map((i) => i.id)), ['b1', 'b2']);
  assert.equal(ctx._local.get('activityTab'), 'bg');
  app.agents.list._actTabSelect('runs');
  assert.deepEqual(plain(app.agents.list._actItems().slice(1).map((i) => i.t)), ['secempty']);
});

test('FR-PCH-80: 저장 값이 모르는 탭이면 첫 탭이다. 모르는 탭으로는 바꾸지 않는다', () => {
  const ctx = loadUI();
  ctx._local.set('activityTab', 'usage');
  const app = rig(ctx);
  assert.equal(app.agents.list._actTab(), 'agents');
  app.agents.list._actTabSelect('nope');
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
  app.agents._agWindowItems = () => [{ t: 'group', attn: 1 }];
  app.chat._chatS().add('r1', { id: 'm1' }, false);
  app.chat._chatS().add('r2', { id: 'm2' }, false);
  app.chat._chatS().add('gone', { id: 'm3' }, false);
  assert.deepEqual(tabsOf(app.agents.list._actItems()), [['agents', 0, true], ['bg', 2, false], ['runs', 0, false]]);
  assert.equal(app.chat.chatUnreadTotal(), 2);
});

test('채팅 목록: 작업 패널은 채팅 항목을 만들지 않는다. 데몬이 준비되지 않으면 까닭 한 줄이다', () => {
  const ctx = loadUI();
  const app = rig(ctx);
  let built = 0;
  app.chat._chatItems = () => { built++; return [] };
  // CHAT_WINDOW_SRS FR-CW-40 으로 개정: 이전 — 작업 패널 탭은 넷(…·chats)이었다 / 지금 — 셋이고 채팅은 메인 패널의 `채팅` 탭이다 / 이유 — 사용자 결정 D-7.
  // 저장된 고른 탭이 `chats` 여도 첫 탭이다 (FR-CW-40).
  ctx._local.set('activityTab', 'chats');
  app._actTabKey = null;
  assert.equal(app.agents.list._actTab(), 'agents');
  app.agents.list._actItems();
  assert.equal(built, 0);
  delete app.chat._chatItems;
  app._chat = { down: 'chat_daemon_restart' };
  const rows = app.chat._chatItems();
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
  // ISSUE_TREE_CHAT_SRS FR-CUX-9·14: 내 노드의 상대는 탭 이름이다(다른 노드는 chat-color.test.mjs).
  const d = { kind: 'direct', people: [{ id: 'A-me', label: 'mac/User' }, { id: 'A-x', label: 'mac/claude' }] };
  assert.equal(chatRoomTitle(d, 'A-me'), 'claude');
  assert.equal(chatRoomTitle({ kind: 'direct', people: [] }, 'me'), 'chat.direct');
  assert.equal(chatShortId('f'.repeat(64) + '-0123456789abcdef'), '012345');
});

test('사람에게 온 글: 그 방의 탭이 보이면 안 읽은 수가 늘지 않는다', () => {
  const ctx = loadUI();
  const app = rig(ctx);
  app.chat._onChatMessage({ msg: { id: 'm1', room: 'r1', text: 'hi' } });
  assert.equal(app.chat._chatS().unread('r1'), 1);
  app.chat.views._chatViewMap().set('k', { roomId: 'r1', root: { isConnected: true, classList: { contains: (c) => c === 'vis' } } });
  app.chat._onChatMessage({ msg: { id: 'm2', room: 'r1', text: 'hi' } });
  assert.equal(app.chat._chatS().unread('r1'), 1);
  app.chat._onChatMessage({ msg: { id: 'm2', room: 'r1', text: 'hi' } });
  assert.equal(app.chat._chatS().list('r1').length, 2, '같은 글은 다시 넣지 않는다');
  app.chat._onChatMessage({});
  assert.equal(app.renders, 2);
});

test('ISSUE_TREE_CHAT FR-TGT-9: 텔레그램에서 쓴 내 글은 읽은 글로 들어가고 알람을 울리지 않는다', () => {
  const ctx = loadUI();
  const app = rig(ctx);
  app._chat = { me: { id: 'u1' }, rooms: [{ id: 'r1', notify: 'all' }] };
  app.chat._onChatMessage({ msg: { id: 'tg-1', room: 'r1', from: 'u1', fromKind: 'user', text: 'hi' } });
  assert.equal(app.chat._chatS().list('r1').length, 1);
  assert.equal(app.chat._chatS().unread('r1'), 0);
  assert.equal(app.chat._chatS().alarmed('r1'), false);
  app.chat._onChatMessage({ msg: { id: 'm2', room: 'r1', from: 'a7', text: 'hi' } });
  assert.equal(app.chat._chatS().unread('r1'), 1);
  assert.equal(app.chat._chatS().alarmed('r1'), true);
});

test('FR-PCH-83: 같은 방의 채팅 탭은 하나다 — 이미 있으면 그리로 간다', () => {
  const ctx = load([...BASE, ...LAYOUT, ...CHAT], {
    globals: {
      App: class {}, Screens: SCREENS_LOADED, TAB_TYPE_RUN: 'run', TAB_TYPE_GIT: 'git', TAB_TYPE_EDITOR: 'editor', TAB_TYPE_TERMINAL: 'terminal', TAB_TYPE_CHAT: 'chat',
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
  app.layout.tabAdd._revealTab = (f) => { revealed = f.tab.id };
  app.slot.paneTabSet = () => {};
  app.focus.setFocusState = () => {};
  app.render = () => {};
  app.wsSave.save = () => {};
  const first = app.chat._addChatTab(app.ws.windows[0], pane, { roomId: 'r1', name: '#ops' });
  assert.equal(first.uuid, 'tab1');
  assert.deepEqual(plain(pane.tabs), [{ id: 'tab1', name: '#ops', type: 'chat', roomId: 'r1' }]);
  assert.equal(app.chat._addChatTab(app.ws.windows[0], pane, { roomId: 'r1' }), undefined);
  assert.equal(revealed, 'tab1');
  assert.equal(pane.tabs.length, 1);
  assert.equal(app.chat._addChatTab(app.ws.windows[0], pane, {}), undefined);
});

// ── ISSUE_TREE_CHAT_SRS FR-CAL-15·16: 사람 참가자의 알람 ──

function alarmRig() {
  const ctx = loadUI();
  const app = rig(ctx);
  app._chat = { me: { id: 'me' }, rooms: [{ id: 'r1', joined: true }, { id: 'r2', joined: true, notify: 'all' }, { id: 'r3', joined: true, notify: 'off' }] };
  app.announced = [];
  app.attn = { claim: { _attnAnnounceChat: (id) => { app.announced.push(id) } } };
  return app;
}

test('FR-CAL-15: 기본 단계(called)는 부른 글만 알람이다', () => {
  const app = alarmRig();
  app.chat._onChatMessage({ msg: { id: 'm1', room: 'r1', text: 'a' } });
  assert.equal(app.chat.chatRoomAlarmed('r1'), false);
  app.chat._onChatMessage({ msg: { id: 'm2', room: 'r1', text: 'b', called: true } });
  assert.equal(app.chat.chatRoomAlarmed('r1'), true);
  assert.deepEqual(plain(app.announced), ['m2']);
  assert.equal(app.chat.chatAlarmAny(), true);
});

test('FR-CAL-15: all 은 모든 글, off 는 어떤 글도 알람이 아니다', () => {
  const app = alarmRig();
  app.chat._onChatMessage({ msg: { id: 'm1', room: 'r2', text: 'a' } });
  app.chat._onChatMessage({ msg: { id: 'm2', room: 'r3', text: 'b', called: true } });
  assert.equal(app.chat.chatRoomAlarmed('r2'), true);
  assert.equal(app.chat.chatRoomAlarmed('r3'), false);
  assert.deepEqual(plain(app.announced), ['m1']);
});

test('FR-CAL-15·16: 방 탭이 보이면 알람을 걸지 않고, 보이게 되면 알람이 꺼진다', () => {
  const app = alarmRig();
  app.chat.views._chatViewMap().set('k', { roomId: 'r1', root: { isConnected: true, classList: { contains: (c) => c === 'vis' } } });
  app.chat._onChatMessage({ msg: { id: 'm1', room: 'r1', text: 'a', called: true } });
  assert.equal(app.chat.chatRoomAlarmed('r1'), false);
  assert.deepEqual(plain(app.announced), []);
  app.chat._onChatMessage({ msg: { id: 'm2', room: 'r2', text: 'b' } });
  assert.equal(app.chat.chatRoomAlarmed('r2'), true);
  assert.equal(app.chat._chatS().read('r2'), true);
  assert.equal(app.chat.chatRoomAlarmed('r2'), false);
  assert.equal(app.chat.chatAlarmAny(), false);
});

test('채팅 저장소: 알람은 안 읽은 수와 따로 꺼지지 않는다 — 읽으면 함께 꺼진다', () => {
  const { ChatStore } = loadUI();
  const s = new ChatStore();
  assert.equal(s.alarmed('r'), false);
  s.alarm('r');
  assert.equal(s.alarmed('r'), true);
  assert.equal(s.read('r'), true, '안 읽은 수가 0 이어도 알람이 꺼지면 바뀐 것이다');
  assert.equal(s.alarmed('r'), false);
  assert.equal(s.read('r'), false);
});

test('FR-CAL-15: 알람이 걸린 방 행에는 attn 이 붙는다', () => {
  const app = alarmRig();
  app.chat._onChatMessage({ msg: { id: 'm1', room: 'r2', text: 'a' } });
  const row = (id) => app.chat._chatRoomRowEl({ id, kind: 'group', name: id, members: 1, joined: false }, 'me').className;
  assert.match(row('r2'), /\battn\b/);
  assert.doesNotMatch(row('r1'), /\battn\b/);
});
