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
  const ctx = load(['core/app-agents.js', 'core/app-agents-sub.js', 'core/app-activity.js', 'core/app-claude-accounts.js'], {
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
  const ctx = loadFoot();
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
  await app._claudeAcctNext();
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
