import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

import { CONSTANTS, SCREENS_LOADED, load, fakeClock, plain } from './harness.mjs';

/**
 * `web/js/ui/bare-link.js` — 스킴 없는 도메인 링크 (BARE_DOMAIN_LINK_SRS).
 *
 * 감지는 번들된 linkify-it 이 하므로 vendor 판을 그대로 싣는다 — 대역으로 바꾸면
 * §2 표의 실측이 무엇을 쟀는지 말할 수 없다.
 */
function ctxWith(api) {
  const clock = fakeClock();
  const calls = [];
  const ctx = load(['../vendor/markdown-it.js', 'core/i18n.js', 'i18n/ko.js', ...CONSTANTS, 'core/path.js', 'ui/bare-link.js'], {
    clock,
    globals: {
      // markdown-it 번들이 싣는 순간 쓴다.
      atob,
      Screens: SCREENS_LOADED,
      apiPost: async (path, body) => { calls.push({ path, body: plain(body) }); return api(body) },
    },
  });
  return { ctx, clock, calls };
}

const texts = (ctx, s) => plain(ctx.bareLinks(s).map((m) => m.text));

test('TC-BDL-1 맨 도메인만 잡는다', () => {
  const { ctx } = ctxWith(() => ({ ok: true, data: { stamps: {} } }));
  assert.deepEqual(texts(ctx, 'naver.com a.co.kr www.x.com github.com/a/b'), ['naver.com', 'a.co.kr', 'www.x.com', 'github.com/a/b']);
  assert.deepEqual(texts(ctx, 'README.md app.py'), ['README.md', 'app.py']);
  assert.deepEqual(texts(ctx, 'main.go v1.2.3 foo.bar 1.2.3.4 localhost:3000'), []);
  assert.deepEqual(texts(ctx, 'docs/README.md ./a.md /abs/b.md src/x.rs'), []);
  // 스킴 있는 것·이메일은 기존 경로의 몫이다.
  assert.deepEqual(texts(ctx, 'https://a.com me@x.com'), []);
  const [m] = plain(ctx.bareLinks('go naver.com now'));
  assert.deepEqual(m, { index: 3, lastIndex: 12, text: 'naver.com', url: 'http://naver.com' });
});

test('TC-BDL-2 기준 폴더의 파일만 가려낸다 — 한 요청으로', async () => {
  const { ctx, calls } = ctxWith((body) => ({ ok: true, data: { stamps: { [body.paths[1]]: 's' } } }));
  const got = await ctx.bareLinkFiles(['naver.com', 'README.md'], '/w');
  assert.deepEqual([...got], ['README.md']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/api/file/stamps');
  assert.deepEqual(calls[0].body, { paths: ['/w/naver.com', '/w/README.md'] });
});

test('TC-BDL-2 기준 폴더를 모르면 묻지 않고, 실패하면 빈 집합이다', async () => {
  const { ctx, calls } = ctxWith(() => ({ ok: false, status: 500, data: null }));
  assert.equal((await ctx.bareLinkFiles(['README.md'], '')).size, 0);
  assert.equal(calls.length, 0);
  assert.equal((await ctx.bareLinkFiles(['README.md'], '/w')).size, 0);
  assert.equal(calls.length, 1);
});

test('TC-BDL-3 5초 안의 같은 질문은 다시 묻지 않는다', async () => {
  const { ctx, clock, calls } = ctxWith((body) => ({ ok: true, data: { stamps: { [body.paths[0]]: 's' } } }));
  assert.deepEqual([...await ctx.bareLinkFiles(['README.md'], '/w')], ['README.md']);
  assert.deepEqual([...await ctx.bareLinkFiles(['README.md'], '/w')], ['README.md']);
  assert.equal(calls.length, 1);
  // 다른 폴더는 다른 질문이다.
  await ctx.bareLinkFiles(['README.md'], '/v');
  assert.equal(calls.length, 2);
  await clock.advance(5001);
  await ctx.bareLinkFiles(['README.md'], '/w');
  assert.equal(calls.length, 3);
});

/**
 * PERF 3.4.12.2 (D-43): markdown-it 은 `mdlib` 묶음이다. 실리기 전의 provideLinks 는 묶음을 기다린 뒤
 * 그 줄을 판정한다 — 첫 hover 의 밑줄이 한 번 늦는 것은 사용자 결정으로 받아들였다.
 */
function lazyCtx({ fail = false } = {}) {
  const loads = [];
  let ready = false;
  let ctx = null;
  const Screens = {
    ready: (n) => n === 'mdlib' && ready,
    load(n) {
      loads.push(n);
      if (fail) return Promise.reject(new Error('net'));
      new vm.Script(readFileSync(new URL('../../vendor/markdown-it.js', import.meta.url), 'utf8')).runInContext(ctx);
      ready = true;
      return Promise.resolve();
    },
  };
  ctx = load(['core/i18n.js', 'i18n/ko.js', ...CONSTANTS, 'core/path.js', 'ui/bare-link.js'], {
    globals: { atob, Screens, fileLinksOn: () => false, apiPost: async () => ({ ok: true, data: { stamps: {} } }) },
  });
  return { ctx, loads };
}

// xterm 버퍼 한 줄의 대역 — 한 칸에 한 글자.
function fakeTerm(text) {
  const cells = [...text].map((ch) => ({ getWidth: () => 1, getChars: () => ch }));
  return { cols: cells.length, buffer: { active: { getLine: (i) => (i === 0 ? { getCell: (x) => cells[x] } : null) } } };
}

const provide = (ctx, term, y = 1) => new Promise((res) => ctx.bareLinkProvider(term, () => '/w').provideLinks(y, res));

test('PERF 3.4.12.2 mdlib 이 없으면 provideLinks 가 묶음을 실은 뒤 판정한다', async () => {
  const { ctx, loads } = lazyCtx();
  assert.equal(typeof ctx.markdownit, 'undefined');
  const links = await provide(ctx, fakeTerm('go naver.com now'));
  assert.deepEqual(loads, ['mdlib']);
  assert.deepEqual(plain(links.map((l) => l.text)), ['naver.com']);
  // 실린 뒤에는 다시 싣지 않는다.
  await provide(ctx, fakeTerm('a.co.kr'));
  assert.deepEqual(loads, ['mdlib']);
});

test('PERF 3.4.12.2 묶음이 실패하면 링크 없이 답하고, 다음 hover 에서 다시 싣는다', async () => {
  const { ctx, loads } = lazyCtx({ fail: true });
  assert.equal(await provide(ctx, fakeTerm('go naver.com now')), undefined);
  assert.equal(await provide(ctx, fakeTerm('go naver.com now')), undefined);
  assert.deepEqual(loads, ['mdlib', 'mdlib']);
});
