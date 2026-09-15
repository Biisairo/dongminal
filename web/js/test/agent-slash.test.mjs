import assert from 'node:assert/strict';
import { test } from 'node:test';

import { load, plain } from './harness.mjs';

/**
 * `web/js/ui/agent-pane.js` 의 슬래시 토큰 — **캐럿 앞을 본다**
 * (M12_SRS FR-M12-10 / V-M12-23~25).
 *
 * 사용자 지시: *"글 쓰던 중간의 `/` 도 명령을 찾아 넣는다."*
 *
 *   이전 동작: `v.startsWith('/')` — **입력 전체**가 `/` 로 시작할 때만 목록이 선다
 *   새  동작: 캐럿 앞에서 공백까지 거슬러 올라간 **토큰**이 `/` 로 시작하면 찾는다
 *
 * 경로(`src/foo`)가 명령으로 읽히지 않는 것은 덤이 아니라 같은 규칙의 결과다 —
 * 그 `/` 는 토큰의 **첫 글자가 아니다**.
 */
function fn() {
  const ctx = load(['ui/agent-pane.js'], { globals: { t: (k) => k, UIKit: {}, TIMERS: {}, Toast: {} } });
  return ctx.agentSlashToken;
}

/**
 * 편의: `|` 가 캐럿이다. `plain` 으로 실인(realm)을 건넌다 — vm 안의 객체는 호스트의
 * `Object.prototype` 을 갖지 않아 `deepStrictEqual` 이 내용이 같아도 떨어진다.
 */
function at(tok, s) {
  const caret = s.indexOf('|');
  const r = tok(s.replace('|', ''), caret);
  return r === null ? null : plain(r);
}

test('V-M12-23: 입력 전체가 명령이면 종전대로 선다', () => {
  const tok = fn();
  assert.deepEqual(at(tok, '/mod|'), { start: 0, end: 4, q: 'mod' });
  assert.deepEqual(at(tok, '/|'), { start: 0, end: 1, q: '' });
});

test('V-M12-23: 문장 중간의 `/` 도 찾는다', () => {
  const tok = fn();
  assert.deepEqual(at(tok, '이걸 고쳐줘 /mod|'), { start: 7, end: 11, q: 'mod' });
  // 줄바꿈도 토큰 경계다.
  assert.deepEqual(at(tok, '첫 줄\n/con|'), { start: 4, end: 8, q: 'con' });
});

test('V-M12-25: 토큰 중간의 `/` 는 명령이 아니다', () => {
  const tok = fn();
  assert.equal(at(tok, 'src/fo|o'), null, '경로가 명령으로 읽히면 안 된다');
  assert.equal(at(tok, 'a/b|'), null);
  assert.equal(at(tok, 'http://x|'), null);
});

test('V-M12-25: `/` 앞에 캐럿이 있거나 토큰이 없으면 서지 않는다', () => {
  const tok = fn();
  assert.equal(at(tok, '|/model'), null, '캐럿 앞에 토큰이 없다');
  assert.equal(at(tok, '그냥 글|'), null);
  assert.equal(at(tok, '|'), null);
});

test('V-M12-24: 캐럿 뒤의 글자는 토큰에 들지 않는다', () => {
  const tok = fn();
  // 뒤를 삼키면 고르는 순간 사용자가 쓴 뒷글이 사라진다.
  assert.deepEqual(at(tok, '/mo|del 뒤'), { start: 0, end: 3, q: 'mo' });
});
