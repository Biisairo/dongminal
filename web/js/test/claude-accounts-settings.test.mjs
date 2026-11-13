import assert from 'node:assert/strict';
import { test } from 'node:test';

import { load, plain } from './harness.mjs';

/**
 * CLAUDE_ACCOUNTS_SRS TC-CAC-30 (JS) — 설정 "Claude 계정" 구역의 뷰 모델 (FR-CAC-94·94a·34a·88b).
 */
const EN = {
  'cacct.st.relogin_required': 'Log in again',
  'cacct.set.login_unknown': 'Login expiry unknown', 'cacct.login_expires': 'Login expires {d}',
  'cacct.set.warn_links': 'Shared items not linked: {names}',
  'cacct.hist.deleted': 'Deleted account',
  'cacct.set.auto_threshold': 'Threshold', 'cacct.set.auto_interval': 'Check interval',
  'cacct.set.auto_bad': '{field} is out of range',
  'cacct.set.unclaimed_row': '{t} · fingerprint {fp}',
};
function fillEn(k, p) {
  if (!(k in EN)) return k;
  return EN[k].replace(/\{(\w+)\}/g, (_, n) => String(p && p[n]));
}

function loadSet() {
  return load(['core/path.js', 'core/app-agents.js', 'core/app-agents-sub.js', 'core/app-activity.js', 'core/app-claude-accounts.js',
    'core/app-claude-accounts-map.js', 'core/app-settings-claude.js'], {
    expose: ['CACCT_AUTO_FIELDS'],
    globals: {
      App: class {}, t: (k, p) => fillEn(k, p),
      ACTIVITY_STATE: { ENDED: 'ended', WORKING: 'working', DONE: 'done', WAITING: 'waiting', IDLE: 'idle' },
      AGENT_STATE_ICON: { working: '●', done: '✓', waiting: '…', idle: '○' },
      PrefStore: { local: { json: (k, d) => d, setJson: () => true } },
      STORE_KEYS: {},
      UIKit: { iconHTML: () => '' },
    },
  });
}

const ymd = (s) => { const d = new Date(s * 1000); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') };

// ── 계정 줄 (FR-CAC-94a) ──

test('FR-CAC-94a: 계정 줄 — 이름·이메일·조직·칸 값·로그인 만료·상태·링크 경고', () => {
  const { cacctSetRows } = loadSet();
  const exp = 1_800_000_000;
  const rows = plain(cacctSetRows([
    { id: 'a', email: 'a@x.com', organizationName: 'Org', alias: 'Work', color: 'acct-2', threshold: 85, priority: 3, disabled: true,
      usage: { status: 'relogin_required', loginExpiresAt: exp, loginExpiringSoon: true }, profileWarnings: ['skills', 'plugins'] },
    { id: 'b', email: 'b@y.org', color: 'bogus', priority: 0, disabled: false, usage: { status: 'ok' } },
  ]));
  assert.deepEqual(rows[0], { id: 'a', name: 'Work', email: 'a@x.com', org: 'Org', color: 'acct-2', alias: 'Work',
    threshold: '85', priority: '3', disabled: true,
    login: { text: 'Login expires ' + ymd(exp), warn: true }, status: 'Log in again',
    warnings: 'Shared items not linked: skills, plugins' });
  assert.deepEqual(rows[1], { id: 'b', name: 'b@y.org', email: 'b@y.org', org: '', color: 'acct-1', alias: '',
    threshold: '', priority: '0', disabled: false,
    login: { text: 'Login expiry unknown', warn: false }, status: '', warnings: '' });
  assert.deepEqual(plain(cacctSetRows(null)), []);
});

test('FR-CAC-94a: 칸 하나의 저장 본문 — 별칭·문턱값(비우면 전역)·우선순위·제외·색', () => {
  const { cacctItemPatch } = loadSet();
  assert.deepEqual(plain(cacctItemPatch('a', 'alias', ' Home ')), { id: 'a', alias: 'Home' });
  assert.deepEqual(plain(cacctItemPatch('a', 'threshold', '70')), { id: 'a', threshold: 70 });
  assert.deepEqual(plain(cacctItemPatch('a', 'threshold', '')), { id: 'a', clearThreshold: true });
  assert.deepEqual(plain(cacctItemPatch('a', 'priority', '12')), { id: 'a', priority: 12 });
  assert.deepEqual(plain(cacctItemPatch('a', 'disabled', true)), { id: 'a', disabled: true });
  assert.deepEqual(plain(cacctItemPatch('a', 'color', 'acct-5')), { id: 'a', color: 'acct-5' });
  // 숫자가 아니면 보내지 않는다 — 서버 값으로 되돌린다.
  assert.equal(cacctItemPatch('a', 'threshold', 'abc'), null);
  assert.equal(cacctItemPatch('a', 'priority', '1.5'), null);
});

test('FR-CAC-13·94a: 끌어 놓은 뒤의 순서 — 놓은 줄의 앞 또는 뒤', () => {
  const { cacctReorder } = loadSet();
  assert.deepEqual(plain(cacctReorder(['a', 'b', 'c'], 'c', 'a', true)), ['c', 'a', 'b']);
  assert.deepEqual(plain(cacctReorder(['a', 'b', 'c'], 'a', 'c', false)), ['b', 'c', 'a']);
  assert.equal(cacctReorder(['a', 'b'], 'a', 'a', true), null);
  assert.equal(cacctReorder(['a', 'b'], 'x', 'a', true), null);
});

// ── 폴더 연결 (FR-CAC-94·94a) ──

test('FR-CAC-94: 폴더 연결 — 경로 순, 하위 연결은 들여 쓰고 덮어씀 표시, 지워진 계정은 그렇다고 적는다', () => {
  const { cacctFolderRows } = loadSet();
  const rows = plain(cacctFolderRows({
    '/r/a/b': { accountId: 'b' }, '/r': { accountId: 'a' }, '/r/a': { accountId: 'a' }, '/q': { accountId: 'zzz' }, '/r-x': { accountId: 'b' },
  }, [{ id: 'a', email: 'a@x.com', alias: 'Work', color: 'acct-3' }, { id: 'b', email: 'b@y.org', color: 'acct-4' }]));
  assert.deepEqual(rows.map((r) => [r.path, r.depth, r.overrides, r.name, r.color]), [
    ['/q', 0, false, 'Deleted account', ''],
    ['/r', 0, false, 'Work', 'acct-3'],
    ['/r/a', 1, true, 'Work', 'acct-3'],
    ['/r/a/b', 2, true, 'b@y.org', 'acct-4'],
    ['/r-x', 0, false, 'b@y.org', 'acct-4'],
  ]);
  assert.deepEqual(plain(cacctFolderRows(null, [])), []);
});

// ── 자동 전환 (FR-CAC-70·94a) ──

test('FR-CAC-94a: 자동 전환 칸 → 바뀐 키만 담은 PUT 본문', () => {
  const { cacctAutoBody, CACCT_AUTO_FIELDS } = loadSet();
  assert.deepEqual(plain(CACCT_AUTO_FIELDS.map((f) => f.key)),
    ['threshold', 'weeklyThreshold', 'intervalSeconds', 'cooldownSeconds', 'hysteresisPct', 'unhealthyTicks']);
  const prev = { enabled: false, threshold: 90, intervalSeconds: 60, cooldownSeconds: 300, hysteresisPct: 10,
    strategy: 'best', unhealthyTicks: 3, weeklyThreshold: 95, models: ['Opus'] };
  const form = { enabled: true, threshold: '90', weeklyThreshold: '', intervalSeconds: '120', cooldownSeconds: '300',
    hysteresisPct: '10', strategy: 'consume-first', unhealthyTicks: '3', models: ' Opus , Sonnet ,' };
  assert.deepEqual(plain(cacctAutoBody(prev, form)), { body: { enabled: true, weeklyThreshold: null, intervalSeconds: 120,
    strategy: 'consume-first', models: ['Opus', 'Sonnet'] }, bad: '' });
  assert.deepEqual(plain(cacctAutoBody(prev, { ...form, models: 'all' })).body.models, 'all');
  assert.deepEqual(plain(cacctAutoBody({ ...prev, models: 'all' }, { ...form, models: '' })).body.models, null);
  // 그대로면 빈 본문이다.
  const same = { enabled: false, threshold: '90', weeklyThreshold: '95', intervalSeconds: '60', cooldownSeconds: '300',
    hysteresisPct: '10', strategy: 'best', unhealthyTicks: '3', models: 'Opus' };
  assert.deepEqual(plain(cacctAutoBody(prev, same)), { body: {}, bad: '' });
  // 숫자가 아니면 보내지 않고 그 칸을 알린다.
  assert.deepEqual(plain(cacctAutoBody(prev, { ...same, intervalSeconds: 'x' })), { body: null, bad: 'Check interval is out of range' });
  assert.deepEqual(plain(cacctAutoBody(prev, { ...same, threshold: '' })), { body: null, bad: 'Threshold is out of range' });
});

test('FR-CAC-94a: 자동 전환 설정 → 칸 값', () => {
  const { cacctAutoForm } = loadSet();
  assert.deepEqual(plain(cacctAutoForm({ enabled: true, threshold: 90, intervalSeconds: 60, cooldownSeconds: 300, hysteresisPct: 10,
    strategy: 'best', unhealthyTicks: 3 })), { enabled: true, threshold: '90', weeklyThreshold: '', intervalSeconds: '60',
    cooldownSeconds: '300', hysteresisPct: '10', strategy: 'best', unhealthyTicks: '3', models: '' });
  assert.equal(cacctAutoForm({ models: ['A', 'B'] }).models, 'A, B');
  assert.equal(cacctAutoForm({ models: 'all' }).models, 'all');
});

// ── 보관된 자격증명 (FR-CAC-34a) ──

test('FR-CAC-34a: 보관 목록 줄 — 시각과 지문', () => {
  const { cacctUnclaimedRows, claudeAcctDate, limitClock } = loadSet();
  const at = 1_794_000_000;
  assert.deepEqual(plain(cacctUnclaimedRows([{ name: at + '-aaaaaaaaaaaa.json', at, fingerprint: 'aaaaaaaaaaaa' }])), [
    { name: at + '-aaaaaaaaaaaa.json', fp: 'aaaaaaaaaaaa', text: claudeAcctDate(at * 1000) + ' ' + limitClock(at * 1000) + ' · fingerprint aaaaaaaaaaaa' },
  ]);
  assert.deepEqual(plain(cacctUnclaimedRows(undefined)), []);
});
