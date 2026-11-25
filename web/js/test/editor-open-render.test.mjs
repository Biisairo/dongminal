import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BASE, controllers, fakeClock, load } from './harness.mjs';

/**
 * PERF 3.6.3 (FR-SPA-4) — 파일 열기의 그리기는 한 번이다.
 *
 * `edOpenFile` 은 `addTab` 뒤에 `switchWindow` 를 부른다. 대상 창이 아직 활성이 아니면 `switchWindow` 가 그리므로
 * `addTab` 의 그리기는 같은 작업 안에서 덮인다(측정: 한 작업 71~79 ms 중 ≈22%). 그 그리기를 건너뛰어도 생명주기 전이
 * (`ScreenLife.commit`)는 빠지지도 겹치지도 않아야 한다.
 *
 * 가짜 그리기는 렌더러가 하는 일 중 생명주기 몫만 한다 — 활성 창의 탭 주인을 모아 `commit` 에 넘긴다.
 */
function world() {
  const clock = fakeClock();
  let seq = 0;
  const findPane = (n, rid) => (n && n.id === rid ? n : null);
  const ctx = load(['core/i18n.js', 'i18n/ko.js', 'core/constants.js', 'core/timer-hub.js', ...BASE,
    'ui/screen-life.js', 'core/layout-tab-add.js', 'core/editor-file.js'], {
    clock,
    globals: {
      App: class {},
      // PERF 3.4.7: `edOpenFile` 은 editor 묶음을 먼저 기다린다. 이 시험은 그리기 수만 잰다.
      Screens: { load: () => Promise.resolve() },
      findPane,
      newEntityId: () => 'tab' + (++seq),
      pathBase: (p) => p.split('/').pop(),
      findTabWhere: (wins, fn) => {
        for (const w of wins) for (const t of w.layout.tabs) if (fn(t)) return { win: w, pane: w.layout, tab: t };
        return null;
      },
    },
    expose: ['ScreenLife', 'LayoutTabAdd', 'EditorFile', 'TAB_TYPE_EDITOR', 'SCREEN_SLEEP_MS'],
  });
  const app = controllers(ctx, new ctx.App());
  const log = [];
  const owners = new Map();   // tab id → 계약 주인
  const ownerOf = (tab) => {
    if (!owners.has(tab.id)) {
      const n = tab.name || tab.id;
      owners.set(tab.id, { wake: () => log.push(n + ':wake'), sleep: () => log.push(n + ':sleep'), mount: () => log.push(n + ':mount') });
    }
    return owners.get(tab.id);
  };
  const term = { id: 'w1', type: 'plain', layout: { id: 'p1', tabs: [{ id: 'old', name: 'old' }], active: 'old' } };
  const ed = { id: 'w2', type: 'editor', layout: { id: 'p2', tabs: [], active: null } };
  app.ws = { windows: [term, ed], activeWindow: 'w1' };
  const life = new ctx.ScreenLife({ timers: ctx.TIMERS });
  app.renders = 0;
  app.render = () => {
    app.renders++;
    const w = app.ws.windows.find((x) => x.id === app.ws.activeWindow);
    const shown = new Map();
    const tab = w.layout.tabs.find((t) => t.id === w.layout.active);
    if (tab) shown.set(ownerOf(tab), {});
    life.commit(shown);
  };
  app.layout.tabAdd = new ctx.LayoutTabAdd(app);
  app.layout.switchWindow = (sid) => {
    if (app.ws.activeWindow === sid) return;
    app.ws.activeWindow = sid;
    app.render();
  };
  app.editor.file = new ctx.EditorFile(app);
  Object.assign(app.editor, {
    edOn: () => true,
    isEditorWin: (w) => !!w && w.type === 'editor',
    edWindowFor: () => ed,
    _edHome: () => '/r',
    edFocusHandoff: () => {},
  });
  Object.assign(app.editor.pane, { _edLinkedWindow: () => ed, edEnsurePane: () => 'p2' });
  app.editor.open._edTreeFor = () => null;
  app.mobile.mobileShowPane = () => {};
  app.slot.paneTabSet = (pn, id) => { pn.active = id };
  app.focus.setFocusState = () => {};
  app.focus.owner._focusWindow = () => {};
  app.layout.winState._activateWindow = (id) => { app.ws.activeWindow = id };
  app.wsSave.save = () => {};
  app.slot.editorAny = () => null;
  app.chat._addChatTab = () => {};
  Object.assign(app.git, { isGitWin: () => false, isChatWin: () => false });
  app.render();   // 처음 화면: 일반 창의 탭 하나가 깨어 있다
  log.length = 0;
  return { ctx, clock, app, log, term, ed };
}

test('PERF 3.6.3: 다른 창의 파일을 새로 열면 그리기는 한 번이다', async () => {
  const { app } = world();
  app.renders = 0;
  await app.editor.file.edOpenFile('/r/a.js');
  assert.equal(app.renders, 1, 'addTab 과 switchWindow 가 둘 다 그렸다');
  assert.equal(app.ws.activeWindow, 'w2');
});

test('PERF 3.6.3: 이미 활성인 창에 열면 addTab 이 그린다 — switchWindow 는 그리지 않는다', async () => {
  const { app } = world();
  app.ws.activeWindow = 'w2';
  app.render();
  app.renders = 0;
  await app.editor.file.edOpenFile('/r/a.js');
  assert.equal(app.renders, 1);
});

test('PERF 3.6.3: 생명주기 전이 — 새 탭은 mount·wake 한 번, 떠난 탭은 2초 뒤 sleep 한 번', async () => {
  const { ctx, clock, app, log } = world();
  await app.editor.file.edOpenFile('/r/a.js');
  assert.deepEqual(log, ['a.js:mount', 'a.js:wake']);
  await clock.advance(ctx.SCREEN_SLEEP_MS);
  assert.deepEqual(log, ['a.js:mount', 'a.js:wake', 'old:sleep']);
});

test('PERF 3.6.3: 이미 열린 탭을 다시 열면 종전처럼 그린다 (드러내기 갈래)', async () => {
  const { app } = world();
  await app.editor.file.edOpenFile('/r/a.js');
  app.ws.activeWindow = 'w1';
  app.render();
  app.renders = 0;
  await app.editor.file.edOpenFile('/r/a.js');
  assert.ok(app.renders >= 1, '드러냈는데 그리지 않았다');
  assert.equal(app.ws.activeWindow, 'w2');
});
