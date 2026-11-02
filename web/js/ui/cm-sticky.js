// CODEMIRROR_MIGRATION_SRS 묶음 K (FR-CMR-80~84) — 편집기 칸의 sticky scroll. Diff 뷰에는 없다 (§3.16).

/**
 * 줄 번호 `line` 을 감싸는 범위의 첫 줄 번호들. 바깥 먼저, 최대 `max` 줄이다 (FR-CMR-80).
 * 구문 트리를 주는 언어는 트리로, legacy-modes 와 언어 없는 파일은 들여쓰기로 정한다 (FR-CMR-81).
 */
function edStickyLines(state, line, max) {
  const lang = state.facet(CM.language);
  const out = lang && !(lang instanceof CM.StreamLanguage) ? edStickyByTree(state, line) : edStickyByIndent(state, line);
  return out.slice(0, max);
}

function edStickyByTree(state, line) {
  const top = state.doc.line(line);
  const seen = new Set();
  for (let n = CM.syntaxTree(state).resolveInner(top.from, 1); n; n = n.parent) {
    const head = state.doc.lineAt(n.from);
    if (head.number >= line || seen.has(head.number)) continue;
    const r = CM.foldable(state, head.from, head.to);
    if (r && r.to >= top.from) seen.add(head.number);
  }
  return [...seen].sort((a, b) => a - b);
}

function edStickyByIndent(state, line) {
  const doc = state.doc;
  const indentOf = (l) => (/\S/.test(l.text) ? CM.countColumn(l.text.match(/^\s*/)[0], state.tabSize) : -1);
  let limit = -1;
  for (let i = line; i <= doc.lines && limit < 0; i++) limit = indentOf(doc.line(i));
  const out = [];
  for (let i = line - 1; i >= 1 && limit > 0; i--) {
    const ind = indentOf(doc.line(i));
    if (ind < 0 || ind >= limit) continue;
    out.push(i);
    limit = ind;
  }
  return out.reverse();
}

// 처음 쓸 때 만든다 (`CM` 이 페이지 로드 때 없다).
function edCmStickyPlugin() {
  if (edCmStickyPlugin.plugin) return edCmStickyPlugin.plugin;
  edCmStickyPlugin.plugin = CM.ViewPlugin.fromClass(class {
    constructor(view) {
      this.view = view;
      this.dom = document.createElement('div');
      this.dom.className = 'cm-sticky';
      this.dom.addEventListener('mousedown', (e) => this.onDown(e));
      view.dom.appendChild(this.dom);
      this.shown = '';
      this.measure = { read: () => this.read(), write: (m) => this.write(m), key: this };
      view.requestMeasure(this.measure);
    }

    update(u) {
      if (u.docChanged || u.viewportChanged || u.geometryChanged || CM.syntaxTree(u.startState) !== CM.syntaxTree(u.state)) {
        if (u.docChanged || CM.syntaxTree(u.startState) !== CM.syntaxTree(u.state)) this.shown = '';
        u.view.requestMeasure(this.measure);
      }
    }

    // FR-CMR-83: viewport 맨 위 줄 하나에 대해서만 계산한다.
    read() {
      const v = this.view;
      const box = v.dom.getBoundingClientRect();
      const block = v.lineBlockAtHeight(v.scrollDOM.getBoundingClientRect().top - v.documentTop);
      const top = v.state.doc.lineAt(block.from).number;
      const nums = edStickyLines(v.state, top, ED_STICKY_MAX);
      const gutters = v.dom.querySelector('.cm-gutters');
      const num = v.dom.querySelector('.cm-lineNumbers');
      const line = v.contentDOM.querySelector('.cm-line');
      const pad = line ? parseFloat(getComputedStyle(line).paddingLeft) || 0 : 0;
      // 오른쪽 끝은 미니맵 앞이다 (Monaco 와 같다). 미니맵이 없으면 스크롤 영역 끝(스크롤바 앞)이다.
      const map = v.dom.querySelector('.cm-minimap-gutter');
      const end = map ? map.getBoundingClientRect().left : v.scrollDOM.getBoundingClientRect().right;
      return {
        nums,
        lh: v.defaultLineHeight,
        numLeft: num ? num.getBoundingClientRect().left - box.left : 0,
        numW: num ? num.getBoundingClientRect().width : 0,
        gutterW: gutters ? gutters.getBoundingClientRect().right - box.left : 0,
        textLeft: v.contentDOM.getBoundingClientRect().left - box.left + pad,
        right: box.right - end,
      };
    }

    write(m) {
      this.dom.style.display = m.nums.length ? '' : 'none';
      this.dom.style.right = m.right + 'px';
      const key = m.nums.join(',');
      if (key !== this.shown) {
        this.shown = key;
        this.dom.replaceChildren(...m.nums.map((n) => this.row(n)));
      }
      for (const row of this.dom.children) {
        row.style.height = row.style.lineHeight = m.lh + 'px';
        const [text, gut, num] = row.children;
        gut.style.width = m.gutterW + 'px';
        Object.assign(num.style, { left: m.numLeft + 'px', width: m.numW + 'px' });
        text.style.left = m.textLeft + 'px';
      }
    }

    // FR-CMR-84: 줄 번호와 편집기와 같은 구문 색의 글자.
    row(n) {
      const st = this.view.state;
      const line = st.doc.line(n);
      const row = document.createElement('div');
      row.className = 'cm-sticky-line';
      row.dataset.line = String(n);
      const gut = document.createElement('div');
      gut.className = 'cm-sticky-gutter';
      const num = document.createElement('div');
      num.className = 'cm-sticky-num';
      num.textContent = String(n);
      const text = document.createElement('div');
      text.className = 'cm-sticky-text';
      let at = line.from;
      const put = (from, to, cls) => {
        if (from > at) text.append(st.doc.sliceString(at, from));
        const s = document.createElement('span');
        s.className = cls;
        s.textContent = st.doc.sliceString(from, to);
        text.append(s);
        at = to;
      };
      CM.highlightTree(CM.syntaxTree(st), { style: (tags) => CM.highlightingFor(st, tags) }, put, line.from, line.to);
      if (at < line.to) text.append(st.doc.sliceString(at, line.to));
      // 가로로 스크롤하면 글자가 거터 밑으로 지나간다 — 거터를 뒤에 붙여 위에 그린다.
      row.append(text, gut, num);
      return row;
    }

    // FR-CMR-82: 커서를 그 줄로 옮기고, 그 줄을 감싸는 고정 줄들 바로 아래에 보인다.
    onDown(e) {
      const row = e.target instanceof Element ? e.target.closest('.cm-sticky-line') : null;
      if (!row || e.button !== 0) return;
      e.preventDefault();
      const v = this.view;
      const n = Number(row.getAttribute('data-line'));
      const from = v.state.doc.line(n).from;
      const k = edStickyLines(v.state, n, ED_STICKY_MAX).length;
      v.dispatch({
        selection: { anchor: from },
        effects: CM.EditorView.scrollIntoView(from, { y: 'start', yMargin: k * v.defaultLineHeight }),
      });
      v.focus();
    }

    destroy() {
      this.dom.remove();
    }
  }, {
    eventHandlers: {
      scroll() { this.view.requestMeasure(this.measure) },
    },
  });
  return edCmStickyPlugin.plugin;
}

/** 편집기 칸의 sticky scroll 확장 (FR-CMR-80~84). 고정된 줄은 스크롤 영역 위쪽에 겹쳐 선다. */
function edCmSticky() {
  return [
    edCmStickyPlugin(),
    CM.EditorView.theme({
      '.cm-sticky': {
        position: 'absolute', top: '0', left: '0', overflow: 'hidden',
        zIndex: 'var(--z-raised)', backgroundColor: 'var(--bg)', borderBottom: '1px solid var(--border)',
        fontFamily: ED_FONT_FAMILY, cursor: 'pointer',
      },
      '.cm-sticky-line': { position: 'relative', whiteSpace: 'pre' },
      '.cm-sticky-line:hover': { backgroundColor: 'color-mix(in srgb, var(--text) 8%, var(--bg))' },
      '.cm-sticky-gutter': { position: 'absolute', top: '0', bottom: '0', left: '0', backgroundColor: 'var(--bg)' },
      '.cm-sticky-num': {
        position: 'absolute', top: '0', textAlign: 'right', boxSizing: 'border-box', padding: '0 3px 0 5px',
        color: 'color-mix(in srgb, var(--text) 40%, var(--bg))',
      },
      '.cm-sticky-text': { position: 'absolute', top: '0' },
    }),
  ];
}
