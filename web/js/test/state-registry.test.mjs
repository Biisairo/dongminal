import assert from 'node:assert/strict';
import { test } from 'node:test';

import { load, plain } from './harness.mjs';

/**
 * REPO_FIX 02 §3A-2 — 서버가 넘친 구독을 **닫는다**. 그때 잃은 이벤트는 재연결의
 * 재수집이 되돌린다: 등록부의 `revalidateOn:['chan:open']` 가 그 약속이다. 새 코드
 * 없이 이 선언을 고정한다 — 누가 빼면 넘침 뒤 화면이 안전망까지 낡는다.
 */
test('재연결(chan:open)이 설정·포커스·도구 상태를 다시 받는다 (git 은 채널 토픽, CHANNEL_PROTOCOL C4)', () => {
  const ctx = load(['core/state-registry.js'], { expose: ['STATE_REGISTRY'] });
  const byId = new Map(ctx.STATE_REGISTRY.map((e) => [e.id, e]));
  assert.ok(!byId.has('git.observe') && !byId.has('git.jobs'), 'git 상태가 아직 등록부에 있다');
  for (const id of ['settings', 'window.focus']) {
    const e = byId.get(id);
    assert.ok(e, `${id} 선언이 없다`);
    assert.ok(e.revalidateOn.includes('chan:open'), `${id} 가 재연결에 다시 받지 않는다`);
  }
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
  // 등록부는 주인까지의 점 경로로 부른다 (REFACTOR3_FE_DELEG_SRS FR-DLG-3).
  for (const path of ['attn._attnRestore', 'agents._activityRestore', 'tool.life._bgRefresh', 'settings.apply._settingsRestore',
    'update._updateRestore', 'focus.owner._focusRestore',
    'edges._edgesRestore', '_runsListRestore']) {
    const keys = path.split('.');
    const name = keys.pop();
    const owner = keys.reduce((o, k) => (o[k] = o[k] || {}), app);
    owner[name] = (src) => { got[name] = src };
  }
  ctx.wireStateRegistry(app);
  const fire = (t, a) => { for (const fn of subs.get(t) || []) fn(a) };
  return { gets, got, fire };
}

test('첫 연결: 스냅샷 한 요청, 설정은 건너뛴다, /api/state 는 없다', async () => {
  const { gets, got, fire } = snapshotRig();
  fire('chan:open', { gen: 1 });
  assert.equal(gets.length, 1, JSON.stringify(gets));
  assert.equal(gets[0], '/api/snapshot?parts=update,focus,edges');
  assert.equal(got._settingsRestore, undefined, '첫 연결에 설정을 다시 받았다');
  assert.equal(got._attnRestore, undefined, '채널 토픽인 알람을 재연결에 다시 받았다 (TC-CH3-9)');
  const fo = await got._focusRestore;
  assert.equal(fo.ok, true);
  assert.equal(fo.data.part, 'focus');
  assert.equal(fo.text, JSON.stringify({ part: 'focus' }));
  // 조각이 없으면(503 인 update) 실패 봉투다 — 종단이 실패한 것과 같다.
  const up = await got._updateRestore;
  assert.equal(up.ok, false);
});

test('재연결·소프트 리로드: 설정도 같은 스냅샷에 든다', async () => {
  for (const [topic, a] of [['chan:open', { gen: 2 }], ['softreload', {}]]) {
    const { gets, got, fire } = snapshotRig();
    fire(topic, a);
    assert.equal(gets.length, 1, topic + ' ' + JSON.stringify(gets));
    assert.ok(gets[0].includes('settings'), topic + ' ' + gets[0]);
    const st = await got._settingsRestore;
    assert.equal(st.data.part, 'settings');
  }
});

/**
 * ACTIVITY_RUNS_REFRESH_SRS TC-ARR-6 (FR-ARR-6) — 새로고침하면 패널이 열린 채로 복원되어
 * 「열 때 받기」를 거치지 않는다. 그래서 구독이 열릴 때 곧바로 받아야 첫 주기를 기다리지 않는다.
 */
test('run.list 는 소프트 리로드에 목록을 다시 받는다 (재연결은 채널 토픽이 맞춘다)', () => {
  for (const [topic, a] of [['softreload', {}]]) {
    const { got, fire } = snapshotRig();
    fire(topic, a);
    assert.ok('_runsListRestore' in got, `${topic} ${JSON.stringify(a)} 에 Runs 목록을 받지 않았다`);
  }
});

/**
 * PERF M1 C3 TC-CH3-9 — 주기 폴링이 없다. 재연결의 재조회는 채널 토픽의 재구독이 맡는다.
 */
test('TC-CH3-9: 활동·Runs·Run 화면·Background 에 주기가 없고 토픽 상태는 재연결에 다시 받지 않는다', () => {
  const ctx = load(['core/state-registry.js'], { expose: ['STATE_REGISTRY', 'wireStateRegistry'] });
  const byId = new Map(ctx.STATE_REGISTRY.map((e) => [e.id, e]));
  for (const id of ['tool.activity', 'run.list', 'run.views', 'tool.background']) {
    assert.equal(byId.get(id).every, undefined, id + ' 에 주기가 남았다');
  }
  for (const id of ['tool.attention', 'tool.activity', 'tool.background', 'run.list']) {
    assert.ok(!(byId.get(id).revalidateOn || []).includes('chan:open'), id);
    assert.ok(byId.get(id).topic, id + ' 에 토픽이 없다');
  }
  const jobs = [];
  ctx.wireStateRegistry({ bus: { subscribe() {} }, timers: { every: (j) => jobs.push(j), after() {} } });
  assert.deepEqual(jobs.map((j) => j.id).filter((id) => ['tool.activity', 'run.list', 'run.views', 'tool.background'].includes(id)), []);
});

function topicRig() {
  const subs = new Map();
  const chanSubs = new Map();
  const got = [];
  const timers = [];
  const ctx = load(['core/i18n.js', 'i18n/ko.js', 'core/constants.js', 'core/channel.js', 'core/state-registry.js'], {
    expose: ['wireStateRegistry'],
    // 같은 chan:open 이 다른 상태의 재조회도 부른다 — 이 시험은 토픽 항목만 본다.
    globals: { apiGet: () => Promise.resolve({ ok: false, status: 0, data: null }), console: { error() {}, log() {} } },
  });
  const app = {
    bus: { subscribe: (t, fn) => { if (!subs.has(t)) subs.set(t, []); subs.get(t).push(fn) } },
    timers: { every() {}, after: (ms, fn) => { timers.push(fn); return { stop() {} } } },
    channel: { sub: (topic, fn) => { chanSubs.set(topic, fn); return { stop() {} } } },
    attn: { _attnRestore: (src) => got.push(['attention', src]) },
    agents: { _activityRestore: (src) => got.push(['activity', src]) },
    tool: { life: { _bgRefresh: (src) => got.push(['background', src]) } },
    _runsListApply: (list) => got.push(['runs', list]),
  };
  ctx.wireStateRegistry(app);
  const fire = (t, a) => { for (const fn of subs.get(t) || []) fn(a) };
  const flush = () => { const fs = timers.splice(0); for (const f of fs) f() };
  return { chanSubs, got, fire, flush };
}

/**
 * PERF M1 C3 TC-CH3-8 — 첫 `chan:open` 에 구독하고, 토픽 맵으로 GET 과 같은 본문을 만들어 복원에 넘긴다.
 */
test('TC-CH3-8: 토픽 항목은 첫 chan:open 에 구독하고 GET 모양 본문을 복원에 넘긴다', async () => {
  const { chanSubs, got, fire, flush } = topicRig();
  assert.equal(chanSubs.size, 0, '연결 전에 구독했다');
  fire('chan:open', { gen: 1 });
  fire('chan:open', { gen: 2 });
  assert.deepEqual([...chanSubs.keys()].sort(), ['activity', 'attention', 'background', 'runs']);

  chanSubs.get('activity')({ kind: 'full', data: { t2: { toolId: 't2', state: 'idle' }, _limits: [{ k: 1 }] } });
  chanSubs.get('activity')({ kind: 'delta', ops: [{ op: 'put', id: 't1', v: { toolId: 't1', state: 'working' } }] });
  chanSubs.get('attention')({ kind: 'full', data: { t1: true } });
  chanSubs.get('background')({ kind: 'full', data: { b1: { toolId: 'b1' } } });
  chanSubs.get('runs')({ kind: 'full', data: { r1: { id: 'r1' } } });
  assert.equal(got.length, 0, '한 틱 안의 변화를 합치지 않았다');
  flush();
  const by = Object.fromEntries(got.map(([k, v]) => [k, v]));
  const act = await by.activity;
  assert.equal(act.ok, true);
  assert.deepEqual(plain(act.data), { activities: [{ toolId: 't1', state: 'working' }, { toolId: 't2', state: 'idle' }], limits: [{ k: 1 }] });
  assert.equal(act.text, JSON.stringify(act.data));
  assert.deepEqual(plain((await by.attention).data), { toolIds: ['t1'] });
  assert.deepEqual(plain((await by.background).data), { background: [{ toolId: 'b1' }] });
  assert.deepEqual(plain(by.runs), [{ id: 'r1' }]);
  assert.equal(got.length, 4, '활동이 두 번 복원됐다');

  chanSubs.get('attention')({ kind: 'delta', ops: [{ op: 'del', id: 't1' }] });
  flush();
  assert.deepEqual(plain((await got.at(-1)[1]).data), { toolIds: [] });
});
