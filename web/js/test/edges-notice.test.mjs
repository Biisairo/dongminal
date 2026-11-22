import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BASE, load } from './harness.mjs';

/**
 * EDGE_PAIRING_SRS FR-EPR-5·23·32·70·71 — 간선 상태의 화면 쪽 규칙 (TC-EPR-10).
 *
 *   FR-EPR-5  방송의 `paired` 가 오면 "{name}({지문 앞자리})와 맺었습니다" 알림이 남는다.
 *   FR-EPR-23 상대가 지운 `removed`(`byPeer`)가 오면 "{name} 간선이 끊겼습니다" 알림을 띄운다.
 *             이쪽에서 끊은 간선은 알리지 않는다.
 *   FR-EPR-32 간선 줄은 `이름#번호 · 주소:포트` 다 (PROFILE_NAME_SRS FR-PFN-22). 주소를 모르면 `-` 다.
 *   FR-EPR-70 승인 대기 구역·알림은 없다.
 *   FR-EPR-71 상대에게 알리지 못하고 끊었으면 그 사실을 알린다.
 */
function setup(extra = {}) {
  const shown = [];
  const posts = [];
  let next = { ok: true, status: 200, data: { edges: [] } };
  let postResult = { ok: true, status: 200, data: {} };
  const after = [];
  const ctx = load([...BASE, 'core/settings-section.js', 'core/state-registry.js', 'core/settings-live.js', 'core/edges-controller.js',
    'core/settings-edges.js'], {
    expose: ['edgeFp16', 'edgeRemain', 'edgeWho', 'edgeHandle', 'EdgesSection', 'EdgesController', 'SettingsLive'],
    globals: {
      App: function App() {},
      t: (k, p) => k + (p ? JSON.stringify(p) : ''), MS_PER_SEC: 1000, EDGE_REMAIN_TICK_MS: 1000,
      apiGet: async () => next,
      apiPost: async (path, body) => { posts.push([path, body]); return postResult },
      statusRun: async (_el, _opts, fn) => fn(),
      document: { getElementById: () => null },
      profileName: '',
      Toast: {
        show(text, kind, ms, opts) {
          const h = { text, kind, ms, opts, closed: false, el: { isConnected: true } };
          h.close = () => { h.closed = true; h.el.isConnected = false };
          h.update = (msg) => { h.text = msg };
          shown.push(h);
          return h;
        },
      },
      ...extra,
    },
  });
  const app = new ctx.App();
  // REFACTOR3_FE_APPCTL_SRS 9a: 간선 읽기·알림은 `EdgesController`, 패널의 기준은 `SettingsLive` 다.
  app.edges = new ctx.EdgesController(app);
  // 섹션은 탭 이름으로 찾는다 (REFACTOR3_FE_DELEG_SRS D-DLG-4). 간선 칠하기는 막아 둔다.
  const sections = { edges: { _edgesPaint() {} }, profile: { _pfFollow() {} } };
  app.settings = { live: new ctx.SettingsLive(app), apply: {}, saveState: {}, section: (t) => sections[t] || null };
  app.settings.live._liveOpen = () => false; // 설정 패널이 열려 있지 않다 (UX_BATCH12 FR-LIV-4)
  app.timers = { after: (...a) => { after.push(a); return { stop() {} } }, cancel() {} };
  app._restoreBegin = () => 1;
  app._restoreLive = () => true;
  app._restoreEnd = () => {};
  app._titles = 0;
  app.settings.apply._applyPageTitle = () => { app._titles++ };
  // REFACTOR3_FE_SETTINGS_SRS 8c: 패널은 `EdgesSection` 이다. 읽기·지문·알림은 App 을 거친다.
  const sec = new ctx.EdgesSection(app);
  return {
    ctx, app, sec, shown, posts, after,
    setNext: (v) => { next = v },
    setPost: (v) => { postResult = v },
  };
}

test('지문은 앞 16자다', () => {
  const { ctx } = setup();
  assert.equal(ctx.edgeFp16('0123456789abcdef0123'), '0123456789abcdef');
  assert.equal(ctx.edgeFp16(undefined), '');
});

test('남은 시간은 m:ss 이고, 지났으면 빈 값이다', () => {
  const { ctx } = setup();
  const now = Date.parse('2026-11-10T00:00:00Z');
  assert.equal(ctx.edgeRemain('2026-11-10T00:02:05Z', now), '2:05');
  assert.equal(ctx.edgeRemain('2026-11-10T00:00:00.400Z', now), '0:01');
  assert.equal(ctx.edgeRemain('2026-11-10T00:00:00Z', now), '');
  assert.equal(ctx.edgeRemain('bad', now), '');
});

test('간선 줄은 이름#번호 · 주소:포트다 (FR-PFN-22)', () => {
  const { ctx } = setup();
  const fp = '0123456789abcdef'.repeat(4);
  assert.equal(ctx.edgeWho({ name: 'home', tag: '1234', fp, addr: '10.0.0.2', port: 58147 }), 'home#1234 · 10.0.0.2:58147');
  assert.equal(ctx.edgeWho({ name: 'home', tag: '1234', fp, addr: '', port: 0 }), 'home#1234 · -');
  assert.equal(ctx.edgeWho({ name: 'v6', tag: '0007', fp, addr: 'fe80::1', port: 1 }), 'v6#0007 · [fe80::1]:1');
});

test('핸들은 이름#번호이고, 번호가 없으면 이름만이다 (FR-PFN-6)', () => {
  const { ctx } = setup();
  assert.equal(ctx.edgeHandle({ name: '동민', tag: '0427' }), '동민#0427');
  assert.equal(ctx.edgeHandle({ name: '동민' }), '동민');
  assert.equal(ctx.edgeHandle({ name: '동민', tag: '' }), '동민');
});

test('승인 대기가 있어도 알림·만료 타이머가 없다', async () => {
  const { app, shown, after, setNext } = setup();
  setNext({ ok: true, status: 200, data: { edges: [], pending: [{ id: 'p1', expires: '2099-01-01T00:00:00Z' }] } });
  await app.edges._edgesRestore();
  assert.equal(shown.length, 0);
  assert.equal(after.length, 0);
});

test('paired 방송은 상대 핸들로 "맺었습니다" 알림을 남긴다 (FR-PFN-22)', async () => {
  const { app, shown } = setup();
  await app.edges._onEdgesChanged({ paired: { fp: 'aaaaaaaaaaaaaaaabbbb', name: 'node-a', tag: '0042' } });
  assert.equal(shown.length, 1);
  assert.equal(shown[0].kind, 'ok');
  assert.equal(shown[0].ms, 0, '맺음 알림은 남아야 한다');
  assert.match(shown[0].text, /^edge\.paired_notice/);
  assert.match(shown[0].text, /"name":"node-a#0042"/);
  await app.edges._onEdgesChanged({});
  assert.equal(shown.length, 1);
});

test('상대가 지운 removed 방송만 "끊겼습니다" 알림을 띄운다', async () => {
  const { app, shown } = setup();
  await app.edges._onEdgesChanged({ removed: { fp: 'f1', name: 'node-b', tag: '0001' }, byPeer: true });
  assert.equal(shown.length, 1);
  assert.match(shown[0].text, /^edge\.removed_notice/);
  assert.match(shown[0].text, /"name":"node-b#0001"/);
  // 이쪽에서 지운 것(어느 탭이든 dmctl 이든)은 알리지 않는다.
  await app.edges._onEdgesChanged({ removed: { fp: 'f2', name: 'node-c' } });
  assert.equal(shown.length, 1, '이쪽에서 지운 간선을 알렸다');
});

test('끊기는 지문으로 보내고, 상대에게 알리지 못했으면 알린다', async () => {
  const { sec, shown, posts, setPost } = setup();
  setPost({ ok: true, status: 200, data: { fp: 'f3', name: 'node-d', notified: false } });
  await sec._egRemove({ fp: 'f3', name: 'node-d' });
  assert.equal(JSON.stringify(posts), JSON.stringify([['/api/edges/remove', { fp: 'f3' }]]));
  assert.equal(shown.length, 1);
  assert.match(shown[0].text, /^edge\.remove_unnotified/);
  setPost({ ok: true, status: 200, data: { fp: 'f4', name: 'node-e', notified: true } });
  await sec._egRemove({ fp: 'f4', name: 'node-e' });
  assert.equal(shown.length, 1, '알렸는데 미통지 알림을 띄웠다');
});

/**
 * C6: 탭을 여는 읽기가 방송의 다시 읽기에 밀려도(세대가 지나도) 노드 설정 칸은 그 읽기의
 * 값으로 채운다. 비어 남은 칸을 저장하면 400 이다.
 */
test('탭을 여는 읽기가 밀려도 노드 칸은 그 값으로 채운다', async () => {
  const data = { node: { name: 'office', port: 58147 }, edges: [{ name: 'b', fp: 'f' }] };
  const { app, sec } = setup({ apiGet: async () => ({ ok: true, status: 200, data }) });
  app._restoreLive = () => false; // 방송의 다시 읽기가 뒤에 시작했다
  const painted = {};
  sec._egNodePaint = (v) => { painted.node = v };
  sec._egEdgesPaint = (p, force) => { painted.edges = [p, force] };
  sec._egNodeCollect = () => ({}); // 폼 DOM 은 이 시험의 대상이 아니다 (UX_BATCH12 FR-LIV-6 의 기준값)
  await sec._loadEdgesPanel();
  assert.equal(painted.node, data);
  assert.deepEqual(painted.edges, [data.edges, true]);
});

test('간선 읽기의 노드 이름이 탭 제목 이름이 된다 (PROFILE_NAME_SRS FR-PFN-20)', async () => {
  const { ctx, app, setNext } = setup();
  setNext({ ok: true, status: 200, data: { node: { name: '동민', tag: '0427' }, edges: [] } });
  await app.edges._edgesRestore();
  assert.equal(ctx.profileName, '동민');
  assert.equal(app._titles, 1);
});

test('간선 읽기는 열린 프로필 패널에도 알린다 (FR-PFN-14)', async () => {
  const { app, setNext } = setup();
  const seen = [];
  app.settings.section('profile')._pfFollow = (r) => { seen.push(r) };
  const r = { ok: true, status: 200, data: { node: { name: '동민' }, edges: [] } };
  setNext(r);
  await app.edges._edgesRestore();
  assert.equal(seen.length, 1);
  assert.equal(seen[0], r);
});
