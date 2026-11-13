import assert from 'node:assert/strict';
import { test } from 'node:test';

import { load, plain } from './harness.mjs';

/**
 * CLAUDE_ACCOUNTS_SRS TC-CAC-21 — Activity 하단(Usage foot)의 계정 묶음과 statusLine 한 줄 (FR-CAC-90~93).
 */
const EN = {
  'usage.win.five_hour': 'Current session', 'usage.win.seven_day': 'Current week',
  'usage.used': '{n}% used', 'usage.resets_in': 'Resets in {t}', 'usage.resets_soon': 'Resets soon',
  'usage.as_of': 'as of {t}', 'usage.dur.d': '{n}d', 'usage.dur.h': '{n}h', 'usage.dur.m': '{n}m',
  'usage.sl.label': 'statusLine', 'usage.sl.five_hour': 'Session', 'usage.sl.seven_day': 'Week',
  'cacct.title': 'Claude accounts', 'cacct.active': 'Active', 'cacct.next': 'Next account',
  'cacct.age_min': '{n}m ago', 'cacct.retry_at': 'retry {t}',
  'cacct.st.relogin_required': 'Log in again', 'cacct.st.rate_limited': 'Rate limited',
  'cacct.pace_expected': 'Expected {n}%', 'cacct.pace_runout': 'runs out before reset at this pace ({t})',
  'cacct.pace_lasts': 'lasts until reset', 'cacct.spend': 'Extra usage {used} / {limit}',
  'cacct.login_expires': 'Login expires {d}', 'cacct.switch': 'Switch to this account', 'cacct.refresh': 'Refresh',
  'cacct.wd.3': 'Wed',
  'cacct.rs.title': 'Limit resets', 'cacct.rs.juniper': '5-hour reset', 'cacct.rs.usable': 'available',
  'cacct.rs.next': 'next {t}', 'cacct.rs.left': '{n}/{m} left', 'cacct.rs.until': 'until {d}', 'cacct.rs.paused': 'paused',
  'cacct.rs.use': 'Use reset…', 'cacct.rs.confirm_title': 'Use a limit reset?', 'cacct.rs.clears': 'Refills: {w}',
  'cacct.rs.weekly_deduct': 'Counts against your weekly limit', 'cacct.rs.weekly_back': 'Gives back weekly usage',
  'cacct.rs.irreversible': 'This cannot be undone.', 'cacct.rs.confirm_use': 'Use',
  'cacct.rs.r.reset': 'Reset done', 'cacct.rs.r.unconfirmed': 'Could not confirm',
};
function fillEn(k, p) {
  if (!(k in EN)) return k;
  return EN[k].replace(/\{(\w+)\}/g, (_, n) => String(p && p[n]));
}

function memStore() {
  const m = new Map();
  return {
    m,
    get: (k) => (m.has(k) ? m.get(k) : null),
    set: (k, v) => { m.set(k, String(v)); return true },
    remove: (k) => { m.delete(k); return true },
    json: (k, d) => (m.has(k) ? JSON.parse(m.get(k)) : d),
    setJson: (k, v) => { m.set(k, JSON.stringify(v)); return true },
  };
}

function loadFoot(globals = {}) {
  const local = memStore();
  const ctx = load(['core/path.js', 'core/app-agents.js', 'core/app-agents-sub.js', 'core/app-activity.js', 'core/app-claude-accounts.js', 'core/app-claude-accounts-map.js'], {
    expose: ['ACTIVITY_SECTIONS'],
    globals: {
      App: class {},
      ACTIVITY_STATE: { ENDED: 'ended', WORKING: 'working', DONE: 'done', WAITING: 'waiting', IDLE: 'idle' },
      AGENT_STATE_ICON: { working: '●', done: '✓', waiting: '…', idle: '○' },
      PrefStore: { local },
      STORE_KEYS: { agentsGroupFold: 'agentsGroupFold', agentsSubView: 'agentsSubView', claudeAcctOpen: 'claudeAcctOpen' },
      UIKit: {
        iconHTML: (n) => '<i:' + n + '>',
        button: (b) => ({ className: 'ui-btn ' + (b.cls || ''), textContent: b.label, children: [] }),
      },
      t: (k, p) => fillEn(k, p),
      // FR-CAC-95a: 복원 뒤의 매핑 받기. 기본은 계정 기능이 없는 서버(503)다.
      apiGet: () => Promise.resolve({ ok: false, status: 503, data: null }),
      ...globals,
    },
  });
  ctx._local = local;
  return ctx;
}

const NOW = 1_794_000_000; // unix 초
const clock = (ms) => { const d = new Date(ms); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') };

const ACC_A = {
  id: 'a', email: 'a@x.com', organizationName: 'Org A', alias: 'Work', color: 'acct-3', active: true,
  usage: {
    status: 'ok', fetchedAt: NOW - 30, ageSeconds: 30,
    windows: {
      fiveHour: { pct: 34.4, resetsAt: NOW + 7800, resetsInSec: 7800, level: '' },
      sevenDay: { pct: 72, resetsAt: NOW + 368000, resetsInSec: 368000, level: 'warn' },
      scoped: [{ name: 'Opus', pct: 95, level: 'critical' }],
      spend: { used: 12.4, limit: 50, pct: 24.8, currency: 'USD' },
    },
    pace: { sevenDay: { expectedPct: 22, aheadOfPace: true, projectedExhaustionAt: 0, willLastToReset: false } },
    loginExpiresAt: 0,
  },
};
const ACC_B = { id: 'b', email: 'b@x.com', color: 'bogus', active: false, usage: {} };

// ── 계정 묶음 (FR-CAC-91) ──

test('FR-CAC-91: 접힌 묶음은 머리와 5시간·주간 막대뿐이다', () => {
  const { claudeAcctView } = loadFoot();
  const v = plain(claudeAcctView(ACC_A, false));
  assert.equal(v.id, 'a');
  assert.equal(v.name, 'Work');
  assert.equal(v.title, 'a@x.com · Org A');
  assert.equal(v.color, 'acct-3');
  assert.equal(v.active, true);
  assert.equal(v.status, '');
  assert.equal(v.age, '');
  assert.equal(v.open, false);
  assert.deepEqual(v.bars.map((b) => b.label), ['Current session', 'Current week']);
  assert.deepEqual(v.bars[0], { id: 'a:five_hour', label: 'Current session', used: '34% used', fill: 34.4, level: '',
    reset: 'Resets in 2h 10m', title: 'Current session · 34% used · resets at ' + clock((NOW + 7800) * 1000) });
  assert.equal(v.bars[1].level, 'warn');
  assert.equal(v.more, null);
});

test('FR-CAC-91: 펼치면 scoped·예측·추가 사용량·로그인 만료·동작이 보인다', () => {
  const { claudeAcctView } = loadFoot();
  const exhaust = Date.UTC(2026, 10, 11, 9, 0) / 1000; // 수요일
  const acc = structuredClone(ACC_A);
  acc.usage.pace.sevenDay.projectedExhaustionAt = exhaust;
  acc.usage.loginExpiresAt = Date.UTC(2026, 11, 1, 12) / 1000;
  acc.usage.loginExpiringSoon = true;
  const v = plain(claudeAcctView(acc, true));
  assert.equal(v.open, true);
  assert.deepEqual(v.more.scoped.map((b) => [b.id, b.label, b.level, b.reset]), [['a:scoped:Opus', 'Opus', 'critical', '']]);
  const d = new Date(exhaust * 1000);
  assert.equal(v.more.pace.text, 'Expected 22% · runs out before reset at this pace (' + fillEn('cacct.wd.' + d.getDay()) + ' ' + clock(exhaust * 1000) + ')');
  assert.equal(v.more.pace.warn, true);
  assert.equal(v.more.spend, 'Extra usage $12.40 / $50');
  const ld = new Date(acc.usage.loginExpiresAt * 1000);
  const ymd = ld.getFullYear() + '-' + String(ld.getMonth() + 1).padStart(2, '0') + '-' + String(ld.getDate()).padStart(2, '0');
  assert.deepEqual(v.more.login, { text: 'Login expires ' + ymd, warn: true });
  assert.equal(v.more.canSwitch, false);
});

test('FR-CAC-57·91: 예측이 버티면 그렇게 말하고, 예측이 없으면 줄이 없다', () => {
  const { claudeAcctView } = loadFoot();
  const acc = structuredClone(ACC_A);
  acc.usage.pace.sevenDay = { expectedPct: 50, aheadOfPace: false, willLastToReset: true };
  assert.deepEqual(plain(claudeAcctView(acc, true).more.pace), { text: 'Expected 50% · lasts until reset', warn: false });
  acc.usage.pace = {};
  assert.equal(claudeAcctView(acc, true).more.pace, null);
});

test('FR-CAC-55·56·91: 상태 문구·다시 시도 시각·n분 전, 이름은 별칭이 없으면 이메일', () => {
  const { claudeAcctView } = loadFoot();
  const acc = { id: 'c', email: 'c@x.com', color: 'acct-8', active: false,
    usage: { status: 'rate_limited', backoffUntil: NOW + 600, stale: true, ageSeconds: 420, windows: { fiveHour: { pct: 5, level: '' } } } };
  const v = plain(claudeAcctView(acc, true));
  assert.equal(v.name, 'c@x.com');
  assert.equal(v.title, 'c@x.com');
  assert.equal(v.status, 'Rate limited · retry ' + clock((NOW + 600) * 1000));
  assert.equal(v.age, '7m ago');
  assert.deepEqual(v.bars.map((b) => b.label), ['Current session']);
  assert.equal(v.more.canSwitch, true);
  assert.equal(v.more.spend, '');
  assert.equal(v.more.login, null);
});

test('FR-CAC-98: 팔레트 밖의 색은 첫 색으로 그린다. 아직 조회하지 않은 계정은 막대가 없다', () => {
  const { claudeAcctView } = loadFoot();
  const v = plain(claudeAcctView(ACC_B, false));
  assert.equal(v.color, 'acct-1');
  assert.deepEqual(v.bars, []);
  assert.equal(v.status, '');
  assert.equal(plain(claudeAcctView({ ...ACC_B, usage: null }, false)).bars.length, 0);
});

// ── statusLine 줄 (FR-CAC-93) ──

test('FR-CAC-93: statusLine 은 한 줄이다 — 창마다 이름과 %, 끝에 세션 초기화', () => {
  const { statusLineView } = loadFoot();
  const observedAt = Date.UTC(2026, 10, 10, 5, 0);
  const limits = [{ agent: 'claude', observedAt, windows: [
    { name: 'five_hour', usedPct: 34.4, resetsInSec: 7800, level: '' },
    { name: 'seven_day', usedPct: 91, resetsInSec: 368000, level: 'critical' },
    { name: 'no_pct', level: '' },
  ] }];
  const v = plain(statusLineView(limits, observedAt + 60_000));
  assert.equal(v.label, 'statusLine');
  assert.deepEqual(v.segs, [{ text: 'Session 34%', level: '' }, { text: 'Week 91%', level: 'critical' }]);
  assert.equal(v.reset, 'Resets in 2h 10m');
  assert.equal(v.asOf, '');
  assert.equal(plain(statusLineView(limits, observedAt + 11 * 60_000)).asOf, 'as of ' + clock(observedAt));
});

test('FR-CAC-93: 값이 없으면 statusLine 줄을 그리지 않는다', () => {
  const { statusLineView } = loadFoot();
  assert.equal(statusLineView([], 0), null);
  assert.equal(statusLineView(undefined, 0), null);
  assert.equal(statusLineView([{ agent: 'claude', observedAt: 0, windows: [{ name: 'five_hour', level: '' }] }], 0), null);
});

// ── 바닥의 조립 (FR-CAC-90) ──

function footApp(ctx) {
  const app = new ctx.App();
  app._bg = []; app._runsPanel = () => ({});
  app._agWindowItems = () => [];
  app._agFolded = () => new Set();
  app._limits = [];
  app._claudeAccts = [];
  return app;
}
/** 하네스 DOM 에는 querySelector 가 없다 — 자식을 따라 클래스로 찾는다. */
function find(el, cls) {
  if (String(el.className).split(' ').includes(cls)) return el;
  for (const c of el.children || []) { const f = find(c, cls); if (f) return f }
  return null;
}
const SL = [{ agent: 'claude', observedAt: Date.now(), windows: [{ name: 'five_hour', usedPct: 1, level: '' }] }];

test('FR-CAC-90: 계정도 statusLine 도 없으면 바닥이 없다', () => {
  const app = footApp(loadFoot());
  assert.equal(app._actItems().some((i) => i.t === 'foot'), false);
});

test('FR-CAC-90: 계정이 없으면 statusLine 줄만, 있으면 계정 묶음 + statusLine 줄', () => {
  const app = footApp(loadFoot());
  app._limits = SL;
  let foot = app._actItems().at(-1);
  assert.equal(foot.t, 'foot');
  assert.equal(foot.view.accounts.length, 0);
  assert.ok(foot.view.sl);

  app._claudeAccts = [ACC_A, ACC_B];
  foot = app._actItems().at(-1);
  assert.deepEqual(plain(foot.view.accounts.map((a) => a.id)), ['a', 'b']);
  assert.equal(foot.view.next, true);
  assert.ok(foot.view.sl);

  app._limits = [];
  app._claudeAccts = [ACC_A];
  foot = app._actItems().at(-1);
  assert.equal(foot.view.sl, null);
  assert.equal(foot.view.next, false, '전환할 다른 계정이 없으면 다음 계정 버튼이 없다');
});

test('FR-CAC-91: 펼침은 계정별로 기억한다', () => {
  const ctx = loadFoot({ apiPost: () => Promise.resolve({ ok: false, status: 409, data: {} }) });
  const app = footApp(ctx);
  let rendered = 0;
  app.agentsRender = () => { rendered++ };
  app._claudeAccts = [ACC_A, ACC_B];
  app._claudeAcctToggle('b');
  assert.equal(rendered, 1);
  assert.deepEqual(JSON.parse(ctx._local.m.get('claudeAcctOpen')), ['b']);
  const v = app._actItems().at(-1).view;
  assert.deepEqual(plain(v.accounts.map((a) => a.open)), [false, true]);
  app._claudeAcctToggle('b');
  assert.deepEqual(JSON.parse(ctx._local.m.get('claudeAcctOpen')), []);
});

test('FR-CAC-90·93: 바닥 원소 — 머리, 계정 묶음, 맨 아래 statusLine 줄', () => {
  const ctx = loadFoot();
  const app = footApp(ctx);
  app._claudeAccts = [ACC_A, ACC_B];
  app._limits = SL;
  const foot = app._actUsageFootEl(app._actItems().at(-1).view);
  const kinds = [...foot.children].map((c) => c.className.split(' ')[0]);
  assert.deepEqual(kinds, ['act-usage-head', 'cacct', 'cacct', 'act-usage-sl']);
  const a = foot.children[1];
  assert.equal(a.className, 'cacct active');
  assert.equal(a.dataset.id, 'a');
  const head = a.children[0];
  assert.equal(head.className, 'cacct-head');
  assert.equal(find(head, 'cacct-dot').style.background, 'var(--acct-3)');
  assert.equal(find(head, 'cacct-name').textContent, 'Work');
  assert.equal(find(head, 'cacct-active').textContent, 'Active');
  assert.deepEqual([...a.children].slice(1).map((c) => c.className), ['act-usage-win', 'act-usage-win lv-warn']);
  const sl = foot.children[3];
  assert.deepEqual([...sl.children].map((c) => c.textContent), ['statusLine', 'Session 1%']);
  assert.equal(sl.children[1].className, 'act-usage-sl-seg');
});

test('FR-CAC-91: 펼친 묶음에는 동작 버튼이 있고, 활성 계정에는 전환이 없다', () => {
  const ctx = loadFoot();
  const app = footApp(ctx);
  ctx._local.setJson('claudeAcctOpen', ['a', 'b']);
  app._claudeAccts = [ACC_A, { ...ACC_B, usage: { windows: { fiveHour: { pct: 1, level: '' } } } }];
  const foot = app._actUsageFootEl(app._actItems().at(-1).view);
  const [a, b] = [foot.children[1], foot.children[2]];
  assert.equal(find(a, 'cacct-switch'), null);
  assert.ok(find(a, 'cacct-refresh'));
  assert.ok(find(b, 'cacct-switch'));
  assert.equal(find(a, 'cacct-pace').className, 'cacct-pace warn');
  assert.equal(find(a, 'cacct-spend').textContent, 'Extra usage $12.40 / $50');
});

// ── 데이터 (FR-CAC-122) ──

function restoreApp(ctx) {
  const app = new ctx.App();
  app._restoreBegin = () => new Set();
  app._restoreLive = () => true;
  app._restoreEnd = () => {};
  app.agentsRender = () => {};
  return app;
}

test('FR-CAC-122: 복원이 계정 목록을 담고, 503(계정 기능 없음)이면 비운다', async () => {
  let reply = { ok: true, status: 200, data: { activeId: 'a', accounts: [ACC_A] } };
  const ctx = loadFoot({ stateFetch: () => Promise.resolve(reply) });
  const app = restoreApp(ctx);
  await app._claudeAcctRestore();
  assert.deepEqual(plain(app._claudeAccts.map((a) => a.id)), ['a']);
  reply = { ok: false, status: 0, data: null };
  await app._claudeAcctRestore();
  assert.equal(app._claudeAccts.length, 1, '망 실패는 마지막 값을 지우지 않는다');
  reply = { ok: false, status: 503, data: { code: 'claude_accounts_unavailable' } };
  await app._claudeAcctRestore();
  assert.equal(app._claudeAccts.length, 0);
});

test('FR-CAC-91·92: 전환·다음 계정·새로 고침은 서버 종단을 부르고, 실패는 알린다', async () => {
  const calls = [], toasts = [];
  let reply = { ok: true, status: 200, data: {} };
  const ctx = loadFoot({
    apiPost: (p, b) => { calls.push([p, b]); return Promise.resolve(reply) },
    apiErrText: (r) => 'E' + r.status,
    Toast: { show: (m, k) => toasts.push([m, k]) },
  });
  const app = restoreApp(ctx);
  app._claudeAcctRestore = () => Promise.resolve();
  await app._claudeAcctSwitch('b');
  await app._claudeAcctSmart('next');
  await app._claudeAcctRefresh('a');
  assert.deepEqual(plain(calls), [
    ['/api/claude-accounts/switch', { id: 'b' }],
    ['/api/claude-accounts/switch', { strategy: 'next' }],
    ['/api/claude-accounts/refresh', { id: 'a' }],
  ]);
  assert.equal(toasts.length, 0);
  reply = { ok: false, status: 409, data: { code: 'claude_too_soon' } };
  await app._claudeAcctRefresh('a');
  assert.deepEqual(plain(toasts), [['E409', 'err']]);
});

// ── 계정 색 (FR-CAC-98) ──

test('FR-CAC-98: 계정 색 8개는 모드별 고정 팔레트이고, 54종 전부의 표면에서 3:1 을 넘는다', () => {
  const ctx = load(['core/contrast.js', 'ui/themes.js'], { globals: { TOPTS: {} }, expose: ['THEMES', 'CONTRAST_FLOORS'] });
  const keys = Array.from({ length: 8 }, (_, i) => '--acct-' + (i + 1));
  const dark = plain(ctx.deriveAccountColors('dark'));
  const light = plain(ctx.deriveAccountColors('light'));
  assert.deepEqual(Object.keys(dark), keys);
  assert.deepEqual(Object.keys(light), keys);
  assert.notDeepEqual(dark, light);
  assert.deepEqual(plain(ctx.deriveAccountColors(undefined)), dark);
  for (const [name, t] of Object.entries(ctx.THEMES)) {
    const d = ctx.deriveContrastTokens(t.ui, t.mode, null, t.terminal);
    const pal = ctx.deriveAccountColors(t.mode);
    for (const k of keys) for (const bg of [t.ui.bg, t.ui.sidebarBg, d.bgAlt]) {
      assert.ok(ctx.contrastRatio(pal[k], bg) >= ctx.CONTRAST_FLOORS.ui, `${name} ${k} on ${bg}`);
    }
  }
});

// ── 제한 초기화 (FR-CAC-62·63·65) ──

const RESETS = {
  fetchedAt: NOW,
  juniperTide: { eligible: true, available: false, nextAvailableAt: NOW + 3600 },
  cedarEmber: { eligible: true, atLimit: true, exhausted: [], grants: [
    { id: 'g_1', label: 'Fable reset', resetsTotal: 3, resetsLeft: 2, endsAt: Date.UTC(2026, 11, 1, 12) / 1000,
      clears: ['five_hour', 'seven_day'], paused: false, usableNow: true, givesBackWeekly: true, blocking: [] },
    { id: 'g_0', label: 'Spent', resetsTotal: 1, resetsLeft: 0, clears: [], paused: false, usableNow: false, blocking: [] },
    { id: 'g_p', label: '', resetsTotal: 1, resetsLeft: 1, clears: ['five_hour'], paused: true, usableNow: false, blocking: [] },
  ] },
};
const withResets = (r) => { const a = structuredClone(ACC_A); a.usage.resets = r; return a };
const ymdOf = (sec) => { const d = new Date(sec * 1000); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') };

test('FR-CAC-65: 펼친 묶음의 초기화 칸 — 주간 5시간 초기화와 남은 티켓', () => {
  const { claudeAcctView } = loadFoot();
  const rs = plain(claudeAcctView(withResets(RESETS), true).more.resets);
  assert.deepEqual(rs.map((r) => r.key), ['juniper', 'g:g_1', 'g:g_p']);
  const d = new Date((NOW + 3600) * 1000);
  assert.deepEqual(rs[0], { key: 'juniper', program: 'juniper_tide', grantId: '', name: '5-hour reset',
    detail: 'next ' + fillEn('cacct.wd.' + d.getDay()) + ' ' + clock((NOW + 3600) * 1000), usable: false,
    confirm: { clears: 'Refills: Current session', left: '', ends: '', weekly: 'Counts against your weekly limit' } });
  assert.equal(rs[1].name, 'Fable reset');
  assert.equal(rs[1].detail, '2/3 left · until ' + ymdOf(RESETS.cedarEmber.grants[0].endsAt) + ' · available');
  assert.equal(rs[1].usable, true);
  assert.deepEqual(rs[1].confirm, { clears: 'Refills: Current session, Current week', left: '2/3 left',
    ends: 'until ' + ymdOf(RESETS.cedarEmber.grants[0].endsAt), weekly: 'Gives back weekly usage' });
  assert.equal(rs[2].name, 'g_p', '이름이 없으면 id');
  assert.equal(rs[2].detail, '1/1 left · paused');
  assert.equal(rs[2].usable, false);
});

test('FR-CAC-61·65: 자격이 없거나 상태가 없으면 칸이 비고, 쓸 수 있는 주간 초기화는 available', () => {
  const { claudeAcctView } = loadFoot();
  assert.deepEqual(plain(claudeAcctView(ACC_A, true).more.resets), []);
  const off = structuredClone(RESETS);
  off.juniperTide.eligible = false; off.cedarEmber.eligible = false;
  assert.deepEqual(plain(claudeAcctView(withResets(off), true).more.resets), []);
  const on = { fetchedAt: NOW, juniperTide: { eligible: true, available: true } };
  const r = plain(claudeAcctView(withResets(on), true).more.resets);
  assert.equal(r[0].detail, 'available');
  assert.equal(r[0].usable, true);
  const none = { fetchedAt: NOW, juniperTide: { eligible: true, available: false } };
  assert.equal(plain(claudeAcctView(withResets(none), true).more.resets)[0].detail, '');
});

test('FR-CAC-65: 초기화 칸 원소 — 쓸 수 있는 줄에만 버튼', () => {
  const ctx = loadFoot();
  const app = footApp(ctx);
  ctx._local.setJson('claudeAcctOpen', ['a']);
  app._claudeAccts = [withResets(RESETS)];
  const box = app._actUsageFootEl(app._actItems().at(-1).view).children[1];
  const sec = find(box, 'cacct-resets');
  assert.ok(sec);
  const rows = sec.children.filter((c) => c.className.split(' ')[0] === 'cacct-rs');
  assert.equal(rows.length, 3);
  assert.equal(find(rows[0], 'cacct-rs-use'), null);
  assert.ok(find(rows[1], 'cacct-rs-use'));
  assert.equal(find(rows[2], 'cacct-rs-use'), null);
});

test('FR-CAC-62·63: 사용은 확인 뒤에만 보내고, 결과를 알린다. 실패 응답은 오류로 알린다', async () => {
  const calls = [], toasts = [];
  let reply = { ok: true, status: 200, data: { result: 'reset' } };
  const ctx = loadFoot({
    apiPost: (p, b) => { calls.push([p, b]); return Promise.resolve(reply) },
    apiErrText: (r) => 'E' + r.status,
    Toast: { show: (m, k) => toasts.push([m, k]) },
  });
  const app = restoreApp(ctx);
  app._claudeAcctRestore = () => Promise.resolve();
  await app._claudeAcctReset('a', { program: 'cedar_ember', grantId: 'g_1' });
  reply = { ok: true, status: 200, data: { result: 'unconfirmed' } };
  await app._claudeAcctReset('a', { program: 'juniper_tide', grantId: '' });
  reply = { ok: false, status: 400, data: { code: 'claude_account_invalid' } };
  await app._claudeAcctReset('a', { program: 'juniper_tide', grantId: '' });
  assert.deepEqual(plain(calls), [
    ['/api/claude-accounts/reset', { id: 'a', program: 'cedar_ember', grantId: 'g_1' }],
    ['/api/claude-accounts/reset', { id: 'a', program: 'juniper_tide' }],
    ['/api/claude-accounts/reset', { id: 'a', program: 'juniper_tide' }],
  ]);
  assert.deepEqual(plain(toasts), [['Reset done', 'ok'], ['Could not confirm', 'err'], ['E400', 'err']]);
});

test('FR-CAC-60·65: 펼칠 때 초기화 상태를 조용히 다시 묻는다 — 접을 때는 묻지 않는다', async () => {
  const calls = [], toasts = [];
  const ctx = loadFoot({
    apiPost: (p, b) => { calls.push([p, b]); return Promise.resolve({ ok: false, status: 409, data: {} }) },
    Toast: { show: (m, k) => toasts.push([m, k]) },
  });
  const app = footApp(ctx);
  app.agentsRender = () => {};
  app._claudeAcctRestore = () => Promise.resolve();
  await app._claudeAcctToggle('a');
  await app._claudeAcctToggle('a');
  assert.deepEqual(plain(calls), [['/api/claude-accounts/refresh', { id: 'a', resets: true }]]);
  assert.equal(toasts.length, 0, '409(1분 안) 는 알리지 않는다');
});

// ── 4단계: 자동 전환 표식·스마트 전환 메뉴·기록·알림 (FR-CAC-92·100a·111) ──

const EN4 = {
  'cacct.auto.off': 'Auto-switch off', 'cacct.auto.on': 'Auto-switch on',
  'cacct.auto.unmanaged': 'Auto-switch: unmanaged', 'cacct.auto.exhausted': 'Auto-switch: all exhausted',
  'cacct.reason.stay': 'Already on the account with the most room', 'cacct.reason.none': 'No other account',
  'cacct.trig.proactive': 'proactive', 'cacct.trig.manual': 'manual', 'cacct.by.auto': 'auto', 'cacct.by.ui': 'screen',
  'cacct.hist.deleted': 'Deleted account',
  'cacct.alert.autoswitch': 'Switched {from} → {to} ({trigger})', 'cacct.alert.relogin': '{name}: log in again',
  'cacct.alert.near_limit': '{name}: {window} at the line, nowhere to switch', 'cacct.alert.all_exhausted': 'All accounts exhausted',
  'cacct.alert.reset_available': 'a limit reset is available', 'cacct.alert.login_expiring': '{name}: login expires {d}',
  'cacct.alert.autoswitch_stopped': 'Auto-switch stopped: cswap auto is running',
};
Object.assign(EN, EN4);

test('FR-CAC-92: 자동 전환 표식은 목록 응답의 요약에서 온다', async () => {
  const ctx = loadFoot();
  assert.deepEqual(plain(ctx.claudeAcctAutoView(null)), { text: 'Auto-switch off', on: false });
  assert.deepEqual(plain(ctx.claudeAcctAutoView({ enabled: true, status: 'on' })), { text: 'Auto-switch on', on: true });
  assert.deepEqual(plain(ctx.claudeAcctAutoView({ enabled: true, status: 'exhausted' })), { text: 'Auto-switch: all exhausted', on: true });
  assert.deepEqual(plain(ctx.claudeAcctAutoView({ enabled: false, status: 'weird' })), { text: 'Auto-switch off', on: false });

  const app = footApp(ctx);
  app._claudeAccts = [ACC_A, ACC_B];
  app._claudeAcctAuto = { enabled: true, status: 'on' };
  assert.deepEqual(plain(app._actItems().at(-1).view.auto), { text: 'Auto-switch on', on: true });

  const reply = { ok: true, status: 200, data: { activeId: 'a', accounts: [ACC_A], autoswitch: { enabled: true, status: 'unmanaged' } } };
  const r = restoreApp(loadFoot({ stateFetch: () => Promise.resolve(reply) }));
  await r._claudeAcctRestore();
  assert.deepEqual(plain(r._claudeAcctAuto), { enabled: true, status: 'unmanaged' });
});

test('FR-CAC-31a·92: 스마트 전환 셋은 전략을 보내고, best 가 머물면 이유를 알린다', async () => {
  const calls = [], toasts = [];
  let reply = { ok: true, status: 200, data: { from: 'a', to: 'b' } };
  const ctx = loadFoot({
    apiPost: (p, b) => { calls.push([p, b]); return Promise.resolve(reply) },
    apiErrText: (r) => 'E' + r.status,
    Toast: { show: (m, k) => toasts.push([m, k]) },
  });
  const app = restoreApp(ctx);
  app._claudeAcctRestore = () => Promise.resolve();
  for (const s of ['next', 'next-available', 'best']) await app._claudeAcctSmart(s);
  assert.deepEqual(plain(calls.map((c) => c[1])), [{ strategy: 'next' }, { strategy: 'next-available' }, { strategy: 'best' }]);
  assert.equal(toasts.length, 0);
  reply = { ok: true, status: 200, data: { from: 'a', to: 'a', noop: true, reason: 'stay' } };
  await app._claudeAcctSmart('best');
  assert.deepEqual(plain(toasts), [['Already on the account with the most room', '']]);
  reply = { ok: false, status: 409, data: { code: 'claude_no_candidate' } };
  await app._claudeAcctSmart('next-available');
  assert.deepEqual(plain(toasts.at(-1)), ['E409', 'err']);
});

test('FR-CAC-111: 기록 줄은 계정 이름·트리거·주체를 보이고, 지워진 계정은 그렇다고 적는다', () => {
  const ctx = loadFoot();
  const at = NOW * 1000;
  const d = new Date(at);
  const stamp = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') + ' ' + clock(at);
  const rows = ctx.claudeAcctHistoryRows([
    { at: NOW, from: 'b', to: 'a', trigger: 'proactive', by: 'auto' },
    { at: NOW, from: 'gone', to: 'b', trigger: 'manual', by: 'ui' },
  ], [ACC_A, ACC_B]);
  assert.deepEqual(plain(rows[0]), { time: stamp, from: ACC_B.alias || ACC_B.email, to: 'Work', trigger: 'proactive', by: 'auto' });
  assert.equal(rows[1].from, 'Deleted account');
  assert.equal(rows[1].by, 'screen');
  assert.deepEqual(plain(ctx.claudeAcctHistoryRows(null, [])), []);
});

test('FR-CAC-100a: 알림은 토스트로 뜬다 — 전환은 ok, 나머지는 err, 모르는 사건은 무시한다', () => {
  const toasts = [];
  const ctx = loadFoot({ Toast: { show: (m, k) => toasts.push([m, k]) } });
  const app = restoreApp(ctx);
  app._onClaudeAccountAlert({ kind: 'autoswitch', from: 'ab***@', to: 'Work', trigger: 'proactive' });
  app._onClaudeAccountAlert({ kind: 'near_limit', name: 'Work', window: 'five_hour' });
  app._onClaudeAccountAlert({ kind: 'all_exhausted', resetAvailable: true });
  app._onClaudeAccountAlert({ kind: 'relogin', name: 'ab***@' });
  app._onClaudeAccountAlert({ kind: 'nonsense' });
  app._onClaudeAccountAlert(null);
  assert.deepEqual(plain(toasts), [
    ['Switched ab***@ → Work (proactive)', 'ok'],
    ['Work: Current session at the line, nowhere to switch', 'err'],
    ['All accounts exhausted · a limit reset is available', 'err'],
    ['ab***@: log in again', 'err'],
  ]);
});

// ── 계정별 statusLine 줄 (FR-CAC-78·93, D-CAC-22) ──

test('FR-CAC-93: statusLine 줄은 등록 계정(순서·색·이름) 다음 등록되지 않은 계정 순이고, 값이 없으면 줄이 없다', async () => {
  const ctx = loadFoot();
  const SLV = (pct, age) => ({ windows: { fiveHour: { pct, resetsInSec: 7800, level: pct >= 90 ? 'critical' : '' }, sevenDay: { pct: 21, level: '' } },
    observedAt: NOW - age, ageSeconds: age, stale: age > 300 });
  const a = { ...ACC_A, statusLine: SLV(34, 10) };
  const b = { ...ACC_B };
  const lines = ctx.claudeAcctStatusLines([a, b], [{ name: 'ze***@', ...SLV(95, 600) }]);
  assert.equal(lines.length, 2, '값이 없는 계정(b)은 줄이 없다');
  assert.deepEqual(plain(lines[0]), {
    key: 'a', label: 'statusLine', name: 'Work', color: 'acct-3',
    segs: [{ text: 'Session 34%', level: '' }, { text: 'Week 21%', level: '' }], reset: 'Resets in 2h 10m', asOf: '',
  });
  assert.equal(lines[1].name, 'ze***@');
  assert.equal(lines[1].color, '');
  assert.deepEqual(plain(lines[1].segs[0]), { text: 'Session 95%', level: 'critical' });
  assert.equal(lines[1].asOf, '10m ago');
  assert.deepEqual(plain(ctx.claudeAcctStatusLines(null, null)), []);

  const app = footApp(ctx);
  app._claudeAccts = [a];
  app._claudeAcctOtherSl = [];
  const v = app._actItems().at(-1).view;
  assert.deepEqual(plain(v.acctSl.map((l) => l.key)), ['a']);

  const reply = { ok: true, status: 200, data: { activeId: 'a', accounts: [a], otherStatusLines: [{ name: 'x***@', ...SLV(1, 1) }] } };
  const r = restoreApp(loadFoot({ stateFetch: () => Promise.resolve(reply) }));
  await r._claudeAcctRestore();
  assert.equal(r._claudeAcctOtherSl.length, 1);
});
