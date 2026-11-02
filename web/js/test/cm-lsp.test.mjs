import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { loadCM } from './cm-harness.mjs';
import { load } from './harness.mjs';

/**
 * `ui/cm-lsp.js` — CODEMIRROR_MIGRATION_SRS FR-CMR-23·90~94 / §11.6 L1.
 */

const CM = await loadCM();

class FakeWS {
  static all = [];
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  constructor(url) {
    this.url = url;
    this.readyState = FakeWS.CONNECTING;
    this.sent = [];
    FakeWS.all.push(this);
  }
  send(m) { this.sent.push(m) }
  close() { this._close(1000, '') }
  _open() { this.readyState = FakeWS.OPEN; if (this.onopen) this.onopen({}) }
  _msg(o) { if (this.onmessage) this.onmessage({ data: JSON.stringify(o) }) }
  _close(code, reason) {
    if (this.readyState === FakeWS.CLOSED) return;
    this.readyState = FakeWS.CLOSED;
    if (this.onclose) this.onclose({ code, reason });
  }
  msgs() { return this.sent.map((s) => JSON.parse(s)) }
  methods() { return this.msgs().map((m) => m.method || `#${m.id}`) }
}

const ctx = load(['ui/cm-buffer.js', 'ui/cm-lsp.js'], {
  expose: ['edLspUri', 'edLspPath', 'edLspLangId', 'edLspServerReply', 'edLspWorkspaceClass', 'EdLspSocket', 'EdLspConn',
    'EdBuffer', 'edLspDiagItems', 'edLspDiagShow', 'edLspDiagnostics'],
  globals: {
    CM, WebSocket: FakeWS, TextEncoder, TextDecoder, URLSearchParams, queueMicrotask,
    location: { protocol: 'http:', host: 'h:1' },
    LSP_WS_API: '/api/lsp/ws', LSP_WS_CLOSE_LIMIT: 4001, LSP_WS_CLOSE_START: 4002, LSP_WS_CLOSE_ENDED: 4003,
    ED_LSP_TIMEOUT_MS: 15000, ED_LSP_RETRY_MS: 5000,
  },
});
const { edLspUri, edLspPath, edLspLangId, edLspWorkspaceClass, EdLspSocket, EdLspConn,
  EdBuffer, edLspDiagItems, edLspDiagShow, edLspDiagnostics } = ctx;

const HERE = dirname(fileURLToPath(import.meta.url));
const VECTORS = JSON.parse(readFileSync(join(HERE, '../../../internal/shared/platform/testdata/file_uri_vectors.json'), 'utf8'));

const tick = () => new Promise((r) => setTimeout(r, 0));

// ── URI ↔ 경로 ──

test('URI 는 Go platform.Paths 와 같은 벡터를 낸다 (왕복 포함)', () => {
  assert.ok(VECTORS.length >= 10);
  for (const v of VECTORS) {
    assert.equal(edLspUri(v.path), v.uri, `${v.os} ${v.path}`);
    assert.equal(edLspPath(v.uri), v.path, `${v.os} ${v.uri}`);
  }
});

test('file: 이 아니거나 비면 빈 경로다', () => {
  for (const u of ['', 'http://x/a.go', 'untitled:1', null, undefined]) assert.equal(edLspPath(u), '');
});

test('다르게 인코딩된 같은 파일 URI 도 같은 경로로 풀린다', () => {
  assert.equal(edLspPath('file:///C%3A/a/b.go'), 'C:\\a\\b.go');
  assert.equal(edLspPath('file:///a/b%20c/d.go'), '/a/b c/d.go');
});

// ── 언어 id ──

test('언어 id 는 Go languageFor 와 같은 표다', () => {
  const ts = ['typescript', 'javascript'];
  const cases = [['a.ts', 'typescript'], ['a.MTS', 'typescript'], ['a.cts', 'typescript'], ['a.tsx', 'typescriptreact'],
    ['a.js', 'javascript'], ['a.mjs', 'javascript'], ['a.cjs', 'javascript'], ['a.jsx', 'javascriptreact']];
  for (const [p, want] of cases) assert.equal(edLspLangId('/r/' + p, ts), want, p);
  assert.equal(edLspLangId('/r/a.go', ['go']), 'go');
  assert.equal(edLspLangId('/r/Makefile', []), '');
});

// ── 서버 요청 ──

test('서버 요청은 Go serverRequestResult 의 표로 답한다', () => {
  // vm 컨텍스트의 배열은 다른 realm 이다 — 값만 견준다.
  const edLspServerReply = (...a) => JSON.parse(JSON.stringify(ctx.edLspServerReply(...a)));
  assert.deepEqual(edLspServerReply('workspace/configuration', { items: [{}, {}] }, '/r').result, [null, null]);
  assert.deepEqual(edLspServerReply('workspace/configuration', {}, '/r').result, []);
  for (const m of ['client/registerCapability', 'client/unregisterCapability', 'window/workDoneProgress/create']) {
    const r = edLspServerReply(m, {}, '/r');
    assert.ok('result' in r && r.result === null, m);
  }
  assert.deepEqual(edLspServerReply('workspace/workspaceFolders', null, '/r/한 글').result,
    [{ uri: 'file:///r/%ED%95%9C%20%EA%B8%80', name: '한 글' }]);
  assert.deepEqual(edLspServerReply('workspace/workspaceFolders', null, 'C:\\w\\proj').result,
    [{ uri: 'file:///C:/w/proj', name: 'proj' }]);
  assert.equal(edLspServerReply('workspace/applyEdit', {}, '/r').error.code, -32601);
});

// ── Workspace (FR-CMR-23) ──

function fakeClient() {
  return {
    opened: [], closed: [],
    didOpen(f) { this.opened.push({ uri: f.uri, version: f.version, text: f.doc.toString(), languageId: f.languageId }) },
    didClose(uri) { this.closed.push(uri) },
  };
}

/** `LSPPlugin.get(view)` 이 `view.plugin(...)` 을 부르므로 그 자리에 가짜 플러그인을 둔다. */
function fakeView(doc) {
  const v = { state: CM.EditorState.create({ doc }) };
  const p = {
    syncedDoc: v.state.doc,
    unsyncedChanges: CM.ChangeSet.empty(v.state.doc.length),
    clear() { p.syncedDoc = v.state.doc; p.unsyncedChanges = CM.ChangeSet.empty(v.state.doc.length) },
  };
  v.plugin = () => p;
  v.lsp = p;
  v.edit = (spec) => {
    const tr = v.state.update(spec);
    v.state = tr.state;
    p.unsyncedChanges = p.unsyncedChanges.compose(tr.changes);
    return tr.changes;
  };
  return v;
}

/** 그룹 전달을 흉내낸다 — EdBuffer 처럼 한 칸의 변경을 나머지 칸에 그대로 건다. */
function editGroup(views, spec) {
  const ch = views[0].edit(spec);
  for (const v of views.slice(1)) v.edit({ changes: ch });
}

function workspace(hooks = {}) {
  const W = edLspWorkspaceClass();
  const client = fakeClient();
  return { ws: new W(client, hooks), client };
}

const U = 'file:///r/a.go';

test('같은 파일의 두 칸은 didOpen 한 번, 마지막 칸이 닫힐 때 didClose 한 번', () => {
  const { ws, client } = workspace();
  const a = fakeView('package a\n'), b = fakeView('package a\n');
  ws.openFile(U, 'go', a);
  ws.openFile(U, 'go', b);
  assert.equal(client.opened.length, 1);
  assert.equal(ws.files.length, 1);
  ws.closeFile(U, a);
  assert.deepEqual(client.closed, []);
  ws.closeFile(U, b);
  assert.deepEqual(client.closed, [U]);
  assert.equal(ws.files.length, 0);
  ws.closeFile(U, b);
  assert.deepEqual(client.closed, [U], '이미 닫힌 파일은 다시 닫지 않는다');
});

test('그룹의 변경은 한 번만 동기화되고 모든 칸의 미동기 변경이 비워진다', () => {
  const { ws } = workspace();
  const a = fakeView('ab\n'), b = fakeView('ab\n');
  ws.openFile(U, 'go', a);
  ws.openFile(U, 'go', b);
  const v0 = ws.files[0].version;
  editGroup([a, b], { changes: { from: 1, insert: 'X' } });
  const ups = ws.syncFiles();
  assert.equal(ups.length, 1);
  assert.equal(ups[0].changes.apply(ups[0].prevDoc).toString(), 'aXb\n');
  assert.equal(ws.files[0].doc.toString(), 'aXb\n');
  assert.equal(ws.files[0].version, v0 + 1);
  assert.ok(a.lsp.unsyncedChanges.empty && b.lsp.unsyncedChanges.empty);
  assert.equal(ws.syncFiles().length, 0, '바뀐 것이 없으면 내지 않는다');
});

test('나중에 붙은 칸이 있어도 파일의 판에서 이어지는 변경을 낸다', () => {
  const { ws } = workspace();
  const a = fakeView('ab\n');
  ws.openFile(U, 'go', a);
  a.edit({ changes: { from: 0, insert: '1' } });
  // b 는 a 의 편집 뒤에 섰다 — 그 칸의 기준 문서는 파일의 판보다 새롭다.
  const b = fakeView(a.state.doc.toString());
  ws.openFile(U, 'go', b);
  editGroup([b, a], { changes: { from: 0, insert: '2' } });
  const ups = ws.syncFiles();
  assert.equal(ups.length, 1);
  assert.equal(ups[0].prevDoc.toString(), 'ab\n');
  assert.equal(ups[0].changes.apply(ups[0].prevDoc).toString(), '21ab\n');
});

test('기준이 맞는 칸이 없으면 전체 교체로 낸다', () => {
  const { ws } = workspace();
  const a = fakeView('ab\n');
  ws.openFile(U, 'go', a);
  a.edit({ changes: { from: 0, insert: 'z' } });
  a.lsp.clear(); // 기준을 잃은 칸
  a.edit({ changes: { from: 0, insert: 'y' } });
  const ups = ws.syncFiles();
  assert.equal(ups.length, 1);
  assert.equal(ups[0].changes.apply(ups[0].prevDoc).toString(), 'yzab\n');
});

test('getFile 은 문자열이 달라도 같은 경로면 찾는다', () => {
  const { ws } = workspace();
  ws.openFile('file:///C:/a/b.go', 'go', fakeView('x'));
  assert.ok(ws.getFile('file:///C:/a/b.go'));
  assert.ok(ws.getFile('file:///C%3A/a/b.go'));
  assert.ok(ws.getFile('file:///c:/a/b.go'), 'Windows 드라이브 문자는 대소문자를 가리지 않는다');
  assert.equal(ws.getFile('file:///C:/a/c.go'), null);
  assert.equal(ws.getFile('http://x'), null);
});

test('getView 는 그룹의 칸을 내고, 주어진 칸이 그룹에 있으면 그것을 낸다', () => {
  const { ws } = workspace();
  const a = fakeView('x'), b = fakeView('x');
  ws.openFile(U, 'go', a);
  ws.openFile(U, 'go', b);
  const f = ws.getFile(U);
  assert.equal(f.getView(b), b);
  assert.ok([a, b].includes(f.getView()));
  assert.ok([a, b].includes(f.getView(fakeView('x'))));
  ws.closeFile(U, a);
  assert.equal(f.getView(), b);
});

test('connected 는 열린 파일마다 didOpen 을 다시 보낸다', () => {
  const { ws, client } = workspace();
  ws.openFile(U, 'go', fakeView('x'));
  ws.openFile('file:///r/b.go', 'go', fakeView('y'));
  client.opened.length = 0;
  ws.connected();
  assert.deepEqual(client.opened.map((o) => o.uri).sort(), [U, 'file:///r/b.go']);
});

test('displayFile 은 앱이 연 편집기의 뷰를 낸다', async () => {
  const opened = [];
  const view = fakeView('x');
  const { ws } = workspace({ display: async (p) => { opened.push(p); return view } });
  assert.equal(await ws.displayFile('file:///r/b%20c.go'), view);
  assert.deepEqual(opened, ['/r/b c.go']);
  const { ws: ws2 } = workspace({ display: async () => null });
  assert.equal(await ws2.displayFile(U), null);
  assert.equal(await ws2.displayFile('http://x'), null);
});

test('같은 파일에 칸이 하나 더 붙으면 joined 를 부른다 (첫 칸은 부르지 않는다)', () => {
  const seen = [];
  const { ws } = workspace({ joined: (p, v) => seen.push([p, v]) });
  const a = fakeView('x'), b = fakeView('x');
  ws.openFile('file:///r/b%20c.go', 'go', a);
  assert.equal(seen.length, 0);
  ws.openFile('file:///r/b%20c.go', 'go', b);
  assert.equal(seen.length, 1);
  assert.equal(seen[0][0], '/r/b c.go');
  assert.equal(seen[0][1], b);
});

// ── 진단 (FR-CMR-92 · §11.6 L2) ──

const lspDiag = (l1, c1, l2, c2, extra = {}) => ({ range: { start: { line: l1, character: c1 }, end: { line: l2, character: c2 } }, message: 'm', ...extra });
const plain = (x) => JSON.parse(JSON.stringify(x));

/** `EditorState` 로 선 가짜 칸 (cm-buffer.test.mjs 와 같다). */
function bufSink(buf) {
  const s = {
    state: CM.EditorState.create({ doc: buf.doc }),
    dispatch(spec) {
      const tr = s.state.update(spec);
      s.state = tr.state;
      buf.fromSink(s, [tr]);
    },
  };
  buf.attach(s);
  return s;
}

const shown = (s) => {
  const out = [];
  CM.forEachDiagnostic(s.state, (d, from, to) => out.push({ from, to, severity: d.severity, message: d.message }));
  return out;
};

test('진단 위치는 동기화된 문서 기준이고 미동기 변경으로 옮겨진다', () => {
  const v = fakeView('ab\ncd\n');
  v.edit({ changes: { from: 0, insert: 'XX' } }); // 동기화 뒤 앞에 두 글자
  const got = plain(edLspDiagItems(v.lsp, [lspDiag(1, 0, 1, 2)]));
  assert.equal(got.length, 1);
  assert.equal(got[0].from, 5);
  assert.equal(got[0].to, 7);
});

test('심각도 1·2·3·4 는 error·warning·info·hint, 없으면 error 다. source 를 싣는다', () => {
  const v = fakeView('abcdef\n');
  const got = plain(edLspDiagItems(v.lsp, [
    lspDiag(0, 0, 0, 1, { severity: 1 }), lspDiag(0, 0, 0, 1, { severity: 2 }),
    lspDiag(0, 0, 0, 1, { severity: 3 }), lspDiag(0, 0, 0, 1, { severity: 4 }),
    lspDiag(0, 0, 0, 1, { source: 'compiler', message: 'boom' }),
  ]));
  assert.deepEqual(got.map((d) => d.severity), ['error', 'warning', 'info', 'hint', 'error']);
  assert.equal(got[4].source, 'compiler');
  assert.equal(got[4].message, 'boom');
});

test('문서 밖의 줄·글자는 문서 안으로 접힌다 (던지지 않는다)', () => {
  const v = fakeView('ab\ncd');
  const got = plain(edLspDiagItems(v.lsp, [lspDiag(0, 9, 7, 3), lspDiag(-1, -2, 0, 1)]));
  assert.deepEqual(got.map((d) => [d.from, d.to]), [[2, 5], [0, 1]]);
});

test('edLspDiagShow: 켜져 있으면 그룹의 모든 칸에 보관분을, 꺼져 있으면 빈 진단을 그린다', () => {
  const buf = new EdBuffer('abcdef\n');
  const a = bufSink(buf), b = bufSink(buf);
  buf.setDiagnostics([{ from: 1, to: 3, severity: 'warning', message: 'w' }]);
  edLspDiagShow(buf, true);
  assert.deepEqual(shown(a), [{ from: 1, to: 3, severity: 'warning', message: 'w' }]);
  assert.deepEqual(shown(b), shown(a));
  edLspDiagShow(buf, false);
  assert.deepEqual(shown(a), []);
  assert.deepEqual(shown(b), []);
  assert.equal(buf.diagnostics.length, 1, '끄면 그림만 지우고 보관분은 남는다');
});

function diagSetup(on) {
  const buf = new EdBuffer('package a\nfunc f() {}\n');
  const a = bufSink(buf), b = bufSink(buf);
  const { ws } = workspace();
  const va = fakeView(buf.doc.toString()), vb = fakeView(buf.doc.toString());
  ws.openFile(U, 'go', va);
  ws.openFile(U, 'go', vb);
  const st = { on };
  const paths = [];
  const ext = edLspDiagnostics({ bufOf: (p) => { paths.push(p); return p === '/r/a.go' ? buf : null }, on: () => st.on });
  const handle = ext.notificationHandlers['textDocument/publishDiagnostics'];
  const client = { workspace: ws };
  return { buf, a, b, ws, st, paths, handle: (params) => handle(client, params) };
}

test('publishDiagnostics: 버퍼에 보관하고 그룹의 모든 칸에 그린다', () => {
  const t = diagSetup(true);
  const r = t.handle({ uri: U, diagnostics: [lspDiag(1, 5, 1, 6, { severity: 2 })] });
  assert.equal(r, true);
  assert.deepEqual(t.paths, ['/r/a.go']);
  assert.equal(t.buf.diagnostics.length, 1);
  assert.deepEqual(shown(t.a).map((d) => [d.from, d.to, d.severity]), [[15, 16, 'warning']]);
  assert.deepEqual(shown(t.b), shown(t.a));
  // 빈 진단은 "이제 깨끗하다" 이다 — 앞 밑줄을 걷는다.
  t.handle({ uri: U, diagnostics: [] });
  assert.equal(t.buf.diagnostics.length, 0);
  assert.deepEqual(shown(t.a), []);
});

test('publishDiagnostics: 꺼져 있으면 보관만 하고 그리지 않는다 — 다시 켜면 보관분을 그린다', () => {
  const t = diagSetup(false);
  t.handle({ uri: U, diagnostics: [lspDiag(0, 0, 0, 7)] });
  assert.equal(t.buf.diagnostics.length, 1);
  assert.deepEqual(shown(t.a), []);
  edLspDiagShow(t.buf, true);
  assert.equal(shown(t.a).length, 1);
  assert.equal(shown(t.b).length, 1);
});

test('publishDiagnostics: 판이 다르거나 열리지 않은 파일이면 버린다', () => {
  const t = diagSetup(true);
  const ver = t.ws.getFile(U).version;
  t.handle({ uri: U, version: ver + 1, diagnostics: [lspDiag(0, 0, 0, 1)] });
  t.handle({ uri: 'file:///r/zz.go', diagnostics: [lspDiag(0, 0, 0, 1)] });
  assert.equal(t.buf.diagnostics.length, 0);
  assert.deepEqual(shown(t.a), []);
  t.handle({ uri: U, version: ver, diagnostics: [lspDiag(0, 0, 0, 1)] });
  assert.equal(t.buf.diagnostics.length, 1, '판이 같으면 받는다');
});

test('edLspDiagnostics: 능력과 autoSync 는 라이브러리 serverDiagnostics 의 것이다', () => {
  const ext = edLspDiagnostics({ bufOf: () => null, on: () => true });
  const base = CM.serverDiagnostics();
  assert.equal(ext.editorExtension, base.editorExtension);
  assert.deepEqual(plain(ext.clientCapabilities), plain(base.clientCapabilities));
  assert.equal(typeof ext.notificationHandlers['textDocument/publishDiagnostics'], 'function');
});

// ── 소켓 ──

test('소켓: 여는 중에는 줄을 세우고 열리면 보낸다', () => {
  FakeWS.all.length = 0;
  const s = new EdLspSocket('ws://h/x', { root: '/r' });
  const got = [];
  s.subscribe((m) => got.push(m));
  s.send('{"jsonrpc":"2.0","id":1,"method":"initialize"}');
  const ws = FakeWS.all[0];
  assert.equal(ws.sent.length, 0);
  ws._open();
  assert.equal(ws.sent.length, 1);
  ws._msg({ jsonrpc: '2.0', id: 1, result: {} });
  assert.equal(got.length, 1);
});

test('소켓: 서버 요청은 가로채 답하고 클라이언트에 넘기지 않는다', () => {
  FakeWS.all.length = 0;
  const s = new EdLspSocket('ws://h/x', { root: '/r' });
  const got = [];
  s.subscribe((m) => got.push(m));
  const ws = FakeWS.all[0];
  ws._open();
  ws._msg({ jsonrpc: '2.0', id: 'q1', method: 'workspace/configuration', params: { items: [{}] } });
  assert.equal(got.length, 0);
  assert.deepEqual(ws.msgs(), [{ jsonrpc: '2.0', id: 'q1', result: [null] }]);
  ws._msg({ jsonrpc: '2.0', id: 'q2', method: 'nope' });
  assert.equal(ws.msgs()[1].error.code, -32601);
});

test('소켓: 닫힌 뒤 요청은 던지고 알림은 버린다 — 어느 쪽이든 다시 연결을 청한다', () => {
  FakeWS.all.length = 0;
  let retries = 0, closed = null;
  const s = new EdLspSocket('ws://h/x', { root: '/r', onRetry: () => retries++, onClose: (c, r) => { closed = [c, r] } });
  const ws = FakeWS.all[0];
  ws._open();
  ws._close(4003, 'ended');
  assert.deepEqual(closed, [4003, 'ended']);
  assert.throws(() => s.send('{"jsonrpc":"2.0","id":7,"method":"textDocument/hover"}'));
  s.send('{"jsonrpc":"2.0","method":"textDocument/didChange"}');
  assert.equal(retries, 2);
  assert.equal(ws.sent.length, 0);
});

// ── 연결 ──

/** initialize 에 답하는 가짜 서버. */
function serve(ws) {
  ws._open();
  const init = ws.msgs().find((m) => m.method === 'initialize');
  ws._msg({ jsonrpc: '2.0', id: init.id, result: { capabilities: { textDocumentSync: 2, hoverProvider: true } } });
}

function conn(extra = {}) {
  let now = 1000;
  const c = new EdLspConn({ root: '/r', desc: 'gopls/gopls', now: () => now, ...extra });
  return { c, advance: (d) => { now += d } };
}

test('연결: 주소는 루트와 서술자를 싣고, initialize 의 rootUri 는 루트다', async () => {
  FakeWS.all.length = 0;
  const { c } = conn({ root: '/r/한 글' });
  const p = c.ensure();
  const ws = FakeWS.all[0];
  const u = new URL(ws.url);
  assert.equal(u.protocol, 'ws:');
  assert.equal(u.host, 'h:1');
  assert.equal(u.pathname, '/api/lsp/ws');
  assert.equal(u.searchParams.get('root'), '/r/한 글');
  assert.equal(u.searchParams.get('server'), 'gopls/gopls');
  serve(ws);
  await p;
  assert.equal(c.state, 'open');
  const init = ws.msgs().find((m) => m.method === 'initialize');
  assert.equal(init.params.rootUri, 'file:///r/%ED%95%9C%20%EA%B8%80');
  assert.equal(c.client.timeout, 15000);
  assert.ok(ws.methods().includes('initialized'));
});

test('연결: 같은 연결의 ensure 는 소켓을 하나만 연다', async () => {
  FakeWS.all.length = 0;
  const { c } = conn();
  const p1 = c.ensure(), p2 = c.ensure();
  assert.equal(FakeWS.all.length, 1);
  serve(FakeWS.all[0]);
  await Promise.all([p1, p2]);
  await c.ensure();
  assert.equal(FakeWS.all.length, 1);
});

test('연결: 끊긴 뒤 ensure 는 새 소켓으로 다시 열고 열린 파일을 다시 didOpen 한다', async () => {
  FakeWS.all.length = 0;
  const { c } = conn();
  c.client.workspace.openFile(U, 'go', fakeView('package a\n'));
  const p = c.ensure();
  serve(FakeWS.all[0]);
  await p;
  await tick();
  assert.ok(FakeWS.all[0].methods().includes('textDocument/didOpen'));
  FakeWS.all[0]._close(4003, 'ended');
  assert.equal(c.state, 'closed');
  assert.deepEqual([c.lastClose.code, c.lastClose.reason], [4003, 'ended']);
  const p2 = c.ensure();
  assert.equal(FakeWS.all.length, 2);
  serve(FakeWS.all[1]);
  await p2;
  await tick();
  const ms = FakeWS.all[1].methods();
  assert.ok(ms.indexOf('initialize') < ms.indexOf('textDocument/didOpen'), ms.join(','));
});

test('연결: 끊긴 뒤 처음 요청은 실패하고 다시 연결을 청한다', async () => {
  FakeWS.all.length = 0;
  const { c } = conn();
  const p = c.ensure();
  serve(FakeWS.all[0]);
  await p;
  FakeWS.all[0]._close(4003, 'ended');
  await assert.rejects(c.client.request('textDocument/hover', {}));
  assert.equal(FakeWS.all.length, 2, '다시 연결을 청하지 않았다');
});

test('연결: 상한·기동 실패로 닫히면 재시도 시간 안에는 다시 열지 않는다', async () => {
  for (const code of [4001, 4002]) {
    FakeWS.all.length = 0;
    const { c, advance } = conn();
    const p = c.ensure();
    FakeWS.all[0]._open();
    FakeWS.all[0]._close(code, code === 4001 ? 'limit' : 'gopls 없음');
    await assert.rejects(p);
    assert.equal(c.lastClose.code, code);
    await assert.rejects(c.ensure());
    assert.equal(FakeWS.all.length, 1, `${code}: 재시도 시간 안에 다시 열었다`);
    advance(5001);
    const p2 = c.ensure();
    assert.equal(FakeWS.all.length, 2);
    serve(FakeWS.all[1]);
    await p2;
  }
});

test('연결: initialize 전에 닫혀도 처리되지 않은 rejection 이 남지 않는다', async () => {
  FakeWS.all.length = 0;
  const leaks = [];
  const on = (e) => leaks.push(e);
  process.on('unhandledRejection', on);
  try {
    const { c } = conn({ timeout: 20 });
    c.client.workspace.openFile(U, 'go', fakeView('x'));
    const p = c.ensure();
    p.catch(() => {});
    FakeWS.all[0]._open();
    FakeWS.all[0]._close(4001, 'limit');
    await new Promise((r) => setTimeout(r, 80));
  } finally {
    process.off('unhandledRejection', on);
  }
  assert.deepEqual(leaks, []);
});
