import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { load } from './harness.mjs';

/**
 * OTTERMINAL_RENAME_SRS FR-FAV-1~4 — 주의 상태 파비콘.
 *   waiting → 빨강, done → 초록, 그 밖의 이유 → 노랑, 주의 없음·설정 끔 → 기본
 */

const JS_ROOT = new URL('..', import.meta.url).pathname;
const REPO = join(JS_ROOT, '..', '..');
const ctx = load(['core/attn-favicon.js'], { expose: ['ATTN_FAVICON'] });
const { attnFaviconHref, applyAttnFavicon, ATTN_FAVICON } = ctx;
const attn = (...reasons) => new Map(reasons.map((r, i) => ['t' + i, { reason: r }]));

test('FR-FAV-1: 이유 하나마다 그 색의 에셋', () => {
  assert.equal(attnFaviconHref(attn('waiting'), true), ATTN_FAVICON.waiting);
  assert.equal(attnFaviconHref(attn('done'), true), ATTN_FAVICON.done);
  assert.equal(attnFaviconHref(attn('idle'), true), ATTN_FAVICON.other);
  assert.equal(attnFaviconHref(attn('signaled'), true), ATTN_FAVICON.other);
  assert.equal(attnFaviconHref(attn(undefined), true), ATTN_FAVICON.other);
});

test('FR-FAV-1: 섞이면 가장 급한 것 — waiting > done > 그 밖', () => {
  assert.equal(attnFaviconHref(attn('idle', 'done', 'waiting'), true), ATTN_FAVICON.waiting);
  assert.equal(attnFaviconHref(attn('signaled', 'done', 'idle'), true), ATTN_FAVICON.done);
  assert.equal(attnFaviconHref(attn('idle', 'signaled'), true), ATTN_FAVICON.other);
});

test('FR-FAV-1: 주의가 없으면 기본 — 빈 집합·없는 집합', () => {
  assert.equal(attnFaviconHref(new Map(), true), ATTN_FAVICON.base);
  assert.equal(attnFaviconHref(undefined, true), ATTN_FAVICON.base);
});

test('FR-FAV-3: 설정이 꺼져 있으면 주의가 있어도 기본', () => {
  assert.equal(attnFaviconHref(attn('waiting'), false), ATTN_FAVICON.base);
});

test('FR-FAV-1: 네 에셋은 서로 다르고 실제 파일이다', () => {
  const hrefs = [ATTN_FAVICON.base, ATTN_FAVICON.waiting, ATTN_FAVICON.done, ATTN_FAVICON.other];
  assert.equal(new Set(hrefs).size, 4);
  for (const h of hrefs) assert.ok(readFileSync(join(REPO, 'web', h), 'utf8').startsWith('<svg'), h);
});

function fakeDoc(href) {
  const writes = [];
  const link = {
    getAttribute: (k) => (k === 'href' ? href : null),
    setAttribute: (k, v) => { writes.push([k, v]); href = v },
  };
  return { writes, doc: { querySelector: (sel) => (sel === 'link[rel="icon"][type="image/svg+xml"]' ? link : null) } };
}

test('FR-FAV-2: 바뀌면 SVG 아이콘 링크의 href 를 쓴다', () => {
  const { writes, doc } = fakeDoc(ATTN_FAVICON.base);
  applyAttnFavicon(doc, ATTN_FAVICON.waiting);
  assert.equal(writes.length, 1);
  assert.equal(writes[0][1], ATTN_FAVICON.waiting);
});

test('FR-FAV-2: 같은 에셋이면 DOM 을 다시 쓰지 않는다', () => {
  const { writes, doc } = fakeDoc(ATTN_FAVICON.done);
  applyAttnFavicon(doc, ATTN_FAVICON.done);
  assert.equal(writes.length, 0);
});

test('FR-FAV-2: 링크가 없으면 아무것도 하지 않는다', () => {
  assert.doesNotThrow(() => applyAttnFavicon({ querySelector: () => null }, ATTN_FAVICON.done));
});

test('FR-FAV-2: 제목을 쓰는 자리가 파비콘도 함께 갱신한다', () => {
  const src = readFileSync(join(JS_ROOT, 'core/settings-apply.js'), 'utf8');
  const body = src.slice(src.indexOf('_applyPageTitle(){'));
  const fn = body.slice(0, body.indexOf('\n  }') + 4);
  assert.match(fn, /applyAttnFavicon\(document,\s*attnFaviconHref\(this\.app\._attn,\s*attnFavicon\)\)/);
});

test('FR-FAV-4: 설정 표에 attnFavicon 이 Display 불리언 기본 켬으로 있다', () => {
  const src = readFileSync(join(JS_ROOT, 'core/settings-schema.js'), 'utf8');
  assert.match(src, /\{"key":"attnFavicon","type":"bool","def":true,"where":"Display ▸ [^"]+"\}/);
});

test('FR-FAV-4: index.html 이 attn-favicon.js 를 settings-apply.js 보다 먼저 싣는다', () => {
  const html = readFileSync(join(REPO, 'web/index.html'), 'utf8');
  const a = html.indexOf('js/core/attn-favicon.js');
  const b = html.indexOf('js/core/settings-apply.js');
  assert.ok(a > 0 && a < b, `${a} < ${b}`);
});
