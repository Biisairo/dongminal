import assert from 'node:assert/strict';
import { test } from 'node:test';

import { load, fakeClock, plain } from './harness.mjs';

/**
 * `web/js/ui/file-link.js` — 터미널 출력의 파일 경로 링크 (UX_BATCH11_SRS FR-FPL).
 *
 * 존재 확인은 맨 도메인(`bare-link.js`)과 같은 저장을 쓴다 (D-13) — 그래서 둘을 함께 싣는다.
 */
function ctxWith(api) {
  const clock = fakeClock();
  const calls = [];
  const ctx = load(['../vendor/markdown-it.js', 'core/i18n.js', 'i18n/ko.js', 'core/constants.js', 'core/path.js', 'ui/bare-link.js', 'ui/file-link.js'], {
    clock,
    globals: {
      atob,
      apiPost: async (path, body) => { calls.push({ path, body: plain(body) }); return api(body) },
    },
  });
  return { ctx, clock, calls };
}

const cands = (ctx, s) => plain(ctx.filePathCandidates(s)).map((c) => [c.path, c.line, c.col]);

test('TC-FPL-1 경로형·줄번호형만 후보다', () => {
  const { ctx } = ctxWith(() => ({ ok: true, data: { stamps: {} } }));
  assert.deepEqual(cands(ctx, 'src/a.go:12:5'), [['src/a.go', 12, 5]]);
  assert.deepEqual(cands(ctx, './b.ts:3'), [['./b.ts', 3, null]]);
  assert.deepEqual(cands(ctx, '/abs/c.rs'), [['/abs/c.rs', null, null]]);
  assert.deepEqual(cands(ctx, 'C:\\x\\y.go:7'), [['C:\\x\\y.go', 7, null]]);
  assert.deepEqual(cands(ctx, 'C:/x/y.go'), [['C:/x/y.go', null, null]]);
  assert.deepEqual(cands(ctx, 'a.py:9'), [['a.py', 9, null]]);
  for (const s of ['main.go', 'https://a.com/b', 'v1.2:3x', 'a:0', 'x:', '']) {
    assert.deepEqual(cands(ctx, s), [], s);
  }
});

test('TC-FPL-1 끝의 구두점을 떼고, 괄호·따옴표로 끊는다', () => {
  const { ctx } = ctxWith(() => ({ ok: true, data: { stamps: {} } }));
  assert.deepEqual(cands(ctx, 'src/a.go:12:5: error'), [['src/a.go', 12, 5]]);
  assert.deepEqual(cands(ctx, 'see (src/a.go:3).'), [['src/a.go', 3, null]]);
  assert.deepEqual(cands(ctx, '"src/a.go", \'b/c.ts\';'), [['src/a.go', null, null], ['b/c.ts', null, null]]);
  assert.deepEqual(cands(ctx, '--> src/main.rs:3:5'), [['src/main.rs', 3, 5]]);
  const [m] = plain(ctx.filePathCandidates('at src/a.go:12:5,'));
  assert.equal(m.index, 3);
  assert.equal(m.lastIndex, 16);
  assert.equal(m.text, 'src/a.go:12:5');
});

test('TC-FPL-2 상대 후보는 cwd 로 펴서 한 요청으로 묻고, 있는 파일만 남긴다', async () => {
  const { ctx, calls } = ctxWith(() => ({ ok: true, data: { stamps: { '/w/src/a.go': 's' } } }));
  const cs = ctx.filePathCandidates('src/a.go:2 nope/x.go:1 /abs/c.rs');
  const got = plain((await ctx.filePathExisting(cs, '/w')).map((x) => [x.abs, x.cand.line]));
  assert.deepEqual(got, [['/w/src/a.go', 2]]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/api/file/stamps');
  assert.deepEqual(calls[0].body, { paths: ['/w/src/a.go', '/w/nope/x.go', '/abs/c.rs'] });
});

test('TC-FPL-2 cwd 를 모르면 상대 후보는 묻지 않는다 · 실패하면 링크가 없다', async () => {
  const { ctx, calls } = ctxWith(() => ({ ok: false, status: 500, data: null }));
  const cs = ctx.filePathCandidates('src/a.go:2 /abs/c.rs');
  assert.deepEqual(plain(await ctx.filePathExisting(cs, '')), []);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].body, { paths: ['/abs/c.rs'] });
  assert.equal(ctx.filePathResolve('src/a.go', ''), '');
  assert.equal(ctx.filePathResolve('/abs/c.rs', ''), '/abs/c.rs');
});

test('TC-FPL-2 5초 기억은 맨 도메인과 같은 저장이다 (D-13)', async () => {
  const { ctx, clock, calls } = ctxWith((body) => ({ ok: true, data: { stamps: Object.fromEntries(body.paths.filter((p) => p.endsWith('README.md')).map((p) => [p, 's'])) } }));
  const cs = ctx.filePathCandidates('./README.md:1');
  assert.equal((await ctx.filePathExisting(cs, '/w')).length, 1);
  await ctx.filePathExisting(cs, '/w');
  assert.equal(calls.length, 1);
  // 같은 절대 경로를 맨 도메인 쪽이 물어도 다시 묻지 않는다.
  assert.deepEqual([...await ctx.bareLinkFiles(['README.md'], '/w')], ['README.md']);
  assert.equal(calls.length, 1);
  await clock.advance(5001);
  await ctx.filePathExisting(cs, '/w');
  assert.equal(calls.length, 2);
});
