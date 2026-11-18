import assert from 'node:assert/strict';
import { test } from 'node:test';
import { load } from './harness.mjs';

/**
 * RUN_RECOVERY_SRS 묶음 W (TC-RRC-11) — Run 복구 버튼.
 */
const plain = (x) => JSON.parse(JSON.stringify(x));

function setup(replies) {
  const posts = [];
  const toasts = [];
  const ctx = load(['ui/runs-panel.js', 'ui/run-tree.js', 'ui/run-recover.js'], {
    globals: {
      t: (k, o) => (o ? k + JSON.stringify(o) : k),
      panesOf: () => [],
      RUNS_RECOVER_API: '/api/runs/recover',
      TOAST_MS: 3000, TOAST_ERR_MS: 8000, TIP_RUNS_RECOVER_FORCE: '', TIP_RUNS_RECOVER_ONE: '', TIP_RUNS_RECOVER_ALL: '',
      apiPost: async (url, body) => {
        posts.push({ url, body: plain(body) });
        const r = replies.shift();
        return { ok: r.ok !== false, status: r.status || 200, data: r.json, text: "" };
      },
      apiErrText: (_r, what) => what,
      paintIfChanged: (el, sig, draw) => { if (el.dataset.sig === String(sig)) return false; draw(); el.dataset.sig = String(sig); return true },
      UIKit: { button: (o) => Object.assign({ disabled: false }, o) },
      Toast: { show: (text, kind, ms, opts) => { const h = { closed: 0, close() { h.closed++ } }; toasts.push({ text, kind, ms, opts, h }); return h } },
    },
    expose: ['RunsPanel', 'runRecoverBody', 'runRecoverAny', 'runRecoverSummary', 'runCoordItem'],
  });
  return { ctx, posts, toasts };
}

test('FR-RRC-20: 요청 본문 — Run 단위·멤버 하나·조정자 하나, 강제는 하나일 때만', () => {
  const { ctx } = setup([]);
  assert.deepEqual(plain(ctx.runRecoverBody('R', null, true)), { runId: 'R' });
  assert.deepEqual(plain(ctx.runRecoverBody('R', { id: 'M' }, false)), { runId: 'R', memberId: 'M' });
  assert.deepEqual(plain(ctx.runRecoverBody('R', { id: 'M' }, true)), { runId: 'R', memberId: 'M', force: true });
  assert.deepEqual(plain(ctx.runRecoverBody('R', { coord: true, id: 'coordinator' }, true)), { runId: 'R', coordinator: true, force: true });
});

test('FR-RRC-30: Run 단위 버튼은 복구할 것이 하나라도 있을 때만', () => {
  const { ctx } = setup([]);
  assert.equal(ctx.runRecoverAny({ members: [{ recoverable: false }] }), false);
  assert.equal(ctx.runRecoverAny({ members: [{}, { recoverable: true }] }), true);
  assert.equal(ctx.runRecoverAny({ coordinatorRecoverable: true }), true);
  assert.equal(ctx.runRecoverAny(null), false);
});

test('FR-RRC-41: 조정자 항목은 복구 근거와 Run id 를 싣는다', () => {
  const { ctx } = setup([]);
  const c = plain(ctx.runCoordItem({ runId: 'R', coordinatorToolId: 'T', coordinatorRecoverable: true }));
  assert.equal(c.runId, 'R');
  assert.equal(c.recoverable, true);
});

// 대시보드는 /api/runs/{id}/graph 로 그린다 — Run id 는 `runId` 에 실려 온다.
test('FR-RRC-30: Run 단위 버튼은 /graph 응답으로 그려지고 그 Run 을 복구한다', async () => {
  const { ctx, posts } = setup([{ json: { results: [{ outcome: 'resumed' }] } }]);
  const self = Object.create(ctx.RunsPanel.prototype);
  self._runRefreshViewsOf = () => {};
  const bar = { dataset: {}, textContent: '', kids: [], appendChild(x) { this.kids.push(x) } };
  const root = { querySelector: (q) => (q === '.run-summary' ? {} : q === '.run-recover-bar' ? bar : null) };
  self._runPaintRecover(root, { runId: 'R', state: 'open', members: [{ id: 'M', recoverable: true }] });
  assert.equal(bar.kids.length, 1);
  await bar.kids[0].onClick();
  assert.deepEqual(posts[0].body, { runId: 'R' });
});

test('FR-RRC-33: 결과 요약', () => {
  const { ctx } = setup([]);
  const s = plain(ctx.runRecoverSummary([
    { outcome: 'resumed' }, { outcome: 'skipped', reason: 'busy' }, { outcome: 'skipped', reason: 'busy' },
    { outcome: 'skipped', reason: 'unknown', needsForce: true },
  ]));
  assert.deepEqual(s, { resumed: 1, skipped: 3, failed: 0, needsForce: true, reasons: ['busy', 'unknown'] });
  // 리뷰 지적 7: 넣기 실패는 건너뜀과 따로 세고 사유를 남긴다.
  const f = plain(ctx.runRecoverSummary([{ outcome: 'failed', reason: 'paste: boom' }, { outcome: 'skipped', reason: 'busy' }]));
  assert.deepEqual(f, { resumed: 0, skipped: 1, failed: 1, needsForce: false, reasons: ['busy', 'failed'] });
});

test('FR-RRC-32: 판정 불가면 확인(토스트의 계속 버튼)을 받고 강제로 다시 부른다', async () => {
  const { ctx, posts, toasts } = setup([
    { json: { results: [{ outcome: 'skipped', reason: 'unknown', needsForce: true }] } },
    { json: { results: [{ outcome: 'resumed' }] } },
  ]);
  const self = Object.create(ctx.RunsPanel.prototype);
  self._runRefreshViewsOf = () => {};
  await self._runRecover('R', { id: 'M' }, false);
  assert.equal(posts.length, 1);
  assert.equal(toasts.length, 1);
  const actions = toasts[0].opts && toasts[0].opts.actions;
  assert.ok(actions && actions.length === 1, JSON.stringify(toasts[0]));
  // 확인 토스트는 스스로 사라지고(출구), 「계속」을 누르면 닫힌다.
  assert.ok(toasts[0].ms > 0, 'ms=' + toasts[0].ms);
  await actions[0].onClick();
  assert.equal(toasts[0].h.closed, 1);
  assert.equal(posts.length, 2);
  assert.deepEqual(posts[1].body, { runId: 'R', memberId: 'M', force: true });
});

test('FR-RRC-33·34: 결과를 알리고, 누른 동안 버튼을 막았다가 푼다', async () => {
  const { ctx, toasts } = setup([{ json: { results: [{ outcome: 'resumed' }, { outcome: 'skipped', reason: 'busy' }] } }]);
  const self = Object.create(ctx.RunsPanel.prototype);
  self._runRefreshViewsOf = () => {};
  const btn = { disabled: false };
  const p = self._runRecover('R', null, false, btn);
  assert.equal(btn.disabled, true);
  await p;
  assert.equal(btn.disabled, false);
  assert.equal(toasts.length, 1);
  assert.equal(toasts[0].kind, 'ok');
  assert.ok(toasts[0].text.includes('runs.recover_done'), toasts[0].text);
});

test('실패 응답은 오류 토스트다', async () => {
  const { ctx, toasts } = setup([{ ok: false, status: 409, json: null }]);
  const self = Object.create(ctx.RunsPanel.prototype);
  self._runRefreshViewsOf = () => {};
  await self._runRecover('R', null, false);
  assert.equal(toasts[0].kind, 'err');
});

test('리뷰 지적 3: 같은 대상의 복구는 응답이 오기 전까지 한 번만 나간다(단추·계속 모두)', async () => {
  const { ctx, posts } = setup([{ json: { results: [{ outcome: 'resumed' }] } }, { json: { results: [{ outcome: 'resumed' }] } }]);
  const self = Object.create(ctx.RunsPanel.prototype);
  self._runRefreshViewsOf = () => {};
  const a = self._runRecover('R', { id: 'M' }, false);
  const b = self._runRecover('R', { id: 'M' }, true);
  await Promise.all([a, b]);
  assert.equal(posts.length, 1);
  // 끝난 뒤에는 다시 부를 수 있다.
  await self._runRecover('R', { id: 'M' }, false);
  assert.equal(posts.length, 2);
});
