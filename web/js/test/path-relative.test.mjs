import assert from 'node:assert/strict';
import { test } from 'node:test';

import { load } from './harness.mjs';

/**
 * `web/js/core/helpers.js` 의 `pathRelative` — M9_SRS FR-M9-19 / D-M9-10.
 *
 * 탐색기의 "상대 경로 복사" 가 이 함수 하나를 딛는다. 여기서 어긋나면 사용자가
 * 붙여넣은 경로가 **다른 파일을 가리킨다** — 조용히 틀리는 종류다.
 *
 * 단위로 재는 이유는 갈라지는 자리가 전부 **문자열**이기 때문이다:
 * 구분자(POSIX·Windows) · 루트의 꼬리 구분자 · 접두가 겹치는 형제(`/a/bc` vs `/a/b`).
 * 브라우저를 띄워도 같은 것을 볼 뿐이다 (`hunk-coords` 와 같은 근거).
 */
// `helpers.js` 는 로드 시점에 `t()` 로 단축키 이름표를 세운다 — 카탈로그가 먼저
// 서야 한다 (`optimistic-layout.test.mjs` 와 같은 벌).
const { pathRelative } = load(['core/i18n.js', 'i18n/ko.js', 'core/constants.js', 'core/helpers.js']);

test('POSIX: 루트 아래의 경로가 루트를 뗀 나머지가 된다', () => {
  assert.equal(pathRelative('/a/b', '/a/b/c/d.txt'), 'c/d.txt');
  assert.equal(pathRelative('/a/b', '/a/b/c'), 'c');
});

test('루트의 꼬리 구분자는 있으나 없으나 같다', () => {
  assert.equal(pathRelative('/a/b/', '/a/b/c.txt'), 'c.txt');
});

// `startsWith(root)` 만으로 재면 `/a/bc` 가 `/a/b` 아래로 잡힌다 — `pathUnder` 가
// 이미 그 함정을 적어 두었고, 여기도 같은 함정 위에 선다.
test('접두만 겹치는 형제는 상대가 아니다 — 절대를 그대로 준다', () => {
  assert.equal(pathRelative('/a/b', '/a/bc/d.txt'), '/a/bc/d.txt');
});

test('루트 밖이면 절대를 그대로 준다 — 없는 관계를 지어내지 않는다', () => {
  assert.equal(pathRelative('/a/b', '/x/y.txt'), '/x/y.txt');
});

test('루트 자신은 그 이름이다 — 빈 문자열은 붙여넣을 것이 없다는 뜻이 된다', () => {
  assert.equal(pathRelative('/a/b', '/a/b'), 'b');
  assert.equal(pathRelative('/a/b/', '/a/b'), 'b');
});

/**
 * Windows 는 구분자가 `\` 이고 **드라이브 뿌리**(`C:\`)는 그 자체가 꼬리 구분자를
 * 가진다. 구분자를 `/` 로 굳히면 어떤 경로도 아래로 잡히지 않는다 (`pathUnder` 의 §).
 */
test('Windows: 구분자를 그 경로에게 묻는다', () => {
  assert.equal(pathRelative('C:\\Users\\x', 'C:\\Users\\x\\repo\\a.txt'), 'repo\\a.txt');
  assert.equal(pathRelative('C:\\', 'C:\\a\\b.txt'), 'a\\b.txt');
  assert.equal(pathRelative('C:\\Users\\x', 'C:\\Users\\xy\\a.txt'), 'C:\\Users\\xy\\a.txt');
});

test('빈 값은 빈 값이 아니라 받은 것을 그대로 돌려준다', () => {
  assert.equal(pathRelative('', '/a/b.txt'), '/a/b.txt');
  assert.equal(pathRelative('/a', ''), '');
});
