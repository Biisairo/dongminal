import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AGENTS, BASE, PANELS, controllers, load, plain } from './harness.mjs';

/**
 * CLAUDE_ACCOUNTS_SRS TC-CAC-21 — Activity 하단(Usage foot)의 계정 묶음과 statusLine 한 줄 (FR-CAC-90~93).
 */
const EN = {
  'usage.win.five_hour': 'Current session', 'usage.win.seven_day': 'Current week',
  'usage.used': '{n}% used', 'usage.resets_in': 'Resets in {t}', 'usage.resets_soon': 'Resets soon',
  'usage.as_of': 'as of {t}', 'usage.dur.d': '{n}d', 'usage.dur.h': '{n}h', 'usage.dur.m': '{n}m',
  'usage.short.d': '{n}d', 'usage.short.h': '{n}h', 'usage.short.m': '{n}m',
  'usage.sl.label': 'statusLine', 'usage.sl.five_hour': 'Session', 'usage.sl.seven_day': 'Week',
  'cacct.title': 'Claude accounts', 'cacct.active': 'Active', 'cacct.next': 'Next account',
  'cacct.age_min': '{n}m ago', 'cacct.retry_at': 'retry {t}',
  'cacct.st.relogin_required': 'Log in again', 'cacct.st.rate_limited': 'Rate limited',
  'cacct.pace_expected': 'Expected {n}%', 'cacct.pace_runout': 'runs out before reset at this pace ({t})',
  'cacct.pace_lasts': 'lasts until reset', 'cacct.spend': 'Extra usage {used} / {limit}',
  'cacct.login_expires': 'Login expires {d}', 'cacct.switch': 'Switch to this account', 'cacct.refresh': 'Refresh',
  'cacct.wd.3': 'Wed',
  'cacct.rs.title': 'Limit resets', 'cacct.rs.unknown': 'Press Refresh to check', 'cacct.rs.juniper': '5-hour reset', 'cacct.rs.usable': 'available',
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
    bool: (k, d) => (m.has(k) ? (d ? m.get(k) !== '0' : m.get(k) === '1') : d),
    setBool: (k, on) => { m.set(k, on ? '1' : '0'); return true },
    json: (k, d) => (m.has(k) ? JSON.parse(m.get(k)) : d),
    setJson: (k, v) => { m.set(k, JSON.stringify(v)); return true },
  };
}

function loadFoot(globals = {}) {
  const local = memStore();
  const ctx = load([...BASE, ...PANELS, 'core/helpers.js', 'core/path.js', ...AGENTS, 'core/claude-accounts-view.js', 'core/claude-accounts-controller.js', 'core/claude-maps.js'], {
    expose: ['ACTIVITY_SECTIONS', 'EscapeStack', 'ClaudeAccountsController'],
    globals: {
      App: class {},
      ACTIVITY_STATE: { ENDED: 'ended', WORKING: 'working', DONE: 'done', WAITING: 'waiting', IDLE: 'idle' },
      // FR-TIP-2: Activity 탭의 영어 툴팁 (constants-tips.js).
      TIP_USAGE_SUM_OPEN: 'Show usage', TIP_USAGE_SUM_CLOSE: 'Hide usage',
      TIP_LIMIT_STATUSLINE: 'Rate limits reported by the Claude Code statusLine',
      // REFACTOR3_FE_REST2_SRS FR-FR2-13·14: 시간 이름 (constants.js).
      MS_PER_SEC: 1000, LIMIT_STALE_MS: 10 * 60 * 1000,
      TIP_ACT_AGENTS: 'Show running agents', TIP_ACT_BG: 'Show background tools', TIP_ACT_RUNS: 'Show runs', TIP_ACT_CHATS: 'Show chat rooms',
      AGENT_STATE_ICON: { working: '●', done: '✓', waiting: '…', idle: '○' },
      PrefStore: { local },
      TIMERS: { frame: () => ({}), disposeOwner() {} },
      STORE_KEYS: { agentsGroupFold: 'agentsGroupFold', agentsSubView: 'agentsSubView', claudeAcctFold: 'claudeAcctFold', activityUsageOpen: 'activityUsageOpen' },
      UIKit: {
        iconHTML: (n) => '<i:' + n + '>',
        icon: (n) => ({ className: 'ui-icon', icon: n, children: [] }),
        button: (b) => ({ className: 'ui-btn ' + (b.cls || ''), textContent: b.label, children: [], appendChild(c) { this.children.push(c); return c } }),
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

test('FR-CAC-91: 오버레이가 닫힌 묶음은 머리와 5시간·주간 막대뿐이다', () => {
  const { claudeAcctView } = loadFoot();
  const v = plain(claudeAcctView(ACC_A, false, true));
  assert.equal(v.id, 'a');
  assert.equal(v.name, 'Work');
  assert.equal(v.title, 'a@x.com · Org A');
  assert.equal(v.color, 'acct-3');
  assert.equal(v.active, true);
  assert.equal(v.status, '');
  assert.equal(v.age, '');
  assert.equal(v.pop, false);
  assert.equal(v.wide, true);
  assert.deepEqual(v.mini, [{ label: 'Session', pct: '34%', left: '2h', fill: 34.4, level: '', title: 'Current session · 34% used · Resets in 2h 10m' },
    { label: 'Week', pct: '72%', left: '4d', fill: 72, level: 'warn', title: 'Current week · 72% used · Resets in 4d 6h' }], 'D-CAC-37: 칸 — 사용률·가장 큰 단위 하나의 남은 시간');
  assert.deepEqual(v.bars.map((b) => b.label), ['Current session', 'Current week']);
  assert.deepEqual(v.bars[0], { id: 'a:five_hour', label: 'Current session', used: '34% used', fill: 34.4, level: '',
    reset: 'Resets in 2h 10m · ' + fillEn('cacct.wd.' + new Date((NOW + 7800) * 1000).getDay()) + ' ' + clock((NOW + 7800) * 1000),
    title: 'Current session · 34% used · resets at ' + clock((NOW + 7800) * 1000) }, '남은 시간 · 초기화 시각(오늘이 아니면 요일)');
  assert.equal(v.bars[1].level, 'warn');
  assert.equal(v.more, null);
});

test('FR-CAC-91: 오버레이를 열면 scoped·예측·추가 사용량·로그인 만료·동작이 보인다', () => {
  const { claudeAcctView } = loadFoot();
  const exhaust = Date.UTC(2026, 10, 11, 9, 0) / 1000; // 수요일
  const acc = structuredClone(ACC_A);
  acc.usage.pace.sevenDay.projectedExhaustionAt = exhaust;
  acc.usage.loginExpiresAt = Date.UTC(2026, 11, 1, 12) / 1000;
  acc.usage.loginExpiringSoon = true;
  const v = plain(claudeAcctView(acc, true));
  assert.equal(v.pop, true);
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
  assert.equal(v.status, '', 'D-CAC-34: 저절로 다시 시도하는 상태는 머리에 보이지 않는다');
  assert.equal(v.more.status, 'Rate limited · retry ' + clock((NOW + 600) * 1000), '오버레이에는 보인다');
  assert.equal(v.age, '7m ago');
  const re = plain(claudeAcctView({ ...acc, usage: { ...acc.usage, status: 'relogin_required', backoffUntil: 0 } }, false));
  assert.equal(re.status, 'Log in again', '손써야 하는 상태는 머리에 보인다');
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
  assert.deepEqual(v.cells, [{ label: 'Session', pct: '34%', left: '2h', fill: 34.4, level: '', title: 'Current session · 34% used · Resets in 2h 10m' },
    { label: 'Week', pct: '91%', left: '4d', fill: 91, level: 'critical', title: 'Current week · 91% used · Resets in 4d 6h' }]);
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
  const app = controllers(ctx, new ctx.App());
  app.claude = new ctx.ClaudeAccountsController(app);   // REFACTOR3_FE_APPCTL_SRS 9b
  app._bg = []; app.runsPanel = () => ({});
  app.agents._agWindowItems = () => [];
  app.chat.chatUnreadTotal = () => 0;
  app.agents._agFolded = () => new Set();
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
/** 바닥의 첫 계정 묶음. UX_AUDIT_FIX_SRS FR-UXF-73: 데스크톱도 요약 줄이 맨 앞이라 자리로 찾지 않는다. */
const firstAcct = (foot) => foot.children.find((c) => c.className.split(' ')[0] === 'cacct');
const SL = [{ agent: 'claude', observedAt: Date.now(), windows: [{ name: 'five_hour', usedPct: 1, level: '' }] }];

test('FR-CAC-90: 계정도 statusLine 도 없으면 바닥이 없다', () => {
  const app = footApp(loadFoot());
  assert.equal(app.agents.list._actItems().some((i) => i.t === 'foot'), false);
});

test('FR-CAC-90: 계정이 없으면 statusLine 줄만, 있으면 계정 묶음 + statusLine 줄', () => {
  const app = footApp(loadFoot());
  app._limits = SL;
  let foot = app.agents.list._actItems().at(-1);
  assert.equal(foot.t, 'foot');
  assert.equal(foot.view.accounts.length, 0);
  assert.ok(foot.view.sl);

  app._claudeAccts = [ACC_A, ACC_B];
  foot = app.agents.list._actItems().at(-1);
  assert.deepEqual(plain(foot.view.accounts.map((a) => a.id)), ['a', 'b']);
  assert.equal(foot.view.next, true);
  assert.ok(foot.view.sl);

  app._limits = [];
  app._claudeAccts = [ACC_A];
  foot = app.agents.list._actItems().at(-1);
  assert.equal(foot.view.sl, null);
  assert.equal(foot.view.next, false, '전환할 다른 계정이 없으면 다음 계정 버튼이 없다');
});

test('FR-CAC-91: 모양 기본값은 활성 계정만 넓게이고, 바꾼 모양은 계정별로 기억한다', () => {
  const ctx = loadFoot();
  const app = footApp(ctx);
  let rendered = 0;
  app.agents.agentsRender = () => { rendered++ };
  app._claudeAccts = [ACC_A, ACC_B];
  const wide = () => plain(app.agents.list._actItems().at(-1).view.accounts.map((a) => a.wide));
  assert.deepEqual(wide(), [true, false]);
  app.claude._claudeAcctFoldToggle('b');
  assert.equal(rendered, 1);
  assert.deepEqual(JSON.parse(ctx._local.m.get('claudeAcctFold')), { b: true });
  assert.deepEqual(wide(), [true, true]);
  app.claude._claudeAcctFoldToggle('a');
  assert.deepEqual(JSON.parse(ctx._local.m.get('claudeAcctFold')), { b: true, a: false });
  assert.deepEqual(wide(), [false, true]);
  // 기억한 값이 없는 계정은 활성 여부를 따른다.
  ctx._local.setJson('claudeAcctFold', {});
  app._claudeAccts = [{ ...ACC_A, active: false }, { ...ACC_B, active: true }];
  assert.deepEqual(wide(), [false, true]);
});

test('FR-CAC-91: 오버레이는 한 번에 하나 — 같은 칸은 닫고, 다른 칸은 옮기고, 바깥 누름·Esc 는 닫는다', () => {
  const ctx = loadFoot({ apiPost: () => Promise.resolve({ ok: false, status: 409, data: {} }) });
  const app = footApp(ctx);
  let rendered = 0;
  app.agents.agentsRender = () => { rendered++ };
  app._claudeAccts = [ACC_A, ACC_B];
  const pops = () => plain(app.agents.list._actItems().at(-1).view.accounts.map((a) => a.pop));
  assert.deepEqual(pops(), [false, false]);
  app.claude._claudeAcctPopToggle('a');
  assert.deepEqual(pops(), [true, false]);
  app.claude._claudeAcctPopToggle('b');
  assert.deepEqual(pops(), [false, true]);
  app.claude._claudeAcctPopToggle('b');
  assert.deepEqual(pops(), [false, false]);
  assert.equal(ctx._local.m.has('claudeAcctFold'), false, '오버레이는 기억하지 않는다');

  const at = (sel) => ({ type: 'pointerdown', target: { closest: (q) => (q.split(',').includes(sel) ? {} : null) } });
  app.claude._claudeAcctPopToggle('a');
  app.claude._claudeAcctPopDismiss(at('.cacct-pop'));
  assert.deepEqual(pops(), [true, false], '오버레이 안은 닫지 않는다');
  app.claude._claudeAcctPopDismiss(at('.cacct'));
  assert.deepEqual(pops(), [true, false], '칸 누름은 칸의 처리기가 맡는다');
  // REFACTOR3_FE_ESC_SRS FR-FEE-7: Esc 는 EscapeStack 캡처 층 항목이 닫는다.
  const esc = (key) => ctx.EscapeStack.handle({ key, preventDefault() {}, stopPropagation() {} }, 'capture');
  assert.equal(esc('a'), false);
  assert.deepEqual(pops(), [true, false]);
  const n = rendered;
  app.claude._claudeAcctPopDismiss(at('.elsewhere'));
  assert.deepEqual(pops(), [false, false]);
  assert.equal(rendered, n + 1);
  app.claude._claudeAcctPopDismiss(at('.elsewhere'));
  assert.equal(rendered, n + 1, '열린 것이 없으면 다시 그리지 않는다');
  assert.equal(ctx.EscapeStack._items.length, 0, '바깥 누름으로 닫았는데 Esc 항목이 남았다');
  app.claude._claudeAcctPopToggle('b');
  assert.equal(esc('Escape'), true);
  assert.deepEqual(pops(), [false, false]);
  assert.equal(ctx.EscapeStack._items.length, 0);
});

test('FR-CAC-93: statusLine 줄은 꼭 한 줄 — 오래되면 글자 대신 흐림과 툴팁, 활성 카드는 바탕 대신 표식', () => {
  const ctx = loadFoot();
  const app = footApp(ctx);
  // MOBILE_UX_OVERHAUL_SRS FR-MUX-81: 등록 계정의 statusLine 은 줄이 되지 않는다 — 줄은 등록되지 않은 계정의 것이다.
  //   이전: 등록 계정 둘(ACC_A·ACC_B)의 statusLine 으로 두 줄을 그렸다. 지금: 같은 값을 등록되지 않은 계정 둘로 준다.
  app._claudeAccts = [
    { ...ACC_A, statusLine: { windows: { fiveHour: { pct: 34, level: '' } }, observedAt: NOW, ageSeconds: 600, stale: true } },
  ];
  app._claudeAcctOtherSl = [
    { name: 'x***@', windows: { fiveHour: { pct: 34, level: '' } }, observedAt: NOW, ageSeconds: 600, stale: true },
    { name: 'y***@', windows: { fiveHour: { pct: 5, level: '' } }, observedAt: NOW, ageSeconds: 10, stale: false },
  ];
  const foot = app.agents.list._actUsageFootEl(app.agents.list._actItems().at(-1).view);
  const rows = foot.children.filter((c) => c.className.split(' ')[0] === 'act-usage-sl');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].className, 'act-usage-sl cacct-sl stale');
  assert.match(rows[0].title, /10m ago/);
  assert.equal(find(rows[0], 'act-usage-asof'), null, '오래됨을 글자로 붙이지 않는다');
  assert.equal(rows[1].className, 'act-usage-sl cacct-sl');
  assert.deepEqual(rows[0].children.map((c) => c.className.split(' ')[0]), ['cacct-who', 'cacct-cells'], '좁은 카드와 같은 줄 모양');
  assert.equal(find(rows[0], 'cacct-cells').children.length, 2, '세션·주간 두 칸 — 값이 없는 칸도 자리를 지킨다');
});

test('FR-CAC-90·93: 바닥 원소 — 머리, 계정 묶음, 맨 아래 statusLine 줄', () => {
  const ctx = loadFoot();
  const app = footApp(ctx);
  app._claudeAccts = [ACC_A, ACC_B];
  app._limits = SL;
  const foot = app.agents.list._actUsageFootEl(app.agents.list._actItems().at(-1).view);
  // UX_AUDIT_FIX_SRS FR-UXF-73 으로 개정: 이전 — 데스크톱 바닥의 첫 원소는 계정 머리 줄이었다 / 지금 — 요약 줄
  // (`act-usage-sum`)이 맨 앞이고 저장값이 없으면 펼친 채다 / 이유 — 진단 D17·X8, 사용자 결정 D-25.
  assert.ok(foot.children[0].className.split(' ').includes('act-usage-sum'));
  const parts = foot.children.slice(1);
  const kinds = parts.map((c) => c.className.split(' ')[0]);
  assert.deepEqual(kinds, ['act-usage-head', 'cacct', 'cacct', 'act-usage-sl-h', 'act-usage-sl'], '열 이름 줄 없음 · statusLine 머리 한 줄 + 줄');
  assert.equal(find(parts[0], 'cacct-history-btn'), null, 'FR-CAC-111: 전환 기록은 Activity 에 두지 않는다');
  const [a, b] = foot.children.filter((c) => c.className.split(' ')[0] === 'cacct');
  assert.equal(a.className, 'cacct active wide');
  assert.equal(a.dataset.id, 'a');
  assert.equal(a.children[0].className, 'cacct-bar', '왼쪽 색 바가 첫 원소다');
  assert.equal(a.children[0].style.background, 'var(--acct-3)');
  const head = a.children[1];
  assert.equal(head.className, 'cacct-head');
  assert.equal(find(a, 'cacct-fold'), null, '모양은 색 바로 바꾼다 — ▸/▾ 가 없다');
  assert.equal(find(head, 'cacct-mini'), null, '넓은 모양은 머리에 작은 막대가 없다');
  assert.equal(find(head, 'cacct-dot').style.background, 'var(--acct-3)');
  assert.equal(find(head, 'cacct-name').textContent, 'Work');
  assert.equal(find(head, 'cacct-active').textContent, 'Active');
  assert.deepEqual([...a.children].slice(2).map((c) => c.className), ['act-usage-win', 'act-usage-win lv-warn']);
  assert.equal(b.className, 'cacct');
  assert.deepEqual([...b.children].map((c) => c.className), ['cacct-bar', 'cacct-head'], '좁은 모양은 머리 한 줄이다');
  assert.deepEqual(find(b.children[1], 'cacct-cells').children.map((c) => c.textContent), ['', ''], '값이 없어도 두 칸의 자리');
  assert.equal(find(a, 'cacct-pop'), null);
  assert.equal(parts[3].textContent, 'statusLine');
  const sl = parts[4];
  assert.equal(find(sl, 'cacct-cell-pct').textContent, '1%');
  assert.equal(find(sl, 'act-usage-sl-label'), null, '이름표는 머리에 한 번만');
});

test('FR-CAC-91: 오버레이 자리 — 패널 바깥 옆, 칸 높이에 맞추고 화면 안으로 당긴다. 옆에 자리가 없으면 칸 위', () => {
  const { claudeAcctPopPlace } = loadFoot();
  const card = { top: 600, bottom: 630 };
  // 패널이 오른쪽: 왼쪽에 뜬다
  assert.deepEqual(plain(claudeAcctPopPlace(card, { left: 1000, right: 1260 }, 280, 200, 1280, 900)),
    { left: 714, top: 600, width: 280, side: 'left' });
  // 화면 아래로 넘치면 위로 당긴다
  assert.deepEqual(plain(claudeAcctPopPlace({ top: 800, bottom: 830 }, { left: 1000, right: 1260 }, 280, 200, 1280, 900)),
    { left: 714, top: 694, width: 280, side: 'left' });
  // 패널이 왼쪽: 오른쪽에 뜬다
  assert.deepEqual(plain(claudeAcctPopPlace(card, { left: 0, right: 260 }, 280, 200, 1280, 900)),
    { left: 266, top: 600, width: 280, side: 'right' });
  // 옆에 자리가 없으면(모바일) 화면 폭으로 칸 위에
  assert.deepEqual(plain(claudeAcctPopPlace(card, { left: 0, right: 390 }, 280, 200, 390, 800)),
    { left: 6, top: 394, width: 378, side: 'over' });
  assert.equal(plain(claudeAcctPopPlace({ top: 100, bottom: 130 }, { left: 0, right: 390 }, 280, 200, 390, 800)).top, 6);
});

test('FR-CAC-91: 오버레이에는 요약과 동작 버튼이 있고, 활성 계정에는 전환이 없다', () => {
  const ctx = loadFoot();
  const app = footApp(ctx);
  app._claudeAccts = [ACC_A, { ...ACC_B, usage: { windows: { fiveHour: { pct: 1, level: '' } } } }];
  const render = (id) => { app._claudeAcctPopId = id; return app.agents.list._actUsageFootEl(app.agents.list._actItems().at(-1).view).children.filter((c) => c.className.split(' ')[0] === 'cacct') };
  let foot = render('a');
  const a = foot[0];
  assert.equal(a.className, 'cacct active wide pop');
  const pop = find(a, 'cacct-pop');
  assert.equal(find(pop, 'cacct-pop-title').textContent, 'a@x.com · Org A');
  const cls = (el) => el.className.split(' ')[0];
  assert.deepEqual(pop.children.map(cls), ['cacct-pop-head', 'cacct-pop-sec', 'cacct-pop-sec', 'cacct-pop-sec', 'cacct-acts'],
    '머리 / 사용량 / 기타 / 제한 초기화(조회 전 안내) / 동작');
  const head = pop.children[0];
  assert.equal(find(head, 'cacct-pop-name').textContent, 'Work');
  assert.equal(find(head, 'cacct-active').textContent, 'Active', '활성 표식은 머리에');
  const usage = pop.children[1];
  assert.deepEqual(usage.children.map(cls), ['act-usage-win', 'act-usage-win', 'act-usage-win', 'cacct-pace'], '5시간·주간·scoped, 예측은 막대 뒤');
  assert.deepEqual(pop.children[2].children.map(cls), ['cacct-spend']);
  const acts = pop.children[4];
  assert.deepEqual(acts.children.map((c) => c.className.trim()), ['ui-btn cacct-refresh'], '활성 계정은 새로 고침만');
  assert.equal(find(a, 'cacct-switch'), null);
  assert.ok(find(a, 'cacct-refresh'));
  assert.equal(find(a, 'cacct-pace').className, 'cacct-pace warn');
  assert.equal(find(a, 'cacct-spend').textContent, 'Extra usage $12.40 / $50');
  assert.equal(find(foot[1], 'cacct-pop'), null);
  foot = render('b');
  const b = foot[1];
  assert.ok(find(b, 'cacct-switch'));
  const popB = find(b, 'cacct-pop');
  assert.deepEqual(popB.children.map((c) => c.className.split(' ')[0]), ['cacct-pop-head', 'cacct-pop-sec', 'cacct-pop-sec', 'cacct-acts'], '기타 정보가 없으면 그 구역이 없다');
  assert.equal(find(popB.children[0], 'cacct-active'), null);
  assert.deepEqual(popB.children[3].children.map((c) => c.className.trim()), ['ui-btn cacct-refresh', 'ui-btn cacct-switch'], '새로 고침 왼쪽, 전환 오른쪽');
  const cell = find(b, 'cacct-cells').children[0];
  assert.equal(find(cell, 'cacct-cell-pct').textContent, '1%', '좁은 모양의 한 줄에 창마다 칸');
  assert.equal(find(cell, 'cacct-cell-label').textContent, 'Session', '칸 앞에 작은 창 이름');
  assert.equal(find(foot[0], 'cacct-pop'), null);
});

// ── 데이터 (FR-CAC-122) ──

function restoreApp(ctx) {
  const app = controllers(ctx, new ctx.App());
  app.claude = new ctx.ClaudeAccountsController(app);   // REFACTOR3_FE_APPCTL_SRS 9b
  app.wsSync._restoreBegin = () => new Set();
  app.wsSync._restoreLive = () => true;
  app.wsSync._restoreEnd = () => {};
  app.agents.agentsRender = () => {};
  return app;
}

test('FR-CAC-91: 초기화가 오늘이면 남은 시간 뒤에 시각만 붙인다', () => {
  const ctx = loadFoot();
  const at = Math.floor(ctx.Date.now() / 1000) + 120;
  const v = plain(ctx.claudeAcctView({ ...ACC_B, usage: { windows: { fiveHour: { pct: 1, resetsAt: at, resetsInSec: 120, level: '' } } } }, false, true));
  assert.equal(v.bars[0].reset, 'Resets in 2m · ' + clock(at * 1000));
});

test('FR-CAC-91: 활성 계정이 바뀌면 이전·새 활성 계정의 기억한 모양을 지운다', async () => {
  let reply;
  const ctx = loadFoot({ stateFetch: () => Promise.resolve(reply) });
  const app = restoreApp(ctx);
  reply = { ok: true, status: 200, data: { accounts: [{ ...ACC_A, active: true }, { ...ACC_B, active: false }, { ...ACC_B, id: 'c', active: false }] } };
  await app.claude._claudeAcctRestore();
  ctx._local.setJson('claudeAcctFold', { a: false, b: false, c: true });
  await app.claude._claudeAcctRestore();
  assert.deepEqual(JSON.parse(ctx._local.m.get('claudeAcctFold')), { a: false, b: false, c: true }, '활성이 그대로면 둔다');
  reply = { ok: true, status: 200, data: { accounts: [{ ...ACC_A, active: false }, { ...ACC_B, active: true }, { ...ACC_B, id: 'c', active: false }] } };
  await app.claude._claudeAcctRestore();
  assert.deepEqual(JSON.parse(ctx._local.m.get('claudeAcctFold')), { c: true });
  const wide = plain(ctx.claudeAcctFootViews(app._claudeAccts, app.claude._claudeAcctFold(), null).map((x) => x.wide));
  assert.deepEqual(wide, [false, true, true], '새 활성(b)은 넓고, 이전 활성(a)은 기본(좁음)');
});

test('FR-CAC-122: 복원이 계정 목록을 담고, 503(계정 기능 없음)이면 비운다', async () => {
  let reply = { ok: true, status: 200, data: { activeId: 'a', accounts: [ACC_A] } };
  const ctx = loadFoot({ stateFetch: () => Promise.resolve(reply) });
  const app = restoreApp(ctx);
  await app.claude._claudeAcctRestore();
  assert.deepEqual(plain(app._claudeAccts.map((a) => a.id)), ['a']);
  reply = { ok: false, status: 0, data: null };
  await app.claude._claudeAcctRestore();
  assert.equal(app._claudeAccts.length, 1, '망 실패는 마지막 값을 지우지 않는다');
  reply = { ok: false, status: 503, data: { code: 'claude_accounts_unavailable' } };
  await app.claude._claudeAcctRestore();
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
  app.claude._claudeAcctRestore = () => Promise.resolve();
  await app.claude._claudeAcctSwitch('b');
  await app.claude._claudeAcctSmart('next');
  await app.claude._claudeAcctRefresh('a');
  assert.deepEqual(plain(calls), [
    ['/api/claude-accounts/switch', { id: 'b' }],
    ['/api/claude-accounts/switch', { strategy: 'next' }],
    ['/api/claude-accounts/refresh', { id: 'a' }],
  ]);
  assert.equal(toasts.length, 0);
  reply = { ok: false, status: 409, data: { code: 'claude_too_soon' } };
  await app.claude._claudeAcctRefresh('a');
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
  app._claudeAcctPopId = 'a';
  app._claudeAccts = [withResets(RESETS)];
  const box = firstAcct(app.agents.list._actUsageFootEl(app.agents.list._actItems().at(-1).view));
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
  app.claude._claudeAcctRestore = () => Promise.resolve();
  await app.claude._claudeAcctReset('a', { program: 'cedar_ember', grantId: 'g_1' });
  reply = { ok: true, status: 200, data: { result: 'unconfirmed' } };
  await app.claude._claudeAcctReset('a', { program: 'juniper_tide', grantId: '' });
  reply = { ok: false, status: 400, data: { code: 'claude_account_invalid' } };
  await app.claude._claudeAcctReset('a', { program: 'juniper_tide', grantId: '' });
  assert.deepEqual(plain(calls), [
    ['/api/claude-accounts/reset', { id: 'a', program: 'cedar_ember', grantId: 'g_1' }],
    ['/api/claude-accounts/reset', { id: 'a', program: 'juniper_tide' }],
    ['/api/claude-accounts/reset', { id: 'a', program: 'juniper_tide' }],
  ]);
  assert.deepEqual(plain(toasts), [['Reset done', 'ok'], ['Could not confirm', 'err'], ['E400', 'err']]);
});

test('D-CAC-36: 오버레이를 열고 닫아도 서버에 묻지 않는다', async () => {
  const calls = [];
  const ctx = loadFoot({ apiPost: (p, b) => { calls.push([p, b]); return Promise.resolve({ ok: true, status: 200, data: {} }) } });
  const app = footApp(ctx);
  app.agents.agentsRender = () => {};
  await app.claude._claudeAcctPopToggle('a');
  await app.claude._claudeAcctPopToggle('a');
  assert.deepEqual(plain(calls), []);
});

test('FR-CAC-65 · D-CAC-36: 초기화 칸 머리에 조회 시각, 조회한 적이 없으면 새로 고침 안내만', () => {
  const ctx = loadFoot();
  const app = footApp(ctx);
  app._claudeAcctPopId = 'a';
  app._claudeAccts = [withResets(RESETS)];
  let sec = find(firstAcct(app.agents.list._actUsageFootEl(app.agents.list._actItems().at(-1).view)), 'cacct-resets');
  assert.ok(find(sec, 'cacct-resets-age'), '조회 시각');
  assert.equal(find(sec, 'cacct-resets-unknown'), null);
  app._claudeAccts = [ACC_A];
  sec = find(firstAcct(app.agents.list._actUsageFootEl(app.agents.list._actItems().at(-1).view)), 'cacct-resets');
  assert.equal(find(sec, 'cacct-resets-unknown').textContent, 'Press Refresh to check');
  assert.equal(sec.children.filter((c) => c.className.split(' ')[0] === 'cacct-rs').length, 0);
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
  assert.deepEqual(plain(app.agents.list._actItems().at(-1).view.auto), { text: 'Auto-switch on', on: true });

  const reply = { ok: true, status: 200, data: { activeId: 'a', accounts: [ACC_A], autoswitch: { enabled: true, status: 'unmanaged' } } };
  const r = restoreApp(loadFoot({ stateFetch: () => Promise.resolve(reply) }));
  await r.claude._claudeAcctRestore();
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
  app.claude._claudeAcctRestore = () => Promise.resolve();
  for (const s of ['next', 'next-available', 'best']) await app.claude._claudeAcctSmart(s);
  assert.deepEqual(plain(calls.map((c) => c[1])), [{ strategy: 'next' }, { strategy: 'next-available' }, { strategy: 'best' }]);
  assert.equal(toasts.length, 0);
  reply = { ok: true, status: 200, data: { from: 'a', to: 'a', noop: true, reason: 'stay' } };
  await app.claude._claudeAcctSmart('best');
  assert.deepEqual(plain(toasts), [['Already on the account with the most room', '']]);
  reply = { ok: false, status: 409, data: { code: 'claude_no_candidate' } };
  await app.claude._claudeAcctSmart('next-available');
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
  app.claude._onClaudeAccountAlert({ kind: 'autoswitch', from: 'ab***@', to: 'Work', trigger: 'proactive' });
  app.claude._onClaudeAccountAlert({ kind: 'near_limit', name: 'Work', window: 'five_hour' });
  app.claude._onClaudeAccountAlert({ kind: 'all_exhausted', resetAvailable: true });
  app.claude._onClaudeAccountAlert({ kind: 'relogin', name: 'ab***@' });
  app.claude._onClaudeAccountAlert({ kind: 'nonsense' });
  app.claude._onClaudeAccountAlert(null);
  assert.deepEqual(plain(toasts), [
    ['Switched ab***@ → Work (proactive)', 'ok'],
    ['Work: Current session at the line, nowhere to switch', 'err'],
    ['All accounts exhausted · a limit reset is available', 'err'],
    ['ab***@: log in again', 'err'],
  ]);
});

// ── 계정별 statusLine 줄 (FR-CAC-78·93, D-CAC-22) ──

// MOBILE_UX_OVERHAUL_SRS FR-MUX-81 (TC-MUX-29): 등록 계정의 줄은 없다.
//   이전: 등록 계정(순서·색·이름) 다음 등록되지 않은 계정 순 (D-CAC-22)
//   지금: 등록되지 않은 계정의 줄만 — 등록 계정의 값은 묶음 막대(OAuth·statusLine 중 큰 값, D-CAC-35)가 보인다
test('FR-CAC-93 · FR-MUX-81: statusLine 줄은 등록되지 않은 계정의 것뿐이고, 값이 없으면 줄이 없다', async () => {
  const ctx = loadFoot();
  const SLV = (pct, age) => ({ windows: { fiveHour: { pct, resetsInSec: 7800, level: pct >= 90 ? 'critical' : '' }, sevenDay: { pct: 21, level: '' } },
    observedAt: NOW - age, ageSeconds: age, stale: age > 300 });
  const a = { ...ACC_A, statusLine: SLV(34, 10) };
  const lines = ctx.claudeAcctStatusLines([{ name: 'wo***@', ...SLV(34, 10) }, { name: 'em***@' }, { name: 'ze***@', ...SLV(95, 600) }]);
  assert.equal(lines.length, 2, '값이 없는 계정(em***@)은 줄이 없다');
  assert.deepEqual(plain(lines[0]), {
    key: 'other:wo***@', label: 'statusLine', name: 'wo***@', color: '',
    cells: [{ label: 'Session', pct: '34%', left: '2h', fill: 34, level: '', title: 'Current session · 34% used · Resets in 2h 10m' },
      { label: 'Week', pct: '21%', left: '', fill: 21, level: '', title: 'Current week · 21% used' }], asOf: '',
  });
  assert.equal(lines[1].name, 'ze***@');
  assert.equal(lines[1].color, '');
  assert.deepEqual([lines[1].cells[0].pct, lines[1].cells[0].level], ['95%', 'critical']);
  assert.equal(lines[1].asOf, '10m ago');
  assert.deepEqual(plain(ctx.claudeAcctStatusLines(null)), []);

  const app = footApp(ctx);
  app._claudeAccts = [a];
  app._claudeAcctOtherSl = [];
  const v = app.agents.list._actItems().at(-1).view;
  assert.deepEqual(plain(v.acctSl.map((l) => l.key)), [], '등록 계정(a)의 statusLine 은 줄이 되지 않는다');

  const reply = { ok: true, status: 200, data: { activeId: 'a', accounts: [a], otherStatusLines: [{ name: 'x***@', ...SLV(1, 1) }] } };
  const r = restoreApp(loadFoot({ stateFetch: () => Promise.resolve(reply) }));
  await r.claude._claudeAcctRestore();
  assert.equal(r._claudeAcctOtherSl.length, 1);
});
