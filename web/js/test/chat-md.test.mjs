import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { readBundles } from '../../../scripts/bundles-def.mjs';
import { load } from './harness.mjs';

/**
 * `web/js/core/chat-md.js` — 채팅 글의 마크다운 (ISSUE_TREE_CHAT_SRS FR-CUX-8, TC-ITH-9).
 *
 * markdown-it·highlight.js 는 vendor 판을 그대로 싣는다. DOMPurify 는 DOM 이 있어야 돌므로 정화 뒤의 링크 손질만
 * 대역으로 잰다 — 실제 정화는 e2e 가 잰다.
 */
function ctxWith(globals = {}) {
  return load(['../vendor/markdown-it.js', '../vendor/highlight.js', 'core/chat-md.js'], { globals: { atob, ...globals } });
}

test('TC-ITH-9 코드 울타리는 <pre> 이고, 아는 언어는 강조하며 언어를 싣는다', () => {
  const ctx = ctxWith();
  const html = ctx.chatMdHtml('\x60\x60\x60js\nconst a = 1;\n\x60\x60\x60');
  assert.match(html, /^<pre class="chat-code" data-lang="js"><code class="hljs">/);
  assert.match(html, /<span class="hljs-keyword">const<\/span>/);
});

test('TC-ITH-9 모르는 언어는 색 없이 글자로 내되 언어는 싣는다', () => {
  const ctx = ctxWith();
  const html = ctx.chatMdHtml('\x60\x60\x60nolang"x\n<b>a</b>\n\x60\x60\x60');
  assert.match(html, /^<pre class="chat-code" data-lang="nolang&quot;x"><code>&lt;b&gt;a&lt;\/b&gt;\n<\/code><\/pre>/);
  assert.doesNotMatch(html, /hljs-/);
});

test('TC-ITH-9 언어 없는 울타리도 <pre> 다', () => {
  const ctx = ctxWith();
  assert.match(ctx.chatMdHtml('\x60\x60\x60\nx < y\n\x60\x60\x60'), /^<pre class="chat-code"><code>x &lt; y\n<\/code><\/pre>/);
});

test('TC-ITH-9 원시 HTML 은 글자로 나오고 <script> 요소는 없다', () => {
  const ctx = ctxWith();
  const html = ctx.chatMdHtml('a <b>b</b>\n\n<script>alert(1)</script>');
  assert.match(html, /&lt;b&gt;b&lt;\/b&gt;/);
  assert.doesNotMatch(html, /<script|<b>/);
});

test('TC-ITH-9 인라인 코드·목록·줄바꿈을 그린다', () => {
  const ctx = ctxWith();
  assert.match(ctx.chatMdHtml('run \x60ls\x60'), /<code>ls<\/code>/);
  assert.match(ctx.chatMdHtml('- a\n- b'), /<ul>\n<li>a<\/li>\n<li>b<\/li>\n<\/ul>/);
  assert.match(ctx.chatMdHtml('a\nb'), /a<br>\nb/);
});

test('TC-ITH-9 정화한 조각의 링크는 새 창으로 나간다', () => {
  const a = { attrs: {}, setAttribute(k, v) { this.attrs[k] = v } };
  let opts = null;
  const DOMPurify = { sanitize: (html, o) => { opts = o; return { html, querySelectorAll: (s) => (s === 'a[href]' ? [a] : []) } } };
  const ctx = ctxWith({ DOMPurify });
  const frag = ctx.chatMdFragment('see https://example.com');
  assert.match(frag.html, /<a href="https:\/\/example.com">/);
  assert.equal(opts.RETURN_DOM_FRAGMENT, true);
  assert.deepEqual({ ...a.attrs }, { target: '_blank', rel: 'noopener noreferrer' });
});

test('라이브러리가 없으면 준비되지 않았다고 답한다', () => {
  const ctx = load(['core/chat-md.js'], {});
  assert.equal(ctx.chatMdReady(), false);
  assert.equal(ctxWith({ DOMPurify: {} }).chatMdReady(), true);
});

test('TC-ITH-11 마크다운·강조 라이브러리는 채팅 지연 묶음의 needs 로 실린다', () => {
  const defs = readBundles(new URL('../../..', import.meta.url).pathname);
  const js = (n) => defs.get(n).js;
  assert.deepEqual(js('hljs'), ['vendor/highlight.js']);
  assert.ok(!js('docrender').includes('vendor/highlight.js'), '한 파일은 한 묶음에만 둔다');
  assert.ok(js('chat').indexOf('js/core/chat-md.js') < js('chat').indexOf('js/core/chat-views.js'));
  const src = (f) => readFileSync(new URL('../' + f, import.meta.url), 'utf8');
  assert.match(src('core/chat-controller.js'), /Screens\.register\('chat', \{[^}]*needs: \['mdlib', 'hljs'\]/);
  assert.match(src('core/editor-doc-render.js'), /Screens\.register\('docrender', \{[^}]*needs: \['mdlib', 'hljs'\]/);
  assert.match(src('core/screens.js'), /Screens\.register\('hljs'\);/);
});
