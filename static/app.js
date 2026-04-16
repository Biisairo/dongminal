/**
 * Remote Terminal — Session → Tab → Pane
 *
 * Data model:
 *   Workspace
 *     └── Session[]          (sidebar items)
 *           └── Tab[]        (tab bar)
 *                 └── LayoutNode (split tree)
 *                       └── Pane  (xterm.js + WS + PTY)
 */

const OP = { INPUT: 0, RESIZE: 1, OUTPUT: 0, ERROR: 1, EXIT: 2, SID: 3 };
const enc = new TextEncoder();
const dec = new TextDecoder();

const THEME = {
  background:'#1a1b26', foreground:'#a9b1d6', cursor:'#c0caf5', cursorAccent:'#1a1b26',
  selectionBackground:'#33467c', selectionForeground:'#c0caf5',
  black:'#15161e', red:'#f7768e', green:'#9ece6a', yellow:'#e0af68',
  blue:'#7aa2f7', magenta:'#bb9af7', cyan:'#7dcfff', white:'#a9b1d6',
  brightBlack:'#414868', brightRed:'#f7768e', brightGreen:'#9ece6a',
  brightYellow:'#e0af68', brightBlue:'#7aa2f7', brightMagenta:'#bb9af7',
  brightCyan:'#7dcfff', brightWhite:'#c0caf5',
};

const TERM_OPTS = {
  scrollback: 50000, cursorBlink: true, cursorStyle: 'block',
  fontSize: 14, lineHeight: 1.2, allowProposedApi: true, logLevel: 'off',
  fontFamily: "'Menlo','Monaco','Consolas','Liberation Mono','Courier New',monospace",
  theme: THEME,
};

// ══════════════════════════════════════════════════════
//  TermPane — one xterm.js + one WebSocket → one PTY
// ══════════════════════════════════════════════════════

class TermPane {
  constructor(id, name) {
    this.id = id;
    this.name = name;
    this.ws = null;
    this.term = null;
    this.fitAddon = null;

    // DOM container — always lives in #terminal-area or .split-child
    this.el = document.createElement('div');
    this.el.className = 'term-pane';
    this.el.dataset.paneId = id;

    // Inner div that xterm.js opens into
    this.inner = document.createElement('div');
    this.inner.style.cssText = 'width:100%;height:100%;';
    this.el.appendChild(this.inner);

    this._pending = [];  // buffer output until xterm opens
    this._opened = false;
  }

  /** Create xterm instance. Container must be in DOM and VISIBLE with non-zero size. */
  open() {
    if (this._opened) return;
    this._opened = true;

    this.term = new Terminal(TERM_OPTS);
    this.fitAddon = new FitAddon.FitAddon();
    this.term.loadAddon(this.fitAddon);
    try { this.term.loadAddon(new WebLinksAddon.WebLinksAddon()); } catch (e) { console.warn('weblinks:', e); }
    try { this.term.loadAddon(new Unicode11Addon.Unicode11Addon()); this.term.unicode.activeVersion = '11'; } catch (e) { console.warn('unicode11:', e); }

    this.term.open(this.inner);

    // Replay buffered data
    for (const d of this._pending) {
      try { this.term.write(d); } catch {}
    }
    this._pending = [];

    this.term.onData(d => this._send(OP.INPUT, enc.encode(d)));
    this.term.onResize(({ cols, rows }) => {
      const m = new Uint8Array(5);
      m[0] = OP.RESIZE;
      new DataView(m.buffer).setUint16(1, cols, false);
      new DataView(m.buffer).setUint16(3, rows, false);
      this._sendRaw(m);
    });
  }

  /** Connect WebSocket. paneId is always provided (POST creates it first). */
  connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const cols = this.term?.cols || 120;
    const rows = this.term?.rows || 40;
    const url = `${proto}//${location.host}/ws?cols=${cols}&rows=${rows}&pane=${encodeURIComponent(this.id)}`;

    this.ws = new WebSocket(url);
    this.ws.binaryType = 'arraybuffer';

    this.ws.onmessage = e => {
      const d = new Uint8Array(e.data);
      if (d.length < 1) return;
      switch (d[0]) {
        case OP.OUTPUT:
          if (this.term) {
            try { this.term.write(d.subarray(1)); } catch {}
          } else {
            // xterm not opened yet — buffer it
            this._pending.push(new Uint8Array(d.subarray(1)));
          }
          break;
        case OP.SID:
          // Server confirms pane ID (should match what we sent)
          this.id = dec.decode(d.subarray(1));
          this.el.dataset.paneId = this.id;
          break;
        case OP.EXIT:
          this.write('\r\n\x1b[90m── exited ──\x1b[0m\r\n');
          break;
        case OP.ERROR:
          this.write('\r\n\x1b[31mError: ' + dec.decode(d.subarray(1)) + '\x1b[0m\r\n');
          break;
      }
    };

    this.ws.onclose = () => {
      this.write('\r\n\x1b[90m── disconnected ──\x1b[0m\r\n');
    };
    this.ws.onerror = (e) => {
      console.error('ws error for pane', this.id, e);
    };
  }

  write(s) {
    if (this.term) { try { this.term.write(s); } catch {} }
    else this._pending.push(s);
  }

  fit() {
    if (!this.fitAddon) return;
    try { this.fitAddon.fit(); } catch {}
  }

  focus() {
    if (!this.term) return;
    try { this.term.focus(); } catch {}
  }

  destroy() {
    if (this.ws) { this.ws.onclose = null; this.ws.onerror = null; this.ws.close(); this.ws = null; }
    if (this.term) { this.term.dispose(); this.term = null; }
    this.el.remove();
    this._opened = false;
  }

  async killServer() {
    try { await fetch(`/api/panes/${this.id}`, { method: 'DELETE' }); } catch {}
  }

  _send(op, data) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const m = new Uint8Array(1 + data.length);
    m[0] = op; m.set(data, 1);
    this._sendRaw(m);
  }
  _sendRaw(m) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(m);
  }
}

// ══════════════════════════════════════════════════════
//  Layout tree helpers
// ══════════════════════════════════════════════════════

function splitNode(node, targetId, newId, dir) {
  if (node.type === 'pane') {
    if (node.paneId === targetId) {
      return { type: 'split', direction: dir, children: [
        { type: 'pane', paneId: targetId },
        { type: 'pane', paneId: newId },
      ]};
    }
    return node;
  }
  node.children = node.children.map(c => splitNode(c, targetId, newId, dir));
  return node;
}

function removeNode(node, targetId) {
  if (!node) return null;
  if (node.type === 'pane') return node.paneId === targetId ? null : node;
  node.children = node.children.map(c => removeNode(c, targetId)).filter(Boolean);
  if (node.children.length === 0) return null;
  if (node.children.length === 1) return node.children[0];
  return node;
}

function hasPane(node, id) {
  if (!node) return false;
  if (node.type === 'pane') return node.paneId === id;
  return node.children.some(c => hasPane(c, id));
}

function allPaneIds(node) {
  if (!node) return [];
  if (node.type === 'pane') return [node.paneId];
  return node.children.flatMap(c => allPaneIds(c));
}

function cleanNode(node, valid) {
  if (!node) return null;
  if (node.type === 'pane') return valid.has(node.paneId) ? node : null;
  node.children = node.children.map(c => cleanNode(c, valid)).filter(Boolean);
  if (node.children.length === 0) return null;
  if (node.children.length === 1) return node.children[0];
  return node;
}

// ══════════════════════════════════════════════════════
//  App
// ══════════════════════════════════════════════════════

class App {
  constructor() {
    this.panes = new Map(); // paneId → TermPane
    this.workspace = { sessions: [], activeSession: null };
    // Monotonic counters — never reset on deletion
    this._sNum = 0;  // session number
    this._tNum = 0;  // tab number
  }

  // ── Boot ───────────────────────────────────────────

  async init() {
    try {
      const res = await fetch('/api/state');
      const state = await res.json();
      const serverPanes = state.panes || [];
      const saved = state.workspace;

      // Reconnect existing server panes
      const validIds = new Set(serverPanes.map(p => p.id));
      for (const p of serverPanes) {
        this._makePane(p.id, p.name);
      }

      // Validate saved workspace against live panes
      if (saved?.sessions?.length > 0) {
        this.workspace = saved;

        // Restore counters from loaded IDs (avoid collisions)
        for (const s of this.workspace.sessions) {
          const sn = parseInt(s.id.replace('s', ''), 10);
          if (sn > this._sNum) this._sNum = sn;
          for (const t of s.tabs) {
            const tn = parseInt(t.id.replace('t', ''), 10);
            if (tn > this._tNum) this._tNum = tn;
            // Clean stale pane refs
            t.layout = cleanNode(t.layout, validIds);
          }
          s.tabs = s.tabs.filter(t => t.layout !== null);
        }
        this.workspace.sessions = this.workspace.sessions.filter(s => s.tabs.length > 0);

        // Fix active references
        if (!this.workspace.sessions.find(s => s.id === this.workspace.activeSession)) {
          this.workspace.activeSession = this.workspace.sessions[0]?.id || null;
        }
      }

      // If nothing survived, start fresh
      if (this.workspace.sessions.length === 0) {
        await this.createSession();
        return;
      }
      const as = this.activeSession();
      if (as && !as.tabs.find(t => t.id === as.activeTab)) {
        as.activeTab = as.tabs[0]?.id || null;
      }
    } catch (e) {
      console.error('init failed:', e);
      await this.createSession();
    }
    this.render();
    this._bindKeys();
  }

  // ── Pane helpers ───────────────────────────────────

  _makePane(id, name) {
    if (this.panes.has(id)) return this.panes.get(id);
    const p = new TermPane(id, name);
    document.getElementById('terminal-area').appendChild(p.el);
    p.connect();  // always connect with pane ID (existing pane)
    this.panes.set(id, p);
    return p;
  }

  /** POST to create PTY on server, then make TermPane and connect. */
  async _newPane() {
    const res = await fetch('/api/panes?cols=120&rows=40', { method: 'POST' });
    if (!res.ok) throw new Error('Failed to create pane');
    const { id, name } = await res.json();
    return this._makePane(id, name);  // pane already exists on server → connect with ID
  }

  // ── Session CRUD ───────────────────────────────────

  async createSession() {
    const p = await this._newPane();
    const sid = `s${++this._sNum}`;
    const tid = `t${++this._tNum}`;
    const session = {
      id: sid,
      name: `Session ${this._sNum}`,
      tabs: [{ id: tid, name: `Tab ${this._tNum}`, activeId: p.id, layout: { type: 'pane', paneId: p.id } }],
      activeTab: tid,
    };
    this.workspace.sessions.push(session);
    this.workspace.activeSession = sid;
    await this.save();
    this.render();
  }

  async deleteSession(sid) {
    const idx = this.workspace.sessions.findIndex(s => s.id === sid);
    if (idx < 0) return;
    const session = this.workspace.sessions[idx];

    // Kill all panes in this session
    const ids = new Set();
    for (const tab of session.tabs) {
      for (const pid of allPaneIds(tab.layout)) ids.add(pid);
    }
    for (const pid of ids) {
      const p = this.panes.get(pid);
      if (p) { p.destroy(); this.panes.delete(pid); }
    }
    // Kill on server (after local cleanup)
    for (const pid of ids) {
      try { await fetch(`/api/panes/${pid}`, { method: 'DELETE' }); } catch {}
    }

    this.workspace.sessions.splice(idx, 1);

    if (this.workspace.sessions.length === 0) {
      await this.createSession();
      return;
    }
    if (this.workspace.activeSession === sid) {
      this.workspace.activeSession = this.workspace.sessions[Math.min(idx, this.workspace.sessions.length - 1)].id;
    }
    await this.save();
    this.render();
  }

  // ── Tab CRUD ───────────────────────────────────────

  async createTab() {
    const s = this.activeSession();
    if (!s) return;
    const p = await this._newPane();
    const tid = `t${++this._tNum}`;
    s.tabs.push({ id: tid, name: `Tab ${this._tNum}`, activeId: p.id, layout: { type: 'pane', paneId: p.id } });
    s.activeTab = tid;
    await this.save();
    this.render();
  }

  async deleteTab(tid) {
    const s = this.activeSession();
    if (!s) return;
    const idx = s.tabs.findIndex(t => t.id === tid);
    if (idx < 0) return;
    const tab = s.tabs[idx];

    // Kill panes in this tab
    const pids = allPaneIds(tab.layout);
    for (const pid of pids) {
      const p = this.panes.get(pid);
      if (p) { p.destroy(); this.panes.delete(pid); }
    }
    for (const pid of pids) {
      try { await fetch(`/api/panes/${pid}`, { method: 'DELETE' }); } catch {}
    }

    s.tabs.splice(idx, 1);

    if (s.tabs.length === 0) {
      await this.deleteSession(s.id);
      return;
    }
    if (s.activeTab === tid) {
      s.activeTab = s.tabs[Math.min(idx, s.tabs.length - 1)].id;
    }
    await this.save();
    this.render();
  }

  // ── Split ──────────────────────────────────────────

  async splitActive(dir) {
    const tab = this.activeTab();
    if (!tab) return;
    const p = await this._newPane();
    tab.layout = splitNode(tab.layout, tab.activeId, p.id, dir);
    tab.activeId = p.id;
    await this.save();
    this.render();
  }

  async closeActivePane() {
    const tab = this.activeTab();
    if (!tab) return;
    await this.deletePane(tab.activeId);
  }

  // ── Pane deletion ──────────────────────────────────

  async deletePane(pid) {
    if (!pid) return;
    const p = this.panes.get(pid);
    if (!p) return;

    p.destroy();
    this.panes.delete(pid);
    try { await fetch(`/api/panes/${pid}`, { method: 'DELETE' }); } catch {}

    // Remove from all layouts
    for (const s of this.workspace.sessions) {
      for (const t of s.tabs) {
        if (hasPane(t.layout, pid)) {
          t.layout = removeNode(t.layout, pid);
        }
      }
      s.tabs = s.tabs.filter(t => t.layout !== null);
    }
    this.workspace.sessions = this.workspace.sessions.filter(s => s.tabs.length > 0);

    if (this.workspace.sessions.length === 0) {
      await this.createSession();
      return;
    }
    // Fix active refs
    if (!this.workspace.sessions.find(s => s.id === this.workspace.activeSession)) {
      this.workspace.activeSession = this.workspace.sessions[0].id;
    }
    const as = this.activeSession();
    if (as && !as.tabs.find(t => t.id === as.activeTab)) {
      as.activeTab = as.tabs[0]?.id;
    }
    const at = this.activeTab();
    if (at && !hasPane(at.layout, at.activeId)) {
      const ids = allPaneIds(at.layout);
      at.activeId = ids[0] || null;
    }
    await this.save();
    this.render();
  }

  // ── Navigation ─────────────────────────────────────

  switchSession(sid) {
    this.workspace.activeSession = sid;
    this.save();
    this.render();
  }

  switchTab(tid) {
    const s = this.activeSession();
    if (!s) return;
    s.activeTab = tid;
    this.save();
    this.render();
  }

  setActivePane(pid) {
    const tab = this.activeTab();
    if (!tab || !hasPane(tab.layout, pid)) {
      for (const s of this.workspace.sessions) {
        for (const t of s.tabs) {
          if (hasPane(t.layout, pid)) {
            this.workspace.activeSession = s.id;
            s.activeTab = t.id;
            t.activeId = pid;
            this.save();
            this.render();
            return;
          }
        }
      }
      return;
    }
    tab.activeId = pid;
    this.save();
    this.render();
  }

  // ── Accessors ──────────────────────────────────────

  activeSession() {
    return this.workspace.sessions.find(s => s.id === this.workspace.activeSession) || null;
  }

  activeTab() {
    const s = this.activeSession();
    if (!s) return null;
    return s.tabs.find(t => t.id === s.activeTab) || null;
  }

  activePane() {
    const t = this.activeTab();
    if (!t) return null;
    return this.panes.get(t.activeId) || null;
  }

  // ── State ──────────────────────────────────────────

  async save() {
    try {
      await fetch('/api/workspace', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(this.workspace),
      });
    } catch {}
  }

  // ── Render ─────────────────────────────────────────

  render() {
    this.renderSidebar();
    this.renderTabs();
    this.renderLayout();
  }

  renderSidebar() {
    const el = document.getElementById('session-list');
    el.innerHTML = '';
    for (const s of this.workspace.sessions) {
      const item = document.createElement('div');
      item.className = 'session-item' + (s.id === this.workspace.activeSession ? ' active' : '');
      item.innerHTML =
        `<span class="session-dot"></span>` +
        `<span class="session-name">${s.name}</span>` +
        `<span class="session-close">×</span>`;
      item.addEventListener('click', e => {
        if (!e.target.classList.contains('session-close')) this.switchSession(s.id);
      });
      item.querySelector('.session-close').addEventListener('click', e => {
        e.stopPropagation();
        this.deleteSession(s.id);
      });
      el.appendChild(item);
    }
  }

  renderTabs() {
    const bar = document.getElementById('tabbar');
    bar.innerHTML = '';

    const s = this.activeSession();
    if (!s) { bar.style.display = 'none'; return; }
    bar.style.display = 'flex';

    for (const t of s.tabs) {
      const el = document.createElement('div');
      el.className = 'tab' + (t.id === s.activeTab ? ' active' : '');
      el.innerHTML = `<span class="tab-label">${t.name}</span><span class="tab-close">×</span>`;
      el.addEventListener('click', e => {
        if (!e.target.classList.contains('tab-close')) this.switchTab(t.id);
      });
      el.querySelector('.tab-close').addEventListener('click', e => {
        e.stopPropagation();
        this.deleteTab(t.id);
      });
      bar.appendChild(el);
    }

    // + tab button
    const btnNew = document.createElement('button');
    btnNew.className = 'tabbar-btn tabbar-add';
    btnNew.textContent = '+';
    btnNew.title = 'New Tab (Ctrl+Shift+T)';
    btnNew.addEventListener('click', () => this.createTab());
    bar.appendChild(btnNew);

    // Separator
    const sep = document.createElement('div');
    sep.className = 'tabbar-sep';
    bar.appendChild(sep);

    // Split horizontal
    const btnH = document.createElement('button');
    btnH.className = 'tabbar-btn';
    btnH.innerHTML = '<svg width="14" height="10" viewBox="0 0 14 10"><rect x=".5" y=".5" width="5" height="9" rx="1" fill="none" stroke="currentColor" stroke-width="1.2"/><rect x="8.5" y=".5" width="5" height="9" rx="1" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>';
    btnH.title = 'Split Horizontal (Ctrl+Shift+H)';
    btnH.addEventListener('click', () => this.splitActive('horizontal'));
    bar.appendChild(btnH);

    // Split vertical
    const btnV = document.createElement('button');
    btnV.className = 'tabbar-btn';
    btnV.innerHTML = '<svg width="14" height="10" viewBox="0 0 14 10"><rect x=".5" y=".5" width="13" height="3.5" rx="1" fill="none" stroke="currentColor" stroke-width="1.2"/><rect x=".5" y="6" width="13" height="3.5" rx="1" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>';
    btnV.title = 'Split Vertical (Ctrl+Shift+V)';
    btnV.addEventListener('click', () => this.splitActive('vertical'));
    bar.appendChild(btnV);

    // Close pane
    const btnC = document.createElement('button');
    btnC.className = 'tabbar-btn';
    btnC.innerHTML = '<svg width="12" height="12" viewBox="0 0 12 12"><line x1="2" y1="2" x2="10" y2="10" stroke="currentColor" stroke-width="1.4"/><line x1="10" y1="2" x2="2" y2="10" stroke="currentColor" stroke-width="1.4"/></svg>';
    btnC.title = 'Close Pane (Ctrl+Shift+W)';
    btnC.addEventListener('click', () => this.closeActivePane());
    bar.appendChild(btnC);
  }

  renderLayout() {
    const area = document.getElementById('terminal-area');
    const tab = this.activeTab();

    // 1) Detach all panes from split structure → back to area, hide
    for (const p of this.panes.values()) {
      p.el.classList.remove('visible');
      if (p.el.parentElement !== area) area.appendChild(p.el);
    }

    // 2) Remove old split structure
    for (const ch of [...area.children]) {
      if (ch.classList.contains('split')) ch.remove();
    }

    if (!tab?.layout) return;

    const ids = allPaneIds(tab.layout);

    // 3) Build layout tree, position panes
    if (tab.layout.type === 'pane') {
      const p = this.panes.get(tab.layout.paneId);
      if (p) p.el.classList.add('visible');
    } else {
      area.appendChild(this._buildSplit(tab.layout));
    }

    // 4) Open xterm + fit for visible panes (next frame when layout is settled)
    requestAnimationFrame(() => {
      for (const pid of ids) {
        const p = this.panes.get(pid);
        if (!p || !p.el.classList.contains('visible')) continue;
        if (!p._opened) p.open();
        p.fit();
      }
      // Focus active
      const ap = this.panes.get(tab.activeId);
      if (ap) ap.focus();
    });
  }

  _buildSplit(node) {
    const el = document.createElement('div');
    el.className = 'split';
    el.dataset.dir = node.direction;

    for (let i = 0; i < node.children.length; i++) {
      const child = node.children[i];
      const childEl = document.createElement('div');
      childEl.className = 'split-child';
      el.appendChild(childEl);

      if (child.type === 'pane') {
        const p = this.panes.get(child.paneId);
        if (p) {
          childEl.appendChild(p.el);
          p.el.classList.add('visible');
        }
      } else {
        childEl.appendChild(this._buildSplit(child));
      }

      if (i < node.children.length - 1) {
        const handle = document.createElement('div');
        handle.className = 'split-handle';
        el.appendChild(handle);
        this._initHandle(handle, el);
      }
    }
    return el;
  }

  _initHandle(handle, splitEl) {
    handle.addEventListener('mousedown', e => {
      e.preventDefault();
      const dir = splitEl.dataset.dir;
      const prev = handle.previousElementSibling;
      const next = handle.nextElementSibling;
      const startX = e.clientX, startY = e.clientY;
      const startW = prev.offsetWidth, startH = prev.offsetHeight;

      const onMove = e => {
        if (dir === 'horizontal') {
          const d = e.clientX - startX;
          const total = startW + next.offsetWidth;
          const nw = startW + d;
          if (nw < 60 || total - nw < 60) return;
          prev.style.flex = `${nw / total}`;
          next.style.flex = `${(total - nw) / total}`;
        } else {
          const d = e.clientY - startY;
          const total = startH + next.offsetHeight;
          const nh = startH + d;
          if (nh < 60 || total - nh < 60) return;
          prev.style.flex = `${nh / total}`;
          next.style.flex = `${(total - nh) / total}`;
        }
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        for (const p of this.panes.values()) {
          if (p.el.classList.contains('visible')) p.fit();
        }
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  // ── Keys ───────────────────────────────────────────

  _bindKeys() {
    document.addEventListener('keydown', e => {
      if (e.ctrlKey && e.shiftKey) {
        switch (e.key) {
          case 'H': e.preventDefault(); this.splitActive('horizontal'); break;
          case 'V': if (!e.metaKey) { e.preventDefault(); this.splitActive('vertical'); } break;
          case 'W': e.preventDefault(); this.closeActivePane(); break;
          case 'T': e.preventDefault(); this.createTab(); break;
        }
      }
    });
  }
}

// ══════════════════════════════════════════════════════
//  Boot
// ══════════════════════════════════════════════════════

const app = new App();
app.init();

document.getElementById('btn-new-session').addEventListener('click', () => app.createSession());

window.addEventListener('resize', () => {
  for (const p of app.panes.values()) {
    if (p.el.classList.contains('visible')) p.fit();
  }
});

window.addEventListener('beforeunload', e => {
  if (app.panes.size > 0) { e.preventDefault(); e.returnValue = ''; }
});
