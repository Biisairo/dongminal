import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BASE, LAYOUT, load } from './harness.mjs';

/**
 * REFACTOR3_FE_REST3_SRS R3b FC-05 — 창 닫기(`delWindow`)의 순서·갈래를 고정한다. 나누기 **전**의 동작을 적은
 * 시험이며 나눈 뒤에도 그대로 지나야 한다(D-FR3-1 과 같은 규약).
 *   TC-FR3-31 확인 둘과 순서 · TC-FR3-32 도구 처리 · TC-FR3-33 남은 창·활성 창·포커스
 *
 * 앱 대역은 객체(`host`)로 세운다 — `app.X =` 꼴을 쓰지 않는다(TC-FEA-2).
 */

const pane = (id) => ({ type: 'pane', id, tabs: [{ id: 't-' + id, toolId: id }] });
const split = (...kids) => ({ type: 'split', children: kids });

function ctx() {
  return load([...BASE, 'core/layout-tree.js', ...LAYOUT], {
    expose: ['LayoutController'],
    globals: {
      App: function App() {}, TIMERS: { disposeOwner() {} }, t: (k) => k, tn: (k) => k,
      TAB_TYPE_TERMINAL: 'terminal', TAB_TYPE_EDITOR: 'editor', TAB_TYPE_RUN: 'run', TAB_TYPE_CHAT: 'chat', TAB_TYPE_GIT: 'git',
      CLOSE_DIRTY_MSG: 'dirty?', RETURN_WINDOW_KEY: { plain: 'rp', editor: 're' },
      PrefStore: { session: { get: () => null, set() {} } },
    },
  });
}

/**
 * `over`: dirty(편집 dirty) · saveOk · dirtyAns · busy(pid 집합) · procAns · kind(창 id → 종류 창).
 */
function host(over = {}) {
  const log = [];
  const o = { dirty: false, saveOk: true, dirtyAns: 'discard', busy: [], procAns: 'close', kind: [], ...over };
  const h = {
    log,
    ws: {
      windows: [
        { id: 'A', layout: split(pane('a1'), pane('a2')), focusedPane: 'a2' },
        { id: 'B', layout: pane('b1') },
        { id: 'C', layout: pane('c1') },
      ],
      activeWindow: 'B',
    },
    git: { isKindWin: (s) => o.kind.includes(s.id) },
    render() { log.push('render') },
    editor: { sync: { _edWinDirty(s) { log.push('_edWinDirty:' + s.id); return o.dirty }, async _edWinSaveDirty(s) { log.push('_edWinSaveDirty:' + s.id); return o.saveOk } } }, tool: { async _confirmClose(msg, opt) {
      log.push('_confirmClose:' + msg + ':' + Object.keys(opt).sort().join(','));
      return msg === 'dirty?' ? o.dirtyAns : o.procAns;
    }, async _toolsBusy(pids) {
      log.push('_toolsBusy:' + pids.join(','));
      return Object.fromEntries(pids.map((p) => [p, o.busy.includes(p)]));
    }, life: { _setToolBackground(pid, on) { log.push('_setToolBackground:' + pid + ':' + on) }, _bgRefresh() { log.push('_bgRefresh') }, _kill(pid) { log.push('_kill:' + pid) }, aw: () => h.ws.windows.find((s) => s.id === h.ws.activeWindow) || null } }, slot: { ops: { _slotOnWindowGone(sid) { log.push('_slotOnWindowGone:' + sid) } } }, layout: { async _mkWindow() { log.push('_mkWindow'); h.ws.windows.push({ id: 'N', layout: pane('n1') }); h.ws.activeWindow = 'N' }, winState: { _activateWindow(id) { log.push('_activateWindow:' + id); h.ws.activeWindow = id } } }, focus: { setFocusState(id, s) { log.push('setFocusState:' + id + '@' + s.id) }, focusClear() { log.push('focusClear') }, owner: { _focusWindow(id) { log.push('_focusWindow:' + id) } } }, wsSave: { save() { log.push('save') } },
  };
  return h;
}

function setup(over) {
  const c = ctx();
  const h = host(over);
  const ctl = new c.LayoutController(h);
  // 자기 클래스 안의 부름은 그 인스턴스를 지난다 — 대역은 `ctl` 에 둔다 (REFACTOR3_FE_DELEG_SRS D-DLG-1).
  const fake = h.layout;
  h.layout = ctl;
  ctl._mkWindow = fake._mkWindow;
  ctl.winState._activateWindow = fake.winState._activateWindow;
  ctl._winUndoFinal = () => h.log.push('_winUndoFinal');
  ctl._winUndoArm = (win, i, pids) => h.log.push('_winUndoArm:' + win.id + ':' + i + ':' + pids.join(','));
  return { h, ctl };
}

test('TC-FR3-31: 없는 창은 아무것도 하지 않는다', async () => {
  const { h, ctl } = setup();
  await ctl.delWindow('Z');
  assert.deepEqual(h.log, []);
});

test('TC-FR3-31/32: 한가한 창 — 묻지 않고 유예를 최종으로, 전부 배경으로, 빼고, 되돌리기를 연다', async () => {
  const { h, ctl } = setup();
  await ctl.delWindow('A');
  assert.deepEqual(h.log, ['_edWinDirty:A', '_toolsBusy:a1,a2', '_winUndoFinal', '_setToolBackground:a1:true',
    '_setToolBackground:a2:true', '_bgRefresh', '_winUndoArm:A:0:a1,a2', '_slotOnWindowGone:A',
    'setFocusState:b1@B', '_focusWindow:B', 'render', 'save']);
  assert.deepEqual(h.ws.windows.map((s) => s.id), ['B', 'C']);
});

test('TC-FR3-31: 편집 확인 — 취소면 멈춘다', async () => {
  const { h, ctl } = setup({ dirty: true, dirtyAns: null });
  await ctl.delWindow('A');
  assert.deepEqual(h.log, ['_edWinDirty:A', '_confirmClose:dirty?:saveBtn']);
  assert.equal(h.ws.windows.length, 3);
});

test('TC-FR3-31: 편집 확인 — 저장이 실패하면 멈추고, 저장되면 이어 간다', async () => {
  let { h, ctl } = setup({ dirty: true, dirtyAns: 'save', saveOk: false });
  await ctl.delWindow('A');
  assert.deepEqual(h.log, ['_edWinDirty:A', '_confirmClose:dirty?:saveBtn', '_edWinSaveDirty:A']);
  ({ h, ctl } = setup({ dirty: true, dirtyAns: 'save' }));
  await ctl.delWindow('A');
  assert.deepEqual(h.log.slice(0, 4), ['_edWinDirty:A', '_confirmClose:dirty?:saveBtn', '_edWinSaveDirty:A', '_toolsBusy:a1,a2']);
  assert.equal(h.ws.windows.length, 2);
});

test('TC-FR3-31: force 면 편집 확인을 묻지 않는다', async () => {
  const { h, ctl } = setup({ dirty: true });
  await ctl.delWindow('A', { force: true });
  assert.equal(h.log.filter((x) => x.startsWith('_confirmClose')).length, 0);
  assert.equal(h.ws.windows.length, 2);
});

test('TC-FR3-31: 프로세스 확인 — 취소면 도구도 창도 그대로다', async () => {
  const { h, ctl } = setup({ busy: ['a2'], procAns: null });
  await ctl.delWindow('A');
  assert.deepEqual(h.log, ['_edWinDirty:A', '_toolsBusy:a1,a2', '_confirmClose:core.q_close_window:bgBtn,bgLabel']);
  assert.equal(h.ws.windows.length, 3);
});

test('TC-FR3-32: 물은 닫기 — background 면 busy 만 배경, 나머지 죽이기, 되돌리기 없음', async () => {
  const { h, ctl } = setup({ busy: ['a2'], procAns: 'background' });
  await ctl.delWindow('A');
  assert.deepEqual(h.log.slice(3), ['_setToolBackground:a2:true', '_bgRefresh', '_kill:a1', '_slotOnWindowGone:A',
    'setFocusState:b1@B', '_focusWindow:B', 'render', 'save']);
});

test('TC-FR3-32: 물은 닫기 — 닫기면 전부 죽이고 배경 새로고침도 없다', async () => {
  const { h, ctl } = setup({ busy: ['a2'], procAns: 'close' });
  await ctl.delWindow('A');
  assert.deepEqual(h.log.slice(3, 6), ['_kill:a1', '_kill:a2', '_slotOnWindowGone:A']);
});

test('TC-FR3-32: keepTool — 묻지 않고 busy 만 배경, force 면 전부 죽인다', async () => {
  let { h, ctl } = setup({ busy: ['a1'] });
  await ctl.delWindow('A', { force: true, keepTool: true });
  assert.deepEqual(h.log.slice(2, 6), ['_setToolBackground:a1:true', '_bgRefresh', '_kill:a2', '_slotOnWindowGone:A']);
  ({ h, ctl } = setup({ busy: ['a1'] }));
  await ctl.delWindow('A', { force: true });
  assert.deepEqual(h.log.slice(2, 5), ['_kill:a1', '_kill:a2', '_slotOnWindowGone:A']);
});

test('TC-FR3-33: 마지막 창이면 새 창을 만들고 그리기만 한다', async () => {
  const { h, ctl } = setup();
  h.ws.windows = [h.ws.windows[1]];
  await ctl.delWindow('B');
  assert.deepEqual(h.log.slice(-3), ['_slotOnWindowGone:B', '_mkWindow', 'render']);
});

test('TC-FR3-33: 활성 창을 닫으면 가까운 일반 창으로 간다 — 종류 창은 건너뛴다', async () => {
  const { h, ctl } = setup({ kind: ['C'] });
  await ctl.delWindow('B');
  assert.deepEqual(h.log.slice(-6), ['_slotOnWindowGone:B', '_activateWindow:A', 'setFocusState:a2@A', '_focusWindow:A',
    'render', 'save']);
});

test('TC-FR3-33: 일반 창이 남지 않으면 새 창 → 그리기 → 저장', async () => {
  const { h, ctl } = setup({ kind: ['A', 'C'] });
  await ctl.delWindow('B');
  assert.deepEqual(h.log.slice(-4), ['_slotOnWindowGone:B', '_mkWindow', 'render', 'save']);
});

test('TC-FR3-33: 포커스 칸이 없으면 첫 칸, 레이아웃이 없으면 포커스를 지운다', async () => {
  let { h, ctl } = setup();
  h.ws.windows[0].focusedPane = 'gone';
  h.ws.activeWindow = 'A';
  await ctl.delWindow('B');
  assert.ok(h.log.includes('setFocusState:a1@A'));
  ({ h, ctl } = setup());
  h.ws.windows[1].layout = null;
  await ctl.delWindow('A');
  assert.ok(h.log.includes('focusClear'));
});
