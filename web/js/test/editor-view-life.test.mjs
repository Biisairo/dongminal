import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BASE, fakeClock, load } from './harness.mjs';

/**
 * PERF 3.5.3 — 생명주기 적용: 편집기·문서 렌더 (FR-SPA-3, M3_DESIGN §3.5, D-36).
 *   칸(FileEditor·DocRender): 잠들면 찾기 계산·알림 타이머·버퍼 구독을 놓고, 진단·변경 표시를 그리지 않는다.
 *     깨면 남은 찾기를 이어 끝내고, 밀린 진단·변경 표시·렌더를 한 번 그린다. 내용·커서·실행 취소는 칸의 상태라 그대로다.
 *   문서: 모든 뷰가 잠든 문서는 바깥 변경 관측(감시·stamp·fs_changed 재읽기·git 신호의 기준 다시 받기)에서 빠진다.
 *     첫 뷰가 깨면 감시를 다시 맞추고 stamp 를 한 번 묻는다.
 */

const FIND = { ED_FIND_CHUNK_LINES: 100, ED_FIND_SLICE_MS: 8, ED_FIND_DEBOUNCE_MS: 120 };

function editorCtx(extra = {}) {
  const clock = fakeClock();
  const calls = { watch: 0, poll: 0, unmount: [] };
  const app = {
    editor: {
      open: {
        edDocAsleep: (d) => !!d && d.views.size > 0 && [...d.views].every((v) => v.asleep === true),
        edPollDocStamps: () => { calls.poll++ },
      },
      watch: { edWatchSync: () => { calls.watch++ } },
    },
    renderer: { life: { unmount: (o) => calls.unmount.push(o) } },
  };
  const ctx = load(['core/timer-hub.js', 'ui/cm-lsp.js', 'ui/file-editor-find.js', 'ui/doc-render-util.js', 'ui/doc-render.js',
    'ui/editor-view-life.js', 'ui/file-editor.js', 'ui/file-editor-life.js'], {
    clock,
    expose: ['FileEditor', 'DocRender', 'TIMERS'],
    globals: {
      ...FIND, app, lspDiagOn: true, performance: { now: () => clock.now() }, DOC_RENDER_DEBOUNCE_MS: 150,
      CM: { setDiagnostics: (state, list) => ({ diag: list }) },
      ...extra,
    },
  });
  return { ctx, clock, app, calls };
}

const mine = (ctx, o) => ctx.TIMERS.pending().filter((r) => r.owner === o).length;

function editor(ctx) {
  const fe = Object.create(ctx.FileEditor.prototype);
  fe.el = { classList: new Set(['fe-save-failed']) };
  fe.el.classList.remove = fe.el.classList.delete;
  const noteEl = { classList: new Set(['vis']) };
  noteEl.classList.remove = noteEl.classList.delete;
  fe.notice = { noteEl };
  fe._view = { state: {}, sent: [], dispatch(x) { this.sent.push(x) } };
  fe._buf = null;
  fe._doc = null;
  return fe;
}

function scanOf(steps, hits) {
  return { done: false, n: 0, hits, step() { if (++this.n >= steps) this.done = true } };
}

// ── 찾기 ─────────────────────────────────────────────────────────────────

test('잠든 편집기는 찾기 계산 타이머가 0 이고, 세던 것은 남는다. 깨면 남은 계산을 이어 끝낸다', async () => {
  const { ctx, clock } = editorCtx();
  const fe = editor(ctx);
  const shown = [];
  fe._findEngine = () => ({});
  fe._findShow = (hits) => shown.push(hits);
  const scan = scanOf(3, ['h1', 'h2']);
  fe._findScan = scan;
  fe._findT = ctx.TIMERS.after(FIND.ED_FIND_DEBOUNCE_MS, () => fe._findSlice(), { owner: fe, label: 'find' });
  fe.wake();
  fe.sleep();
  assert.equal(mine(ctx, fe), 0, '잠든 편집기에 찾기 타이머가 남았다');
  assert.equal(fe._findScan, scan, '세던 것을 버렸다');
  await clock.advance(1000);
  assert.equal(scan.n, 0, '잠든 동안 셌다');
  fe.wake();
  await clock.advance(10);
  assert.deepEqual(shown, [['h1', 'h2']]);
  assert.equal(fe._findScan, null);
  assert.equal(mine(ctx, fe), 0);
});

test('잠든 동안 문서가 바뀌면 찾기를 다시 시작하지 않고, 깰 때 한 번 다시 센다', () => {
  const { ctx } = editorCtx();
  const fe = editor(ctx);
  let runs = 0;
  fe._findVis = () => true;
  fe._findRun = () => { runs++ };
  fe._tabLabelAll = () => {};
  fe.wake();
  fe.sleep();
  fe._onUpdate({ docChanged: true, transactions: [] });
  fe._onUpdate({ docChanged: true, transactions: [] });
  assert.equal(runs, 0, '잠든 편집기가 찾기를 돌렸다');
  fe.wake();
  assert.equal(runs, 1);
  fe.sleep(); fe.wake();
  assert.equal(runs, 1, '밀린 것이 없는데 다시 셌다');
});

// ── 알림 타이머 ───────────────────────────────────────────────────────────

test('잠들면 알림 줄·저장 실패 깜빡임 타이머도 0 이고 그 표시는 바로 끝난다', () => {
  const { ctx } = editorCtx();
  const fe = editor(ctx);
  ctx.TIMERS.after(4000, () => {}, { owner: fe, label: 'note-hide' });
  ctx.TIMERS.after(800, () => {}, { owner: fe, label: 'flash' });
  fe.wake();
  fe.sleep();
  assert.equal(mine(ctx, fe), 0);
  assert.equal(fe.notice.noteEl.classList.has('vis'), false);
  assert.equal(fe.el.classList.has('fe-save-failed'), false);
});

// ── LSP 진단 ─────────────────────────────────────────────────────────────

test('LSP 진단은 잠든 칸에 그리지 않고, 깰 때 보관된 진단을 그 칸에 한 번 그린다', () => {
  const { ctx } = editorCtx();
  const fe = editor(ctx);
  const other = { state: {}, sent: [], dispatch(x) { this.sent.push(x) } };
  const buf = { diagnostics: [], sinks: [fe._view, other] };
  fe._buf = buf;
  fe.wake();
  fe.sleep();
  buf.diagnostics = ['d1'];
  ctx.edLspDiagShow(buf, true);
  assert.equal(fe._view.sent.length, 0, '잠든 칸에 진단을 그렸다');
  assert.deepEqual(other.sent.map((x) => x.diag), [['d1']]);
  fe.wake();
  assert.deepEqual(fe._view.sent.map((x) => x.diag), [['d1']]);
  ctx.edLspDiagShow(buf, true);
  assert.equal(fe._view.sent.length, 2, '깬 칸에 다시 그리지 않는다');
});

// ── 변경 표시 ─────────────────────────────────────────────────────────────

test('깰 때 변경 표시는 기준이 밀렸으면 다시 받고, 아니면 다시 계산만 한다', () => {
  const { ctx } = editorCtx();
  const fe = editor(ctx);
  const log = [];
  fe._dd = { stale: true, refresh() { log.push('refresh') }, recompute() { log.push('recompute') } };
  fe.wake();
  fe.sleep(); fe.wake();
  assert.deepEqual(log, ['refresh']);
  assert.equal(fe._dd.stale, false);
  fe.sleep(); fe.wake();
  assert.deepEqual(log, ['refresh', 'recompute']);
});

test('변경 표시는 잠든 칸에 칠하지 않는다', () => {
  const clock = fakeClock();
  const ctx = load(['core/timer-hub.js', 'ui/file-editor-diff.js'], { clock, expose: ['EdDirtyDiff'], globals: {} });
  ctx.edDdField = () => ({ set: { of: (m) => m } });
  ctx.edDdLineMarks = () => 'marks';
  const dd = new ctx.EdDirtyDiff({}, '/r/a.txt');
  const view = () => ({ sent: [], dispatch(x) { this.sent.push(x) }, state: { doc: {} } });
  const awake = { _view: view() }, asleep = { _view: view(), asleep: true };
  dd.views.add(awake); dd.views.add(asleep);
  dd._paint([]);
  assert.equal(awake._view.sent.length, 1);
  assert.equal(asleep._view.sent.length, 0);
});

// ── 문서 단위 전이 ────────────────────────────────────────────────────────

test('문서의 마지막 깬 뷰가 잠들면 감시를 다시 맞추고, 첫 뷰가 깨면 감시를 맞추고 stamp 를 한 번 묻는다', () => {
  const { ctx, calls } = editorCtx();
  const a = editor(ctx), b = editor(ctx);
  const d = { views: new Set([a, b]) };
  a._doc = d; b._doc = d;
  a.wake(); b.wake();
  assert.deepEqual([calls.watch, calls.poll], [0, 0], '처음 깸(mount 직후)은 아무것도 하지 않는다');
  a.sleep();
  assert.deepEqual([calls.watch, calls.poll], [0, 0], '깬 뷰가 남아 있으면 문서는 관측 중이다');
  b.sleep();
  assert.deepEqual([calls.watch, calls.poll], [1, 0]);
  a.wake();
  assert.deepEqual([calls.watch, calls.poll], [2, 1]);
  b.wake();
  assert.deepEqual([calls.watch, calls.poll], [2, 1], '이미 관측 중인 문서는 다시 묻지 않는다');
});

test('파괴되면 생명주기에서 빠진다 (편집기·렌더 뷰)', () => {
  const { ctx, calls } = editorCtx();
  const fe = editor(ctx);
  fe.peek = { drop() {} };
  fe.notice.release = () => {};
  fe._viewReadyResolve = () => {};
  fe._view = null;
  fe.destroy();
  const dr = Object.create(ctx.DocRender.prototype);
  dr._revokeBlob = () => {};
  dr.destroy();
  assert.deepEqual(calls.unmount, [fe, dr]);
});

// ── 문서 렌더 ─────────────────────────────────────────────────────────────

function render(ctx) {
  const v = Object.create(ctx.DocRender.prototype);
  v.el = { classList: { contains: () => true } };
  v._timer = null;
  v._sub = null;
  v.paints = 0;
  v._paint = () => { v.paints++ };
  const subs = new Set();
  const buf = { version: 0, onChange(fn) { subs.add(fn); return () => subs.delete(fn) }, bump() { this.version++; for (const f of subs) f() } };
  v._bindBuf(buf);
  return { v, buf, subs };
}

test('잠든 렌더 뷰는 버퍼 구독·타이머가 0 이고, 깰 때 바뀐 것이 있으면 한 번 그린다', async () => {
  const { ctx, clock } = editorCtx();
  const { v, buf, subs } = render(ctx);
  v.wake();
  v.sleep();
  assert.equal(subs.size, 0, '잠든 렌더 뷰가 버퍼를 구독한다');
  buf.bump(); buf.bump();
  v.onDocBuf(buf);
  await clock.advance(1000);
  assert.equal(mine(ctx, v), 0);
  assert.equal(v.paints, 0);
  v.restoreView();
  v.wake();
  assert.equal(v.paints, 1);
  assert.equal(subs.size, 1);
  v.sleep(); v.wake();
  assert.equal(v.paints, 1, '바뀐 것이 없는데 다시 그렸다');
});

test('그리기를 기다리던 렌더 뷰가 잠들면 타이머를 놓고, 깰 때 한 번만 그린다', async () => {
  const { ctx, clock } = editorCtx();
  const { v, buf } = render(ctx);
  v.wake();
  buf.bump();
  assert.equal(mine(ctx, v), 1);
  v.sleep();
  assert.equal(mine(ctx, v), 0);
  await clock.advance(1000);
  v.restoreView();
  v.wake();
  assert.equal(v.paints, 1);
});

// ── 문서 관측 (core) ──────────────────────────────────────────────────────

function openCtx() {
  const ctx = load([...BASE, 'core/editor-open.js', 'core/editor-pane.js', 'core/editor-watch.js'], {
    expose: ['EditorOpen', 'EditorPane', 'EditorWatch'],
    globals: {
      App: class {}, TAB_TYPE_EDITOR: 'editor', TAB_TYPE_GIT: 'git', EDITOR_DOC_RELOAD_QUEUE: 2,
      panesOf: (l) => [l], TIMERS: { frame() {}, after() { return { stop() {} } } },
    },
  });
  const a = new ctx.App();
  a._edDocs = new Map();
  const w = { id: 'w', layout: { tabs: [{ type: 'editor', filePath: '/r/a.txt' }, { type: 'editor', filePath: '/r/b.txt' }] } };
  a.ws = { windows: [w] };
  a.slot = { windowVisible: () => true };
  const refreshed = [];
  a.editor = { isEditorWin: () => true, doc: { edDocRefresh: async (p) => { refreshed.push(p) } } };
  a.editor.open = new ctx.EditorOpen(a);
  a.editor.pane = new ctx.EditorPane(a);
  a.editor.watch = new ctx.EditorWatch(a);
  return { a, refreshed };
}

const docWith = (...asleep) => ({ buf: {}, dirty: false, stamp: 's', views: new Set(asleep.map((x) => ({ asleep: x }))) });

test('edDocAsleep: 뷰가 있고 모두 잠들었을 때만 참이다', () => {
  const { a } = openCtx();
  const o = a.editor.open;
  assert.equal(o.edDocAsleep(undefined), false);
  assert.equal(o.edDocAsleep(docWith()), false);
  assert.equal(o.edDocAsleep(docWith(true, false)), false);
  assert.equal(o.edDocAsleep(docWith(true, true)), true);
  // git Diff 뷰처럼 생명주기가 없는 뷰는 깬 것으로 본다.
  assert.equal(o.edDocAsleep({ views: new Set([{ asleep: true }, {}]) }), false);
});

test('모든 뷰가 잠든 문서는 감시·stamp 대상에서 빠지고, 깬 뷰가 하나라도 있으면 남는다', () => {
  const { a } = openCtx();
  a._edDocs.set('/r/a.txt', docWith(true));
  a._edDocs.set('/r/b.txt', docWith(true, false));
  assert.deepEqual([...a.editor.open._edVisibleDocPaths()], ['/r/b.txt']);
});

test('모든 뷰가 잠든 문서는 fs_changed 로 다시 읽지 않는다', () => {
  const { a, refreshed } = openCtx();
  a._edDocs.set('/r/a.txt', docWith(true));
  a._edDocs.set('/r/b.txt', docWith(false));
  a.editor.watch._onFsChanged({ changes: [{ path: '/r/a.txt', type: 'updated' }, { path: '/r/b.txt', type: 'updated' }] });
  assert.deepEqual(refreshed, ['/r/b.txt']);
});

test('git 신호에 모든 뷰가 잠든 문서는 기준을 다시 받지 않고 밀린 표시만 남긴다', () => {
  const { a } = openCtx();
  a.editor.open.edActiveTree = () => null;
  const log = [];
  const dd = (name) => ({ stale: false, refresh() { log.push(name) } });
  a._edDocs.set('/r/a.txt', { ...docWith(true), dd: dd('a') });
  a._edDocs.set('/r/b.txt', { ...docWith(false), dd: dd('b') });
  a.editor.pane._edAfterGitSignal();
  assert.deepEqual(log, ['b']);
  assert.equal(a._edDocs.get('/r/a.txt').dd.stale, true);
});
