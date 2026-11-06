import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { load } from './harness.mjs';

/**
 * REPO_FIX 05 §3A-7 (F-9.2·9.3·9.5) — 브랜치·원격 피드백.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const MENU = ['git/menu-items.js', 'git/menu.js'].map((f) => readFileSync(join(HERE, '..', f), 'utf8')).join('\n');

function consts(src) {
  const out = {};
  for (const m of src.matchAll(/\bGIT_[A-Z0-9_]+\b/g)) out[m[0]] = m[0];
  return out;
}

// ── F-9.2 → SERVER_DRIVEN_ACTIONS_SRS GR-1e: 메뉴 항목은 서버 동작의 답을 그린다 ──

const GIT_ACTION_IDS = {
  fetch: 'git.fetch', pull: 'git.pull', push: 'git.push',
  branchPush: 'git.branch.push', branchFetch: 'git.branch.fetch', branchDeleteRemote: 'git.branch.delete_remote',
  tagPush: 'git.tag.push', tagDeleteRemote: 'git.tag.delete_remote',
  write: 'git.write', commit: 'git.commit', lockRemove: 'git.lock.remove',
  worktreeCreate: 'git.worktree.create', worktreeRemove: 'git.worktree.remove',
  submoduleUpdate: 'git.submodule.update', stashCreate: 'git.stash.create',
  commitCherryPick: 'git.commit.cherry_pick', commitRevert: 'git.commit.revert', commitReset: 'git.commit.reset', commitDrop: 'git.commit.drop',
  branchCheckout: 'git.branch.checkout', branchCheckoutLocal: 'git.branch.checkout_local', branchRename: 'git.branch.rename',
  branchMerge: 'git.branch.merge', branchRebase: 'git.branch.rebase', branchUpstreamSet: 'git.branch.upstream_set',
  branchUpstreamUnset: 'git.branch.upstream_unset', branchDelete: 'git.branch.delete', branchDeleteBoth: 'git.branch.delete_both',
  stashNew: 'git.stash.new', uncommittedReset: 'git.uncommitted.reset', uncommittedClean: 'git.uncommitted.clean',
};

/** answers: 동작 ID → 답. 없는 ID 는 답이 아직 없는 것이다. */
function menuWorld(answers) {
  const c = consts(MENU);
  delete c.GIT_MENUS; delete c.GIT_MENU_PRIMARY;
  Object.assign(c, { GIT_REF_KIND_LOCAL: 'local', GIT_REF_KIND_REMOTE: 'remote', GIT_ACTION: GIT_ACTION_IDS });
  const ctx = load(['git/menu-items.js', 'git/menu.js'], {
    globals: {
      ...c, t: (k) => k,
      actionState: (a, pending) => (pending ? { enabled: false, why: '' } : !a ? { enabled: false, why: 'LOADING' }
        : a.ok ? { enabled: true, why: '' } : { enabled: false, why: 'WHY:' + a.why }),
      GitTag: { oidOf: () => '' }, GitCommitOps: { whyHead: () => '', whyDrop: () => '', label: () => '', _restoreCmd: () => '' },
      GitStash: { label: () => '', ref: () => '' }, GitBranches: { restoreRemoteCmd: () => '' },
      gitShQuote: (s) => s, UIKit: { closeMenu() {}, menu: () => ({ dataset: {} }) },
    },
  });
  ctx.app = { gitPanel: {
    statusOf: () => ({}), branchDeletePair: () => ({ local: { short: 'f', isHead: false }, remote: 'o/f', why: '' }),
    branchDeleteTargets: (t) => [t.short], untrackedPaths: () => ['u'], dirtyCount: () => 1,
    actionOf: (id) => answers[id] || null,
  } };
  return ctx;
}

const TARGETS = {
  commit: { oid: 'c', abbrev: 'c', subject: 's' },
  branch: { kind: 'local', short: 'f', upstream: 'o/f', isHead: false, oid: 'o' },
  tag: { short: 'v' }, stash: { oid: 's', index: 0 }, uncommitted: {}, file: { path: 'a' },
};

const REMOTE_BRANCH = { kind: 'remote', short: 'o/f', isHead: false, oid: 'o' };

function allOk() {
  const a = {};
  for (const id of Object.values(GIT_ACTION_IDS)) a[id] = { ok: true };
  return a;
}

test('GR-1e: 항목이 기대는 동작의 답이 거짓이면 그 항목만 서버의 사유로 비활성이다', () => {
  for (const denied of ['git.write', 'git.stash.new', 'git.uncommitted.reset', 'git.uncommitted.clean', 'git.tag.push', 'git.tag.delete_remote']) {
    const answers = allOk();
    answers[denied] = { ok: false, why: 'job_busy' };
    const ctx = menuWorld(answers);
    let hits = 0;
    for (const [kind, items] of Object.entries(ctx.GIT_MENUS)) {
      for (const it of items) {
        if (it.sep || !it.busy) continue;
        for (const t of kind === 'branch' ? [TARGETS.branch, REMOTE_BRANCH] : [TARGETS[kind]]) {
          if (it.disabled && it.disabled(t)) continue;
          const ids = [].concat(typeof it.busy === 'function' ? it.busy(t) : it.busy);
          const why = ctx.GitMenu._why(it, t);
          if (ids.includes(denied)) { hits++; assert.equal(why, 'WHY:job_busy', kind + '/' + it.id + ' @' + denied) }
          else assert.equal(why, '', kind + '/' + it.id + ' @' + denied);
        }
      }
    }
    assert.ok(hits > 0, denied + ' 에 기대는 항목이 하나도 없다 — 검사가 공회전한다');
  }
});

test('GR-1e: 답이 아직 없으면 항목은 loading 으로 비활성이다 (FR-SDA-6)', () => {
  const ctx = menuWorld({});
  const it = ctx.GIT_MENUS.stash.find((x) => x.id === 'apply');
  assert.equal(ctx.GitMenu._why(it, TARGETS.stash), 'LOADING');
});

test('GT-f: act 항목은 대상의 2층 답을 그린다 — 묻는 중(null)이면 loading 이다', () => {
  const ctx = menuWorld(allOk());
  const it = ctx.GIT_MENUS.commit.find((x) => x.id === 'cherry-pick');
  assert.equal(it.act, 'git.commit.cherry_pick');
  assert.equal(ctx.GitMenu._why(it, { ...TARGETS.commit, answers: null }), 'LOADING');
  assert.equal(ctx.GitMenu._why(it, { ...TARGETS.commit, answers: { 'git.commit.cherry_pick': { ok: true } } }), '');
  assert.equal(ctx.GitMenu._why(it, { ...TARGETS.commit,
    answers: { 'git.commit.cherry_pick': { ok: false, why: 'target_is_head' } } }), 'WHY:target_is_head');
});

test('F-9.2: 저장소를 바꾸는 메뉴 항목은 모두 서버 동작의 답을 본다', () => {
  const ctx = menuWorld(allOk());
  const pure = new Set(['copy-hash', 'copy-subject', 'copy-name', 'copy-branch-name', 'compare-mark', 'compare-with',
    'openChanges', 'openFile', 'openFileHead', 'copyPath', 'fileHistory', 'blame', 'open-changes']);
  for (const [kind, items] of Object.entries(ctx.GIT_MENUS)) {
    for (const it of items) {
      if (it.sep || pure.has(it.id)) continue;
      assert.ok(it.busy || it.act, kind + '/' + it.id + ' 에 busy·act 가 없다');
    }
  }
});

// ── F-9.5: 이름 검증 세대 ──

function nameWorld(file, cls) {
  const src = readFileSync(join(HERE, '..', file), 'utf8');
  const pending = [];
  const ctx = load([file], {
    globals: {
      ...consts(src),
      GIT_BR_VALIDATE_DEBOUNCE_MS: 0,
      TIMERS: { after: () => 1, cancel() {} },
      gitFetch: (_url, q, o) => new Promise((res) => pending.push({ q, o, res })),
    },
  });
  const v = Object.create(ctx[cls].prototype);
  // 태그의 종류·메시지 판정은 서버의 답이다 (GV-e) — 이 검사는 이름의 세대만 재므로 답은 늘 열려 있다.
  const answer = { why: () => ({ kind: '', why: '' }), state: () => ({ kind: '', why: '' }) };
  Object.assign(v, { repo: '/r', _seq: 0, whyKind: '', why: '', _answer: answer });
  const told = [];
  const d = { alive: () => true, setWhy: (k, w) => told.push([k, w]), values: () => ({}) };
  return { v, d, pending, told };
}

for (const [file, cls] of [['git/branches-dialogs.js', 'GitBranchCreate'], ['git/tag.js', 'GitTagCreate']]) {
  test('F-9.5: 이전 이름의 검증 응답은 지금 입력의 실행 버튼을 열지 않는다 — ' + cls, async () => {
    const { v, d, pending, told } = nameWorld(file, cls);
    const check = (name) => (cls === 'GitTagCreate' ? v._check({ name }, d, 'name') : v._onName({ name }, d, 'name'));
    check('a');
    const p = v._validate('a', d);
    check('ab');
    const r = pending[0];
    const stale = r.o && r.o.stale ? r.o.stale() : false;
    r.res(stale ? { stale: true } : { ok: true, data: { ok: true, exists: false } });
    await p;
    assert.ok(!told.some(([k]) => k === ''), '앞 이름의 판정이 실행을 열었다');
  });
}
