import assert from 'node:assert/strict';
import { test } from 'node:test';

import { load } from './harness.mjs';

/**
 * REPO_FIX 02 §3A-2 — 서버가 넘친 구독을 **닫는다**. 그때 잃은 이벤트는 재연결의
 * 재수집이 되돌린다: 등록부의 `revalidateOn:['sse:open']` 가 그 약속이다. 새 코드
 * 없이 이 선언을 고정한다 — 누가 빼면 넘침 뒤 화면이 안전망까지 낡는다.
 */
test('재연결(sse:open)이 git·설정·포커스·도구 상태를 다시 받는다', () => {
  const ctx = load(['core/state-registry.js'], { expose: ['STATE_REGISTRY'] });
  const byId = new Map(ctx.STATE_REGISTRY.map((e) => [e.id, e]));
  for (const id of ['git.observe', 'settings', 'window.focus', 'tool.attention', 'tool.activity', 'tool.background']) {
    const e = byId.get(id);
    assert.ok(e, `${id} 선언이 없다`);
    assert.ok(e.revalidateOn.includes('sse:open'), `${id} 가 재연결에 다시 받지 않는다`);
  }
});

/**
 * OPTIMIZE_REFACTOR_SRS FR-OPT-4-6 (FEC-9) — activity 주기는 읽는 곳이 있을 때만 돈다.
 * 패널이 닫히고 알림이 없으면 `when` 이 거짓이다.
 */
test('tool.activity 주기는 패널이 열렸거나 알림이 있을 때만 돈다', () => {
  const ctx = load(['core/state-registry.js'], { expose: ['wireStateRegistry'] });
  const jobs = [];
  let open = false;
  const app = {
    bus: { subscribe() {} },
    timers: { every: (spec) => jobs.push(spec) },
    agentsPollMs: 5000,
    _attn: new Map(),
    _agentsPanelOpen: () => open,
  };
  ctx.wireStateRegistry(app);
  const job = jobs.find((j) => j.id === 'tool.activity');
  assert.ok(job, 'activity 주기가 없다');
  assert.equal(typeof job.when, 'function', 'when 이 없다 — 늘 돈다');
  assert.equal(job.when(), false);
  open = true;
  assert.equal(job.when(), true);
  open = false;
  app._attn.set('t1', { reason: 'signaled' });
  assert.equal(job.when(), true);
});

/**
 * FR-OPT-4-5 (IPC-6 · FEC-10 · FEC-11) — 구독이 열리면 복원 조각을 **요청 하나**로 받는다.
 * 첫 연결은 부팅이 방금 받은 설정을 건너뛰고, 재연결은 다시 받는다. 복원은 제 조각을
 * 종단을 직접 부른 것과 같은 봉투로 받는다.
 */
function snapshotRig() {
  const gets = [];
  const subs = new Map();
  const got = {};
  const ctx = load(['core/state-registry.js'], {
    expose: ['wireStateRegistry'],
    globals: {
      apiGet: (path, o) => {
        gets.push(path + (o && o.query ? '?parts=' + o.query.parts : ''));
        const parts = (o && o.query && o.query.parts || '').split(',');
        const data = {};
        for (const p of parts) if (p !== 'update') data[p] = { part: p };
        return Promise.resolve({ ok: true, status: 200, data, text: JSON.stringify(data), headers: null });
      },
    },
  });
  const app = {
    bus: { subscribe: (t, fn) => { if (!subs.has(t)) subs.set(t, []); subs.get(t).push(fn) } },
    timers: { every() {} },
  };
  for (const name of ['_attnRestore', '_activityRestore', '_bgRefresh', '_settingsRestore',
    '_updateRestore', '_focusRestore', '_gitObserveRestore', '_pollGitJobs']) {
    app[name] = (src) => { got[name] = src };
  }
  ctx.wireStateRegistry(app);
  const fire = (t, a) => { for (const fn of subs.get(t) || []) fn(a) };
  return { gets, got, fire };
}

test('첫 연결: 스냅샷 한 요청, 설정은 건너뛴다, /api/state 는 없다', async () => {
  const { gets, got, fire } = snapshotRig();
  fire('sse:open', { gen: 1 });
  assert.equal(gets.length, 1, JSON.stringify(gets));
  assert.equal(gets[0], '/api/snapshot?parts=attention,activity,background,update,focus');
  assert.equal(got._settingsRestore, undefined, '첫 연결에 설정을 다시 받았다');
  const att = await got._attnRestore;
  assert.equal(att.ok, true);
  assert.equal(att.data.part, 'attention');
  assert.equal(att.text, JSON.stringify({ part: 'attention' }));
  // 조각이 없으면(503 인 update) 실패 봉투다 — 종단이 실패한 것과 같다.
  const up = await got._updateRestore;
  assert.equal(up.ok, false);
  assert.ok('_gitObserveRestore' in got, 'git 관측 재검증이 빠졌다');
});

test('재연결·소프트 리로드: 설정도 같은 스냅샷에 든다', async () => {
  for (const [topic, a] of [['sse:open', { gen: 2 }], ['softreload', {}]]) {
    const { gets, got, fire } = snapshotRig();
    fire(topic, a);
    assert.equal(gets.length, 1, topic + ' ' + JSON.stringify(gets));
    assert.ok(gets[0].includes('settings'), topic + ' ' + gets[0]);
    const st = await got._settingsRestore;
    assert.equal(st.data.part, 'settings');
  }
});
