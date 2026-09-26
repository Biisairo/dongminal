import assert from 'node:assert/strict';
import { test } from 'node:test';

import { load, plain } from './harness.mjs';

/**
 * OPTIMIZE_REFACTOR_SRS FR-OPT-11-3 (FEC-19 · FEU-18) — 브라우저 저장소의 단일 경로와
 * 의도된 무시(`ErrorLog.quiet`).
 *
 * 종전의 `try{localStorage…}catch{}` 는 실패를 아무 데도 남기지 않았다. 이제 막힌
 * 저장소는 여전히 오류가 아니지만(읽기는 null·쓰기는 false) `ErrorLog` 에 흔적이 선다.
 */
function memStore() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)) },
    removeItem: (k) => { m.delete(k) },
  };
}

const blocked = () => {
  const no = () => { throw new Error('SecurityError') };
  return { getItem: no, setItem: no, removeItem: no };
};

function world(local = memStore(), session = memStore()) {
  return load(['core/error-log.js', 'core/pref-store.js'], {
    globals: { localStorage: local, sessionStorage: session, addEventListener() {} },
    expose: ['PrefStore', 'STORE_KEYS', 'ErrorLog'],
  });
}

test('두 영역은 갈린다 — local 에 쓴 것을 session 이 보지 않는다', () => {
  const { PrefStore } = world();
  assert.equal(PrefStore.local.set('k', 7), true);
  assert.equal(PrefStore.local.get('k'), '7', '값은 문자열로 선다');
  assert.equal(PrefStore.session.get('k'), null);
  assert.equal(PrefStore.local.remove('k'), true);
  assert.equal(PrefStore.local.get('k'), null);
});

test('bool 은 기본값 쪽으로 기운다 — 참이면 0 만 거짓, 거짓이면 1 만 참', () => {
  const { PrefStore } = world();
  const s = PrefStore.local;
  assert.equal(s.bool('b', true), true, '없으면 기본값');
  assert.equal(s.bool('b', false), false);
  s.setBool('b', false);
  assert.equal(s.get('b'), '0');
  assert.equal(s.bool('b', true), false);
  s.set('b', 'garbage');
  assert.equal(s.bool('b', true), true, "기본 참: '0' 이 아니면 참 (종전 `!=='0'`)");
  assert.equal(s.bool('b', false), false, "기본 거짓: '1' 만 참 (종전 `==='1'`)");
  s.setBool('b', true);
  assert.equal(s.bool('b', false), true);
});

test('json 은 깨진 값을 기본값으로 읽고 흔적을 남긴다', () => {
  const { PrefStore, ErrorLog } = world();
  const s = PrefStore.session;
  assert.deepEqual(plain(s.json('j', [])), []);
  s.setJson('j', { a: [1, 2] });
  assert.deepEqual(plain(s.json('j', null)), { a: [1, 2] });
  s.set('j', '{broken');
  assert.equal(s.json('j', 'def'), 'def');
  const last = ErrorLog.items().at(-1);
  assert.equal(last.kind, 'storage');
  assert.match(last.message, /^parse j:/);
});

test('막힌 저장소는 오류가 아니다 — 읽기 null · 쓰기 false · 흔적은 남는다', () => {
  const { PrefStore, ErrorLog } = world(blocked(), blocked());
  assert.equal(PrefStore.local.get('x'), null);
  assert.equal(PrefStore.local.set('x', 1), false);
  assert.equal(PrefStore.session.remove('x'), false);
  assert.equal(PrefStore.local.bool('x', true), true);
  assert.deepEqual(plain(PrefStore.local.json('x', [1])), [1]);
  const kinds = ErrorLog.items().map((i) => i.kind);
  assert.ok(kinds.length >= 3 && kinds.every((k) => k === 'storage'), JSON.stringify(kinds));
});

test('ErrorLog.quiet 는 값을 돌려주고, 던지면 삼키되 기록한다', () => {
  const { ErrorLog } = world();
  assert.equal(ErrorLog.quiet('x', () => 42), 42);
  assert.equal(ErrorLog.quiet('dispose', () => { throw new Error('already disposed') }), undefined);
  const last = ErrorLog.items().at(-1);
  assert.equal(last.kind, 'dispose');
  assert.equal(last.message, 'already disposed');
});

test('STORE_KEYS 는 얼어 있고 값이 겹치지 않는다', () => {
  const { STORE_KEYS } = world();
  assert.ok(Object.isFrozen(STORE_KEYS));
  const vals = Object.values(STORE_KEYS);
  assert.equal(new Set(vals).size, vals.length);
});
