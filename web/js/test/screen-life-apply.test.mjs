import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BASE, load } from './harness.mjs';

/**
 * PERF 3.5.2 — 생명주기 적용: git·Run·채팅 (FR-SPA-3, M3_DESIGN §3.5).
 *   git: 패널의 폴링 판정이 "본문으로 깨 있는가 · 사이드가 Changes 인가" 를 본다. 깨고 잠들 때 다시 판정한다.
 *   Run·채팅: 뷰가 주인이다. 잠든 뷰는 토픽 구독·다시 받기·다시 그리기를 하지 않고, 깰 때 밀린 것을 한 번 한다.
 */

// ── git ──────────────────────────────────────────────────────────────────

function gitPoll({ side = 'explorer', root = '/r' } = {}) {
  const ctx = load(['core/constants-git-detect.js', ...BASE, 'git/git-part.js', 'git/git-poll.js', 'git/panel.js'], {
    expose: ['GitPoll', 'GitPanel'],
    globals: { t: () => '', MS_PER_SEC: 1000, TIMERS: { every: () => ({ stop() {} }) }, REPO_SIDE_CHANGES: 'changes' },
  });
  const w = { id: 'w1' };
  const p = {
    root, repo: '/r', _gitMissing: false, _bodyAwake: false,
    app: {
      editor: { edWindowFor: () => w, pane: { edSideOf: () => side } },
      git: { gitWindow: () => w, surfaces: { gitSideOn: (x) => x === w && side === 'changes' } },
      slot: { windowVisible: () => true },
    },
  };
  p.poll = new ctx.GitPoll(p);
  return { ctx, p };
}

test('git: 본문으로 깨 있지 않고 사이드도 Changes 가 아니면 묻지 않는다', () => {
  const { p } = gitPoll();
  assert.equal(p.poll._pollOk(), false);
  p._bodyAwake = true;
  assert.equal(p.poll._pollOk(), true);
});

test('git: 사이드가 Changes 이면 본문이 잠들어도 묻는다', () => {
  const { p } = gitPoll({ side: 'changes' });
  assert.equal(p.poll._pollOk(), true);
});

test('git: 옛 Git 창(루트 없음)의 패널은 본문으로 깨 있을 때만 묻는다', () => {
  const { p } = gitPoll({ side: 'changes', root: '' });
  assert.equal(p.poll._pollOk(), false);
  p._bodyAwake = true;
  assert.equal(p.poll._pollOk(), true);
});

test('git: GitPanel 의 wake·sleep 이 폴링을 다시 판정하고 콘솔 구독을 걸고 놓는다', () => {
  const { ctx } = gitPoll();
  const log = [];
  const p = {
    _bodyAwake: false,
    poll: { _reschedule: () => log.push('resched:' + p._bodyAwake) },
    _consoleView: { paint: () => log.push('console:paint'), _stop: () => log.push('console:stop') },
  };
  ctx.GitPanel.prototype.wake.call(p);
  ctx.GitPanel.prototype.sleep.call(p);
  assert.deepEqual(log, ['resched:true', 'console:paint', 'resched:false', 'console:stop']);
});

// ── Run ──────────────────────────────────────────────────────────────────

function runs(live) {
  const ctx = load(['ui/runs-panel.js', 'ui/run-view-life.js'], {
    globals: { t: (k) => k, panesOf: () => [], TIMERS: { cancel() {} } },
    expose: ['RunsPanel'],
  });
  const unmounted = [];
  const app = { ws: { windows: [] }, slot: { slotBase: (k) => k }, renderer: { life: { unmount: (o) => unmounted.push(o.key) } } };
  const p = new ctx.RunsPanel(app);
  const fetched = [];
  p._runFetch = (v) => fetched.push(v.key);
  p._runLiveTabIds = () => new Set(live);
  return { p, fetched, unmounted };
}

function runView(key) {
  let stopped = 0;
  const v = { key, runId: 'run-' + key, subRun: 'run-' + key, sub: { stop: () => { stopped++ } }, data: {} };
  return { v, stopped: () => stopped };
}

test('Run: 잠든 뷰는 토픽 구독을 놓고, 다시 받기를 건너뛰었다가 깰 때 한 번 받는다', () => {
  const { p, fetched } = runs(['a', 'b']);
  const a = runView('a'), b = runView('b');
  p._runViewMap().set('a', a.v); p._runViewMap().set('b', b.v);
  a.v.decay = { id: 'decay' };
  p._runSleep(a.v);
  assert.equal(a.stopped(), 1);
  assert.equal(a.v.decay, null, '다시 그리기 예약을 걷는다');
  assert.equal(a.v.sub, null);
  assert.equal(a.v.subRun, null, '깰 때 다시 구독하도록 표시를 지운다');
  p._runViewsRefresh();
  assert.deepEqual(fetched, ['b'], '잠든 뷰는 받지 않는다');
  p._runWake(a.v);
  assert.deepEqual(fetched, ['b', 'a'], '밀린 것을 깰 때 한 번 받는다');
  p._runWake(a.v);
  assert.deepEqual(fetched, ['b', 'a'], '밀린 것이 없으면 받지 않는다');
});

test('Run: 탭이 사라진 뷰는 생명주기에서도 놓는다', () => {
  const { p, unmounted } = runs([]);
  const a = runView('a');
  p._runViewMap().set('a', a.v);
  p._runViewsRefresh();
  assert.deepEqual(unmounted, ['a']);
});

test('Run: runViewOwner 는 그 탭·칸의 뷰다', () => {
  const { p } = runs(['a']);
  p.app.slot.slotKey = (id, slot) => (slot ? id + '@' + slot : id);
  const a = runView('a');
  p._runViewMap().set('a', a.v);
  assert.equal(p.runViewOwner({ id: 'a' }, 0), a.v);
});

// ── 채팅 ─────────────────────────────────────────────────────────────────

function chat(live) {
  const ctx = load([...BASE, 'core/chat-views.js'], {
    globals: { t: (k) => k, panesOf: () => [] },
    expose: ['ChatViews'],
  });
  const unmounted = [];
  const app = { renderer: { life: { unmount: (o) => unmounted.push(o.key) } }, slot: { slotKey: (id) => id } };
  const views = new ctx.ChatViews(app);
  const painted = [];
  views._chatViewPaint = (v) => painted.push(v.key);
  views._chatLiveTabIds = () => new Set(live);
  return { views, painted, unmounted };
}

test('채팅: 잠든 뷰는 다시 그리지 않고, 깰 때 밀린 것을 한 번 그린다', () => {
  const { views, painted } = chat(['a', 'b']);
  const a = { key: 'a', tabId: 'a', roomId: 'r' }, b = { key: 'b', tabId: 'b', roomId: 'r' };
  views._chatViewMap().set('a', a); views._chatViewMap().set('b', b);
  views._chatViewSleep(a);
  views._chatViewsPaint();
  assert.deepEqual(painted, ['b']);
  views._chatViewWake(a);
  assert.deepEqual(painted, ['b', 'a']);
  views._chatViewWake(a);
  assert.deepEqual(painted, ['b', 'a']);
});

test('채팅: 탭이 사라진 뷰는 생명주기에서도 놓는다 · chatViewOwner', () => {
  const { views, unmounted } = chat([]);
  const a = { key: 'a', tabId: 'a', roomId: 'r' };
  views._chatViewMap().set('a', a);
  assert.equal(views.chatViewOwner({ id: 'a' }, 0), a);
  views._chatViewsPaint();
  assert.deepEqual(unmounted, ['a']);
});
