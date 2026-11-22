import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { load } from './harness.mjs';

/**
 * REPO_FIX 05 §3A-6 (F-6.1) — Changes 행 서명은 행을 그리는 데 쓰는 필드 목록 **하나**에서
 * 파생한다. 서명에 빠진 필드(서브모듈 상태 `sub` 등)는 바뀌어도 화면에 닿지 않는다(#42).
 */
const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'git/git-change-rows.js'), 'utf8');
const CONST = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'core/constants-git-changes.js'), 'utf8');

function fieldsOfRowEl() {
  const i = SRC.indexOf('  _rowEl(group,e,depth){');
  assert.ok(i >= 0, '_rowEl 이 있다');
  const body = SRC.slice(i, SRC.indexOf('\n  }\n', i));
  return [...new Set([...body.matchAll(/\be\.([a-zA-Z]+)/g)].map((m) => m[1]))].sort();
}

function rowFields() {
  const m = /const GIT_ROW_FIELDS=\[([^\]]*)\]/.exec(CONST);
  assert.ok(m, 'GIT_ROW_FIELDS 가 있다');
  return m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
}

test('F-6.1: 행이 읽는 필드는 전부 서명 목록에 있다', () => {
  const list = rowFields();
  for (const f of fieldsOfRowEl()) assert.ok(list.includes(f), '서명 목록에 없다: ' + f);
});

test('F-6.1: 서브모듈 상태가 바뀌면 행 서명이 바뀐다', () => {
  // 행은 부품(`GitChangeRows`, REFACTOR3_FE_GITPANEL_SRS 7f)이고 공용 상태는 패널 대역이 든다.
  const ctx = load(['core/base/component.js', 'ui/repaint.js', 'git/git-part.js', 'git/git-change-rows.js'], {
    expose: ['GitChangeRows'],
    globals: { GIT_ROW_FIELDS: rowFields() },
  });
  const panel = {
    app: {}, _sel: new Set(), previewFile: null, selection: { _selKey: (g, x) => g + x },
    changes: { _treeMode: () => false }, files: { _op: () => '' },
  };
  const p = new ctx.GitChangeRows(panel);
  p._stateChar = () => 'M';
  const e = { path: 'sub', dir: true, sub: 'commit' };
  const a = p._itemSig({ t: 'file', group: 'working', e, depth: 0 });
  const b = p._itemSig({ t: 'file', group: 'working', e: { ...e, sub: 'commit,inner' }, depth: 0 });
  assert.notEqual(a, b);
});
