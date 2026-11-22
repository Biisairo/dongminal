import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BASE, WS_SYNC, load, plain } from './harness.mjs';

/**
 * REFACTOR3_FE_REST3_SRS R3a — 원격 워크스페이스 적용(`_applyRemoteWorkspace`, FC-07)과 저장(`save`·`_saveAdoptRemote`, FC-09)의
 * 순서·충돌 갈래를 고정한다. 나누기 **전**의 동작을 적은 시험이며 나눈 뒤에도 그대로 지나야 한다.
 *   TC-FR3-1~11  `_applyRemoteWorkspace` 의 호출 순서·도구 거두기·로컬 시선 보존·되쓰기 판정
 *   TC-FR3-12~20 `save` 의 비행·합치기·같은 본문 건너뛰기·미루기·409/428·실패
 *   TC-FR3-21~26 `_saveAdoptRemote` 의 채택 순서·git 병합·백오프
 *
 * 앱 대역은 `app.X =` 로 갈아 끼우지 않는다 — 그 꼴은 TC-FEA-2 의 덮어쓰기 대상 목록을 늘린다.
 */

const TOOLS_ALL_LIVE = { has() { return true } };

// ── FC-07: _applyRemoteWorkspace ───────────────────────────────────────────────

function syncCtx() {
  return load([...BASE, 'core/layout-tree.js', ...WS_SYNC], {
    expose: ['WsSyncController'],
    globals: {
      App: function App() {}, TIMERS: { disposeOwner() {} }, TOOLS_ALL_LIVE, WINDOW_TYPE_EDITOR: 'editor',
      ErrorLog: { quiet(_k, fn) { fn() }, push() {} },
    },
  });
}

const pane = (id, tabs, activeTab) => ({ type: 'pane', id, tabs: tabs.map((t) => ({ id: t })), activeTab: activeTab || tabs[0] });

/**
 * 적용기가 부르는 앱 표면의 대역. 부수 효과가 있는 이름만 `log` 에 적는다. `over` 로 반환값을 바꾼다.
 */
function host(ctx, over = {}) {
  const log = [];
  const ret = { normalize: false, reconcile: false, strip: false, merge: 0, attnDrop: false, edOn: false, ...over };
  const seenBefore = { windows: new Set(['before']), tabs: new Set() };
  const h = {
    log, seenBefore, args: {},
    ws: { windows: [], activeWindow: null, git: { pinned: ['p'] } },
    tools: new Map(), toolIds: new Set(), _toolsBoot: new Set(), editors: null,
    slotBase: (k) => String(k).split('@')[0],
    flattenPanes: (n) => ctx.panesOf(n),
    _wsSeen() { log.push('_wsSeen'); return seenBefore },
    _wsMarkSaved(w) { log.push('_wsMarkSaved'); h.args.marked = w.map((s) => s.id) },
    _attnDrop(id) { log.push('_attnDrop:' + id); return ret.attnDrop },
    _attnRefresh() { log.push('_attnRefresh') },
    _normalizeIncomingWorkspace(_sv, live) { log.push('_normalizeIncomingWorkspace'); h.args.live = live; return ret.normalize },
    _edPatchList(list) { log.push('_edPatchList'); h.args.list = list },
    _edReconcile(w) { log.push('_edReconcile'); h.args.reconcile = w; return ret.reconcile },
    _edKeepActive(sv) { log.push('_edKeepActive'); h.args.keep = sv },
    _fallbackActiveWindow(sv) { log.push('_fallbackActiveWindow'); h.args.fallback = sv },
    edOn: () => ret.edOn,
    edRoots: () => ['/kept'],
    gitWindow: () => h.ws.windows.find((s) => s.type === 'git') || null,
    _activateWindow(id) { log.push('_activateWindow:' + id); h.args.activatedOnNew = h.ws === h.args.sv; h.ws.activeWindow = id },
    _stripDeviceKeys() { log.push('_stripDeviceKeys'); return ret.strip },
    aw: () => h.ws.windows.find((s) => s.id === h.ws.activeWindow) || null,
    setFocusState(id) { log.push('setFocusState:' + id) },
    _slotTabsToWs() { log.push('_slotTabsToWs') },
    save() { log.push('save') },
    render() { log.push('render') },
    gitReposKick() { log.push('gitReposKick') },
  };
  ctx.mergeUnseenLayout = (local, remote, seen, want) => {
    log.push('merge');
    h.args.merge = { local, remote, seen, want, wsAtMerge: h.ws };
    return ret.merge;
  };
  return h;
}

function apply(over, setup) {
  const ctx = syncCtx();
  const h = host(ctx, over);
  const ctl = new ctx.WsSyncController(h);
  const sv = { windows: [{ id: 'W1', layout: pane('p1', ['t1']) }], activeWindow: 'W1', git: { pinned: ['p'] } };
  h.args.sv = sv;
  const r = setup ? setup(h, sv) : {};
  ctl._applyRemoteWorkspace(sv, (r && r.panes) || [], r && 'known' in r ? r.known : undefined);
  return { h, sv, ctx };
}

test('TC-FR3-1: 기본 순서 — 기억 집기 → 기억 갈기 → 정규화 → 재조정 → 활성 잇기 → 폴백 → 병합 → 교체 → 시선 → 그리기', () => {
  const { h, sv } = apply({}, (hh) => { hh.ws = { windows: [{ id: 'W1' }], activeWindow: 'W1', git: { pinned: ['p'] } } });
  assert.deepEqual(h.log, ['_wsSeen', '_wsMarkSaved', '_normalizeIncomingWorkspace', '_edReconcile', '_edKeepActive',
    '_fallbackActiveWindow', 'merge', '_activateWindow:W1', '_stripDeviceKeys', 'setFocusState:p1', '_slotTabsToWs', 'render']);
  assert.equal(h.ws, sv, '적용 뒤 앱의 워크스페이스는 받은 스냅샷이다');
  assert.equal(h.args.activatedOnNew, true, '활성 창 복원은 교체 뒤다');
  assert.equal(h.args.reconcile, sv.windows);
  assert.equal(h.args.keep, sv);
  assert.equal(h.args.fallback, sv);
});

test('TC-FR3-2: 병합은 이 채택 이전의 기억을 받고, 교체 전의 로컬 창과 받은 창을 받는다', () => {
  const { h, sv } = apply({}, (hh) => { hh.ws = { windows: [{ id: 'L' }], activeWindow: null } });
  const m = h.args.merge;
  assert.equal(m.seen, h.seenBefore);
  assert.deepEqual(h.args.marked, ['W1'], '기억은 정규화 전의 받은 창으로 갈린다');
  assert.notEqual(m.wsAtMerge, sv);
  assert.deepEqual(plain(m.local.map((s) => s.id)), ['L']);
  assert.equal(m.remote, sv.windows);
  assert.equal(m.want, null, '편집기가 꺼져 있으면 루트 판정을 주지 않는다');
});

test('TC-FR3-3: 편집기가 켜져 있으면 병합의 루트 판정은 지금 목록의 루트다', () => {
  const { h } = apply({ edOn: true });
  assert.equal(h.args.merge.want('/kept'), true);
  assert.equal(h.args.merge.want('/gone'), false);
});

test('TC-FR3-4: 도구를 알면 받은 id 를 적고, 없는 도구는 칸 접미를 떼고 견주어 거둔다', () => {
  const destroyed = [];
  const { h } = apply({ attnDrop: true }, (hh) => {
    const p = (k) => ({ destroy() { destroyed.push(k) } });
    hh.tools = new Map([['a', p('a')], ['a@1', p('a@1')], ['c', p('c')], ['c@2', p('c@2')]]);
    hh.toolIds = new Set(['a', 'c', 'd']);
    hh._toolsBoot = new Set(['c', 'd', 'a']);
    return { panes: [{ id: 'a' }, { id: 'b' }], known: true };
  });
  assert.deepEqual(destroyed, ['c', 'c@2']);
  assert.deepEqual([...h.tools.keys()], ['a', 'a@1']);
  assert.deepEqual([...h.toolIds].sort(), ['a', 'b']);
  assert.deepEqual([...h._toolsBoot], ['a']);
  assert.deepEqual(h.log.slice(0, 7), ['_wsSeen', '_wsMarkSaved', '_attnDrop:c', '_attnDrop:c', '_attnDrop:c', '_attnDrop:d',
    '_attnRefresh']);
  assert.deepEqual([...h.args.live].sort(), ['a', 'b']);
});

test('TC-FR3-5: 알람을 하나도 거두지 않았으면 알람을 다시 그리지 않는다', () => {
  const { h } = apply({ attnDrop: false }, (hh) => {
    hh.toolIds = new Set(['x']);
    return { panes: [], known: true };
  });
  assert.deepEqual(h.log.slice(0, 4), ['_wsSeen', '_wsMarkSaved', '_attnDrop:x', '_normalizeIncomingWorkspace']);
  assert.equal(h.toolIds.size, 0);
});

test('TC-FR3-6: 도구 목록을 모르면 거두지도 적지도 않고, 정규화는 모두 살아 있다고 받는다', () => {
  const { h } = apply({}, (hh) => {
    hh.tools = new Map([['a', { destroy() { throw new Error('거두면 안 된다') } }]]);
    hh.toolIds = new Set(['a']);
    return { panes: [{ id: 'b' }], known: false };
  });
  assert.deepEqual([...h.tools.keys()], ['a']);
  assert.deepEqual([...h.toolIds], ['a']);
  assert.equal(h.args.live.has('anything'), true);
  assert.ok(!h.log.some((l) => l.startsWith('_attn')));
});

test('TC-FR3-7: 받은 스냅샷에 editors 가 있고 앱에 편집기가 있을 때만 목록을 먼저 갈아 끼운다', () => {
  const a = apply({}, (hh, sv) => { hh.editors = {}; sv.editors = { list: ['L'] } }).h;
  assert.deepEqual(a.log.slice(2, 5), ['_normalizeIncomingWorkspace', '_edPatchList', '_edReconcile']);
  assert.deepEqual(plain(a.args.list), ['L']);
  assert.ok(!apply({}, (hh) => { hh.editors = {} }).h.log.includes('_edPatchList'));
  assert.ok(!apply({}, (_hh, sv) => { sv.editors = { list: [] } }).h.log.includes('_edPatchList'));
});

test('TC-FR3-8: 되쓰기는 정규화·재조정·병합·기기 키 벗기기 중 하나라도 바꿨을 때 한 번, 그리기 앞이다', () => {
  for (const k of ['normalize', 'reconcile', 'strip']) {
    const { h } = apply({ [k]: true });
    assert.deepEqual(h.log.slice(-3), ['_slotTabsToWs', 'save', 'render'], k);
    assert.equal(h.log.filter((l) => l === 'save').length, 1, k);
  }
  const { h } = apply({ normalize: true, reconcile: true, strip: true, merge: 2 });
  assert.equal(h.log.filter((l) => l === 'save').length, 1);
  assert.ok(!apply({}).h.log.includes('save'));
});

test('TC-FR3-9: 병합이 일어나면 활성 창 폴백을 한 번 더 부르고 되쓴다', () => {
  const { h } = apply({ merge: 1 });
  assert.deepEqual(h.log.slice(5, 8), ['_fallbackActiveWindow', 'merge', '_fallbackActiveWindow']);
  assert.ok(h.log.includes('save'));
});

test('TC-FR3-10: 이 화면의 활성 창·칸 포커스·보는 탭·리포가 이긴다 — 받은 쪽에 없으면 받은 값을 쓴다', () => {
  const { h, sv } = apply({}, (hh, s) => {
    hh.ws = { activeWindow: 'W2', windows: [
      { id: 'W1', focusedPane: 'p1b', layout: { type: 'split', children: [pane('p1', ['t1', 't2'], 't2'), pane('p1b', ['u'])] } },
      { id: 'W2', focusedPane: 'gone', layout: pane('p2', ['v1', 'v2'], 'v9') },
      { id: 'G', type: 'git', git: { repo: '/mine' } },
    ] };
    s.windows = [
      { id: 'W1', focusedPane: 'p1', layout: { type: 'split', children: [pane('p1', ['t1', 't2'], 't1'), pane('p1b', ['u'])] } },
      { id: 'W2', focusedPane: 'p2', layout: pane('p2', ['v1', 'v2'], 'v1') },
      { id: 'G', type: 'git' },
    ];
    s.activeWindow = 'W1';
  });
  assert.ok(h.log.includes('_activateWindow:W2'));
  assert.equal(sv.windows[0].focusedPane, 'p1b');
  assert.equal(sv.windows[0].layout.children[0].activeTab, 't2');
  assert.equal(sv.windows[1].focusedPane, 'p2', '로컬 칸이 없으면 받은 포커스');
  assert.equal(sv.windows[1].layout.activeTab, 'v1', '로컬이 보던 탭이 없으면 받은 탭');
  assert.deepEqual(plain(sv.windows[2].git), { repo: '/mine' });
  assert.ok(h.log.includes('setFocusState:p2'));
});

test('TC-FR3-11: 로컬 활성 창이 받은 쪽에 없으면 바꾸지 않고, 로컬 리포가 없으면 받은 리포를 쓰며, 핀이 바뀌면 그리기 뒤에 목록을 받는다', () => {
  const { h, sv } = apply({}, (hh, s) => {
    hh.ws = { activeWindow: 'ZZ', windows: [{ id: 'G', type: 'git' }], git: { pinned: ['old'] } };
    s.windows = [{ id: 'G', type: 'git', git: { repo: '/srv' } }, { id: 'W1', layout: pane('p1', ['t1']) }];
    s.activeWindow = 'W1';
    s.git = { pinned: ['new'] };
  });
  assert.ok(!h.log.some((l) => l.startsWith('_activateWindow')));
  assert.equal(sv.windows[0].git.repo, '/srv');
  assert.deepEqual(h.log.slice(-2), ['render', 'gitReposKick']);
  const same = apply({}, (hh) => { hh.ws = { windows: [], activeWindow: null, git: { pinned: ['p'] } } }).h;
  assert.ok(!same.log.includes('gitReposKick'));
});

test('TC-FR3-27(FC-07): wsLiveTools — 알면 받은 id 와 그 집합, 모르면 빈 목록과 모두 살아 있음', () => {
  const ctx = syncCtx();
  const k = ctx.wsLiveTools([{ id: 'a' }, { id: 'b' }], true);
  assert.deepEqual(plain(k.ids), ['a', 'b']);
  assert.equal(k.live.has('a') && !k.live.has('c'), true);
  assert.deepEqual(plain(ctx.wsLiveTools(null, undefined).ids), [], '알림이 없으면 아는 것이다 — 빈 목록');
  const u = ctx.wsLiveTools([{ id: 'a' }], false);
  assert.deepEqual(plain(u.ids), []);
  assert.equal(u.live, TOOLS_ALL_LIVE);
});

test('TC-FR3-27(FC-07): wsPinsKey — 없으면 빈 목록의 키', () => {
  const ctx = syncCtx();
  assert.equal(ctx.wsPinsKey(null), '[]');
  assert.equal(ctx.wsPinsKey({}), '[]');
  assert.equal(ctx.wsPinsKey({ pinned: ['a', 'b'] }), '["a","b"]');
});

test('TC-FR3-27(FC-07): wsViewOf·wsViewRestore — 집은 칸·탭은 받은 쪽에 있을 때만 되얹는다', () => {
  const ctx = syncCtx();
  const flat = (n) => ctx.panesOf(n);
  const view = ctx.wsViewOf([
    { id: 'A', focusedPane: 'p2', layout: { type: 'split', children: [pane('p1', ['x', 'y'], 'y'), pane('p2', ['z'])] } },
    { id: 'B' },
    { id: 'C', focusedPane: 'q', layout: pane('q', [], null) },
  ], flat);
  assert.deepEqual(plain([...view.focus]), [['A', 'p2'], ['C', 'q']]);
  assert.deepEqual(plain([...view.tabs]), [['p1', 'y'], ['p2', 'z']]);
  const got = [
    { id: 'A', focusedPane: 'p1', layout: { type: 'split', children: [pane('p1', ['x'], 'x'), pane('p2', ['z', 'w'], 'w')] } },
    { id: 'C', focusedPane: 'r', layout: pane('r', ['t']) },
    { id: 'D' },
  ];
  ctx.wsViewRestore(got, view, flat);
  assert.equal(got[0].focusedPane, 'p2');
  assert.equal(got[0].layout.children[0].activeTab, 'x', '보던 탭 y 가 없으면 받은 탭');
  assert.equal(got[0].layout.children[1].activeTab, 'z');
  assert.equal(got[1].focusedPane, 'r', '보던 칸 q 가 없으면 받은 칸');
  assert.deepEqual(plain(got[2]), { id: 'D' });
});

// ── FC-09: save · _saveAdoptRemote ────────────────────────────────────────────

const res = (status, etag, data) => ({
  status, ok: status >= 200 && status < 300, data,
  headers: { get: (k) => (k === 'ETag' ? etag : null) },
});

function saveRig() {
  const net = { puts: [], gets: [], put: null, get: null };
  const warns = [];
  const errs = [];
  // REFACTOR3_FE_REST5_SRS FR-FR5-22: 저장 기계는 `WsSaveController` 다 — App 원형의 위임자가 그리로 잇는다.
  const ctx = load([...BASE, 'core/layout-tree.js', 'core/app.js', 'core/ws-save-controller.js'], {
    expose: ['App', 'WsSaveController'],
    globals: {
      TIMERS: { disposeOwner() {} }, WINDOW_TYPE_EDITOR: 'editor',
      WS_SCHEMA_VERSION: 2, WS_SAVE_BACKOFF_MS: 200, WS_SAVE_BACKOFF_MAX_MS: 2000, WS_SAVE_CONFLICT_WARN: 4,
      apiPut: (url, body, opts) => { net.puts.push({ url, body: JSON.parse(body), headers: { ...opts.headers } }); return net.put(body) },
      apiGet: (url) => { net.gets.push(url); return net.get(url) },
      ErrorLog: { push: (k, m) => errs.push([k, String(m)]), quiet(_k, fn) { fn() } },
      console: { ...console, warn: (...a) => warns.push(a.join(' ')) },
    },
  });
  const log = [];
  const sleeps = [];
  const A = Object.create(ctx.App.prototype);
  Object.assign(A, {
    ws: { schemaVersion: 1, activeWindow: 'W1', windows: [{ id: 'W1', focusedPane: 'p1', layout: pane('p1', ['t1']) }] },
    wsETag: '5', _wsSavedIds: new Set(), _wsSavedTabs: new Set(),
    timers: {
      sleep: (ms) => { sleeps.push(ms); log.push('sleep:' + ms); return Promise.resolve() },
      defer: (_fn, o) => { log.push('defer:' + o.label) },
    },
    _saveFlushDeferred() { log.push('flush') },
    gitReposKick() { log.push('gitReposKick') },
    edOn: () => false,
    _edPatchList(list) { log.push('_edPatchList:' + JSON.stringify(list)) },
    _edReconcile(...a) { log.push('_edReconcile:' + a.length) },
    _applyRemoteWorkspace(rem, panes, known) { log.push('apply:' + JSON.stringify([panes, known])); A._applied = rem },
  });
  A.wsSave = new ctx.WsSaveController(A);
  return { ctx, A, net, log, sleeps, warns, errs };
}

const drain = () => new Promise((r) => setImmediate(r));

test('TC-FR3-12: 부팅에 실패한 판은 저장하지 않는다', () => {
  const { A, net } = saveRig();
  A._bootFailed = true;
  assert.equal(A.save(), undefined);
  assert.equal(net.puts.length, 0);
  assert.equal(A._savePending, undefined);
});

test('TC-FR3-13: 본문은 창별 키·dirty 를 벗기고 현재 스키마 판을 싣고, If-Match 로 나간다. 성공하면 ETag·기억·마지막 본문을 적는다', async () => {
  const { A, net, log } = saveRig();
  A.ws.windows[0].layout.tabs[0].dirty = true;
  A._saveConflicts = 3; A._saveHoldUntil = 0;
  net.put = async () => res(200, '6');
  const p = A.save();
  assert.equal(A._saveInflight, true);
  assert.equal(A._saveChain, p);
  A.ws.windows.push({ id: 'LATE' });
  await p;
  assert.equal(net.puts.length, 1);
  const put = net.puts[0];
  assert.equal(put.url, '/api/workspace');
  assert.deepEqual(put.headers, { 'If-Match': '5' });
  assert.equal(put.body.schemaVersion, 2);
  assert.equal('activeWindow' in put.body, false);
  assert.equal('focusedPane' in put.body.windows[0], false);
  assert.equal('dirty' in put.body.windows[0].layout.tabs[0], false);
  assert.equal(A.wsETag, '6');
  assert.deepEqual([...A._wsSavedIds], ['W1'], '기억은 직렬화 시점의 창이다');
  assert.deepEqual([...A._wsSavedTabs], ['t1']);
  assert.equal(A._wsLastSent.etag, '6');
  assert.equal(A._saveConflicts, 0);
  assert.equal(A._saveHoldUntil, 0);
  assert.equal(A._saveInflight, false);
  assert.equal(A._saveChain, null);
  assert.deepEqual(log, ['flush']);
});

test('TC-FR3-14: ETag 가 없으면 조건 머리를 싣지 않는다. 응답에 ETag 가 없으면 지금 값을 둔다', async () => {
  const { A, net } = saveRig();
  A.wsETag = null;
  net.put = async () => res(200, null);
  await A.save();
  assert.deepEqual(net.puts[0].headers, {});
  assert.equal(A.wsETag, null);
});

test('TC-FR3-15: 비행 중의 저장은 같은 약속을 돌려받고, 대기분은 같은 비행에서 한 번 더 나간다', async () => {
  const { A, net, log } = saveRig();
  let n = 0;
  net.put = async () => res(200, String(6 + n++));
  const p1 = A.save();
  A.ws.windows[0].name = 'x';
  const p2 = A.save();
  const p3 = A.save();
  assert.equal(p1, p2);
  assert.equal(p2, p3);
  await p1;
  assert.equal(net.puts.length, 2);
  assert.equal(net.puts[1].headers['If-Match'], '6');
  assert.equal(net.puts[1].body.windows[0].name, 'x');
  assert.deepEqual(log, ['flush']);
});

test('TC-FR3-16: 마지막으로 성공한 본문·ETag 와 같으면 보내지 않고, 비행이 동기로 끝나 붙들지 않는다', async () => {
  const { A, net, log } = saveRig();
  net.put = async () => res(200, '6');
  await A.save();
  A.ws.activeWindow = 'other';
  A.ws.windows[0].focusedPane = 'zz';
  const p = A.save();
  assert.equal(A._saveInflight, false, '같은 본문은 await 없이 끝난다');
  assert.equal(A._saveChain, null);
  await p;
  assert.equal(net.puts.length, 1);
  assert.deepEqual(log, ['flush', 'flush']);
  A.wsETag = '9';
  await A.save();
  assert.equal(net.puts.length, 2, 'ETag 가 바뀌면 같은 본문도 보낸다');
});

test('TC-FR3-17: 충돌 뒤의 미루기 — 남은 시간만큼 잔 뒤에 나간다', async () => {
  const { ctx, A, net, log } = saveRig();
  net.put = async () => { log.push('put'); return res(200, '6') };
  A._saveHoldUntil = ctx.Date.now() + 150;
  await A.save();
  assert.deepEqual(log, ['sleep:150', 'put', 'flush']);
});

for (const st of [409, 428]) {
  test('TC-FR3-18: ' + st + ' 이면 원격을 채택하고 이 저장을 포기한다 — 대기분은 이 비행에서 보내지 않는다', async () => {
    const { A, net, log } = saveRig();
    net.put = async () => { log.push('put'); return res(st, '99') };
    net.get = async () => { A.save(); return res(200, '7', {}) };
    await A.save();
    assert.equal(net.puts.length, 1);
    assert.deepEqual(net.gets, ['/api/workspace']);
    assert.equal(A.wsETag, '7');
    assert.equal(A._savePending, true, '대기분은 남아 비행 끝의 처리로 간다');
    assert.equal(A._wsLastSent, undefined);
    assert.deepEqual(log, ['put', 'flush']);
  });
}

test('TC-FR3-19: 그 밖의 실패 응답은 아무것도 적지 않고, 예외는 경고로 남기고 대기분을 이어 보낸다', async () => {
  const { A, net, warns } = saveRig();
  net.put = async () => res(500, '6');
  await A.save();
  assert.equal(A.wsETag, '5');
  assert.equal(A._wsLastSent, undefined);
  assert.equal(net.gets.length, 0);
  let n = 0;
  net.put = async () => { if (n++ === 0) { await null; A.save(); throw new Error('net') } return res(200, '8') };
  await A.save();
  assert.equal(net.puts.length, 3);
  assert.equal(warns.length, 1);
  assert.match(warns[0], /^\[save\] PUT failed/);
  assert.equal(A.wsETag, '8');
});

test('TC-FR3-20: 직렬화가 던져도 비행은 닫히고 끝 처리를 부른다', async () => {
  const { A, log, warns } = saveRig();
  A.ws.loop = A.ws;
  await A.save();
  assert.equal(A._saveInflight, false);
  assert.equal(A._saveChain, null);
  assert.deepEqual(log, ['flush']);
  assert.equal(warns.length, 1);
});

test('TC-FR3-21: 채택 순서 — 조회 → ETag → git 병합 → editors → 창 적용(도구 모름) → 미루기', async () => {
  const { ctx, A, net, log } = saveRig();
  A.edOn = () => true;
  A.ws.git = { pinned: ['a'], drafts: { r: 'mine' }, favorites: { f: 1 } };
  const rem = { git: { pinned: ['b'], drafts: { r: 'theirs', s: 'x' }, extra: 1 }, editors: { list: ['E'] }, windows: [{ id: 'R' }] };
  net.get = async () => res(200, '7', rem);
  const now = ctx.Date.now();
  await A._saveAdoptRemote();
  assert.deepEqual(log, ['gitReposKick', '_edPatchList:["E"]', '_edReconcile:0', 'apply:[[],false]']);
  assert.equal(A.wsETag, '7');
  assert.equal(A.ws.git, rem.git, 'git 은 받은 객체 그대로다');
  assert.deepEqual(plain(A.ws.git), { pinned: ['b'], drafts: { r: 'mine', s: 'x' }, extra: 1, favorites: { f: 1 } });
  assert.equal(A.ws.editors, rem.editors);
  assert.equal(A._applied, rem);
  assert.equal(A._saveConflicts, 1);
  assert.equal(A._saveHoldUntil, now + 200);
});

test('TC-FR3-22: 핀이 같으면 목록을 받지 않고, 내 쪽에 drafts·favorites 가 없으면 받은 것을 그대로 둔다', async () => {
  const { A, net, log } = saveRig();
  A.ws.git = { pinned: ['a'] };
  const rem = { git: { pinned: ['a'], drafts: { r: 'theirs' } } };
  net.get = async () => res(200, '7', rem);
  await A._saveAdoptRemote();
  assert.deepEqual(log, []);
  assert.deepEqual(plain(A.ws.git), { pinned: ['a'], drafts: { r: 'theirs' } });
});

test('TC-FR3-23: 편집기가 꺼져 있으면 editors 를 받지 않고, git·windows 가 없으면 그 갈래를 건너뛴다', async () => {
  const { A, net, log } = saveRig();
  const before = A.ws.git;
  net.get = async () => res(200, null, { editors: { list: ['E'] } });
  await A._saveAdoptRemote();
  assert.deepEqual(log, []);
  assert.equal(A.ws.git, before);
  assert.equal(A.ws.editors, undefined);
  assert.equal(A.wsETag, null, 'ETag 는 응답의 것으로 갈린다 — 없으면 null');
});

test('TC-FR3-24: 조회가 실패하면 아무것도 채택하지 않고 미루기만 한다', async () => {
  const { ctx, A, net, log } = saveRig();
  net.get = async () => res(500, '7', { windows: [] });
  const now = ctx.Date.now();
  await A._saveAdoptRemote();
  assert.deepEqual(log, []);
  assert.equal(A.wsETag, '5');
  assert.equal(A._saveHoldUntil, now + 200);
});

test('TC-FR3-25: 조회가 던지면 오류 기록에 남기고 미루기는 한다', async () => {
  const { ctx, A, net, errs } = saveRig();
  net.get = async () => { throw new Error('boom') };
  const now = ctx.Date.now();
  await A._saveAdoptRemote();
  assert.deepEqual(errs, [['workspace', 'boom']]);
  assert.equal(A._saveHoldUntil, now + 200);
});

test('TC-FR3-26: 연속 충돌 수는 비행을 넘어 늘고, 미루기는 그에 비례하되 상한이 있으며, 넷째부터 경고한다', async () => {
  const { ctx, A, net, warns } = saveRig();
  net.get = async () => res(500);
  const holds = [];
  for (let i = 0; i < 12; i++) { await A._saveAdoptRemote(); holds.push(A._saveHoldUntil - ctx.Date.now()) }
  assert.deepEqual(holds, [200, 400, 600, 800, 1000, 1200, 1400, 1600, 1800, 2000, 2000, 2000]);
  assert.equal(A._saveConflicts, 12);
  assert.equal(warns.length, 9);
  assert.match(warns[0], /4번 이어졌다/);
  await drain();
});

test('TC-FR3-27(FC-09): wsSaveBody — 창별 키·dirty 를 벗기고 현재 스키마 판을 싣는다. 원본은 고치지 않는다', () => {
  const { ctx } = saveRig();
  const ws = { schemaVersion: 1, activeWindow: 'W', windows: [{ id: 'W', focusedPane: 'p', layout: { tabs: [{ id: 't', dirty: true }] } }] };
  assert.equal(ctx.wsSaveBody(ws), '{"schemaVersion":2,"windows":[{"id":"W","layout":{"tabs":[{"id":"t"}]}}]}');
  assert.equal(ws.schemaVersion, 1);
  assert.equal(ws.activeWindow, 'W');
});

test('TC-FR3-27(FC-09): wsSaveSame — 기억이 없거나 본문·ETag 가 하나라도 다르면 거짓', () => {
  const { ctx } = saveRig();
  assert.equal(ctx.wsSaveSame(undefined, 'b', '1'), false);
  assert.equal(ctx.wsSaveSame(null, 'b', '1'), false);
  assert.equal(ctx.wsSaveSame({ body: 'b', etag: '1' }, 'b', '1'), true);
  assert.equal(ctx.wsSaveSame({ body: 'b', etag: '1' }, 'c', '1'), false);
  assert.equal(ctx.wsSaveSame({ body: 'b', etag: '1' }, 'b', '2'), false);
  assert.equal(ctx.wsSaveSame({ body: 'b', etag: null }, 'b', null), true);
});

test('TC-FR3-27(FC-09): wsGitAdopt — 받은 객체에 내 drafts·favorites 를 얹는다(내 키가 이긴다)', () => {
  const { ctx } = saveRig();
  const rem = { pinned: ['x'], drafts: { a: 'r', b: 'r' } };
  const out = ctx.wsGitAdopt({ pinned: ['y'], drafts: { a: 'm' }, favorites: { f: 1 }, other: 1 }, rem);
  assert.equal(out, rem);
  assert.deepEqual(plain(out), { pinned: ['x'], drafts: { a: 'm', b: 'r' }, favorites: { f: 1 } });
  const bare = { pinned: [] };
  assert.deepEqual(plain(ctx.wsGitAdopt({}, bare)), { pinned: [] });
});

test('TC-FR3-27(FC-09): wsSaveHoldMs — 200·n, 상한 2000', () => {
  const { ctx } = saveRig();
  assert.deepEqual([1, 2, 9, 10, 11, 100].map((n) => ctx.wsSaveHoldMs(n)), [200, 400, 1800, 2000, 2000, 2000]);
});
