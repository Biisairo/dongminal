import assert from 'node:assert/strict';
import { test } from 'node:test';

import { load } from './harness.mjs';

/**
 * `web/js/core/lsp-client.js` 의 `lspOfferFor` — EDITOR_LSP_SRS FR-LSP-44,
 * CODEMIRROR_MIGRATION_SRS §11.6 L3.
 *
 * 편집기가 서 있는지는 CodeMirror 뷰(`_view`)로 판정한다.
 */
function setup(servers, dismissed = {}) {
  const store = { 'lsp-offer': dismissed };
  const PrefStore = {
    local: {
      json: (k, d) => (k in store ? store[k] : d),
      setJson: (k, v) => { store[k] = v },
    },
  };
  const ctx = load(['core/lsp-client.js'], {
    expose: ['LspClient'],
    globals: {
      apiPost: async () => ({ ok: true, status: 200, data: { servers } }),
      PrefStore,
      LSP_STATUS_API: '/api/lsp/status',
      LSP_OFFER_KEY: 'lsp-offer',
      LSP_STATUS_TTL_MS: 60000,
    },
  });
  return new ctx.LspClient({ updateStatusBar() {} });
}

function editor(path, mounted = true) {
  const offers = [];
  return { filePath: path, _view: mounted ? {} : null, offer: (s) => offers.push(s.id), offers };
}

const GO = { id: 'gopls', exts: ['.go'], found: false };

test('CodeMirror 편집기가 서 있고 서버가 없으면 제안한다', async () => {
  const app = setup([GO]);
  const v = editor('/r/a.go');
  await app.lspOfferFor(v);
  assert.deepEqual(v.offers, ['gopls']);
});

test('확장자 대소문자는 가리지 않는다', async () => {
  const app = setup([GO]);
  const v = editor('/r/A.GO');
  await app.lspOfferFor(v);
  assert.deepEqual(v.offers, ['gopls']);
});

test('편집기가 서지 않았으면 제안하지 않는다', async () => {
  const app = setup([GO]);
  const v = editor('/r/a.go', false);
  await app.lspOfferFor(v);
  assert.deepEqual(v.offers, []);
});

test('서버가 이미 있으면 제안하지 않는다', async () => {
  const app = setup([{ ...GO, found: true }]);
  const v = editor('/r/a.go');
  await app.lspOfferFor(v);
  assert.deepEqual(v.offers, []);
});

test('닫은 언어는 다시 제안하지 않는다', async () => {
  const app = setup([GO], { gopls: true });
  const v = editor('/r/a.go');
  await app.lspOfferFor(v);
  assert.deepEqual(v.offers, []);
});

test('확장자가 없거나 표에 없으면 제안하지 않는다', async () => {
  const app = setup([GO]);
  const a = editor('/r/Makefile');
  const b = editor('/r/a.zzz');
  await app.lspOfferFor(a);
  await app.lspOfferFor(b);
  assert.deepEqual([...a.offers, ...b.offers], []);
});

/**
 * UX_AUDIT_FIX_SRS FR-UXF-82: 띠는 한 언어에 **처음 한 번** 선다 — 선 순간 "제안함" 으로 기억한다.
 * 닫지 않고 파일을 떠나도 같다.
 */
test('한 번 제안하면 같은 언어의 다음 파일에는 제안하지 않는다', async () => {
  const app = setup([GO]);
  const a = editor('/r/a.go');
  const b = editor('/r/b.go');
  await app.lspOfferFor(a);
  await app.lspOfferFor(b);
  assert.deepEqual([...a.offers, ...b.offers], ['gopls']);
});
