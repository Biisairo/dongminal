import assert from 'node:assert/strict';
import { test } from 'node:test';

import { load, fakeClock, plain } from './harness.mjs';

/**
 * `web/js/ui/bare-link.js` — 스킴 없는 도메인 링크 (BARE_DOMAIN_LINK_SRS).
 *
 * 감지는 번들된 linkify-it 이 하므로 vendor 판을 그대로 싣는다 — 대역으로 바꾸면
 * §2 표의 실측이 무엇을 쟀는지 말할 수 없다.
 */
function ctxWith(api) {
  const clock = fakeClock();
  const calls = [];
  const ctx = load(['../vendor/markdown-it.js', 'core/i18n.js', 'i18n/ko.js', 'core/constants.js', 'core/path.js', 'ui/bare-link.js'], {
    clock,
    globals: {
      // markdown-it 번들이 싣는 순간 쓴다.
      atob,
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
