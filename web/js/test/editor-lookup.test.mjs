import assert from 'node:assert/strict';
import { test } from 'node:test';

import { load } from './harness.mjs';

/**
 * REPO_FIX 03 §3A-6 (E-4) — 편집기 조회의 두 헬퍼.
 *
 * 칸 1 이상에만 있는 편집기도 찾아야 한다 — `fileEditors.get(tab.id)` 는 칸 0 만
 * 잡아 닫기 확인·이름변경 추적·줄 이동이 조용히 빠졌다 (#5, N6).
 */
function app(focused) {
  const ctx = load(['core/app-slots.js'], { globals: { App: class {} } });
  const a = Object.create(ctx.App.prototype);
  a._slots = { windows: [{}, {}, {}, {}], focused };
  a.fileEditors = new Map();
  return a;
}

test('editorsOf: 모든 칸의 인스턴스, editorAny: 포커스 칸 → 칸 0 → 나머지', () => {
  const a = app(2);
  const e1 = { id: 'e1', destroyed: false, destroy() { this.destroyed = true } };
  const e3 = { id: 'e3', destroyed: false, destroy() { this.destroyed = true } };
  a.fileEditors.set(a.slotKey('t', 1), e1);
  a.fileEditors.set(a.slotKey('t', 3), e3);
  assert.equal(a.editorsOf('t').map((e) => e.id).join(','), 'e1,e3');
  assert.equal(a.editorAny('t').id, 'e1', '칸 1 에만 있는 편집기도 찾는다');
  const e2 = { id: 'e2', destroy() {} };
  a.fileEditors.set(a.slotKey('t', 2), e2);
  assert.equal(a.editorAny('t').id, 'e2', '포커스 칸이 먼저다');
  a.editorsDrop('t');
  assert.equal(a.fileEditors.size, 0);
  assert.ok(e1.destroyed && e3.destroyed, '모든 칸이 파괴된다');
  assert.equal(a.editorAny('t'), null);
});
