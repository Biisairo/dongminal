import assert from 'node:assert/strict';
import { test } from 'node:test';

import { load } from './harness.mjs';

/** REPO_FIX 03 §3A-5 — 문서 비동기 적용의 토큰 규칙. */
const { docTokenOf, docTokenValid } = load(['core/doc-token.js']);

const model = (v) => ({ v, getAlternativeVersionId() { return this.v } });

test('살아 있고 세대·판이 같으면 적용한다', () => {
  const doc = { gen: 1, model: model(5) };
  const reg = new Map([['/a', doc]]);
  const tok = docTokenOf(doc, '/a');
  assert.equal(docTokenValid(tok, reg), true);
});

test('요청 뒤 편집(판 변화)·세대 변화·문서 해제·경로 이동이면 버린다', () => {
  const doc = { gen: 1, model: model(5) };
  const reg = new Map([['/a', doc]]);
  const tok = docTokenOf(doc, '/a');
  doc.model.v = 6;
  assert.equal(docTokenValid(tok, reg), false, '편집');
  doc.model.v = 5; doc.gen = 2;
  assert.equal(docTokenValid(tok, reg), false, '세대');
  doc.gen = 1; reg.delete('/a');
  assert.equal(docTokenValid(tok, reg), false, '해제');
  reg.set('/b', doc);
  assert.equal(docTokenValid(tok, reg), false, '이동');
  reg.set('/a', { gen: 1, model: model(5) });
  assert.equal(docTokenValid(tok, reg), false, '같은 경로의 다른 문서');
});

test('초기 로드: 모델이 없을 때 잡은 토큰은 그 사이 누가 모델을 만들면 무효다', () => {
  const doc = { gen: 0, model: null };
  const reg = new Map([['/a', doc]]);
  const tok = docTokenOf(doc, '/a');
  assert.equal(docTokenValid(tok, reg), true);
  doc.model = model(1);
  assert.equal(docTokenValid(tok, reg), false);
});
