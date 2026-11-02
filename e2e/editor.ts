/**
 * e2e 의 편집기 접근 계층 — CODEMIRROR_MIGRATION_SRS 묶음 T (FR-CMR-120~122).
 *
 * **편집 엔진을 아는 e2e 코드는 이 파일 하나다.** 스펙은 엔진의 API·DOM 이름을 쓰지
 * 않고, 여기의 선택자 상수와 페이지 안 어댑터 `edT` 를 쓴다. 엔진을 바꾸는 커밋은
 * 앱 코드와 이 파일을 함께 고친다 — 스펙은 그대로다.
 *
 * ## 어댑터 `edT`
 *
 * fixtures 가 모든 페이지에 초기화 스크립트로 심는다. 스펙의 `page.evaluate` 안에서
 * 그대로 부른다 — 여러 단계를 한 번의 evaluate 로 하던 스펙의 원자성이 유지된다.
 *
 *   edT.of(fileEditorView)        → 편집기 핸들 (없으면 null)
 *   edT.diffSide(diffView, side)  → Diff 의 한쪽 핸들 ('orig' | 'mod')
 *   edT.text(h) / edT.setText(h, s) / ...
 *
 * 핸들은 불투명하다 — 스펙은 핸들의 필드를 읽지 않는다.
 *
 * ## 전환 기간 (CODEMIRROR_MIGRATION_SRS §7.1)
 *
 * 편집기 칸은 CodeMirror(M3), Git Diff 뷰는 M6 까지 Monaco 다. 편집기 칸의 핸들은 칸 자체
 * (`FileEditor` — 뷰 `_view` 와 버퍼 `_buf` 를 함께 든다), Diff 쪽의 핸들은 Monaco 편집기다.
 * 함수마다 `cm(h)` 로 갈라 둘 다 받는다. M6 에서 Monaco 갈래를 걷는다.
 *
 * ## 좌표
 *
 * 줄·열은 **1 부터** 센다 (지금 스펙들이 쓰는 값 그대로).
 */

// ── DOM 선택자 ─────────────────────────────────────────────────────────────

/**
 * 엔진의 DOM 이름. Node 쪽(locator)과 페이지 쪽(`edT.sel`)이 **이 한 벌**을 쓴다.
 */
export const ED_SEL = {
  /** 편집기 하나의 바깥 요소. */
  surface: ':is(.cm-editor, .monaco-editor)',
  /** Diff 편집기 하나의 바깥 요소. */
  diffSurface: ':is(.git-diff-cm, .monaco-diff-editor)',
  /** Diff 의 수정본 쪽 편집기. */
  diffModified: ':is(.git-diff-side-mod, .monaco-diff-editor .editor.modified)',
  /** Diff 전체의 overview ruler. */
  diffRuler: ':is(.git-diff-ruler, .diffOverviewRuler)',
  /** Diff 의 더한 줄·지운 줄. */
  diffInsLine: ':is(.git-diff-side-mod .cm-changedLine, .line-insert)',
  diffDelLine: ':is(.git-diff-side-orig .cm-changedLine, .cm-deletedChunk, .line-delete)',
  /** 글자가 그려지는 영역 — 눌러서 포커스를 주는 자리. */
  text: ':is(.cm-content, .view-lines)',
  /** 키 입력을 받는 요소. */
  input: ':is(.cm-content, textarea)',
  /** 호버 툴팁. */
  hover: ':is(.cm-tooltip-hover, .monaco-hover)',
  /** LSP 참조 패널과 그 항목 (`@codemirror/lsp-client`). Monaco 에는 대응물이 없다. */
  refPanel: '.cm-lsp-reference-panel',
  refItem: '.cm-lsp-reference',
  /** 진단 밑줄 (error). */
  lintError: ':is(.cm-lintRange-error, .squiggly-error)',
  /** 엔진 기본 찾기 위젯이 떠 있는 상태. 우리 패널이 대신하므로 떠서는 안 된다. */
  builtinFind: ':is(.cm-search, .find-widget.visible)',
  /** 줄 번호 옆 장식 칸 (dirty diff 막대가 서는 곳). */
  gutter: ':is(.cm-gutters, .margin-view-overlays)',
  /** 미니맵. */
  minimap: ':is(.cm-minimap-gutter, .minimap)',
  /** 미니맵 안의 뷰포트 표시. */
  minimapSlider: ':is(.cm-minimap-overlay, .minimap-slider)',
  /** 세로 스크롤바의 thumb. 편집기 칸은 직접 그린다 (FR-CMR-74). */
  scrollThumb: ':is(.cm-vscroll-thumb, .scrollbar.vertical > .slider)',
  /** 세로 스크롤바의 track. */
  scrollTrack: ':is(.cm-vscroll, .scrollbar.vertical)',
  /** 스크롤되는 영역. */
  scroller: ':is(.cm-scroller, .monaco-scrollable-element)',
  /** 편집기 안의 overview ruler. */
  overviewRuler: ':is(.cm-vscroll-ruler, .decorationsOverviewRuler)',
  /** sticky scroll 의 고정된 줄 하나 (FR-CMR-80). */
  stickyLine: ':is(.cm-sticky-line, .sticky-line-content)',
} as const;

/** 엔진 자산의 요청 경로 (로드 실패를 흉내 낼 때 막는다). */
export const ED_VENDOR_ROUTE = '**/vendor/{monaco,codemirror}/**';

// ── 페이지 안 어댑터 ───────────────────────────────────────────────────────

/**
 * 초기화 스크립트로 심는 함수. **자기 완결**이어야 한다 — 직렬화돼 페이지에서 돈다.
 */
export function installEdAdapter(sel: typeof ED_SEL) {
  const w = window as any;
  const M = () => w.monaco;
  const CMg = () => w.CM;
  // CodeMirror 핸들(= FileEditor)인가.
  const cm = (h: any) => !!(h && h._view);
  const V = (h: any) => h._view;
  const pos = (h: any, line: number, col: number) => w.edCmPos(V(h).state.doc, line, col);
  const opt = (h: any, k: string) => h.getOption(M().editor.EditorOption[k]);
  const deco = (h: any, field: string, re: RegExp) =>
    h.getModel().getAllDecorations()
      .filter((d: any) => re.test(d.options[field] || ''))
      .map((d: any) => ({
        cls: d.options[field],
        line: d.range.startLineNumber,
        end: d.range.endLineNumber,
        ruler: d.options.overviewRuler ? JSON.stringify(d.options.overviewRuler.color) : null,
        minimap: d.options.minimap ? JSON.stringify(d.options.minimap.color) : null,
      }))
      .sort((a: any, b: any) => a.line - b.line);
  // ruler 가 그린 항목·미니맵이 받은 표식에서 같은 표식을 찾는다. 색은 CSS 변수 이름이다 — 값은 묻지 않는다.
  const rulerOf = (h: any, cls: string, from: number) => {
    const it = w.edCmRulerItems(V(h)).find((x: any) => x.cls === cls && x.from === from);
    return it ? JSON.stringify(it.color) : null;
  };
  const minimapOf = (h: any, kind: 'marks' | 'gutter', cls: string, line: number) => {
    const d = CMg().minimapDrawn(V(h));
    const it = d && d[kind].find((x: any) => x.cls === cls && x.line === line);
    return it ? JSON.stringify(it.color) : null;
  };
  // CodeMirror 의 찾기 표시 (`cm-find.js` 의 `edFindMarks`).
  const cmMarks = (h: any, re: RegExp) => {
    const out: any[] = [];
    const st = V(h).state;
    const set = st.field(w.edFindMarks().field, false);
    if (!set) return out;
    set.between(0, st.doc.length, (from: number, to: number, d: any) => {
      const cls = d.spec.class || '';
      const line = st.doc.lineAt(from).number;
      if (re.test(cls)) out.push({ cls, line, end: st.doc.lineAt(to).number, ruler: rulerOf(h, cls, from), minimap: minimapOf(h, 'marks', cls, line) });
    });
    return out;
  };
  // CodeMirror 의 dirty diff 표식 (`file-editor-diff.js` 의 `edDdField`). 줄마다 하나다.
  const cmLineMarks = (h: any, re: RegExp) => {
    const out: any[] = [];
    const st = V(h).state;
    const set = st.field(w.edDdField().field, false);
    if (!set) return out;
    set.between(0, st.doc.length, (from: number, _to: number, m: any) => {
      const cls = 'fe-dd-' + m.type;
      const line = st.doc.lineAt(from).number;
      if (re.test(cls)) out.push({ cls, line, end: line, ruler: rulerOf(h, cls, from), minimap: minimapOf(h, 'gutter', cls, line) });
    });
    return out;
  };

  // Monaco 의 TextEditorCursorBlinkingStyle 열거값 → 이름.
  const BLINK: Record<number, string> = { 0: 'hidden', 1: 'blink', 2: 'smooth', 3: 'phase', 4: 'expand', 5: 'solid' };
  const SEV: Record<number, string> = { 8: 'error', 4: 'warning', 2: 'info', 1: 'hint' };
  const markersOf = (model: any) => M().editor.getModelMarkers({ resource: model.uri, owner: LSP_DIAG_OWNER })
    .map((m: any) => ({ line: m.startLineNumber, sev: SEV[m.severity] || String(m.severity), msg: m.message }));
  // CodeMirror lint 상태의 진단 (§11.6 L2). 심각도 이름은 lint 의 것이 곧 엔진 중립 이름이다.
  const cmDiags = (v: any) => {
    const out: any[] = [];
    const st = v.state;
    CMg().forEachDiagnostic(st, (d: any, from: number) => out.push({ line: st.doc.lineAt(from).number, sev: d.severity, msg: d.message }));
    return out;
  };
  // 문서 레지스트리 항목 → 그 문서를 보는 CodeMirror 칸 하나.
  const viewOfDoc = (d: any) => [...d.views].find((v: any) => v && v._view) || null;
  const docKey = (d: any) => {
    for (const [k, x] of w.app.testing.edDocs) if (x === d) return k;
    return null;
  };

  w.edT = {
    sel,

    // 핸들
    of: (v: any) => (v && v._view ? v : null),
    has: (v: any) => !!(v && v._view),
    // 인라인 보기에는 원본 편집기가 없다 — 그때 'orig' 는 null 이다.
    diffSide: (dv: any, side: 'orig' | 'mod') => {
      const c = dv && dv._cm;
      if (!c) return null;
      const v = side === 'orig' ? c.a : c.b;
      return v ? { _view: v } : null;
    },
    /** Diff 뷰에 편집기가 섰는가. */
    diffReady: (dv: any) => !!(dv && dv._cm),
    /** 핸들의 바깥 DOM 요소. */
    dom: (h: any) => (cm(h) ? V(h).dom : h.getDomNode()),
    /** 이 페이지의 첫 편집기 칸. */
    firstInFileEditor: () => [...w.app.fileEditors.values()].find((v: any) => v && v._view) || null,

    // 내용
    text: (h: any) => (cm(h) ? V(h).state.doc.toString() : h.getValue()),
    /** 내용을 통째로 갈아 끼운다 — 편집이 아니라 초기화다 (실행 취소 기록이 끊긴다). */
    setText: (h: any, s: string) => (cm(h) ? h._buf.replace(s) : h.setValue(s)),
    /** 내용을 통째로 바꾸는 **편집** — 사용자의 타이핑과 같은 경로다. */
    replaceAll: (h: any, s: string, source = 'test') => {
      if (cm(h)) { V(h).dispatch({ changes: { from: 0, to: V(h).state.doc.length, insert: s }, userEvent: 'input.' + source }); return }
      const m = h.getModel();
      h.executeEdits(source, [{ range: m.getFullModelRange(), text: s }]);
    },
    /** (줄, 열) 자리에 끼워 넣는 편집. */
    insert: (h: any, line: number, col: number, s: string, source = 'spec') => {
      if (cm(h)) { V(h).dispatch({ changes: { from: pos(h, line, col), insert: s }, userEvent: 'input.' + source }); return }
      h.executeEdits(source, [{ range: new (M().Range)(line, col, line, col), text: s }]);
    },
    /** 커서 자리에 키 입력처럼 넣는다. */
    type: (h: any, s: string) => (cm(h)
      ? V(h).dispatch(V(h).state.replaceSelection(s), { userEvent: 'input.type' })
      : h.trigger('e2e', 'type', { text: s })),
    /** 편집기를 거치지 않은 것처럼 문서를 고친다. */
    docInsert: (h: any, line: number, col: number, s: string) => {
      if (cm(h)) { V(h).dispatch({ changes: { from: pos(h, line, col), insert: s } }); return }
      h.getModel().applyEdits([{ range: { startLineNumber: line, startColumn: col, endLineNumber: line, endColumn: col }, text: s }]);
    },
    line: (h: any, n: number) => (cm(h) ? V(h).state.doc.line(n).text : h.getModel().getLineContent(n)),
    language: (h: any) => {
      if (!cm(h)) return h.getModel()?.getLanguageId() ?? null;
      const l = V(h).state.facet(CMg().language);
      return l ? l.name : null;
    },
    /** 두 핸들이 같은 문서를 편집하는가. */
    sameDoc: (a: any, b: any) => (cm(a) ? a._buf === b._buf : a.getModel() === b.getModel()),

    // 커서·포커스
    cursor: (h: any) => {
      if (cm(h)) return w.edCmLineCol(V(h).state.doc, V(h).state.selection.main.head);
      const p = h.getPosition();
      return p ? { line: p.lineNumber, col: p.column } : null;
    },
    setCursor: (h: any, line: number, col: number) => (cm(h)
      ? V(h).dispatch({ selection: { anchor: pos(h, line, col) } })
      : h.setPosition({ lineNumber: line, column: col })),
    setSelection: (h: any, l1: number, c1: number, l2: number, c2: number) => (cm(h)
      ? V(h).dispatch({ selection: { anchor: pos(h, l1, c1), head: pos(h, l2, c2) } })
      : h.setSelection({ startLineNumber: l1, startColumn: c1, endLineNumber: l2, endColumn: c2 })),
    focus: (h: any) => (cm(h) ? V(h).focus() : h.focus()),
    hasFocus: (h: any) => (cm(h) ? V(h).hasFocus : h.hasTextFocus()),

    // 스크롤·화면
    scrollTop: (h: any) => (cm(h) ? V(h).scrollDOM.scrollTop : h.getScrollTop()),
    setScrollTop: (h: any, t: number) => { if (cm(h)) V(h).scrollDOM.scrollTop = t; else h.setScrollTop(t) },
    scrollHeight: (h: any) => (cm(h) ? V(h).scrollDOM.scrollHeight : h.getScrollHeight()),
    viewHeight: (h: any) => (cm(h) ? V(h).scrollDOM.clientHeight : h.getLayoutInfo().height),
    revealLine: (h: any, n: number) => (cm(h)
      ? V(h).dispatch({ effects: CMg().EditorView.scrollIntoView(pos(h, n, 1), { y: 'nearest' }) })
      : h.revealLine(n)),
    /** sticky scroll 에 고정된 줄 번호들 — 위에서 아래로 (FR-CMR-80). */
    stickyLines: (h: any) => (cm(h)
      ? [...V(h).dom.querySelectorAll('.cm-sticky-line')].map((e: any) => Number(e.dataset.line))
      : []),
    revealLineNearTop: (h: any, n: number) => (cm(h)
      ? V(h).dispatch({ effects: CMg().EditorView.scrollIntoView(pos(h, n, 1), { y: 'start' }) })
      : h.revealLineNearTop(n)),
    lineVisible: (h: any, n: number) => {
      if (!cm(h)) return h.getVisibleRanges().some((r: any) => r.startLineNumber <= n && n <= r.endLineNumber);
      const l = V(h).state.doc.line(n);
      return V(h).visibleRanges.some((r: any) => r.from <= l.to && l.from <= r.to);
    },
    /** (줄, 열) 의 화면 좌표. 화면에 없으면 null. */
    coords: (h: any, line: number, col: number) => {
      if (cm(h)) {
        const c = V(h).coordsAtPos(pos(h, line, col));
        return c ? { left: c.left, top: c.top, height: c.bottom - c.top } : null;
      }
      const p = h.getScrolledVisiblePosition({ lineNumber: line, column: col });
      if (!p) return null;
      const r = h.getDomNode().getBoundingClientRect();
      return { left: r.left + p.left, top: r.top + p.top, height: p.height };
    },

    // 옵션 — 이름은 엔진 중립이다
    option: (h: any, name: string) => {
      if (cm(h)) {
        const v = V(h);
        switch (name) {
          // 미니맵은 늘 `fill` 좌표계다 — 뷰포트 표시가 스크롤바 thumb 와 같은 함수를 쓴다 (FR-CMR-61).
          case 'minimapEnabled': return !!v.dom.querySelector('.cm-minimap-gutter');
          case 'minimapSize': return v.dom.querySelector('.cm-minimap-gutter') ? 'fill' : null;
          case 'readOnly': return v.state.readOnly;
          case 'wordWrap': return v.contentDOM.classList.contains('cm-lineWrapping') ? 'on' : 'off';
          case 'fontSize': return parseFloat(getComputedStyle(v.dom).fontSize);
          // drawSelection 의 커서는 깜박이고 옮겨갈 때 애니메이션이 없다.
          case 'cursorBlinking': return 'blink';
          case 'smoothCaret': return 'off';
          default: throw new Error('edT.option: 모르는 이름 ' + name);
        }
      }
      switch (name) {
        case 'minimapEnabled': return !!opt(h, 'minimap').enabled;
        case 'minimapSize': return opt(h, 'minimap').size;
        case 'readOnly': return !!opt(h, 'readOnly');
        case 'wordWrap': return String(opt(h, 'wordWrap'));
        case 'fontSize': return h.getRawOptions().fontSize;
        case 'cursorBlinking': return BLINK[opt(h, 'cursorBlinking')] ?? String(opt(h, 'cursorBlinking'));
        case 'smoothCaret': return opt(h, 'cursorSmoothCaretAnimation');
        default: throw new Error('edT.option: 모르는 이름 ' + name);
      }
    },
    // 편집기 칸 안의 미니맵 자리 (칸의 왼쪽 변 기준). 미니맵이 없으면 0 이다.
    minimapLeft: (h: any) => {
      if (!cm(h)) return h.getLayoutInfo().minimap.minimapLeft;
      const m = V(h).dom.querySelector('.cm-minimap-gutter');
      return m ? Math.round(m.getBoundingClientRect().left - V(h).dom.getBoundingClientRect().left) : 0;
    },
    minimapWidth: (h: any) => {
      if (!cm(h)) return h.getLayoutInfo().minimap.minimapWidth;
      const m = V(h).dom.querySelector('.cm-minimap-gutter');
      return m ? Math.round(m.getBoundingClientRect().width) : 0;
    },

    // 장식 — 인라인(글자 위)·줄 장식(gutter)
    marks: (h: any, re: string) => (cm(h) ? cmMarks(h, new RegExp(re)) : deco(h, 'className', new RegExp(re))),
    lineMarks: (h: any, re: string) => (cm(h) ? cmLineMarks(h, new RegExp(re)) : deco(h, 'linesDecorationsClassName', new RegExp(re))),

    // 진단 — 심각도는 엔진 중립 이름이다 ('error' | 'warning' | 'info' | 'hint').
    diagnostics: (h: any) => (cm(h) ? cmDiags(V(h)) : markersOf(h.getModel())),
    docDiagnostics: (d: any) => {
      if (!d.buf) return markersOf(d.model);
      const v = viewOfDoc(d);
      return v ? cmDiags(V(v)) : [];
    },
    /** 문서에 진단 하나를 직접 얹는다 (서버를 거치지 않고). 그룹의 모든 칸에 그려진다. */
    docSetDiagnostic: (d: any, line: number, msg: string) => {
      if (d.buf) {
        const ln = d.buf.doc.line(line);
        d.buf.setDiagnostics([{ from: ln.from, to: Math.min(ln.from + 1, ln.to), severity: 'error', message: msg }]);
        w.edLspDiagShow(d.buf, w.lspDiagOn);
        return;
      }
      M().editor.setModelMarkers(d.model, LSP_DIAG_OWNER, [{
        startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: 2,
        message: msg, severity: M().MarkerSeverity.Error,
      }]);
    },

    // 명령 — 편집기 칸은 M8 에서 선다.
    /** 커서 자리에 마우스를 올린 것처럼 한다 — 라이브러리가 hoverTime 뒤에 묻는다. */
    showHover: (h: any) => {
      if (!cm(h)) { h.trigger('e2e', 'editor.action.showHover', null); return }
      const v = V(h);
      const c = v.coordsAtPos(v.state.selection.main.head);
      if (!c) return;
      const x = c.left + 1, y = (c.top + c.bottom) / 2;
      const el = document.elementFromPoint(x, y) || v.contentDOM;
      el.dispatchEvent(new MouseEvent('mousemove', { clientX: x, clientY: y, bubbles: true }));
    },
    goToDefinition: (h: any) => { if (!cm(h)) h.trigger('e2e', 'editor.action.revealDefinition', {}) },

    // 문서 레지스트리 (`app.testing.edDocs` 의 값)
    docText: (d: any) => d.buf.value(),
    docSetText: (d: any, s: string) => d.buf.replace(s),
    docHasModel: (d: any) => !!(d && d.buf),
    /** 문서가 아직 버려지지 않았는가. */
    docLive: (d: any) => !!(d && d.buf) && !d.buf.disposed,
    docBoundTo: (d: any, h: any) => cm(h) && h._buf === d.buf,
    /** 문서 전체를 바꾸는 **되돌릴 수 있는** 편집 — 그 문서를 보는 칸 하나를 거친다. */
    docEdit: (d: any, s: string) => {
      const v = viewOfDoc(d);
      V(v).dispatch({ changes: { from: 0, to: V(v).state.doc.length, insert: s }, userEvent: 'input' });
    },
    docUndo: (d: any) => CMg().undo(V(viewOfDoc(d))),
    /** 문서가 가리키는 파일 경로. */
    docPath: (d: any) => docKey(d),
    /** 문서의 실행 취소 기록 — 칸마다 따로라(§3.16) 문서 단위로는 답하지 않는다. */
    docCanUndo: () => null,
    /** 고아 문서 — 경로로 찾는 엔진 등록소가 없어(§3.16) 만들 자리가 없다. */
    plantOrphanDoc: () => {},
    /** 경로의 문서가 아직 살아 있는가. */
    docAlive: (path: string) => { const d = w.app.testing.edDocs.get(path); return !!(d && d.buf) },

    // Diff 뷰 (`gitPanel._diffView` 등)
    diffText: (dv: any, side: 'orig' | 'mod') => (side === 'orig'
      ? (dv._cm.a ? dv._cm.a.state.doc.toString() : CMg().getOriginalDoc(dv._cm.b.state).toString())
      : dv._cm.b.state.doc.toString()),
    /** 수정본 내용을 통째로 바꾸는 편집 — 문서를 나누면 그 문서도 바뀐다. */
    diffSetText: (dv: any, s: string) => {
      const b = dv._cm.b;
      b.dispatch({ changes: { from: 0, to: b.state.doc.length, insert: s } });
    },
    /** Diff 의 수정본 끝에 덧붙이는 편집 (사용자 입력 표식 없이). */
    diffAppend: (dv: any, s: string) => {
      const b = dv._cm.b;
      b.dispatch({ changes: { from: b.state.doc.length, insert: s } });
    },
    /** Diff 의 수정본이 그 문서 레지스트리 항목과 같은 문서인가. */
    diffSharesDoc: (dv: any, d: any) => !!d.buf && dv._buf === d.buf,
    diffHasMod: (dv: any) => !!(dv && dv._cm),
    diffHasOrig: (dv: any) => !!(dv && dv._cm),
    /** Diff 의 두 쪽이 LSP 에 어느 파일로 보이는가 (`lspPathOf`). */
    diffLspPaths: (dv: any) => ({ mod: dv.lspPathOf(dv._mod), orig: dv.lspPathOf(dv._orig) }),
    /** hunk 툴바가 지금 붙어 있는 줄 (`gitPanel`). 없으면 -1. */
    hunkBarLine: (gp: any) => gp._hunkBarPos?.line ?? -1,
    diffChangeCount: (dv: any) => {
      const ch = dv && dv.chunks ? dv.chunks() : null;
      return ch ? ch.length : -1;
    },

    // 집계 — 누수 판정. diffs 는 편집기를 든 Diff 뷰, docs 는 그 편집기 수다.
    counts: () => {
      // `GitDiffView` 는 클래식 스크립트의 class 라 `window` 의 속성이 아니다 — 전역 이름으로 읽는다.
      const G = (0, eval)('typeof GitDiffView === "undefined" ? null : GitDiffView');
      const live = [...(G ? G.live : [])] as any[];
      const editors = live.reduce((n, v) => n + (v._cm ? (v._cm.a ? 2 : 1) : 0), 0);
      return { editors, diffs: live.length, docs: editors };
    },

    /** 앱 밖에 엔진 편집기를 하나 세운다 — 앱의 설정이 다른 편집기로 새지 않는지 볼 때. */
    probe: (host: HTMLElement, text: string) => {
      const e = M().editor.create(host, { value: text });
      return {
        focus: () => e.focus(),
        /** 엔진 기본 찾기를 연다. 그 위젯이 떴는지는 `sel.builtinFind` 로 본다. */
        openBuiltinFind: () => e.trigger('probe', 'actions.find', null),
        dispose: () => e.dispose(),
      };
    },
    /** 앱 밖에 Diff 편집기를 세우고, 그 DOM 이 섰는지 답한 뒤 거둔다. */
    probeDiff: (host: HTMLElement, a: string, b: string) => {
      const mv = new (CMg().MergeView)({ a: { doc: a }, b: { doc: b }, parent: host });
      const mounted = !!host.querySelector('.cm-mergeView');
      mv.destroy();
      return mounted;
    },
  };
}
