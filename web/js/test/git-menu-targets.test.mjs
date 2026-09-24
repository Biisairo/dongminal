import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { load, plain } from './harness.mjs';

/**
 * REPO_FIX 05 §3A-2 (F-1) — 확인창에 보인 대상만 실행한다.
 *
 * 확인창이 떠 있는 동안 선택·refs·untracked 가 바뀌어도 실행은 확인 **전의**
 * 계산을 따른다. 항목은 메뉴 정의에서 열거한다 — 새 파괴적 항목이 표에 없으면
 * 이 검사가 실패한다.
 */
const FILES = ['git/menu.js', 'git/branches-ops.js', 'git/panel-views.js'];
const SRC = FILES.map((f) =>
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', f), 'utf8')).join('\n');

const LOCAL = 'local', REMOTE = 'remote';

function world() {
  const log = [];
  const rec = (name) => (...a) => { log.push([name, ...a]); return { ok: true, data: {} } };
  const recNS = (name) => new Proxy({}, { get: (_, k) => rec(name + '.' + String(k)) });
  const consts = {};
  for (const m of SRC.matchAll(/\bGIT_[A-Z0-9_]+\b/g)) consts[m[0]] = m[0];
  delete consts.GIT_MENUS; delete consts.GIT_MENU_PRIMARY;
  consts.GIT_REF_KIND_LOCAL = LOCAL; consts.GIT_REF_KIND_REMOTE = REMOTE; consts.GIT_BR_PREFIX_SEP = '/';
  const dialog = { onConfirm: null, shown: [] };
  const ctx = load(FILES, {
    globals: {
      ...consts,
      t: (k) => k,
      gitShQuote: (s) => s,
      GitPanel: class {},
      GitBranches: {},
      GitTag: recNS('GitTag'),
      GitCommitOps: new Proxy({}, { get: (_, k) =>
        k === 'label' ? (t) => 'commit ' + t.oid : k === 'whyHead' || k === 'whyDrop' ? () => ''
          : k === '_restoreCmd' ? () => '' : rec('GitCommitOps.' + String(k)) }),
      GitStash: { label: (t) => 'stash ' + t.oid, ref: (i) => 'stash@{' + i + '}' },
      GitDialog: {
        async confirm(o) {
          dialog.shown.push(o.targets);
          if (dialog.onConfirm) dialog.onConfirm();
          return true;
        },
        open: async () => 'cancel',
      },
      UIKit: { closeMenu() {}, menu: () => ({ dataset: {} }) },
      Toast: { show: rec('Toast.show') },
      TOAST_ERR_MS: 0,
    },
  });
  const panel = Object.create(ctx.GitPanel.prototype);
  const state = {
    sel: ['feat'],
    refs: [{ kind: LOCAL, short: 'feat', upstream: 'origin/feat', oid: 'o1' }],
    untracked: ['a.txt'],
  };
  Object.assign(panel, {
    repo: '/r',
    _writing: false,
    _status: { status: { oid: 'h1' } },
    get _knownRefs() { return state.refs },
    _branchesView: { selection: () => state.sel.slice(), clearSelection() {} },
    post: async (url, body) => { log.push(['post', url, body]); return { ok: true, data: {} } },
    postJob: async (url, body) => { log.push(['post', url, body]); return { ok: true, data: {} } },
    _remote: () => ({
      run: async (kind, body) => { log.push(['remote', kind, body]); return { ok: true, data: { job: { id: 'j' } } } },
      awaitJob: async () => ({ exitCode: 0 }),
    }),
    afterRefWrite() {}, applyWriteFail() {}, _after() {}, _paint() {}, isDirty: () => false,
    untrackedPaths: () => state.untracked.slice(),
    stashDrop: rec('stashDrop'),
    uncommittedClean: undefined,
  });
  ctx.app = { gitPanel: panel };
  return { ctx, panel, state, log, dialog };
}

/** 확인창이 떠 있는 동안 바뀌는 것 — 선택이 넓어지고, 짝이 모호해지고, untracked 가 늘어난다. */
function mutate(state) {
  state.sel = ['feat', 'other', 'third'];
  state.refs = state.refs.concat([{ kind: LOCAL, short: 'feat2', upstream: 'origin/feat', oid: 'o2' }]);
  state.untracked = ['a.txt', 'b.txt'];
}

const FIXTURES = {
  commit: [{ oid: 'c1', abbrev: 'c1', subject: 's' }],
  branch: [
    { kind: LOCAL, short: 'feat', upstream: 'origin/feat', oid: 'o1' },
    { kind: REMOTE, short: 'origin/feat', oid: 'o1' },
  ],
  tag: [{ short: 'v1' }],
  stash: [{ oid: 's1', index: 0, message: 'm' }],
  uncommitted: [{}],
};

/**
 * 실행이 확인창의 대상과 어떻게 맞아야 하는가. `same` 은 "바뀐 뒤에도 확인 전과
 * 같은 일을 한다", `abort` 는 "확인 뒤 대상이 달라졌으면 실행하지 않고 사유를
 * 보인다"(서버가 대상 목록을 받지 않는 Clean).
 */
const EXPECT = {
  'commit/checkout-detached': 'same', 'commit/drop': 'same',
  'branch/rebase': 'same', 'branch/delete': 'same', 'branch/delete-both': 'same',
  'tag/checkout': 'same', 'tag/delete': 'same', 'tag/delete-remote': 'same',
  'stash/drop': 'same',
  'uncommitted/clean': 'abort',
};

function patch(w) {
  // panel-files.js 의 Clean 을 실제로 쓴다 — 대상 대조가 그 안에 있다.
  const pf = load(['git/panel-files.js'], { globals: {
    GitPanel: class {}, Toast: w.ctx.Toast, TOAST_ERR_MS: 0, GIT_UNC_CLEAN_CHANGED: 'changed' } });
  w.panel.uncommittedClean = pf.GitPanel.prototype.uncommittedClean;
}

async function runItem(kind, id, target, mutating) {
  const w = world();
  patch(w);
  const it = w.ctx.GIT_MENUS[kind].find((x) => x.id === id);
  if (mutating) w.dialog.onConfirm = () => mutate(w.state);
  await w.ctx.GitMenu._pick(it, target);
  return { log: JSON.parse(JSON.stringify(w.log)), shown: plain(w.dialog.shown[0]) };
}

test('F-1: 파괴적·경고 항목은 모두 표에 있다 (누락 없음)', () => {
  const { ctx } = world();
  const ids = [];
  for (const [kind, items] of Object.entries(ctx.GIT_MENUS)) {
    for (const it of items) if (!it.sep && (it.warn || it.destructive)) ids.push(kind + '/' + it.id);
  }
  assert.deepEqual(ids.sort(), Object.keys(EXPECT).sort());
});

test('F-1: 확인창이 떠 있는 동안 상태가 바뀌어도 확인한 것만 실행한다', async () => {
  const { ctx } = world();
  for (const [kind, items] of Object.entries(ctx.GIT_MENUS)) {
    for (const it of items) {
      if (it.sep || !(it.warn || it.destructive)) continue;
      for (const target of FIXTURES[kind]) {
        if (it.disabled && it.disabled(target)) continue;
        const key = kind + '/' + it.id + '@' + (target.kind || '-');
        const base = await runItem(kind, it.id, target, false);
        const moved = await runItem(kind, it.id, target, true);
        assert.ok(base.log.length, key + ': 기준 실행이 무언가를 한다');
        assert.deepEqual(moved.shown, base.shown, key + ': 확인창 대상은 확인 전에 계산된다');
        if (EXPECT[kind + '/' + it.id] === 'same') {
          assert.deepEqual(moved.log, base.log, key + ': 확인 뒤 바뀐 상태를 다시 읽지 않는다');
        } else {
          assert.ok(!moved.log.some((e) => e[0] === 'post'), key + ': 대상이 달라졌으면 실행하지 않는다');
          assert.ok(moved.log.some((e) => e[0] === 'Toast.show'), key + ': 사유를 보인다');
        }
      }
    }
  }
});

test('F-1: Delete both 는 확인창의 한 쌍만 지운다 (다중 선택으로 넓어지지 않는다)', async () => {
  const w = world();
  const it = w.ctx.GIT_MENUS.branch.find((x) => x.id === 'delete-both');
  w.state.sel = ['feat', 'other'];
  await w.ctx.GitMenu._pick(it, FIXTURES.branch[0]);
  assert.deepEqual(plain(w.dialog.shown[0]), ['feat', 'origin/feat']);
  const del = w.log.find((e) => e[0] === 'post' && e[1] === '/api/git/branch/delete');
  assert.deepEqual(plain(del[2].names), ['feat']);
  const rm = w.log.find((e) => e[0] === 'remote');
  assert.deepEqual([rm[1], rm[2].remote, rm[2].branch], ['branch/delete-remote', 'origin', 'feat']);
});

test('F-1: 로컬 Delete 는 확인창에 보인 다중 선택 그대로를 지운다', async () => {
  const w = world();
  const it = w.ctx.GIT_MENUS.branch.find((x) => x.id === 'delete');
  w.state.sel = ['feat', 'other'];
  w.dialog.onConfirm = () => { w.state.sel = ['feat'] };
  await w.ctx.GitMenu._pick(it, FIXTURES.branch[0]);
  const del = w.log.find((e) => e[0] === 'post' && e[1] === '/api/git/branch/delete');
  assert.deepEqual(plain(del[2].names), ['feat', 'other']);
});

test('FR-GIT-277 개정: Clean 은 확인창에 보인 목록을 paths 로 싣는다 (서버가 그것만 지운다)', async () => {
  const w = world();
  patch(w);
  const it = w.ctx.GIT_MENUS.uncommitted.find((x) => x.id === 'clean');
  w.state.untracked = ['a.txt', 'd/b.txt'];
  await w.ctx.GitMenu._pick(it, FIXTURES.uncommitted[0]);
  const req = w.log.find((e) => e[0] === 'post' && e[1] === '/api/git/uncommitted/clean');
  assert.deepEqual(plain(req[2]), { repo: '/r', confirm: true, paths: ['a.txt', 'd/b.txt'] });
});
