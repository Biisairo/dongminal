import assert from 'node:assert/strict';
import { test } from 'node:test';

import { loadCM } from './cm-harness.mjs';
import { load, plain } from './harness.mjs';

/**
 * `core/lsp-client.js` 의 `lspClickDef` — EDITOR_LINK_LSP_SRS FR-ELS-10 순서 2·3 · FR-ELS-13 (V-ELS-5·6).
 *
 * 문서 링크의 `file:` target 이 그 자리를 품으면 그 파일을 연다. 아니면 정의로 이동한다.
 */
const CM = await loadCM();

function setup({ caps = true, links = null, fail = false } = {}) {
  const calls = [];
  const client = {
    hasCapability: (n) => (n === 'documentLinkProvider' ? caps : null),
    sync: () => calls.push('sync'),
    request: (m, p) => { calls.push(m + ' ' + p.textDocument.uri); return fail ? Promise.reject(new Error('x')) : Promise.resolve(links) },
  };
  const plugin = { client, uri: 'file:///r/a.html' };
  const view = {
    state: CM.EditorState.create({ doc: '<a href="b.html">x</a> foo' }),
    dispatch: (tr) => calls.push('select ' + tr.selection.anchor),
  };
  const fakeCM = { ...CM, LSPPlugin: { get: () => plugin }, jumpToDefinition: () => calls.push('def') };
  const ctx = load(['ui/cm-lsp.js', 'ui/cm-link.js', 'core/lsp-client.js'], {
    expose: ['LspClient'],
    globals: { CM: fakeCM },
  });
  const app = { edOpenFile: async (p, o) => { calls.push('open ' + p + ' ' + JSON.stringify(plain(o))) } };
  const lsp = new ctx.LspClient(app);
  lsp._lspConns = new Map([['k', { client, ensure: () => Promise.resolve(), lastClose: null }]]);
  return { lsp, view, calls };
}

const LINK = { range: { start: { line: 0, character: 9 }, end: { line: 0, character: 15 } }, target: 'file:///r/b.html#L3' };

test('FR-ELS-10 순서 2: 그 자리를 품은 file: 문서 링크면 그 파일의 그 줄을 연다', async () => {
  const { lsp, view, calls } = setup({ links: [LINK] });
  await lsp.lspClickDef(view, 11);
  assert.deepEqual(calls, ['sync', 'textDocument/documentLink file:///r/a.html', 'open /r/b.html {"line":3}']);
});

test('FR-ELS-10 순서 3: 링크 밖이면 정의로 이동한다', async () => {
  const { lsp, view, calls } = setup({ links: [LINK] });
  await lsp.lspClickDef(view, 24);
  assert.deepEqual(calls.slice(-2), ['select 24', 'def']);
});

test('FR-ELS-13: 요청 실패 · 빈 결과 · 능력 없음은 정의 이동으로 넘어간다', async () => {
  for (const o of [{ fail: true, links: [LINK] }, { links: null }, { caps: false, links: [LINK] }]) {
    const { lsp, view, calls } = setup(o);
    await lsp.lspClickDef(view, 11);
    assert.deepEqual(calls.slice(-2), ['select 11', 'def'], JSON.stringify(o));
    assert.ok(!calls.some((c) => c.startsWith('open')), JSON.stringify(o));
  }
});
