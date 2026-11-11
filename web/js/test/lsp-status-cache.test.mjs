import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fakeClock, load } from './harness.mjs';

/**
 * UX_BATCH12_SRS TC-LIV-7 (FR-LIV-10) — LSP 상태 캐시는 60초가 지나면 낡은 것으로 보고
 * 다음에 쓸 때 다시 읽는다. 다른 탭·터미널의 설치·삭제를 이 주기 안에 알게 된다.
 */
function setup() {
  const clock = fakeClock();
  let asked = 0;
  const ctx = load(['core/lsp-client.js'], {
    clock,
    expose: ['LspClient'],
    globals: {
      apiPost: async () => { asked++; return { ok: true, status: 200, data: { servers: [] } } },
      LSP_STATUS_API: '/api/lsp/status',
      LSP_STATUS_TTL_MS: 60000,
    },
  });
  return { lsp: new ctx.LspClient({}), clock, asked: () => asked };
}

test('TC-LIV-7a: 60초 안에는 캐시를 쓴다', async () => {
  const { lsp, clock, asked } = setup();
  await lsp._lspStatusCached();
  await clock.advance(59000);
  await lsp._lspStatusCached();
  assert.equal(asked(), 1);
});

test('TC-LIV-7b: 61초가 지나면 다시 읽는다', async () => {
  const { lsp, clock, asked } = setup();
  await lsp._lspStatusCached();
  await clock.advance(61000);
  await lsp._lspStatusCached();
  assert.equal(asked(), 2);
});
