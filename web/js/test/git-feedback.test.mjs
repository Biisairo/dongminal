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
const MENU = readFileSync(join(HERE, '..', 'git/menu.js'), 'utf8');

function consts(src) {
  const out = {};
  for (const m of src.matchAll(/\bGIT_[A-Z0-9_]+\b/g)) out[m[0]] = m[0];
  return out;
}

// ── F-9.2: 잡 진행 중 메뉴 항목 비활성 (01 §6.4 표 "진행 중 잠금") ──

function menuWorld(busySlot) {
  const c = consts(MENU);
  delete c.GIT_MENUS; delete c.GIT_MENU_PRIMARY;
  Object.assign(c, { GIT_REF_KIND_LOCAL: 'local', GIT_REF_KIND_REMOTE: 'remote',
    GIT_JOB_SLOT_INDEX: 'index', GIT_JOB_SLOT_COMMON: 'common' });
  const common = new Set(['fetch', 'push', 'branch/push', 'branch/fetch', 'branch/delete-remote', 'tag-push', 'tag-delete-remote']);
  const ctx = load(['git/menu.js'], {
    globals: {
      ...c, t: (k) => k, GIT_WRITE_ERR: { job_busy: 'JOB_BUSY' },
      gitJobSlotsOf: (k) => (k === 'pull' ? ['index', 'common'] : common.has(k) ? ['common'] : ['index']),
      GitTag: { oidOf: () => '' }, GitCommitOps: { whyHead: () => '', whyDrop: () => '', label: () => '', _restoreCmd: () => '' },
      GitStash: { label: () => '', ref: () => '' }, GitBranches: { restoreRemoteCmd: () => '' },
      gitShQuote: (s) => s, UIKit: { closeMenu() {}, menu: () => ({ dataset: {} }) },
    },
  });
  ctx.app = { gitPanel: {
    statusOf: () => ({}), branchDeletePair: () => ({ local: { short: 'f', isHead: false }, remote: 'o/f', why: '' }),
    branchDeleteTargets: (t) => [t.short], untrackedPaths: () => ['u'], dirtyCount: () => 1,
    _remote: () => ({ busy: (s) => s === busySlot }),
  } };
  return ctx;
}

const TARGETS = {
  commit: { oid: 'c', abbrev: 'c', subject: 's' },
  branch: { kind: 'local', short: 'f', upstream: 'o/f', isHead: false, oid: 'o' },
  tag: { short: 'v' }, stash: { oid: 's', index: 0 }, uncommitted: {}, file: { path: 'a' },
};

test('F-9.2: index 칸이 돌면 동기 쓰기·index 잡 시작 항목이, common 칸이 돌면 비-index 잡 시작 항목만 비활성이다', () => {
  for (const slot of ['index', 'common']) {
    const ctx = menuWorld(slot);
    for (const [kind, items] of Object.entries(ctx.GIT_MENUS)) {
      for (const it of items) {
        if (it.sep || !it.busy) continue;
        const t = TARGETS[kind];
        if (it.disabled && it.disabled(t)) continue;
        const keys = [].concat(typeof it.busy === 'function' ? it.busy(t) : it.busy);
        const slots = new Set(keys.map((k) => (k === 'write' ? 'index' : (k === 'pull' ? 'both'
          : ['fetch', 'push', 'branch/push', 'branch/fetch', 'branch/delete-remote', 'tag-push', 'tag-delete-remote'].includes(k) ? 'common' : 'index'))));
        const hit = [...slots].some((s) => s === 'both' || s === slot);
        const why = ctx.GitMenu._why(it, t);
        if (hit) assert.equal(why, 'JOB_BUSY', kind + '/' + it.id + ' @' + slot);
        else assert.notEqual(why, 'JOB_BUSY', kind + '/' + it.id + ' @' + slot);
      }
    }
  }
});

test('F-9.2: 저장소를 바꾸는 메뉴 항목은 모두 잡 칸 판정을 갖는다', () => {
  const ctx = menuWorld('');
  const pure = new Set(['copy-hash', 'copy-subject', 'copy-name', 'copy-branch-name', 'compare-mark', 'compare-with',
    'openChanges', 'openFile', 'openFileHead', 'copyPath', 'fileHistory', 'blame', 'open-changes']);
  for (const [kind, items] of Object.entries(ctx.GIT_MENUS)) {
    for (const it of items) {
      if (it.sep || pure.has(it.id)) continue;
      assert.ok(it.busy, kind + '/' + it.id + ' 에 busy 가 없다');
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
  Object.assign(v, { repo: '/r', _seq: 0, whyKind: '', why: '' });
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
