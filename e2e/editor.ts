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
  surface: '.monaco-editor',
  /** Diff 편집기 하나의 바깥 요소. */
  diffSurface: '.monaco-diff-editor',
  /** Diff 의 수정본 쪽 편집기. */
  diffModified: '.monaco-diff-editor .editor.modified',
  /** Diff 전체의 overview ruler. */
  diffRuler: '.diffOverviewRuler',
  /** 글자가 그려지는 영역 — 눌러서 포커스를 주는 자리. */
  text: '.view-lines',
  /** 키 입력을 받는 요소. */
  input: 'textarea',
  /** 호버 툴팁. */
  hover: '.monaco-hover',
  /** 엔진 기본 찾기 위젯이 떠 있는 상태. 우리 패널이 대신하므로 떠서는 안 된다. */
  builtinFind: '.find-widget.visible',
  /** 줄 번호 옆 장식 칸 (dirty diff 막대가 서는 곳). */
  gutter: '.margin-view-overlays',
  /** 미니맵. */
  minimap: '.minimap',
  /** 미니맵 안의 뷰포트 표시. */
  minimapSlider: '.minimap-slider',
  /** 세로 스크롤바의 thumb. */
  scrollThumb: '.scrollbar.vertical > .slider',
  /** 편집기 안의 overview ruler. */
  overviewRuler: '.decorationsOverviewRuler',
} as const;

/** 엔진 자산의 요청 경로 (로드 실패를 흉내 낼 때 막는다). */
export const ED_VENDOR_ROUTE = '**/vendor/monaco/**';

// ── 페이지 안 어댑터 ───────────────────────────────────────────────────────

/**
 * 초기화 스크립트로 심는 함수. **자기 완결**이어야 한다 — 직렬화돼 페이지에서 돈다.
 */
export function installEdAdapter(sel: typeof ED_SEL) {
  const w = window as any;
  const M = () => w.monaco;
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

  // Monaco 의 TextEditorCursorBlinkingStyle 열거값 → 이름.
  const BLINK: Record<number, string> = { 0: 'hidden', 1: 'blink', 2: 'smooth', 3: 'phase', 4: 'expand', 5: 'solid' };
  const SEV: Record<number, string> = { 8: 'error', 4: 'warning', 2: 'info', 1: 'hint' };
  const markersOf = (model: any) => M().editor.getModelMarkers({ resource: model.uri, owner: LSP_DIAG_OWNER })
    .map((m: any) => ({ line: m.startLineNumber, sev: SEV[m.severity] || String(m.severity), msg: m.message }));

  w.edT = {
    sel,

    // 핸들
    of: (v: any) => (v && v._editor) || null,
    has: (v: any) => !!(v && v._editor),
    diffSide: (dv: any, side: 'orig' | 'mod') => {
      const d = dv && dv._editor;
      if (!d) return null;
      return side === 'orig' ? d.getOriginalEditor() : d.getModifiedEditor();
    },
    /** Diff 뷰에 편집기가 섰는가. */
    diffReady: (dv: any) => !!(dv && dv._editor),
    /** 핸들의 바깥 DOM 요소. */
    dom: (h: any) => h.getDomNode(),
    /** 이 페이지에서 `.file-editor` 안에 선 첫 편집기. */
    firstInFileEditor: () => {
      const m = M();
      return m ? m.editor.getEditors().find((e: any) => e.getDomNode()?.closest('.file-editor')) || null : null;
    },

    // 내용
    text: (h: any) => h.getValue(),
    /** 내용을 통째로 갈아 끼운다 — 편집이 아니라 초기화다 (실행 취소 기록이 끊긴다). */
    setText: (h: any, s: string) => h.setValue(s),
    /** 내용을 통째로 바꾸는 **편집** — 사용자의 타이핑과 같은 경로다. */
    replaceAll: (h: any, s: string, source = 'test') => {
      const m = h.getModel();
      h.executeEdits(source, [{ range: m.getFullModelRange(), text: s }]);
    },
    /** (줄, 열) 자리에 끼워 넣는 편집. */
    insert: (h: any, line: number, col: number, s: string, source = 'spec') =>
      h.executeEdits(source, [{ range: new (M().Range)(line, col, line, col), text: s }]),
    /** 커서 자리에 키 입력처럼 넣는다. */
    type: (h: any, s: string) => h.trigger('e2e', 'type', { text: s }),
    /** 편집기를 거치지 않고 문서를 직접 고친다 (바깥에서 바뀐 것처럼). */
    docInsert: (h: any, line: number, col: number, s: string) =>
      h.getModel().applyEdits([{ range: { startLineNumber: line, startColumn: col, endLineNumber: line, endColumn: col }, text: s }]),
    line: (h: any, n: number) => h.getModel().getLineContent(n),
    language: (h: any) => h.getModel()?.getLanguageId() ?? null,
    /** 두 핸들이 같은 문서를 편집하는가. */
    sameDoc: (a: any, b: any) => a.getModel() === b.getModel(),

    // 커서·포커스
    cursor: (h: any) => {
      const p = h.getPosition();
      return p ? { line: p.lineNumber, col: p.column } : null;
    },
    setCursor: (h: any, line: number, col: number) => h.setPosition({ lineNumber: line, column: col }),
    setSelection: (h: any, l1: number, c1: number, l2: number, c2: number) =>
      h.setSelection({ startLineNumber: l1, startColumn: c1, endLineNumber: l2, endColumn: c2 }),
    focus: (h: any) => h.focus(),
    hasFocus: (h: any) => h.hasTextFocus(),

    // 스크롤·화면
    scrollTop: (h: any) => h.getScrollTop(),
    setScrollTop: (h: any, t: number) => h.setScrollTop(t),
    scrollHeight: (h: any) => h.getScrollHeight(),
    viewHeight: (h: any) => h.getLayoutInfo().height,
    revealLine: (h: any, n: number) => h.revealLine(n),
    revealLineNearTop: (h: any, n: number) => h.revealLineNearTop(n),
    lineVisible: (h: any, n: number) =>
      h.getVisibleRanges().some((r: any) => r.startLineNumber <= n && n <= r.endLineNumber),
    /** (줄, 열) 의 화면 좌표. 화면에 없으면 null. */
    coords: (h: any, line: number, col: number) => {
      const p = h.getScrolledVisiblePosition({ lineNumber: line, column: col });
      if (!p) return null;
      const r = h.getDomNode().getBoundingClientRect();
      return { left: r.left + p.left, top: r.top + p.top, height: p.height };
    },

    // 옵션 — 이름은 엔진 중립이다
    option: (h: any, name: string) => {
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
    minimapLeft: (h: any) => h.getLayoutInfo().minimap.minimapLeft,
    minimapWidth: (h: any) => h.getLayoutInfo().minimap.minimapWidth,

    // 장식 — 인라인(글자 위)·줄 장식(gutter)
    marks: (h: any, re: string) => deco(h, 'className', new RegExp(re)),
    lineMarks: (h: any, re: string) => deco(h, 'linesDecorationsClassName', new RegExp(re)),

    // 진단 — 심각도는 엔진 중립 이름이다 ('error' | 'warning' | 'info' | 'hint')
    diagnostics: (h: any) => markersOf(h.getModel()),
    docDiagnostics: (d: any) => markersOf(d.model),
    /** 문서에 진단 하나를 직접 얹는다 (서버를 거치지 않고). */
    docSetDiagnostic: (d: any, line: number, msg: string) =>
      M().editor.setModelMarkers(d.model, LSP_DIAG_OWNER, [{
        startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: 2,
        message: msg, severity: M().MarkerSeverity.Error,
      }]),

    // 명령
    showHover: (h: any) => h.trigger('e2e', 'editor.action.showHover', null),
    goToDefinition: (h: any) => h.trigger('e2e', 'editor.action.revealDefinition', {}),

    // 문서 레지스트리 (`app.testing.edDocs` 의 값)
    docText: (d: any) => d.model.getValue(),
    docSetText: (d: any, s: string) => d.model.setValue(s),
    docHasModel: (d: any) => !!(d && d.model),
    /** 문서가 엔진 안에서 아직 버려지지 않았는가. */
    docLive: (d: any) => !!(d && d.model) && !d.model.isDisposed(),
    docBoundTo: (d: any, h: any) => h.getModel() === d.model,
    /** 문서 전체를 바꾸는 **되돌릴 수 있는** 편집. */
    docEdit: (d: any, s: string) => d.model.pushEditOperations([], [{ range: d.model.getFullModelRange(), text: s }], () => null),
    docUndo: (d: any) => d.model.undo(),
    /** 문서가 가리키는 파일 경로. */
    docPath: (d: any) => d.model.uri.fsPath,
    /** 문서의 실행 취소 기록이 남아 있는가. 모르면 null. */
    docCanUndo: (d: any) => (d.model.canUndo ? d.model.canUndo() : null),
    /** 어느 문서에도 속하지 않는 같은 경로의 문서(고아)를 엔진 안에 만든다. */
    plantOrphanDoc: (path: string, text: string) => M().editor.createModel(text, 'plaintext', M().Uri.file(path)),
    /** 경로의 문서가 엔진 안에 아직 살아 있는가. */
    docAlive: (path: string) => !!M().editor.getModel(M().Uri.file(path)),

    // Diff 뷰 (`gitPanel._diffView` 등)
    diffText: (dv: any, side: 'orig' | 'mod') => (side === 'orig' ? dv._orig : dv._mod).getValue(),
    diffSetText: (dv: any, s: string) => dv._mod.setValue(s),
    /** Diff 의 수정본 끝에 덧붙이는 편집 (편집기를 거치지 않는다). */
    diffAppend: (dv: any, s: string) => {
      const m = dv._mod;
      const end = m.getFullModelRange().getEndPosition();
      m.applyEdits([{ range: { startLineNumber: end.lineNumber, startColumn: end.column, endLineNumber: end.lineNumber, endColumn: end.column }, text: s }]);
    },
    /** Diff 의 수정본이 그 문서 레지스트리 항목과 같은 문서인가. */
    diffSharesDoc: (dv: any, d: any) => dv._mod === d.model,
    diffHasMod: (dv: any) => !!(dv && dv._mod),
    diffHasOrig: (dv: any) => !!(dv && dv._orig),
    /** Diff 의 두 쪽이 LSP 에 어느 파일로 보이는가 (`lspPathOf`). */
    diffLspPaths: (dv: any) => ({ mod: dv.lspPathOf(dv._mod), orig: dv.lspPathOf(dv._orig) }),
    /** hunk 툴바가 지금 붙어 있는 줄 (`gitPanel`). 없으면 -1. */
    hunkBarLine: (gp: any) => gp._hunkBarPos?.position?.lineNumber ?? -1,
    diffChangeCount: (dv: any) => {
      const ch = dv && dv._editor ? dv._editor.getLineChanges() : null;
      return ch ? ch.length : -1;
    },

    // 집계 — 누수 판정
    counts: () => {
      const m = M();
      if (!m) return { editors: -1, diffs: -1, docs: -1 };
      return { editors: m.editor.getEditors().length, diffs: m.editor.getDiffEditors().length, docs: m.editor.getModels().length };
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
      const m = M();
      const e = m.editor.createDiffEditor(host, { automaticLayout: false });
      const original = m.editor.createModel(a, 'plaintext');
      const modified = m.editor.createModel(b, 'plaintext');
      e.setModel({ original, modified });
      const mounted = !!host.querySelector(sel.diffSurface);
      e.dispose();
      original.dispose();
      modified.dispose();
      return mounted;
    },
  };
}
