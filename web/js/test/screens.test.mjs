import assert from 'node:assert/strict';
import { test } from 'node:test';

import { load } from './harness.mjs';

/**
 * PERF 3.4.3 — 화면 등록부·로더 (D-30, M3_DESIGN §3.4, FR-SPA-1).
 *   같은 이름은 같은 Promise · 실패는 기억하지 않고 새 URL · CSS 와 JS 가 둘 다 끝나야 푼다 · 등록되지 않은 이름은 reject.
 */
function fakeDocument(ver = 'abc123') {
  const added = [];
  const el = (tag) => {
    const e = {
      tagName: tag.toUpperCase(), attrs: {}, removed: false,
      setAttribute(k, v) { e.attrs[k] = String(v) },
      remove() { e.removed = true },
    };
    return e;
  };
  return {
    added,
    head: { appendChild(c) { added.push(c); return c } },
    createElement: el,
    querySelector: (sel) => (sel === 'script[src*="b/boot.js"]' && ver !== null
      ? { getAttribute: () => 'b/boot.js?v=' + ver } : null),
  };
}

function setup(ver) {
  const document = fakeDocument(ver);
  const ctx = load(['core/screens.js'], { globals: { document }, expose: ['Screens'] });
  return { ctx, document, S: ctx.Screens };
}

const scripts = (d) => d.added.filter((e) => e.tagName === 'SCRIPT');
const links = (d) => d.added.filter((e) => e.tagName === 'LINK');
const settle = async (p) => {
  let state = 'pending';
  p.then(() => { state = 'resolved' }, () => { state = 'rejected' });
  await new Promise((r) => setImmediate(r));
  return state;
};

test('같은 이름을 두 번 load 하면 <script> 는 하나이고 Promise 도 같다', async () => {
  const { S, document } = setup();
  S.register('t', { bundle: 'tb' });
  const a = S.load('t');
  const b = S.load('t');
  assert.equal(a, b);
  assert.equal(scripts(document).length, 1);
  assert.equal(scripts(document)[0].src, 'b/tb.js?v=abc123');
  assert.equal(scripts(document)[0].async, false);
  scripts(document)[0].onload();
  assert.equal(await settle(a), 'resolved');
  assert.equal(S.ready('t'), true);
  await S.load('t');
  assert.equal(scripts(document).length, 1, '실린 뒤의 load 는 다시 붙이지 않는다');
});

test('실패하면 reject 하고, 다음 load 는 새 URL 로 다시 붙인다', async () => {
  const { S, document } = setup();
  S.register('t', { bundle: 'tb' });
  const a = S.load('t');
  scripts(document)[0].onerror();
  assert.equal(await settle(a), 'rejected');
  assert.equal(S.ready('t'), false);
  assert.equal(scripts(document)[0].removed, true, '실패한 태그는 걷는다');
  const b = S.load('t');
  assert.notEqual(a, b);
  assert.equal(scripts(document).length, 2);
  assert.equal(scripts(document)[1].src, 'b/tb.js?v=abc123&r=1');
  scripts(document)[1].onload();
  assert.equal(await settle(b), 'resolved');
});

test('CSS 와 JS 가 둘 다 끝나야 푼다', async () => {
  const { S, document } = setup();
  S.register('t', { bundle: 'tb', css: true });
  const p = S.load('t');
  assert.equal(links(document).length, 1);
  const link = links(document)[0];
  assert.equal(link.rel, 'stylesheet');
  assert.equal(link.href, 'b/tb.css?v=abc123');
  scripts(document)[0].onload();
  assert.equal(await settle(p), 'pending', 'JS 만 끝났다');
  link.onload();
  assert.equal(await settle(p), 'resolved');
});

test('CSS 가 실패해도 reject 하고 두 태그를 걷는다', async () => {
  const { S, document } = setup();
  S.register('t', { bundle: 'tb', css: true });
  const p = S.load('t');
  scripts(document)[0].onload();
  links(document)[0].onerror();
  assert.equal(await settle(p), 'rejected');
  assert.equal(links(document)[0].removed, true);
  assert.equal(S.ready('t'), false);
});

test('등록되지 않은 이름은 reject 하고 아무것도 붙이지 않는다', async () => {
  const { S, document } = setup();
  assert.equal(await settle(S.load('nope')), 'rejected');
  assert.equal(document.added.length, 0);
  assert.equal(S.ready('nope'), false);
});

test('같은 이름을 다시 등록하면 던진다', () => {
  const { S } = setup();
  S.register('t', { bundle: 'tb' });
  assert.throws(() => S.register('t', { bundle: 'tb' }), /t/);
});

test('forTab: 탭을 맡는 화면의 이름, 없으면 null', () => {
  const { S } = setup();
  S.register('t', { bundle: 'tb', tab: (at) => at.type === 'x' });
  assert.equal(S.forTab({ type: 'x' }), 't');
  assert.equal(S.forTab({ type: 'y' }), null);
});

test('판은 부팅 묶음 태그의 ?v= 다. 없으면 붙이지 않는다', () => {
  assert.equal(setup('ddd444').ctx.bootAssetVersion(), 'ddd444');
  assert.equal(setup(null).ctx.bootAssetVersion(), null);
  const { S, document } = setup(null);
  S.register('t', { bundle: 'tb' });
  S.load('t');
  assert.equal(scripts(document)[0].src, 'b/tb.js');
});
