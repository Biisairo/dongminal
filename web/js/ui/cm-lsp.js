/**
 * 브라우저 LSP — CODEMIRROR_MIGRATION_SRS §3.10 · FR-CMR-23 · §11.6 L1.
 *
 * `@codemirror/lsp-client` 를 페이지의 (루트, 서술자)마다 하나 두고(`EdLspConn`), 통로
 * `/api/lsp/ws` 에 잇는다(`EdLspSocket`). 같은 파일을 연 칸들은 언어 서버에 문서 하나로
 * 보인다(`edLspWorkspaceClass`).
 *
 * `CM` 은 편집기를 처음 열 때 온다 — 이 파일은 그 전에 실리므로 `CM` 은 쓸 때 읽는다.
 */

// Go `url.URL` 이 경로에서 이스케이프하지 않는 글자 (영숫자·`-._~`·`$&+,/:;=@`).
const ED_LSP_URI_KEEP = /^[A-Za-z0-9\-._~$&+,/:;=@]$/;
const ED_LSP_WIN_ABS = /^[A-Za-z]:/;

/** 경로 → file URI. Go `platform.Paths.FileURI` 와 같다 (벡터 `file_uri_vectors.json`). */
function edLspUri(path) {
  let p = String(path || '');
  if (ED_LSP_WIN_ABS.test(p)) {
    p = p.replace(/\\/g, '/');
    if (!p.startsWith('/')) p = '/' + p;
  }
  let out = '';
  for (const b of new TextEncoder().encode(p)) {
    const ch = String.fromCharCode(b);
    out += b < 0x80 && ED_LSP_URI_KEEP.test(ch) ? ch : '%' + b.toString(16).toUpperCase().padStart(2, '0');
  }
  return 'file://' + out;
}

/** file URI → 경로. `file:` 이 아니면 빈 값이다. */
function edLspPath(uri) {
  if (typeof uri !== 'string' || !uri.startsWith('file:')) return '';
  let rest = uri.slice('file:'.length);
  if (rest.startsWith('//')) {
    rest = rest.slice(2);
    const i = rest.indexOf('/');
    rest = i < 0 ? '' : rest.slice(i);
  }
  rest = rest.split(/[?#]/)[0];
  const p = edLspDecode(rest);
  if (/^\/[A-Za-z]:/.test(p)) return p.slice(1).replace(/\//g, '\\');
  return p;
}

// 퍼센트 인코딩을 UTF-8 바이트로 푼다. 망가진 `%` 는 글자 그대로 둔다.
function edLspDecode(s) {
  const bytes = [];
  const enc = new TextEncoder();
  for (let i = 0; i < s.length; i++) {
    const hex = s[i] === '%' ? s.slice(i + 1, i + 3) : '';
    if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
      bytes.push(parseInt(hex, 16));
      i += 2;
      continue;
    }
    const cp = s.codePointAt(i);
    const ch = String.fromCodePoint(cp);
    if (ch.length > 1) i++;
    for (const b of enc.encode(ch)) bytes.push(b);
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

// 같은 파일인가를 견주는 열쇠. Windows 드라이브 문자는 대소문자를 가리지 않는다.
function edLspPathKey(uri) {
  const p = edLspPath(uri);
  return ED_LSP_WIN_ABS.test(p) ? p[0].toLowerCase() + p.slice(1) : p;
}

/** 이 파일의 LSP language id. Go `languageFor` 와 같은 표다. */
function edLspLangId(path, langs) {
  const m = String(path || '').match(/(\.[^./\\]+)$/);
  const ext = m ? m[1].toLowerCase() : '';
  if (['.ts', '.mts', '.cts'].includes(ext)) return 'typescript';
  if (ext === '.tsx') return 'typescriptreact';
  if (['.js', '.mjs', '.cjs'].includes(ext)) return 'javascript';
  if (ext === '.jsx') return 'javascriptreact';
  return (langs && langs[0]) || '';
}

/**
 * 서버가 보내는 요청의 답 — Go `serverRequestResult` 를 옮겼다. 라이브러리는 서버 요청을
 * 모두 −32601 로 답하므로 소켓이 가로챈다.
 */
function edLspServerReply(method, params, root) {
  switch (method) {
    case 'workspace/configuration': {
      const items = params && Array.isArray(params.items) ? params.items : [];
      return { result: items.map(() => null) };
    }
    case 'client/registerCapability':
    case 'client/unregisterCapability':
    case 'window/workDoneProgress/create':
      return { result: null };
    case 'workspace/workspaceFolders': {
      const name = String(root).split(/[\\/]/).filter(Boolean).pop() || String(root);
      return { result: [{ uri: edLspUri(root), name }] };
    }
  }
  return { error: { code: -32601, message: 'Method not implemented: ' + method } };
}

// LSP DiagnosticSeverity → lint 심각도.
const ED_LSP_SEVERITY = { 1: 'error', 2: 'warning', 3: 'info', 4: 'hint' };

// LSP 위치 → offset. 문서 밖이면 문서 안으로 접는다.
function edLspOffset(doc, pos) {
  const p = pos || {};
  const line = doc.line(Math.min(Math.max(p.line | 0, 0), doc.lines - 1) + 1);
  return line.from + Math.min(Math.max(p.character | 0, 0), line.length);
}

/**
 * LSP 진단 → lint 진단 (FR-CMR-92 · §11.6 L2). 위치는 플러그인이 동기화한 문서 기준이고
 * 그 뒤의 미동기 변경으로 옮긴다 — 라이브러리 `serverDiagnostics` 와 같다.
 */
function edLspDiagItems(plugin, items) {
  const doc = plugin.syncedDoc;
  const ch = plugin.unsyncedChanges;
  return (Array.isArray(items) ? items : []).map((it) => {
    const r = it.range || {};
    const a = ch.mapPos(edLspOffset(doc, r.start));
    const b = ch.mapPos(edLspOffset(doc, r.end));
    const d = { from: Math.min(a, b), to: Math.max(a, b), severity: ED_LSP_SEVERITY[it.severity] || 'error', message: String(it.message || '') };
    if (it.source) d.source = String(it.source);
    return d;
  });
}

/** 그룹의 모든 칸에 진단을 그린다 — 꺼져 있으면 빈 진단(지운다). 보관분은 그대로 둔다. */
function edLspDiagShow(buf, on) {
  if (!buf) return;
  const list = on ? buf.diagnostics : [];
  for (const s of buf.sinks) s.dispatch(CM.setDiagnostics(s.state, list));
}

/**
 * `LSPClient` 확장 — 능력과 autoSync(`didChange`)는 라이브러리 것을 그대로 쓰고, 진단 처리기만
 * 바꾼다: 그룹의 버퍼에 보관하고 모든 칸에 그린다. 켜기/끄기는 처리기가 본다 (FR-CMR-92).
 *
 * hooks.bufOf(path): 그 파일의 `EdBuffer`. hooks.on(): 진단을 그리는가.
 */
function edLspDiagnostics(hooks) {
  const base = CM.serverDiagnostics();
  return {
    clientCapabilities: base.clientCapabilities,
    editorExtension: base.editorExtension,
    notificationHandlers: {
      'textDocument/publishDiagnostics': (client, params) => {
        const file = client.workspace.getFile(params.uri);
        if (!file || (params.version != null && params.version !== file.version)) return true;
        const view = file.getView();
        const plugin = view && CM.LSPPlugin.get(view);
        const buf = plugin && hooks.bufOf(edLspPath(file.uri));
        if (!buf) return true;
        buf.setDiagnostics(edLspDiagItems(plugin, params.diagnostics));
        edLspDiagShow(buf, hooks.on());
        return true;
      },
    },
  };
}

let edLspWorkspaceCls = null;

/**
 * 같은 파일의 칸들을 문서 하나로 세는 Workspace (FR-CMR-23). `CM` 이 선 뒤에 만든다.
 *
 * hooks.display(path) 는 앱이 그 파일을 열고 편집기가 선 뒤 그 뷰를 낸다. hooks.joined(path, view) 는
 * 이미 열린 파일에 칸이 하나 더 붙었다는 알림이다 — 그 칸에 보관한 진단을 그린다.
 */
function edLspWorkspaceClass() {
  if (edLspWorkspaceCls) return edLspWorkspaceCls;
  class EdLspFile {
    constructor(uri, languageId, version, doc) {
      this.uri = uri;
      this.languageId = languageId;
      this.version = version;
      this.doc = doc;
      this.views = new Set();
    }
    getView(main) {
      if (main && this.views.has(main)) return main;
      for (const v of this.views) return v;
      return null;
    }
  }
  edLspWorkspaceCls = class EdLspWorkspace extends CM.Workspace {
    constructor(client, hooks) {
      super(client);
      this.files = [];
      this._hooks = hooks || {};
      this._versions = new Map();
    }

    _nextVersion(uri) {
      const v = (this._versions.has(uri) ? this._versions.get(uri) : -1) + 1;
      this._versions.set(uri, v);
      return v;
    }

    getFile(uri) {
      const exact = this.files.find((f) => f.uri === uri);
      if (exact) return exact;
      const key = edLspPathKey(uri);
      if (!key) return null;
      return this.files.find((f) => edLspPathKey(f.uri) === key) || null;
    }

    /**
     * 그룹의 칸들은 같은 변경을 받으므로, 파일의 판(`doc`)에서 출발한 칸 하나의 미동기
     * 변경이 곧 그룹의 변경이다. 그런 칸이 없으면 전체를 갈아 끼운다.
     */
    syncFiles() {
      const out = [];
      for (const f of this.files) {
        const view = f.getView();
        if (!view) continue;
        let base = null;
        for (const v of f.views) {
          const p = CM.LSPPlugin.get(v);
          if (p && p.syncedDoc.eq(f.doc)) { base = { v, p }; break }
        }
        let changes;
        let next;
        if (base) {
          if (base.p.unsyncedChanges.empty) continue;
          changes = base.p.unsyncedChanges;
          next = base.v.state.doc;
        } else {
          next = view.state.doc;
          if (next.eq(f.doc)) { this._clear(f); continue }
          changes = CM.ChangeSet.of({ from: 0, to: f.doc.length, insert: next }, f.doc.length);
        }
        out.push({ file: f, prevDoc: f.doc, changes });
        f.doc = next;
        f.version = this._nextVersion(f.uri);
        this._clear(f);
      }
      return out;
    }

    _clear(f) {
      for (const v of f.views) {
        const p = CM.LSPPlugin.get(v);
        if (p) p.clear();
      }
    }

    openFile(uri, languageId, view) {
      const f = this.getFile(uri);
      if (f) {
        f.views.add(view);
        if (this._hooks.joined) this._hooks.joined(edLspPath(f.uri), view);
        return;
      }
      const nf = new EdLspFile(uri, languageId, this._nextVersion(uri), view.state.doc);
      nf.views.add(view);
      this.files.push(nf);
      this.client.didOpen(nf);
    }

    closeFile(uri, view) {
      const f = this.getFile(uri);
      if (!f) return;
      f.views.delete(view);
      if (f.views.size) return;
      this.files = this.files.filter((x) => x !== f);
      this.client.didClose(f.uri);
    }

    displayFile(uri) {
      const path = edLspPath(uri);
      if (!path || !this._hooks.display) return Promise.resolve(null);
      return Promise.resolve(this._hooks.display(path)).then((v) => v || null);
    }
  };
  return edLspWorkspaceCls;
}

// 요청(`id` 가 있다)인가. 닫힌 뒤에만 부른다 — 평소에는 메시지를 풀지 않는다.
function edLspIsRequest(msg) {
  const m = JSON.parse(msg);
  return m != null && m.id !== undefined;
}

/**
 * `lsp-client` 의 Transport — WebSocket 하나 (FR-CMR-91).
 *
 * o.root: 서버 요청의 답에 쓴다. o.onClose(code, reason): 소켓이 닫혔다. o.onRetry():
 * 닫힌 뒤 무엇을 보내려 했다 — 다시 연결을 청한다.
 */
class EdLspSocket {
  constructor(url, o) {
    this._o = o || {};
    this._subs = new Set();
    this._queue = [];
    this.closed = false;
    const ws = new WebSocket(url);
    this._ws = ws;
    ws.onopen = () => {
      const q = this._queue;
      this._queue = [];
      for (const m of q) ws.send(m);
    };
    ws.onmessage = (e) => this._recv(String(e.data));
    ws.onclose = (e) => {
      if (this.closed) return;
      this.closed = true;
      this._queue = [];
      if (this._o.onClose) this._o.onClose(e.code, e.reason);
    };
  }

  /** 닫힌 뒤에는 요청이면 던지고(라이브러리가 그 요청을 실패로 돌린다) 알림이면 버린다. */
  send(msg) {
    if (this.closed) {
      if (this._o.onRetry) this._o.onRetry();
      if (edLspIsRequest(msg)) throw new Error('lsp: connection closed');
      return;
    }
    if (this._ws.readyState === WebSocket.OPEN) this._ws.send(msg);
    else this._queue.push(msg);
  }

  subscribe(fn) { this._subs.add(fn) }
  unsubscribe(fn) { this._subs.delete(fn) }

  close() {
    if (!this.closed) this._ws.close();
  }

  _recv(raw) {
    const m = JSON.parse(raw);
    if (m && m.id !== undefined && m.method) {
      this._ws.send(JSON.stringify({ jsonrpc: '2.0', id: m.id, ...edLspServerReply(m.method, m.params, this._o.root) }));
      return;
    }
    for (const fn of this._subs) fn(raw);
  }
}

/**
 * 연결 하나 — 페이지의 (루트, 서술자) (FR-CMR-90·91).
 *
 * o: {root, desc, display(path), joined(path, view), extensions, sanitizeHTML, timeout, now}
 */
class EdLspConn {
  constructor(o) {
    this.root = o.root;
    this.desc = o.desc;
    this._now = o.now || (() => Date.now());
    this._sock = null;
    this._ready = null;
    this._initDone = false;
    this._retrying = false;
    this.state = 'idle';
    this.lastClose = null;
    const W = edLspWorkspaceClass();
    this.client = new CM.LSPClient({
      rootUri: edLspUri(o.root),
      timeout: o.timeout || ED_LSP_TIMEOUT_MS,
      workspace: (c) => new W(c, { display: o.display, joined: o.joined }),
      sanitizeHTML: o.sanitizeHTML,
      extensions: o.extensions || [],
    });
  }

  /** 열려 있으면 그 초기화를, 닫혀 있으면 새로 연다. 상한·기동 실패 직후에는 열지 않는다. */
  ensure() {
    if (this._sock && !this._sock.closed) return this._ready;
    const lc = this.lastClose;
    if (lc && (lc.code === LSP_WS_CLOSE_LIMIT || lc.code === LSP_WS_CLOSE_START) && this._now() - lc.at < ED_LSP_RETRY_MS) {
      const p = Promise.reject(new Error(lc.reason || String(lc.code)));
      p.catch(() => {});
      return p;
    }
    return this._open();
  }

  _url() {
    const q = new URLSearchParams({ root: this.root, server: this.desc });
    return (location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + LSP_WS_API + '?' + q.toString();
  }

  _open() {
    let resolve, reject;
    const ready = new Promise((a, b) => { resolve = a; reject = b });
    ready.catch(() => {});
    const sock = new EdLspSocket(this._url(), {
      root: this.root,
      onRetry: () => this._retry(),
      onClose: (code, reason) => this._closed(sock, code, reason, reject),
    });
    // 앞 연결의 초기화 약속은 이미 풀렸다 — 새 약속을 세워야 새 서버의 initialize 전에
    // 요청·알림이 나가지 않는다.
    if (this._sock) this.client.disconnect();
    this._sock = sock;
    this._ready = ready;
    this._initDone = false;
    this.state = 'connecting';
    this.client.connect(sock);
    this.client.initializing.then(() => {
      if (this._sock !== sock || sock.closed) return;
      this._initDone = true;
      this.state = 'open';
      resolve();
    }, () => {});
    return ready;
  }

  /**
   * 소켓이 닫혔다. `disconnect()` 는 다시 열 때 부른다 — 지금 부르면 그 뒤의 요청·알림이
   * 새 초기화 약속을 기다리느라 소켓에 닿지 않아 다시 연결할 계기가 사라진다.
   *
   * initialize 전에 닫혔으면 클라이언트의 초기화 약속을 푼다 — 기다리던 알림들이 닫힌
   * 소켓에서 버려지게 한다. 풀지 않으면 initialize 가 timeout 될 때 그 알림들이 처리되지
   * 않은 rejection 으로 남는다 (`lsp-client` 6.3.0 의 내부 `init`, FR-CMR-4 의 판 고정).
   */
  _closed(sock, code, reason, reject) {
    if (this._sock !== sock) return;
    this.lastClose = { code, reason, at: this._now() };
    this.state = 'closed';
    if (!this._initDone && this.client.init) this.client.init.resolve(null);
    reject(new Error(reason || String(code)));
  }

  _retry() {
    if (this._retrying) return;
    this._retrying = true;
    queueMicrotask(() => {
      this._retrying = false;
      this.ensure();
    });
  }

  /** 편집기에 넣을 확장. */
  plugin(path, languageId) {
    return this.client.plugin(edLspUri(path), languageId);
  }
}
