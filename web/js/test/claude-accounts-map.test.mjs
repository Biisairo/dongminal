import assert from 'node:assert/strict';
import { test } from 'node:test';

import { load, plain } from './harness.mjs';

/**
 * CLAUDE_ACCOUNTS_SRS TC-CAC-22 — 탭 틴트·Repo 칩·Explorer 칩과 계정 메뉴 (FR-CAC-95~97·95a·85·36).
 */
const EN = {
  'cacct.map.src_tab': 'tab assignment', 'cacct.map.src_folder': 'folder {p}',
  'cacct.map.tab_title': 'Claude account: {name} ({where})', 'cacct.map.chip_title': 'Claude account: {name}',
  'cacct.map.tab_only_terminal': 'Only terminal tabs can be assigned',
  'cacct.map.no_accounts': 'No Claude accounts registered',
  'cacct.map.tab_clear': 'Remove assignment', 'cacct.map.tab_note': 'A running claude picks this up on its next start',
  'cacct.map.folder_clear': 'Unlink', 'cacct.map.folder_none': 'No account is linked to this folder',
  'cacct.pinned_running': 'This account has a pinned tab running. That tab is not affected.',
};
function fillEn(k, p) {
  if (!(k in EN)) return k;
  return EN[k].replace(/\{(\w+)\}/g, (_, n) => String(p && p[n]));
}

function loadMap() {
  return load(['core/path.js', 'core/app-claude-accounts.js', 'core/app-claude-accounts-map.js'], {
    expose: ['CLAUDE_ACCT_TINT_TAB', 'CLAUDE_ACCT_TINT_FOLDER'],
    globals: { App: class {}, t: (k, p) => fillEn(k, p) },
  });
}

const A = { id: 'a', email: 'alice@x.com', alias: 'Work', color: 'acct-3' };
const B = { id: 'b', email: 'bob@y.org', color: 'bogus' };
const ACCTS = [A, B];
const MAPS = {
  folders: { '/home/u': { accountId: 'a' }, '/home/u/repo': { accountId: 'b' }, '/gone': { accountId: 'zzz' } },
  tabs: { t1: { accountId: 'a' }, tGone: { accountId: 'zzz' } },
};

// ── 해석 (FR-CAC-81 · FR-CAC-95a) ──

test('FR-CAC-81: 탭 지정이 폴더 연결보다 앞선다', () => {
  const { claudeAcctResolve } = loadMap();
  const r = claudeAcctResolve(MAPS, ACCTS, 't1', '/home/u/repo/pkg');
  assert.equal(r.source, 'tab');
  assert.equal(r.account.id, 'a');
});

test('FR-CAC-81: 같거나 가장 가까운 상위 폴더 연결이 이긴다', () => {
  const { claudeAcctResolve } = loadMap();
  const deep = claudeAcctResolve(MAPS, ACCTS, 't2', '/home/u/repo/pkg/x');
  assert.deepEqual([deep.source, deep.account.id, deep.folder], ['folder', 'b', '/home/u/repo']);
  const same = claudeAcctResolve(MAPS, ACCTS, '', '/home/u/repo');
  assert.equal(same.account.id, 'b');
  // 이름의 앞부분만 같은 형제는 상위가 아니다.
  const sib = claudeAcctResolve(MAPS, ACCTS, '', '/home/u/repo-other');
  assert.deepEqual([sib.account.id, sib.folder], ['a', '/home/u']);
});

test('FR-CAC-81: 연결이 없으면 none 이다. 루트(/) 연결은 모든 경로의 상위다', () => {
  const { claudeAcctResolve } = loadMap();
  assert.deepEqual(plain(claudeAcctResolve(MAPS, ACCTS, '', '/opt/x')), { account: null, source: 'none' });
  const r = claudeAcctResolve({ folders: { '/': { accountId: 'a' } }, tabs: {} }, ACCTS, '', '/opt/x');
  assert.equal(r.folder, '/');
});

test('FR-CAC-81: 지워진 계정을 가리키는 탭 지정·폴더 연결은 없는 것으로 본다', () => {
  const { claudeAcctResolve } = loadMap();
  assert.equal(claudeAcctResolve(MAPS, ACCTS, 'tGone', '/opt').source, 'none');
  assert.equal(claudeAcctResolve(MAPS, ACCTS, '', '/gone/a').source, 'none');
  const r = claudeAcctResolve(MAPS, ACCTS, 'tGone', '/home/u/a');
  assert.deepEqual([r.source, r.account.id], ['folder', 'a']);
});

test('FR-CAC-95a: cwd 를 모르면 탭 지정만 본다. 매핑·계정이 비어도 깨지지 않는다', () => {
  const { claudeAcctResolve } = loadMap();
  assert.equal(claudeAcctResolve(MAPS, ACCTS, 't1', '').source, 'tab');
  assert.equal(claudeAcctResolve(MAPS, ACCTS, 't2', '').source, 'none');
  assert.equal(claudeAcctResolve(null, null, 't1', '/home/u').source, 'none');
});

test('FR-CAC-95a: 구분자가 \\ 이면(Windows) 대소문자를 가리지 않는다', () => {
  const { claudeAcctResolve, claudeAcctDirect } = loadMap();
  const maps = { folders: { 'c:\\users\\u\\repo': { accountId: 'b' } }, tabs: {} };
  const r = claudeAcctResolve(maps, ACCTS, '', 'C:\\Users\\U\\Repo\\pkg');
  assert.deepEqual([r.source, r.account.id], ['folder', 'b']);
  assert.equal(claudeAcctDirect(maps, ACCTS, 'C:\\Users\\U\\Repo').id, 'b');
  // POSIX 는 대소문자를 가린다.
  assert.equal(claudeAcctResolve(MAPS, ACCTS, '', '/Home/u').source, 'none');
});

// ── 탭 틴트 (FR-CAC-95) ──

test('FR-CAC-95: 탭 지정은 진하게(0.28), 폴더 연결은 옅게(0.14), 툴팁은 출처를 말한다', () => {
  const { claudeAcctResolve, claudeAcctTabTint, CLAUDE_ACCT_TINT_TAB, CLAUDE_ACCT_TINT_FOLDER } = loadMap();
  assert.equal(CLAUDE_ACCT_TINT_TAB, 0.28);
  assert.equal(CLAUDE_ACCT_TINT_FOLDER, 0.14);
  const tab = plain(claudeAcctTabTint(claudeAcctResolve(MAPS, ACCTS, 't1', '/home/u/repo')));
  assert.deepEqual(tab, { color: 'acct-3', alpha: 0.28, source: 'tab', title: 'Claude account: Work (tab assignment)' });
  const folder = plain(claudeAcctTabTint(claudeAcctResolve(MAPS, ACCTS, 't2', '/home/u/repo/x')));
  // 색 키가 팔레트 밖이면 첫 색이다. 이름은 별칭이 없으면 이메일이다.
  assert.deepEqual(folder, { color: 'acct-1', alpha: 0.14, source: 'folder', title: 'Claude account: bob@y.org (folder /home/u/repo)' });
});

test('FR-CAC-95: 적용되는 계정이 없으면(전역 활성 계정) 칠하지 않는다', () => {
  const { claudeAcctResolve, claudeAcctTabTint } = loadMap();
  assert.equal(claudeAcctTabTint(claudeAcctResolve(MAPS, ACCTS, 't9', '/opt')), null);
  assert.equal(claudeAcctTabTint(null), null);
});

test('FR-CAC-95: 틴트는 계정 색 변수를 그 진하기로 섞은 배경이다', () => {
  const { claudeAcctTintCss } = loadMap();
  assert.equal(claudeAcctTintCss({ color: 'acct-3', alpha: 0.28 }), 'color-mix(in srgb, var(--acct-3) 28%, transparent)');
  assert.equal(claudeAcctTintCss({ color: 'acct-1', alpha: 0.14 }), 'color-mix(in srgb, var(--acct-1) 14%, transparent)');
  assert.equal(claudeAcctTintCss(null), '');
});

// ── Repo 칩 (FR-CAC-96) ──

test('FR-CAC-96: 저장소 루트에 적용되는 폴더 연결이 있으면 칩을 단다 — 상위 연결도 적용된다', () => {
  const { claudeAcctRepoChip } = loadMap();
  assert.deepEqual(plain(claudeAcctRepoChip(MAPS, ACCTS, '/home/u/repo')),
    { text: 'bob', color: 'acct-1', title: 'Claude account: bob@y.org' });
  assert.deepEqual(plain(claudeAcctRepoChip(MAPS, ACCTS, '/home/u/other')),
    { text: 'Work', color: 'acct-3', title: 'Claude account: Work' });
  assert.equal(claudeAcctRepoChip(MAPS, ACCTS, '/opt/r'), null);
  assert.equal(claudeAcctRepoChip(MAPS, ACCTS, ''), null);
});

// ── Explorer 칩 (FR-CAC-97) ──

test('FR-CAC-97: 직접 연결된 폴더에만 칩이 붙는다 — 물려받는 하위 폴더에는 붙지 않는다', () => {
  const { claudeAcctFolderChip } = loadMap();
  assert.equal(claudeAcctFolderChip(MAPS, ACCTS, '/home/u/repo').text, 'bob');
  assert.equal(claudeAcctFolderChip(MAPS, ACCTS, '/home/u/repo/pkg'), null);
  assert.equal(claudeAcctFolderChip(MAPS, ACCTS, '/gone'), null);
});

test('FR-CAC-95a: Explorer 행의 경로는 루트의 정규화 경로에 상대 경로를 이어 정규화한다', () => {
  const { claudeAcctNormUnder } = loadMap();
  assert.equal(claudeAcctNormUnder('/var/r', '/private/var/r', '/var/r'), '/private/var/r');
  assert.equal(claudeAcctNormUnder('/var/r', '/private/var/r', '/var/r/a/b'), '/private/var/r/a/b');
  assert.equal(claudeAcctNormUnder('/var/r', '/private/var/r', '/var/rx'), '');
  assert.equal(claudeAcctNormUnder('/var/r', '', '/var/r/a'), '');
  assert.equal(claudeAcctNormUnder('C:\\R', 'c:\\r', 'C:\\R\\Sub'), 'c:\\r\\Sub');
});

// ── 메뉴 (FR-CAC-85·97·95a) ──

test('FR-CAC-85·95a: 탭 메뉴 항목 — 터미널 탭이 아니거나 계정이 없으면 사유와 함께 누를 수 없다', () => {
  const { claudeAcctTabMenuWhy } = loadMap();
  assert.equal(claudeAcctTabMenuWhy({ type: 'terminal', toolId: 't1' }, ACCTS), '');
  assert.equal(claudeAcctTabMenuWhy({ type: 'git' }, ACCTS), 'Only terminal tabs can be assigned');
  assert.equal(claudeAcctTabMenuWhy({ type: 'terminal', toolId: 't1' }, []), 'No Claude accounts registered');
});

test('FR-CAC-85·95a: 탭의 계정 메뉴 — 계정마다 하나, 지금 지정 표시, 지정이 있으면 해제, 끝에 안내', () => {
  const { claudeAcctPickItems } = loadMap();
  const items = plain(claudeAcctPickItems(ACCTS, 'a', 'tab'));
  assert.deepEqual(items, [
    { id: 'acct:a', accountId: 'a', label: 'Work', cur: true },
    { id: 'acct:b', accountId: 'b', label: 'bob@y.org', cur: false },
    { sep: true },
    { id: 'clear', accountId: '', label: 'Remove assignment' },
    { sep: true },
    { label: 'A running claude picks this up on its next start', static: true },
  ]);
  const none = plain(claudeAcctPickItems(ACCTS, '', 'tab'));
  assert.deepEqual(none.map((x) => x.id || (x.sep ? 'sep' : 'note')), ['acct:a', 'acct:b', 'sep', 'note']);
});

test('FR-CAC-97·95a: 폴더의 계정 메뉴는 안내가 없고, 해제는 메뉴 밖의 "연결 해제" 가 한다', () => {
  const { claudeAcctPickItems, claudeAcctUnlinkWhy } = loadMap();
  const items = plain(claudeAcctPickItems(ACCTS, 'b', 'folder'));
  assert.deepEqual(items.map((x) => x.id), ['acct:a', 'acct:b']);
  assert.equal(items[1].cur, true);
  assert.equal(claudeAcctUnlinkWhy(MAPS, ACCTS, '/home/u/repo'), '');
  assert.equal(claudeAcctUnlinkWhy(MAPS, ACCTS, '/home/u/repo/pkg'), 'No account is linked to this folder');
});

// ── 전환 안내 (FR-CAC-36) ──

test('FR-CAC-36: 전환 응답의 pinnedRunning 이면 안내 문구, 아니면 빈 문자열', () => {
  const { claudeAcctPinnedNotice } = loadMap();
  assert.equal(claudeAcctPinnedNotice({ from: 'a', to: 'b', pinnedRunning: true }), 'This account has a pinned tab running. That tab is not affected.');
  assert.equal(claudeAcctPinnedNotice({ from: 'a', to: 'b' }), '');
  assert.equal(claudeAcctPinnedNotice(null), '');
});

// ── App 배선 (FR-CAC-95a) ──

function mapApp(routes) {
  const calls = [];
  const ctx = load(['core/path.js', 'core/app-claude-accounts.js', 'core/app-claude-accounts-map.js'], {
    globals: {
      App: class {}, t: (k, p) => fillEn(k, p),
      TIMERS: { defer: (fn) => fn() },
      apiGet: (path, o) => {
        calls.push(path + (o && o.query ? '?' + new URLSearchParams(o.query) : ''));
        return Promise.resolve(routes(path, o && o.query));
      },
    },
  });
  const app = new ctx.App();
  app.renders = 0;
  app.render = () => { app.renders++ };
  app._claudeAccts = ACCTS;
  return { app, calls };
}
const drain = () => new Promise((r) => setImmediate(r));

test('FR-CAC-95a: 매핑을 받으면 다시 칠하고, 503 이면 화면에 아무것도 붙이지 않는다', async () => {
  let reply = { ok: true, status: 200, data: MAPS };
  const { app } = mapApp(() => reply);
  await app._claudeMapsLoad();
  assert.equal(app._claudeMaps, MAPS);
  assert.equal(app.renders, 1);
  reply = { ok: false, status: 503, data: null };
  await app._claudeMapsLoad();
  assert.equal(app._claudeMaps, null);
  assert.equal(app.claudeTabTint({ type: 'terminal', toolId: 't1' }), null);
  assert.equal(app.claudeTabMenuItem({ type: 'terminal', toolId: 't1' }, {}), null);
});

test('FR-CAC-95a: 경로는 서버에 한 번만 묻고, 답이 오면 다시 칠한다. 폴더 연결이 없으면 묻지 않는다', async () => {
  const { app, calls } = mapApp((path, q) => ({ ok: true, status: 200, data: { source: 'none', path: '/private' + q.cwd } }));
  app._claudeMaps = { folders: {}, tabs: {} };
  assert.equal(app._claudeNorm('/var/r'), '');
  assert.equal(calls.length, 0);
  app._claudeMaps = { folders: { '/private/var/r': { accountId: 'b' } }, tabs: {} };
  assert.equal(app._claudeNorm('/var/r'), '');
  assert.equal(app._claudeNorm('/var/r'), '');
  await drain();
  assert.deepEqual(calls, ['/api/claude-accounts/resolve?cwd=%2Fvar%2Fr']);
  assert.equal(app.renders, 1);
  assert.equal(app._claudeNorm('/var/r'), '/private/var/r');
  assert.equal(app.claudeRepoChip('/var/r').text, 'bob');
  assert.equal(app.claudeFolderChip('/var/r', '/var/r/x'), null);
});

test('FR-CAC-95·95a: 탭 틴트는 터미널의 cwd 보고값을 쓰고, 없으면 /api/cwd 를 도구마다 한 번 묻는다', async () => {
  const { app, calls } = mapApp((path, q) => path === '/api/cwd'
    ? { ok: true, status: 200, data: { cwd: '/home/u/repo' } }
    : { ok: true, status: 200, data: { path: q.cwd } });
  app._claudeMaps = MAPS;
  app.tools = new Map([['t3', { _cwd: '/home/u/x' }], ['t4', {}]]);
  // t3: 보고값 → 정규화를 물은 뒤 폴더 연결(옅게).
  assert.equal(app.claudeTabTint({ type: 'terminal', toolId: 't3' }), null);
  await drain();
  assert.equal(app.claudeTabTint({ type: 'terminal', toolId: 't3' }).alpha, 0.14);
  // t4: 보고값이 없다 → /api/cwd 한 번.
  app.claudeTabTint({ type: 'terminal', toolId: 't4' });
  app.claudeTabTint({ type: 'terminal', toolId: 't4' });
  await drain(); app.claudeTabTint({ type: 'terminal', toolId: 't4' }); await drain();
  assert.equal(calls.filter((c) => c.startsWith('/api/cwd')).length, 1);
  assert.equal(app.claudeTabTint({ type: 'terminal', toolId: 't4' }).folder, undefined);
  assert.equal(app.claudeTabTint({ type: 'terminal', toolId: 't4' }).title, 'Claude account: bob@y.org (folder /home/u/repo)');
  // 탭 지정은 cwd 와 무관하게 진하다.
  assert.equal(app.claudeTabTint({ type: 'terminal', toolId: 't1' }).alpha, 0.28);
});
