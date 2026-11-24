import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { load } from './harness.mjs';

/**
 * PERF_OPTIMIZATION_SRS M1 C2b — full·사건 토픽 (`perf/CHANNEL_PROTOCOL.md` §10.3, TC-CH2B-5·7).
 */
const JS = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = (f) => readFileSync(join(JS, f), 'utf8');

function rig() {
  const ctx = load(['core/state-registry.js'], { expose: ['wireStateTopics', 'STATE_REGISTRY'] });
  const subs = new Map();
  const busSubs = new Map();
  const calls = [];
  const app = {
    bus: { subscribe: (t, fn) => { if (!busSubs.has(t)) busSubs.set(t, []); busSubs.get(t).push(fn) } },
    channel: { sub: (t, fn) => { subs.set(t, fn); return { stop() {} } } },
  };
  const own = (path) => {
    const keys = path.split('.');
    const name = keys.pop();
    const owner = keys.reduce((o, k) => (o[k] = o[k] || {}), app);
    owner[name] = (a) => { calls.push([path, a]) };
  };
  for (const p of ['settings.apply._settingsRestore', 'focus.owner._focusRestore', 'focus.owner._onWindowFocusSrc',
    'claude._claudeAcctRestore', 'claude._onClaudeAccountsChanged', 'claude._onClaudeAccountAlert',
    'editor.watch._onFsChanged', 'edges._onEdgesNotice', 'edges._edgesRestore', 'wsSync._onWorkspaceTopic',
    'update._updateRestore', 'chat._chatRestore']) own(p);
  ctx.wireStateTopics(app);
  const push = (t, m) => subs.get(t)(m);
  const fire = (t) => { for (const fn of busSubs.get(t) || []) fn({}) };
  return { ctx, subs, calls, push, fire };
}

test('TC-CH2B-5: 토픽 항목은 채널에 구독한다', () => {
  const { subs } = rig();
  for (const t of ['workspace', 'settings', 'edges', 'edges.notice', 'chat', 'update', 'claude.accounts', 'focus',
    'telegram', 'alert', 'fs']) {
    assert.ok(subs.has(t), t + ' 구독이 없다');
  }
});

test('TC-CH2B-5: 연결마다 첫 full 은 restore, 그 뒤는 change 가 봉투로 받는다', async () => {
  const { calls, push, fire } = rig();
  push('focus', { kind: 'full', data: { owners: { W1: 'a' } }, seq: 1 });
  push('focus', { kind: 'full', data: { owners: {} }, seq: 2 });
  fire('chan:open');
  push('focus', { kind: 'full', data: { owners: { W2: 'b' } }, seq: 3 });
  assert.deepEqual(calls.map((c) => c[0]), ['focus.owner._focusRestore', 'focus.owner._onWindowFocusSrc', 'focus.owner._focusRestore']);
  const env = await calls[1][1];
  assert.equal(env.ok, true);
  assert.equal(env.status, 200);
  assert.equal(JSON.stringify(env.data), JSON.stringify({ owners: {} }));
  assert.equal(env.text, JSON.stringify({ owners: {} }));
});

test('TC-CH2B-5: change 가 없으면 늘 restore 다', () => {
  const { calls, push } = rig();
  push('settings', { kind: 'full', data: { a: 1 }, seq: 1 });
  push('settings', { kind: 'full', data: { a: 2 }, seq: 2 });
  assert.deepEqual(calls.map((c) => c[0]), ['settings.apply._settingsRestore', 'settings.apply._settingsRestore']);
});

test('TC-CH2B-5: 200 이 아닌 결과는 실패 봉투다', async () => {
  const { calls, push } = rig();
  push('update', { kind: 'full', data: { $http: 503, body: { code: 'x' } }, seq: 1 });
  const env = await calls[0][1];
  assert.equal(env.ok, false);
  assert.equal(env.status, 503);
  assert.equal(env.data.code, 'x');
});

test('TC-CH2B-5: 사건은 event 처리기가 본문을 받는다', () => {
  const { calls, push } = rig();
  push('alert', { kind: 'event', data: { kind: 'autoswitch' }, seq: 1 });
  push('fs', { kind: 'event', data: { overflow: true }, seq: 1 });
  push('edges.notice', { kind: 'event', data: { byPeer: true }, seq: 1 });
  assert.deepEqual(calls.map((c) => c[0]), ['claude._onClaudeAccountAlert', 'editor.watch._onFsChanged', 'edges._onEdgesNotice']);
  assert.equal(calls[0][1].kind, 'autoswitch');
});

test('TC-CH2B-7: 옮긴 상태는 chan:open GET 재검증·주기·SSE 방송 구독이 없다', () => {
  const { ctx } = rig();
  const byId = new Map(ctx.STATE_REGISTRY.map((e) => [e.id, e]));
  for (const id of ['settings', 'update', 'window.focus', 'edges', 'chat', 'claude.accounts']) {
    const e = byId.get(id);
    assert.ok(!(e.revalidateOn || []).includes('chan:open'), id + ' 가 재연결에 GET 한다');
    assert.equal(e.every, undefined, id + ' 에 주기가 있다');
  }
  const events = ctx.STATE_REGISTRY.flatMap((e) => Object.keys(e.events || {}));
  for (const a of ['settings_changed', 'update_changed', 'window_focus', 'edges_changed', 'chat_changed',
    'claude_accounts_changed', 'fs_changed']) {
    assert.ok(!events.includes(a), a + ' 방송을 아직 듣는다');
  }
  const ws = src('core/ws-sync-controller.js');
  assert.doesNotMatch(ws, /subscribe\('(workspace_changed|claude_account_alert)'/);
  assert.doesNotMatch(src('core/settings-telegram.js'), /run:\(\)=>this\._tgRead\(\)/, '짝맞춤 읽기 폴링이 남았다');
});

test('TC-CH2B-1·5: $etag 는 본문에서 빠지고 응답 머리 ETag 로 온다', async () => {
  const { calls, push } = rig();
  push('settings', { kind: 'full', data: { a: 1, $etag: '7' }, seq: 1 });
  const env = await calls[0][1];
  assert.equal(env.headers.get('ETag'), '7');
  assert.equal(env.headers.get('etag'), '7');
  assert.equal(env.headers.get('X'), null);
  assert.equal(JSON.stringify(env.data), JSON.stringify({ a: 1 }));
  assert.equal(env.text, JSON.stringify({ a: 1 }));
});
