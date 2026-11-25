import assert from 'node:assert/strict';
import { test } from 'node:test';

import { load } from './harness.mjs';

/**
 * PERF 3.4.12.9 — 언어 카탈로그 조각 (D-46, M3_BOOT_SCOPE §3).
 *   `i18n:true` 로 등록한 묶음은 활성 로케일의 조각 `js/i18n/<묶음>.<로케일>.js` 를 묶음 JS **앞에** 붙인다
 *   (둘 다 async=false — 붙인 차례대로 실행된다) · 조각이 실패하면 묶음도 실리지 않은 것으로 보고 태그를 걷는다 ·
 *   needs 의 조각은 그 need 의 JS 앞에 붙는다 · 표시가 없으면 조각을 붙이지 않는다.
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

function setup(locale = 'ko') {
  const document = fakeDocument();
  const ctx = load(['core/screens.js'], { globals: { document, I18N: { locale } }, expose: ['Screens'] });
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
const done = (d) => { for (const e of scripts(d)) if (!e.removed && e.onload) e.onload() };

test('i18n 표시가 있으면 활성 로케일 조각을 묶음 JS 앞에 붙인다', async () => {
  const { S, document } = setup('en');
  S.register('git', { i18n: true });
  const p = S.load('git');
  assert.deepEqual(srcs(document), ['js/i18n/git.en.js', 'b/git.js']);
  for (const e of scripts(document)) assert.equal(e.async, false, '붙인 차례대로 실행돼야 한다');
  done(document);
  assert.equal(await settle(p), 'resolved');
});

test('i18n 표시가 없으면 조각을 붙이지 않는다', async () => {
  const { S, document } = setup();
  S.register('search');
  S.load('search');
  assert.deepEqual(srcs(document), ['b/search.js']);
});

test('조각은 bundle 이름을 따른다', async () => {
  const { S, document } = setup();
  S.register('view', { bundle: 'plain', i18n: true });
  S.load('view');
  assert.deepEqual(srcs(document), ['js/i18n/plain.ko.js', 'b/plain.js']);
});

test('조각이 실패하면 묶음은 실리지 않고 태그를 걷으며, 다시 부르면 URL 을 바꿔 둘 다 붙인다', async () => {
  const { S, document } = setup();
  S.register('git', { i18n: true });
  const p = S.load('git');
  const [frag, js] = scripts(document);
  js.onload();
  frag.onerror();
  assert.equal(await settle(p), 'rejected');
  assert.equal(S.ready('git'), false);
  assert.equal(frag.removed && js.removed, true);
  const q = S.load('git');
  assert.deepEqual(srcs(document).slice(2), ['js/i18n/git.ko.js?r=1', 'b/git.js?r=1']);
  done(document);
  assert.equal(await settle(q), 'resolved');
});

test('needs 의 조각은 그 need 의 JS 앞에 붙는다', async () => {
  const { S, document } = setup();
  S.register('lib', { i18n: true });
  S.register('git', { needs: ['lib'], i18n: true });
  const p = S.load('git');
  await tick();
  assert.deepEqual(srcs(document), ['js/i18n/lib.ko.js', 'b/lib.js']);
  done(document);
  await tick();
  await tick();
  assert.deepEqual(srcs(document), ['js/i18n/lib.ko.js', 'b/lib.js', 'js/i18n/git.ko.js', 'b/git.js']);
  done(document);
  assert.equal(await settle(p), 'resolved');
});
