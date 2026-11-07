import assert from 'node:assert/strict';
import test from 'node:test';

import { load } from './harness.mjs';

/**
 * `core/action-answer.js` (SERVER_DRIVEN_ACTIONS_SRS M-8 · TC-SDA-2).
 *
 * 컨트롤은 **서버의 답과 "진행 중" 만으로** 켜지고 꺼진다 (FR-SDA-6·7). 화면이 자기
 * 규칙을 갖지 않으므로, 이 함수가 아는 것은 그 둘뿐이어야 한다.
 */
function mod() {
  const ctx = load(['core/i18n.js', 'core/action-answer.js'], {
    expose: ['I18N', 'actionState', 'actionOk'],
    globals: {
      localStorage: { getItem: () => 'ko', setItem() {} },
      document: { documentElement: { setAttribute() {} }, querySelectorAll: () => [] },
    },
  });
  ctx.I18N.register('ko', {
    'why.loading': '확인하는 중',
    'why.untracked_only': '추적되지 않는 파일 {count}개뿐입니다',
    'why.nothing_to_stash': '저장할 변경이 없습니다',
  });
  ctx.I18N.register('en', {});
  return ctx;
}

test('답이 참이면 켜지고 사유가 없다 (FR-SDA-6)', () => {
  const s = mod().actionState({ ok: true }, false);
  assert.equal(s.enabled, true);
  assert.equal(s.why, '');
});

test('답이 거짓이면 꺼지고 사유는 코드의 문구다 — args 를 보간한다 (FR-SDA-2·8)', () => {
  const s = mod().actionState({ ok: false, why: 'untracked_only', args: { count: 3 } }, false);
  assert.equal(s.enabled, false);
  assert.equal(s.why, '추적되지 않는 파일 3개뿐입니다');
});

test('args 가 없는 거짓 답도 문구를 낸다', () => {
  const s = mod().actionState({ ok: false, why: 'nothing_to_stash' }, false);
  assert.equal(s.enabled, false);
  assert.equal(s.why, '저장할 변경이 없습니다');
});

test('답이 아직 없으면 꺼지고 사유는 loading 이다 (FR-SDA-6)', () => {
  for (const a of [null, undefined]) {
    const s = mod().actionState(a, false);
    assert.equal(s.enabled, false);
    assert.equal(s.why, '확인하는 중');
  }
});

test('진행 중이면 답이 참이어도 꺼지고 사유를 떠들지 않는다 (FR-SDA-7)', () => {
  const s = mod().actionState({ ok: true }, true);
  assert.equal(s.enabled, false);
  assert.equal(s.why, '');
});

test('진행 중이 답 없음보다 앞선다 — 누른 뒤에는 loading 을 보이지 않는다', () => {
  const s = mod().actionState(null, true);
  assert.equal(s.enabled, false);
  assert.equal(s.why, '');
});

test('actionOk: 실린 답이 참일 때만 참이다 — 답이 없으면 거짓 (SERVER_DRIVEN_ACTIONS_SRS R-g)', () => {
  const { actionOk } = mod();
  assert.equal(actionOk({ actions: { 'run.close': { ok: true } } }, 'run.close'), true);
  assert.equal(actionOk({ actions: { 'run.close': { ok: false, why: 'run_closed' } } }, 'run.close'), false);
  assert.equal(actionOk({ actions: {} }, 'run.close'), false);
  assert.equal(actionOk({}, 'run.close'), false);
  assert.equal(actionOk(null, 'run.close'), false);
});
