import assert from 'node:assert/strict';
import { test } from 'node:test';

import { load } from './harness.mjs';

/**
 * PERF 3.4.12.1 — 등록부의 needs (D-45, M3_BOOT_SCOPE §3).
 *   needs 를 먼저 순서대로 싣는다 · 실린 needs 는 건너뛴다 · needs 가 실패하면 본 묶음을 붙이지 않고
 *   실패를 기억하지 않는다 · 순환은 reject · 라이브러리 묶음은 tab 없이 등록한다.
 */
function fakeDocument() {
  const added = [];
  return {
    added,
    head: { appendChild(c) { added.push(c); return c } },
    createElement: (tag) => {
      const e = { tagName: tag.toUpperCase(), removed: false, remove() { e.removed = true } };
      return e;
    },
    querySelector: () => null,
  };
}

function setup() {
  const document = fakeDocument();
  const ctx = load(['core/screens.js'], { globals: { document }, expose: ['Screens'] });
  return { document, S: ctx.Screens };
}

const scripts = (d) => d.added.filter((e) => e.tagName === 'SCRIPT');
const srcs = (d) => scripts(d).map((e) => e.src);
const tick = () => new Promise((r) => setImmediate(r));
const settle = async (p) => {
  let state = 'pending';
  p.then(() => { state = 'resolved' }, () => { state = 'rejected' });
  await tick();
  return state;
};
const byBundle = (d, b) => scripts(d).filter((e) => e.src.startsWith('b/' + b + '.js'));

test('needs 를 순서대로 하나씩 실은 뒤 본 묶음을 붙인다', async () => {
  const { S, document } = setup();
  S.register('a');
  S.register('b');
  S.register('main', { needs: ['a', 'b'] });
  const p = S.load('main');
  await tick();
  assert.deepEqual(srcs(document), ['b/a.js'], '첫 need 가 끝나기 전에는 다음을 붙이지 않는다');
  byBundle(document, 'a')[0].onload();
  await tick();
  assert.deepEqual(srcs(document), ['b/a.js', 'b/b.js']);
  byBundle(document, 'b')[0].onload();
  await tick();
  assert.deepEqual(srcs(document), ['b/a.js', 'b/b.js', 'b/main.js']);
  byBundle(document, 'main')[0].onload();
  assert.equal(await settle(p), 'resolved');
  assert.equal(S.ready('a') && S.ready('b') && S.ready('main'), true);
});

test('needs 는 재귀로 싣는다', async () => {
  const { S, document } = setup();
  S.register('lib');
  S.register('mid', { needs: ['lib'] });
  S.register('top', { needs: ['mid'] });
  const p = S.load('top');
  for (const b of ['lib', 'mid', 'top']) {
    await tick();
    byBundle(document, b)[0].onload();
  }
  assert.equal(await settle(p), 'resolved');
  assert.deepEqual(srcs(document), ['b/lib.js', 'b/mid.js', 'b/top.js']);
});

test('이미 실린 need 는 다시 붙이지 않는다', async () => {
  const { S, document } = setup();
  S.register('lib');
  S.register('main', { needs: ['lib'] });
  const l = S.load('lib');
  byBundle(document, 'lib')[0].onload();
  await l;
  const p = S.load('main');
  await tick();
  assert.deepEqual(srcs(document), ['b/lib.js', 'b/main.js']);
  byBundle(document, 'main')[0].onload();
  assert.equal(await settle(p), 'resolved');
});

test('싣는 중인 need 는 같은 Promise 를 기다린다', async () => {
  const { S, document } = setup();
  S.register('lib');
  S.register('x', { needs: ['lib'] });
  S.register('y', { needs: ['lib'] });
  const px = S.load('x');
  const py = S.load('y');
  await tick();
  assert.equal(byBundle(document, 'lib').length, 1);
  byBundle(document, 'lib')[0].onload();
  await tick();
  byBundle(document, 'x')[0].onload();
  byBundle(document, 'y')[0].onload();
  assert.equal(await settle(px), 'resolved');
  assert.equal(await settle(py), 'resolved');
});

test('need 가 실패하면 본 묶음을 붙이지 않고 reject 하며, 실패를 기억하지 않는다', async () => {
  const { S, document } = setup();
  S.register('lib');
  S.register('main', { needs: ['lib'] });
  const p = S.load('main');
  await tick();
  byBundle(document, 'lib')[0].onerror();
  assert.equal(await settle(p), 'rejected');
  assert.equal(byBundle(document, 'main').length, 0, '본 묶음은 붙지 않았다');
  assert.equal(S.ready('main'), false);
  assert.equal(S.ready('lib'), false);

  const q = S.load('main');
  assert.notEqual(p, q, '다음 load 는 다시 시도한다');
  await tick();
  assert.deepEqual(srcs(document), ['b/lib.js', 'b/lib.js?r=1']);
  byBundle(document, 'lib')[1].onload();
  await tick();
  assert.deepEqual(byBundle(document, 'main').map((e) => e.src), ['b/main.js'], '본 묶음의 첫 시도다');
  byBundle(document, 'main')[0].onload();
  assert.equal(await settle(q), 'resolved');
});

test('본 묶음이 실패해도 실린 need 는 그대로 두고, 다음 load 는 본 묶음만 다시 붙인다', async () => {
  const { S, document } = setup();
  S.register('lib');
  S.register('main', { needs: ['lib'] });
  const p = S.load('main');
  await tick();
  byBundle(document, 'lib')[0].onload();
  await tick();
  byBundle(document, 'main')[0].onerror();
  assert.equal(await settle(p), 'rejected');
  assert.equal(S.ready('lib'), true);
  const q = S.load('main');
  await tick();
  assert.deepEqual(srcs(document), ['b/lib.js', 'b/main.js', 'b/main.js?r=1']);
  byBundle(document, 'main')[1].onload();
  assert.equal(await settle(q), 'resolved');
});

test('순환하는 needs 는 reject 하고 아무것도 붙이지 않는다', async () => {
  const { S, document } = setup();
  S.register('a', { needs: ['b'] });
  S.register('b', { needs: ['a'] });
  const p = S.load('a');
  assert.equal(await settle(p), 'rejected');
  await tick();
  assert.equal(document.added.length, 0);
  S.register('self', { needs: ['self'] });
  assert.equal(await settle(S.load('self')), 'rejected');
  assert.equal(document.added.length, 0);
});

test('등록되지 않은 need 는 reject 하고 본 묶음을 붙이지 않는다', async () => {
  const { S, document } = setup();
  S.register('main', { needs: ['ghost'] });
  assert.equal(await settle(S.load('main')), 'rejected');
  assert.equal(document.added.length, 0);
});

test('라이브러리 묶음은 tab 없이 등록되고 forTab 에 잡히지 않는다', () => {
  const { S } = setup();
  S.register('lib');
  S.register('scr', { tab: (at) => at.type === 'x', needs: ['lib'] });
  assert.equal(S.forTab({ type: 'x' }), 'scr');
  assert.equal(S.forTab({ type: 'lib' }), null);
});
