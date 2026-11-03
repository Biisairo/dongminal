/**
 * 편집기의 수정키+클릭 링크 이동과 수정키 hover 밑줄 — EDITOR_LINK_LSP_SRS FR-ELS-10~24.
 *
 * 순서는 URL → (LSP) 문서 링크 → 정의다. URL 은 클릭 안에서 동기로 연다 — `await` 뒤의
 * `window.open` 은 브라우저가 조용히 막는다 (FR-ELS-12). 문서 링크와 정의는 앱(`lspClickDef`)이 맡는다.
 *
 * 로드 순서: `ui/cm-lsp.js` 뒤 (`edLspPath`·`edLspOffset`).
 */

const ED_LINK_SCHEMAS = ['http:', 'https:'];
const ED_LINK_FRAG_LINE = /#L(\d+)/;

let edLinkify = null;

// FR-ELS-11: 스킴 있는 링크만 — 맨 도메인(fuzzy)은 `README.md` 를 잡는다 (D-BDL-2).
function edLinkifier() {
  if (!edLinkify && typeof markdownit === 'function') {
    edLinkify = markdownit().linkify.set({ fuzzyLink: false, fuzzyEmail: false, fuzzyIP: false });
  }
  return edLinkify;
}

/** 줄 글자와 열(0 부터) → 그 열을 품은 http(s) URL `{from, to, url}`. 없으면 null. */
function edLinkUrlAt(text, col) {
  const lk = edLinkifier();
  const ms = lk && lk.match(String(text || ''));
  if (!ms) return null;
  for (const m of ms) {
    if (!ED_LINK_SCHEMAS.includes(m.schema) || col < m.index || col >= m.lastIndex) continue;
    return { from: m.index, to: m.lastIndex, url: m.url };
  }
  return null;
}

// 그 자리의 URL — 문서 offset 으로.
function edLinkUrlAtPos(state, pos) {
  const line = state.doc.lineAt(pos);
  const u = edLinkUrlAt(line.text, pos - line.from);
  return u ? { from: line.from + u.from, to: line.from + u.to, url: u.url } : null;
}

/** FR-ELS-10: 수정키+클릭이 할 일 — `{kind:'url', url}` · `{kind:'lsp'}` · null. */
function edLinkClickPlan(state, pos, hasLsp) {
  const u = edLinkUrlAtPos(state, pos);
  if (u) return { kind: 'url', url: u.url };
  return hasLsp ? { kind: 'lsp' } : null;
}

/** FR-ELS-20·21: 수정키 hover 의 밑줄 범위 `{from, to}`. 없으면 null. */
function edLinkHoverRange(state, pos, hasLsp) {
  const u = edLinkUrlAtPos(state, pos);
  if (u) return { from: u.from, to: u.to };
  if (!hasLsp) return null;
  const w = state.wordAt(pos);
  return w ? { from: w.from, to: w.to } : null;
}

/** FR-ELS-10 순서 2: 그 자리를 품은 `file:` 문서 링크 → `{path, line}`. 없으면 null. */
function edLspLinkTarget(doc, links, pos) {
  for (const l of Array.isArray(links) ? links : []) {
    if (!l || typeof l.target !== 'string' || !l.target.startsWith('file:') || !l.range) continue;
    const from = edLspOffset(doc, l.range.start);
    const to = edLspOffset(doc, l.range.end);
    if (pos < from || pos > to) continue;
    const m = l.target.match(ED_LINK_FRAG_LINE);
    return { path: edLspPath(l.target), line: m ? Number(m[1]) : null };
  }
  return null;
}

const edLinkMod = (e) => (IS_MAC ? e.metaKey : e.ctrlKey);
const edLinkHasLsp = (view) => !!CM.LSPPlugin.get(view);

/**
 * 편집기 칸의 링크 확장. `hooks.lsp(view, pos)` 는 LSP 가 붙은 칸의 순서 2·3 이다.
 * `hooks.open(url)` 이 비면 `window.open` 이다.
 */
function edCmLinks(hooks) {
  const h = hooks || {};
  const open = h.open || ((url) => window.open(url, '_blank', 'noopener'));
  const setHover = CM.StateEffect.define();
  const mark = CM.Decoration.mark({ class: 'cm-link-hover' });
  const hover = CM.StateField.define({
    create: () => CM.Decoration.none,
    update(v, tr) {
      for (const e of tr.effects) if (e.is(setHover)) return e.value ? CM.Decoration.set([mark.range(e.value.from, e.value.to)]) : CM.Decoration.none;
      return v.map(tr.changes);
    },
    provide: (f) => CM.EditorView.decorations.from(f),
  });
  // NFR-ELS-2: 포인터가 있는 줄 하나만 본다. 키는 window 에서 받는다 — 포커스가 다른 칸에 있어도
  // 수정키를 떼면 밑줄이 사라져야 한다 (FR-ELS-22).
  const plugin = CM.ViewPlugin.fromClass(class {
    constructor(view) {
      this.view = view;
      this.last = null;
      this.onKey = (e) => this.track(edLinkMod(e));
      this.onBlur = () => this.show(null);
      window.addEventListener('keydown', this.onKey);
      window.addEventListener('keyup', this.onKey);
      window.addEventListener('blur', this.onBlur);
    }

    show(r) {
      const v = this.view;
      if (!r && !v.state.field(hover).size) return;
      v.dom.classList.toggle('cm-link-armed', !!r);
      v.dispatch({ effects: setHover.of(r) });
    }

    track(mod) {
      const pos = mod && this.last ? this.view.posAtCoords(this.last) : null;
      this.show(pos == null ? null : edLinkHoverRange(this.view.state, pos, edLinkHasLsp(this.view)));
    }

    destroy() {
      window.removeEventListener('keydown', this.onKey);
      window.removeEventListener('keyup', this.onKey);
      window.removeEventListener('blur', this.onBlur);
    }
  }, {
    eventHandlers: {
      mousedown(e, view) {
        if (e.button !== 0 || !edLinkMod(e)) return false;
        const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
        const plan = pos == null ? null : edLinkClickPlan(view.state, pos, edLinkHasLsp(view) && !!h.lsp);
        if (!plan) return false;
        e.preventDefault();
        if (plan.kind === 'url') open(plan.url);
        else h.lsp(view, pos);
        return true;
      },
      mousemove(e) { this.last = { x: e.clientX, y: e.clientY }; this.track(edLinkMod(e)) },
      mouseleave() { this.last = null; this.show(null) },
    },
  });
  return [hover, plugin];
}
