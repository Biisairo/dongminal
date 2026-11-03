import assert from 'node:assert/strict';
import test from 'node:test';

import { loadCM } from './cm-harness.mjs';
import { load, plain } from './harness.mjs';

/**
 * `ui/cm-link.js` — EDITOR_LINK_LSP_SRS FR-ELS-10~24 (V-ELS-4~7).
 */

const CM = await loadCM();
// 앱이 싣는 markdown-it(linkify-it 포함)을 그대로 쓴다 (NFR-ELS-1).
const ctx = load(['../vendor/markdown-it.js', 'ui/cm-lsp.js', 'ui/cm-link.js'], {
  globals: { CM, atob },
  expose: ['edLinkUrlAt', 'edLinkClickPlan', 'edLinkHoverRange', 'edLspLinkTarget'],
});
const st = (text) => CM.EditorState.create({ doc: text });

test('FR-ELS-11: 스킴 있는 URL 안의 열 → 그 범위', () => {
  const t = 'see https://a.b/c?d=1 now';
  assert.deepEqual(plain(ctx.edLinkUrlAt(t, 4)), { from: 4, to: 21, url: 'https://a.b/c?d=1' });
  assert.deepEqual(plain(ctx.edLinkUrlAt(t, 20)), { from: 4, to: 21, url: 'https://a.b/c?d=1' });
  assert.equal(ctx.edLinkUrlAt(t, 21), null, '끝 다음 열은 아니다');
  assert.equal(ctx.edLinkUrlAt(t, 2), null);
});

test('FR-ELS-11: 끝 문장부호는 URL 이 아니다', () => {
  assert.equal(plain(ctx.edLinkUrlAt('(http://x.io/a).', 1)).url, 'http://x.io/a');
});

test('FR-ELS-11: 맨 도메인 · README.md · http(s) 아닌 스킴은 링크가 아니다', () => {
  assert.equal(ctx.edLinkUrlAt('naver.com', 2), null);
  assert.equal(ctx.edLinkUrlAt('README.md', 2), null);
  assert.equal(ctx.edLinkUrlAt('mailto:a@b.c', 2), null);
  assert.equal(ctx.edLinkUrlAt('ftp://x.io/a', 2), null);
});

test('FR-ELS-10: URL 자리는 url, 그 밖은 LSP 가 있으면 lsp, 없으면 null', () => {
  const s = st('a\n<a href="https://e.x/p">t</a> foo');
  const urlPos = s.doc.line(2).from + 12;
  assert.deepEqual(plain(ctx.edLinkClickPlan(s, urlPos, false)), { kind: 'url', url: 'https://e.x/p' });
  assert.deepEqual(plain(ctx.edLinkClickPlan(s, urlPos, true)), { kind: 'url', url: 'https://e.x/p' });
  const fooPos = s.doc.length - 1;
  assert.deepEqual(plain(ctx.edLinkClickPlan(s, fooPos, true)), { kind: 'lsp' });
  assert.equal(ctx.edLinkClickPlan(s, fooPos, false), null);
});

test('FR-ELS-20·21: 밑줄 범위는 URL, 아니면 LSP 가 있을 때만 낱말', () => {
  const s = st('go https://e.x foo  bar');
  assert.deepEqual(plain(ctx.edLinkHoverRange(s, 5, false)), { from: 3, to: 14 });
  assert.deepEqual(plain(ctx.edLinkHoverRange(s, 16, true)), { from: 15, to: 18 });
  assert.equal(ctx.edLinkHoverRange(s, 16, false), null);
  assert.equal(ctx.edLinkHoverRange(s, 19, true), null, '공백 사이에는 낱말이 없다');
});

test('FR-ELS-10 순서 2·FR-ELS-13: 그 자리를 품은 file: 문서 링크 → 경로와 줄', () => {
  const doc = CM.Text.of(['<a href="b.html">', '<a href="c.md#L12">', '<a href="https://e.x">']);
  const links = [
    { range: { start: { line: 0, character: 9 }, end: { line: 0, character: 15 } }, target: 'file:///r/b.html' },
    { range: { start: { line: 1, character: 9 }, end: { line: 1, character: 17 } }, target: 'file:///r/c.md#L12' },
    { range: { start: { line: 2, character: 9 }, end: { line: 2, character: 20 } }, target: 'https://e.x' },
  ];
  assert.deepEqual(plain(ctx.edLspLinkTarget(doc, links, 10)), { path: '/r/b.html', line: null });
  assert.deepEqual(plain(ctx.edLspLinkTarget(doc, links, doc.line(2).from + 10)), { path: '/r/c.md', line: 12 });
  assert.equal(ctx.edLspLinkTarget(doc, links, doc.line(3).from + 10), null, 'http(s) target 은 순서 1 의 몫이다');
  assert.equal(ctx.edLspLinkTarget(doc, links, 2), null, '링크 밖');
  assert.equal(ctx.edLspLinkTarget(doc, null, 10), null);
  assert.equal(ctx.edLspLinkTarget(doc, [{ range: links[0].range }], 10), null, 'target 없는 링크는 건너뛴다');
});
