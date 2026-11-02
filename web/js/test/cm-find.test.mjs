import assert from 'node:assert/strict';
import test from 'node:test';

import { loadCM } from './cm-harness.mjs';
import { load, plain } from './harness.mjs';

/**
 * `ui/cm-find.js` 의 `edFindHits` — CODEMIRROR_MIGRATION_SRS FR-CMR-31·32 / EDITOR_FIND_PANEL_SRS.
 *
 * 돌려주는 것은 `{from, to, caps}` 의 배열이다. `caps` 는 정규식일 때만 있다(FR-ERS-6) —
 * `[0]` 이 전체 일치다.
 */

const CM = await loadCM();
const WORD_SEP = '`~!@#$%^&*()-=+[{]}\\|;:\'",.<>/?';
const ctx = load(['ui/cm-find.js'], {
  globals: { CM, ED_FIND_WORD_SEPARATORS: WORD_SEP },
  expose: ['edFindHits'],
});
const doc = (s) => CM.Text.of(s.split('\n'));
const hits = (s, q, o = {}, max = 100) => plain(ctx.edFindHits(doc(s), q, { case: false, regex: false, word: false, ...o }, max));
const spans = (s, q, o, max) => hits(s, q, o, max).map((h) => [h.from, h.to]);

test('빈 질의는 일치가 없다', () => {
  assert.deepEqual(hits('abc', ''), []);
});

test('기본은 대소문자를 가리지 않는다', () => {
  assert.deepEqual(spans('Needle needle NEEDLE', 'needle'), [[0, 6], [7, 13], [14, 20]]);
});

test('대소문자 옵션', () => {
  assert.deepEqual(spans('Needle needle NEEDLE', 'needle', { case: true }), [[7, 13]]);
});

test('여러 줄에 걸친 일치의 offset', () => {
  assert.deepEqual(spans('ab\nxab\n', 'ab'), [[0, 2], [4, 6]]);
});

test('FR-CMR-31: 단어 단위는 ED_FIND_WORD_SEPARATORS 를 경계로 쓴다 — `_` 는 단어 글자, `$` 는 경계', () => {
  assert.deepEqual(spans('ab abc a_ab ab$ (ab)', 'ab', { word: true }), [[0, 2], [12, 14], [17, 19]]);
});

test('FR-CMR-31: 단어 단위의 경계는 공백과 문서 끝도 포함한다 · 한글', () => {
  assert.deepEqual(spans('가나 가나다\n가나', '가나', { word: true }), [[0, 2], [7, 9]]);
});

test('정규식 일치와 캡처', () => {
  const h = hits('k1=v1; k2=v2', '(\\w+)=(\\w+)', { regex: true });
  assert.deepEqual(h.map((x) => [x.from, x.to]), [[0, 5], [7, 12]]);
  assert.deepEqual(h[1].caps, ['k2=v2', 'k2', 'v2']);
});

test('리터럴 찾기에는 캡처가 없다 · 정규식 문자는 글자다', () => {
  const h = hits('a.b axb', 'a.b');
  assert.deepEqual(h.map((x) => [x.from, x.to]), [[0, 3]]);
  assert.equal(h[0].caps, undefined);
});

test('정규식 + 대소문자 + 단어 단위', () => {
  assert.deepEqual(spans('Foo foo foobar', 'fo+', { regex: true, case: true, word: true }), [[4, 7]]);
});

test('FR-CMR-32: 상한에서 끊는다', () => {
  assert.equal(hits('a'.repeat(50), 'a', {}, 20).length, 20);
});

test('빈 일치를 만드는 정규식은 무한히 돌지 않고 빈 일치를 내지 않는다', () => {
  assert.deepEqual(hits('abc', 'x*', { regex: true }), []);
});
