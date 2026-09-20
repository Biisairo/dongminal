/**
 * 조사 헬퍼의 계약 (WORDING_COLOR_SRS FR-WRD-60~64 · TC-WRD-15).
 *
 * 의존이 없는 순수 함수이므로 브라우저 없이 잰다 — 이 저장소에서 순수 로직은
 * 그렇게 한다 (`contrast.test.mjs` 의 선례).
 *
 * **화면에서 이 함수가 틀리면 한국어가 틀린다.** `markdown 를 설치하면` 이
 * 그것이었고, 고치는 값이 싸므로 경계를 촘촘히 잰다.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { load } from './harness.mjs';

const ctx = load(['core/i18n.js'], { expose: ['I18N'] });
const { josa } = ctx;

test('한글 — 받침이 조사를 고른다', () => {
  assert.equal(josa('사람 {이가} 있다'), '사람 이 있다');
  assert.equal(josa('나무 {이가} 있다'), '나무 가 있다');
  assert.equal(josa('파일 {을를} 지운다'), '파일 을 지운다');
  assert.equal(josa('저장소 {을를} 지운다'), '저장소 를 지운다');
  assert.equal(josa('이름 {은는} 그대로'), '이름 은 그대로');
  assert.equal(josa('경로 {은는} 그대로'), '경로 는 그대로');
});

test('`으로/로` — `ㄹ` 받침은 예외다', () => {
  assert.equal(josa('서울 {으로로} 간다'), '서울 로 간다');   // ㄹ 받침
  assert.equal(josa('부산 {으로로} 간다'), '부산 으로 간다'); // 그 밖의 받침
  assert.equal(josa('제주 {으로로} 간다'), '제주 로 간다');   // 받침 없음
});

test('라틴 — 글자 이름의 읽기로 고른다', () => {
  assert.equal(josa('go {을를} 설치'), 'go 를 설치');        // 오
  assert.equal(josa('python {을를} 설치'), 'python 을 설치'); // 엔
  assert.equal(josa('html {으로로} 연다'), 'html 로 연다');   // 엘 → ㄹ
  assert.equal(josa('rust {을를} 설치'), 'rust 를 설치');     // 티
  assert.equal(josa('PYTHON {을를} 설치'), 'PYTHON 을 설치'); // 대소문자 무관
});

test('숫자 — 한글 읽기로 고른다', () => {
  assert.equal(josa('1 {이가} 왔다'), '1 이 왔다');   // 일
  assert.equal(josa('2 {이가} 왔다'), '2 가 왔다');   // 이
  assert.equal(josa('1.2.6 {이가} 왔다'), '1.2.6 이 왔다'); // 육
  assert.equal(josa('v1.2.5 {이가} 왔다'), 'v1.2.5 가 왔다'); // 오
});

test('괄호·따옴표는 건너뛰고 그 앞을 본다', () => {
  assert.equal(josa("'파일' {을를} 지운다"), "'파일' 을 지운다");
  assert.equal(josa('(python) {을를} 설치'), '(python) 을 설치');
});

test('판정할 수 없으면 회피형으로 떨어진다 (D-WRD-7)', () => {
  assert.equal(josa('@@ {을를} 지운다'), '@@ 을(를) 지운다');
  assert.equal(josa('{을를} 지운다'), '을(를) 지운다');
  assert.equal(josa('🙂 {이가} 있다'), '🙂 이(가) 있다');
});

// 상수는 로드 시점에 `t()` 를 부른다 (`constants*.js`). 그때 풀리면 `%s` 의 `s`
// 를 보고 고르게 되므로 **치환 전에는 풀지 않는다** (FR-WRD-63).
test('자리표시자 뒤의 마커는 치환을 기다린다', () => {
  assert.equal(josa('%s {을를} 삭제합니다.'), '%s {을를} 삭제합니다.');
  assert.equal(josa('{version} {이가} 나왔습니다'), '{version} {이가} 나왔습니다');
  // 치환하고 나면 그때 풀린다.
  assert.equal(josa('%s {을를} 삭제합니다.'.replace('%s', 'main.go')), 'main.go 를 삭제합니다.');
  assert.equal(josa('%s {을를} 삭제합니다.'.replace('%s', 'main.json')), 'main.json 을 삭제합니다.');
});

test('마커가 없으면 문자열이 그대로다 — 값 없는 일을 하지 않는다', () => {
  const s = '아무 마커도 없는 문장입니다.';
  assert.equal(josa(s), s);
  assert.equal(josa(''), '');
});

// M6 §4-A-1: 대역이 비면 위 단정이 전부 공회전한다.
test('헬퍼가 실제로 실렸다', () => {
  assert.equal(typeof josa, 'function');
});
