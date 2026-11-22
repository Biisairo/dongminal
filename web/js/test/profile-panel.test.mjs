import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BASE, load } from './harness.mjs';

/**
 * PROFILE_NAME_SRS FR-PFN-10~13·20 — 프로필 패널.
 *
 *   FR-PFN-10 이름 칸·`#번호`·지문을 그린다.
 *   FR-PFN-11 저장은 `PUT /api/profile {name}` 이다. 거절이면 탭 제목을 바꾸지 않는다.
 *   FR-PFN-12 저장에 성공하면 탭 제목을 곧바로 바꾼다.
 *   FR-PFN-13 읽을 때의 지문을 `If-Match` 로 싣는다.
 *   FR-PFN-14 열린 패널은 방송을 따라간다 — 고치던 값이 없으면 다시 그리고, 있으면 안내한다.
 *             저장 중에 온 방송은 안내하지 않는다.
 */
const PROFILE = { name: '동민', tag: '0427', handle: '동민#0427', fingerprint: 'ab'.repeat(32) };

function setup({ get, put, open = false } = {}) {
  const els = {};
  for (const id of ['pf-name', 'pf-tag', 'pf-fp', 'pf-status', 'panel-profile', 'modal-overlay']) {
    els[id] = { value: '', textContent: '', hidden: false, classList: { contains: () => open }, querySelector: () => null };
  }
  // UX_AUDIT_FIX_SRS FR-UXF-53: 지문은 4자 묶음 span 으로 그린다 — 묶음을 이어 붙인 글자가 textContent 다.
  els['pf-fp'].replaceChildren = (...kids) => { els['pf-fp'].textContent = kids.map((k) => k.textContent).join('') };
  const puts = [];
  let gets = 0;
  const ctx = load([...BASE, 'core/settings-section.js', 'core/settings-live.js', 'core/edges-controller.js', 'core/settings-profile.js'], {
    expose: ['ProfileSection', 'SettingsLive', 'EdgesController'],
    globals: {
      App: function App() {},
      t: (k) => k,
      profileName: '',
      apiGet: async () => { gets++; return typeof get === 'function' ? get() : get || { ok: true, status: 200, data: PROFILE, headers: { get: () => 'E1' } } },
      apiPut: async (path, body, opts) => { puts.push([path, body, opts]); if (typeof put === 'function') return put(body); return put || { ok: true, status: 200, data: { ...PROFILE, name: body.name, handle: body.name + '#0427' }, headers: { get: () => 'E2' } } },
      statusRun: async (_el, _opts, fn) => fn(),
      document: { getElementById: (id) => els[id] || null, createElement: () => ({ className: '', textContent: '' }) },
      UIKit: { button: () => ({}) },
    },
  });
  const app = new ctx.App();
  // REFACTOR3_FE_APPCTL_SRS 9a: 패널의 기준은 `SettingsLive`, 간선 읽기는 `EdgesController` 다.
  app.settings = { live: new ctx.SettingsLive(app) };
  app.edges = new ctx.EdgesController(app);
  let titles = 0;
  app._applyPageTitle = () => { titles++ };
  const notices = [];
  const cleared = [];
  app._liveNotice = (k, reload) => { if (reload) notices.push(k); else cleared.push(k) };
  // REFACTOR3_FE_SETTINGS_SRS 8c: 패널은 `ProfileSection` 이다. 저장·알림은 App 을 거친다.
  const sec = new ctx.ProfileSection(app);
  return { ctx, app, sec, els, puts, titles: () => titles, gets: () => gets, notices, cleared };
}

test('패널을 열면 이름·번호·지문을 그리고 탭 제목 이름을 맞춘다', async () => {
  const { sec, ctx, els, titles } = setup();
  await sec._loadProfilePanel();
  assert.equal(els['pf-name'].value, '동민');
  assert.equal(els['pf-tag'].textContent, '#0427');
  assert.equal(els['pf-fp'].textContent, PROFILE.fingerprint);
  assert.equal(ctx.profileName, '동민');
  assert.ok(titles() >= 1);
});

test('저장은 이름만 If-Match 와 함께 보내고, 성공하면 탭 제목을 바꾼다', async () => {
  const { sec, ctx, els, puts, titles } = setup();
  await sec._loadProfilePanel();
  const before = titles();
  els['pf-name'].value = '  새이름 ';
  await sec._profileSave();
  assert.equal(puts.length, 1);
  assert.equal(puts[0][0], '/api/profile');
  assert.deepEqual(JSON.parse(JSON.stringify(puts[0][1])), { name: '새이름' });
  assert.equal(puts[0][2].headers['If-Match'], 'E1');
  assert.equal(ctx.profileName, '새이름');
  assert.ok(titles() > before);
});

test('거절된 저장은 이름과 탭 제목을 바꾸지 않는다', async () => {
  const { sec, ctx, els, titles } = setup({ put: { ok: false, status: 400, data: null, headers: { get: () => '' } } });
  await sec._loadProfilePanel();
  const before = titles();
  els['pf-name'].value = '동 민';
  await sec._profileSave();
  assert.equal(ctx.profileName, '동민');
  assert.equal(titles(), before);
});

const edgesRead = (tag) => ({ ok: true, status: 200, data: { node: { name: '동민' } }, headers: { get: () => tag } });

test('열린 패널은 고치던 값이 없으면 방송 뒤 다시 읽는다 (FR-PFN-14)', async () => {
  let name = '동민';
  const { sec, els, gets, notices } = setup({ open: true, get: () => ({ ok: true, status: 200, data: { ...PROFILE, name }, headers: { get: () => name === '동민' ? 'E1' : 'E9' } }) });
  await sec._loadProfilePanel();
  name = '다른창';
  await sec._pfFollow(edgesRead('E9'));
  assert.equal(gets(), 2);
  assert.equal(els['pf-name'].value, '다른창');
  assert.equal(notices.length, 0);
});

test('같은 지문의 방송은 아무것도 하지 않는다', async () => {
  const { sec, gets, notices } = setup({ open: true });
  await sec._loadProfilePanel();
  await sec._pfFollow(edgesRead('E1'));
  assert.equal(gets(), 1);
  assert.equal(notices.length, 0);
});

test('고치던 값이 있으면 덮지 않고 안내한다', async () => {
  const { sec, els, gets, notices } = setup({ open: true });
  await sec._loadProfilePanel();
  els['pf-name'].value = '고치는중';
  await sec._pfFollow(edgesRead('E9'));
  assert.equal(gets(), 1);
  assert.equal(els['pf-name'].value, '고치는중');
  assert.deepEqual(notices, ['profile']);
});

test('저장 중에 온 방송은 안내하지 않는다', async () => {
  let release;
  const { sec, els, notices } = setup({
    open: true,
    put: (body) => new Promise(res => { release = () => res({ ok: true, status: 200, data: { ...PROFILE, name: body.name }, headers: { get: () => 'E9' } }) }),
  });
  await sec._loadProfilePanel();
  els['pf-name'].value = '새이름';
  const saving = sec._profileSave();
  await new Promise(r => setTimeout(r, 0));
  await sec._pfFollow(edgesRead('E9'));
  release();
  await saving;
  assert.equal(notices.length, 0);
  assert.equal(els['pf-name'].value, '새이름');
});

test('닫힌 패널은 방송을 따라가지 않는다', async () => {
  const { sec, gets } = setup({ open: false });
  await sec._loadProfilePanel();
  await sec._pfFollow(edgesRead('E9'));
  assert.equal(gets(), 1);
});

// QUALITY_FLAKY_SRS FR-FLK-6 — 읽기는 하나만 나고, 읽는 사이에 고친 이름을 덮지 않는다.
function pendingGet() {
  const box = { release: null };
  box.get = () => new Promise((res) => { box.release = (name = PROFILE.name, tag = 'E1') => res({ ok: true, status: 200, data: { ...PROFILE, name }, headers: { get: () => tag } }) });
  return box;
}

test('겹친 읽기는 하나만 난다 (열기와 탭 고르기)', async () => {
  const g = pendingGet();
  const { sec, gets } = setup({ open: true, get: g.get });
  const a = sec._loadProfilePanel();
  const b = sec._loadProfilePanel();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(gets(), 1);
  g.release();
  await Promise.all([a, b]);
  assert.equal(gets(), 1);
});

test('읽는 사이에 고친 이름은 덮지 않고, 뒤의 방송이 안내한다', async () => {
  const g = pendingGet();
  const { sec, els, notices } = setup({ open: true, get: g.get });
  const reading = sec._loadProfilePanel();
  await new Promise((r) => setTimeout(r, 0));
  els['pf-name'].value = '고치는중';
  g.release();
  await reading;
  assert.equal(els['pf-name'].value, '고치는중');
  assert.equal(els['pf-tag'].textContent, '#0427');
  await sec._pfFollow(edgesRead('E9'));
  assert.equal(els['pf-name'].value, '고치는중');
  assert.deepEqual(notices, ['profile']);
});

test('읽는 사이에 선 안내는 그 읽기가 거두지 않는다', async () => {
  const g = pendingGet();
  const { sec, els, notices, cleared } = setup({ open: true, get: g.get });
  const reading = sec._loadProfilePanel();
  await new Promise((r) => setTimeout(r, 0));
  els['pf-name'].value = '고치는중';
  await sec._pfFollow(edgesRead('E9'));
  assert.deepEqual(notices, ['profile']);
  g.release();
  await reading;
  assert.equal(els['pf-name'].value, '고치는중');
  assert.deepEqual(cleared, []);
});

test('읽는 사이에 고치지 않았으면 읽은 값으로 그린다', async () => {
  const g = pendingGet();
  const { sec, els, cleared } = setup({ open: true, get: g.get });
  const reading = sec._loadProfilePanel();
  await new Promise((r) => setTimeout(r, 0));
  g.release('다른창', 'E9');
  await reading;
  assert.equal(els['pf-name'].value, '다른창');
  assert.deepEqual(cleared, ['profile']);
});
