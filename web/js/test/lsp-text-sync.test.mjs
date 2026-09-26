import assert from 'node:assert/strict';
import { test } from 'node:test';

import { load } from './harness.mjs';

/**
 * `web/js/core/lsp-client.js` 의 `_lspAsk` — OPTIMIZE_REFACTOR_SRS FR-OPT-6-2.
 * 대상은 `LspClient` 다 (APP_STATE_EXTRACT_SRS FR-ASE-7 · §2.3a A-8).
 *
 * **계수 검사다.** 재는 것은 서버로 나간 요청 수와 그중 텍스트를 실은 수다. 서버는
 * 가짜이며 세 모양을 흉내낸다: 판을 되돌리는 새 서버, 판을 모르는 옛 서버, 판을
 * 잊은(재기동한) 새 서버.
 */
function setup(server) {
  const posts = [];
  const apiPost = async (api, body) => {
    posts.push({ api, body: JSON.parse(JSON.stringify(body)) });
    return { ok: true, status: 200, data: server(body) };
  };
  const ctx = load(['core/lsp-client.js'], {
    expose: ['LspClient'],
    globals: {
      apiPost,
      AbortController,
      LSP_HOVER_API: '/api/lsp/hover', LSP_DEF_API: '/api/lsp/definition',
      LSP_REFS_API: '/api/lsp/references', LSP_CLOSE_API: '/api/lsp/close',
    },
  });
  const app = new ctx.LspClient({});
  app._lspRootOfPath = () => '/r';
  const model = { id: '$model1', ver: 1, value: 'package a\n',
    getAlternativeVersionId() { return this.ver }, getValue() { return this.value } };
  app._lspPathOfModel = () => '/r/a.go';
  const hover = () => app._lspHover(model, { lineNumber: 1, column: 1 }, null);
  const texts = () => posts.filter((p) => p.api !== '/api/lsp/close' && 'text' in p.body).length;
  const asks = () => posts.filter((p) => p.api !== '/api/lsp/close').length;
  return { app, model, posts, hover, texts, asks };
}

// 새 서버: 받은 판을 기억하고 되돌린다. 모르는 판이면 needText.
function newServer() {
  let known = '';
  return {
    handle(body) {
      if (!('text' in body)) {
        if (body.version !== known) return { markdown: '', needText: true };
        return { markdown: 'h', version: body.version };
      }
      known = body.version;
      return { markdown: 'h', version: body.version };
    },
    forget() { known = '' },
  };
}

test('판이 같으면 텍스트를 싣지 않는다 — 호버 5번에 전문 1번', async () => {
  const srv = newServer();
  const { hover, texts, asks } = setup((b) => srv.handle(b));
  for (let i = 0; i < 5; i++) await hover();
  assert.equal(asks(), 5);
  assert.equal(texts(), 1, '이전 동작은 요청마다 전문(5)이었다');
});

test('편집으로 판이 바뀌면 다시 싣는다', async () => {
  const srv = newServer();
  const { hover, model, texts } = setup((b) => srv.handle(b));
  await hover(); await hover();
  model.ver = 2; model.value = 'package b\n';
  await hover(); await hover();
  assert.equal(texts(), 2);
});

test('옛 서버(판을 되돌리지 않음)에는 늘 전문이 간다', async () => {
  const { hover, texts, posts } = setup(() => ({ markdown: 'h' }));
  for (let i = 0; i < 3; i++) await hover();
  assert.equal(texts(), 3);
  assert.equal(posts[2].body.text, 'package a\n');
});

test('서버가 판을 잊으면(needText) 전문으로 한 번 더 묻고 답을 쓴다', async () => {
  const srv = newServer();
  const { hover, texts, asks } = setup((b) => srv.handle(b));
  await hover();
  srv.forget();
  const r = await hover();
  assert.equal(asks(), 3, '생략 1 + 재전송 1');
  assert.equal(texts(), 2);
  assert.ok(r && r.contents[0].value === 'h', '재전송의 답이 호버에 쓰인다');
  await hover();
  assert.equal(texts(), 2, '다시 받은 판은 다시 생략된다');
});

test('다른 모델(다시 연 파일·diff 쪽)은 같은 번호여도 다른 판이다', async () => {
  const srv = newServer();
  const { app, hover, texts } = setup((b) => srv.handle(b));
  await hover();
  const other = { id: '$model2', getAlternativeVersionId: () => 1, getValue: () => 'package z\n' };
  await app._lspHover(other, { lineNumber: 1, column: 1 }, null);
  assert.equal(texts(), 2);
});

test('마지막 뷰가 닫히면 받은 판을 잊는다', async () => {
  const srv = newServer();
  const { app, hover, texts } = setup((b) => srv.handle(b));
  await hover();
  app.lspDocClosed('/r/a.go');
  srv.forget();
  await hover();
  assert.equal(texts(), 2, '닫힌 뒤 첫 요청은 생략하지 않고 전문을 싣는다');
});
