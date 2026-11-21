import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BASE, load } from './harness.mjs';

/**
 * UX_AUDIT_FIX_SRS TC-UXF-51 의 unit 부분 (FR-UXF-53, D-17).
 *
 * 지문은 4자 묶음으로 보이고, 앞 16자(`EDGE_FP_SHOWN`)가 강조다. 묶음은 글자를 바꾸지 않는다 —
 * 이어 붙이면 원문이다.
 */
const ctx = () => load([...BASE, 'core/edges-controller.js'], {
  expose: ['edgeFpGroups'],
  globals: { App: function App() {} },
});
/** vm 영역의 배열은 원형이 달라 deepEqual 이 거절한다 — 값만 이쪽으로 옮긴다. */
const groups = (fp) => JSON.parse(JSON.stringify(ctx().edgeFpGroups(fp)));

const FP = '0123456789abcdef'.repeat(4);

test('TC-UXF-51: 64자는 4자 묶음 열여섯이고 앞 넷이 강조다', () => {
  const g = groups(FP);
  assert.equal(g.length, 16);
  assert.ok(g.every((x) => x.text.length === 4));
  assert.deepEqual(g.map((x) => x.key), [true, true, true, true, ...Array(12).fill(false)]);
  assert.equal(g.map((x) => x.text).join(''), FP, '이어 붙이면 원문이다');
});

test('TC-UXF-51: 빈 값은 빈 목록이다', () => {
  assert.deepEqual(groups(''), []);
  assert.deepEqual(groups(undefined), []);
});

test('TC-UXF-51: 4의 배수가 아니면 마지막 묶음이 짧다', () => {
  const g = groups('abcdefghij');
  assert.deepEqual(g.map((x) => x.text), ['abcd', 'efgh', 'ij']);
});
