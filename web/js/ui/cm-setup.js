/**
 * CodeMirror 편집기의 구성 — CODEMIRROR_MIGRATION_SRS FR-CMR-10~14 · §11.1.
 *
 * 편집기 하나가 받는 확장 전부를 여기서 만든다. 설정으로 바뀌는 값(줄바꿈·글자 크기·
 * 읽기 전용·언어)은 Compartment 안에 두어 편집기를 다시 세우지 않고 갈아 끼운다
 * (FR-WBR-11·FR-MMT-4·FR-FSS-9 와 같은 규약 — 편집 중인 내용과 커서를 잃지 않는다).
 *
 * 테마는 CSS 변수를 그대로 읽는다(FR-CMR-12). 테마를 바꾸면 변수만 바뀌고 여기서 다시
 * 정의할 것이 없다.
 */

// 확장자 → `@codemirror/language-data` 의 언어 이름 (FR-CMR-13). 없는 확장자는 일반 텍스트다.
// Makefile·Bat·VimL 은 대응 언어가 없다 (FR-CMR-14).
const CM_LANG = {
  '.js': 'JavaScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript',
  '.ts': 'TypeScript', '.tsx': 'TSX', '.jsx': 'JSX',
  '.json': 'JSON', '.jsonc': 'JSON',
  '.html': 'HTML', '.htm': 'HTML',
  '.css': 'CSS', '.scss': 'SCSS', '.less': 'LESS',
  '.md': 'Markdown', '.mdown': 'Markdown', '.markdown': 'Markdown',
  '.py': 'Python', '.pyw': 'Python',
  '.go': 'Go',
  '.rs': 'Rust',
  '.java': 'Java',
  '.c': 'C', '.h': 'C',
  '.cpp': 'C++', '.cc': 'C++', '.cxx': 'C++', '.hpp': 'C++',
  '.cs': 'C#',
  '.rb': 'Ruby',
  '.php': 'PHP',
  '.swift': 'Swift',
  '.kt': 'Kotlin', '.kts': 'Kotlin',
  '.scala': 'Scala',
  '.sh': 'Shell', '.bash': 'Shell', '.zsh': 'Shell',
  '.yaml': 'YAML', '.yml': 'YAML',
  '.xml': 'XML', '.svg': 'XML',
  '.sql': 'SQL',
  '.toml': 'TOML',
  '.ini': 'Properties files', '.cfg': 'Properties files', '.conf': 'Properties files',
  '.ps1': 'PowerShell',
  '.lua': 'Lua',
  '.r': 'R',
  '.pl': 'Perl', '.pm': 'Perl',
};
// 확장자가 아니라 이름으로 정해지는 파일.
const CM_LANG_FILE = { dockerfile: 'Dockerfile' };

// 괄호 쌍 색의 순환 (FR-CMR-10). 깊이마다 다음 색이다.
const CM_BRACKET_COLORS = ['--term-yellow', '--term-magenta', '--term-blue', '--term-cyan', '--term-green', '--term-red'];
// 괄호 쌍 색에서 건너뛰는 구문 노드 — 문자열·주석 안의 괄호는 짝이 아니다.
const CM_BRACKET_SKIP = /string|comment|regexp|template/i;
const CM_BRACKET_OPEN = '([{';
const CM_BRACKET_CLOSE = ')]}';

/** 경로 → 언어 이름. 모르면 null(일반 텍스트). */
function edCmLangName(path) {
  const base = pathBase(path).toLowerCase();
  if (CM_LANG_FILE[base]) return CM_LANG_FILE[base];
  const dot = base.lastIndexOf('.');
  if (dot < 0) return null;
  return CM_LANG[base.slice(dot)] || null;
}

/** 그 경로의 언어 지원을 받는다(언어마다 청크 하나, FR-CMR-3). 없으면 null. */
function edCmLangLoad(path) {
  const name = edCmLangName(path);
  if (!name) return Promise.resolve(null);
  const desc = CM.languages.find((l) => l.name === name);
  return desc ? desc.load() : Promise.resolve(null);
}

/** (줄, 열) — 1 부터 — 을 offset 으로. 문서 밖이면 안으로 접는다. */
function edCmPos(doc, line, col) {
  const n = Math.min(Math.max(1, Number(line) || 1), doc.lines);
  const l = doc.line(n);
  return l.from + Math.min(Math.max(0, (Number(col) || 1) - 1), l.length);
}

/** offset 을 (줄, 열) — 1 부터 — 로. 문서 밖이면 안으로 접는다. */
function edCmLineCol(doc, pos) {
  const p = Math.min(Math.max(0, Number(pos) || 0), doc.length);
  const l = doc.lineAt(p);
  return { line: l.number, col: p - l.from + 1 };
}

/**
 * 편집기 하나의 확장과 그 Compartment 들.
 *
 * `diff` 이면 Git Diff 뷰의 한쪽이다 — 변경 막대·직접 그린 스크롤바·미니맵이 없다 (FR-CMR-56, Diff 에는 자기 ruler 가 있다).
 *
 * @param {{readOnly?: boolean, wordWrap?: boolean, fontSize?: number, minimap?: boolean, diff?: boolean}} o
 * @returns {{extensions: any[], cmp: {wrap: any, font: any, ro: any, lang: any, minimap: any, lsp: any}}}
 */
function edCmExtensions(o) {
  const cmp = { wrap: new CM.Compartment(), font: new CM.Compartment(), ro: new CM.Compartment(), lang: new CM.Compartment(), minimap: new CM.Compartment(), lsp: new CM.Compartment() };
  const extensions = [
    CM.lineNumbers(),
    // EDITOR_DIRTY_DIFF_SRS: 변경 막대는 줄 번호 바로 뒤다 (옛 엔진의 linesDecorations 자리).
    !o.diff && typeof edDdExtensions === 'function' ? edDdExtensions() : [],
    CM.highlightActiveLineGutter(),
    CM.foldGutter(),
    CM.drawSelection(),
    CM.dropCursor(),
    CM.EditorState.allowMultipleSelections.of(true),
    CM.indentOnInput(),
    CM.syntaxHighlighting(edCmHighlight()),
    CM.bracketMatching(),
    CM.closeBrackets(),
    CM.autocompletion({ override: [CM.completeAnyWord] }),
    CM.rectangularSelection(),
    CM.crosshairCursor(),
    CM.highlightActiveLine(),
    CM.highlightSelectionMatches(),
    EdBuffer.HISTORY.of(CM.history()),
    CM.EditorState.tabSize.of(4),
    CM.indentUnit.of('    '),
    CM.indentationMarkers({
      colors: { light: 'var(--border-weak)', dark: 'var(--border-weak)', activeLight: 'var(--border)', activeDark: 'var(--border)' },
    }),
    edCmSelectionWhitespace(),
    edFindMarks().field,
    edFindSources(),
    o.diff ? [] : edCmScrollbar(),
    o.diff ? [] : edCmSticky(),
    edCmBracketColors(),
    CM.keymap.of([
      ...CM.closeBracketsKeymap, ...CM.defaultKeymap, ...CM.historyKeymap,
      ...CM.foldKeymap, ...CM.completionKeymap, CM.indentWithTab,
    ]),
    edCmTheme(),
    cmp.wrap.of(o.wordWrap ? CM.EditorView.lineWrapping : []),
    cmp.font.of(edCmFontTheme(o.fontSize)),
    cmp.ro.of(CM.EditorState.readOnly.of(!!o.readOnly)),
    cmp.lang.of([]),
    cmp.minimap.of(edCmMinimap(!o.diff && !!o.minimap)),
    // CODEMIRROR_MIGRATION_SRS §11.6 L1: LSP 확장은 서버를 찾은 뒤에 들어온다 (`edCmLspAttach`).
    cmp.lsp.of([]),
  ];
  return { extensions, cmp };
}

// 미니맵 표식의 출처 — `(state) => [{line, kind:'mark'|'gutter', color}]`. `color` 는 CSS 변수 이름이다.
// 처음 쓸 때 만든다 (`CM` 이 페이지 로드 때 없다).
function edMinimapSource() {
  if (!edMinimapSource.facet) edMinimapSource.facet = CM.Facet.define();
  return edMinimapSource.facet;
}

/**
 * FR-CMR-60~63 · EDITOR_MINIMAP_TOGGLE_SRS FR-MMT-5: 미니맵은 이 함수 하나가 만든다 — 생성과 설정 토글이
 * 같은 덩이를 딛는다. 뷰포트 표시는 스크롤바 thumb 와 같은 함수(`edScrollThumb`)를 쓰고(FR-MMP-2 의 `fill`),
 * 마우스를 올렸을 때만 보인다.
 */
function edCmMinimap(enabled) {
  if (!enabled) return [];
  const collect = (st, kind) => {
    const out = [];
    for (const src of st.facet(edMinimapSource())) for (const it of src(st)) if (it.kind === kind) out.push(it);
    return out;
  };
  return CM.showMinimap.of({
    create: () => ({ dom: document.createElement('div') }),
    showOverlay: 'mouse-over',
    thumb: (v) => edScrollThumb(edScrollGeo(v)),
    fromThumb: (v, top) => edScrollFromThumb(top, edScrollGeo(v)),
    marks: (st) => collect(st, 'mark'),
    gutter: (st) => collect(st, 'gutter'),
  });
}

// 줄 높이는 정수 px 다 — 옛 엔진과 같이 `round(글자 크기 × 1.5)`. 소수면 문서 높이가 소수가 되어 문서 끝에서
// 미니맵(sticky)이 스크롤바 thumb 보다 반 픽셀 위에 선다 (FR-CMR-61).
function edCmFontTheme(px) {
  return CM.EditorView.theme({ '&': { fontSize: px + 'px' }, '.cm-scroller': { lineHeight: Math.round(px * ED_LINE_HEIGHT_RATIO) + 'px' } });
}

// FR-CMR-12: 색은 전부 CSS 변수다. 섞는 비율은 옛 엔진 테마의 것을 옮겼다.
function edCmTheme() {
  return CM.EditorView.theme({
    '&': { color: 'var(--text)', backgroundColor: 'var(--bg)', height: '100%' },
    '.cm-scroller': { fontFamily: ED_FONT_FAMILY },
    '.cm-content': { caretColor: 'var(--accent)' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)' },
    '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection':
      { backgroundColor: 'color-mix(in srgb, var(--text) 15%, var(--bg))' },
    '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--text) 8%, transparent)' },
    '.cm-gutters': { backgroundColor: 'var(--bg)', color: 'color-mix(in srgb, var(--text) 40%, var(--bg))', border: 'none' },
    '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--text)' },
    '.cm-selectionMatch': { backgroundColor: 'color-mix(in srgb, var(--accent) 20%, transparent)' },
    '&.cm-focused .cm-matchingBracket': { backgroundColor: 'color-mix(in srgb, var(--accent) 25%, transparent)' },
    '.cm-tooltip': { backgroundColor: 'var(--bg-alt)', color: 'var(--text)', border: '1px solid var(--border)' },
    '.cm-sel-ws': { color: 'var(--text-hint)' },
  });
}

function edCmHighlight() {
  const tg = CM.tags;
  return CM.HighlightStyle.define([
    { tag: [tg.keyword, tg.modifier, tg.controlKeyword, tg.operatorKeyword], color: 'var(--term-magenta)' },
    { tag: [tg.string, tg.special(tg.string), tg.regexp], color: 'var(--term-green)' },
    { tag: [tg.number, tg.bool, tg.null, tg.atom], color: 'var(--term-yellow)' },
    { tag: [tg.comment, tg.lineComment, tg.blockComment, tg.docComment], color: 'var(--text-dim)', fontStyle: 'italic' },
    { tag: [tg.function(tg.variableName), tg.function(tg.propertyName), tg.definition(tg.function(tg.variableName))], color: 'var(--term-blue)' },
    { tag: [tg.typeName, tg.className, tg.namespace], color: 'var(--term-cyan)' },
    { tag: [tg.propertyName, tg.attributeName], color: 'var(--term-cyan)' },
    { tag: [tg.tagName], color: 'var(--term-red)' },
    { tag: [tg.meta, tg.processingInstruction, tg.punctuation], color: 'var(--text-muted)' },
    { tag: tg.heading, color: 'var(--term-blue)', fontWeight: 'bold' },
    { tag: tg.link, color: 'var(--term-cyan)', textDecoration: 'underline' },
    { tag: tg.emphasis, fontStyle: 'italic' },
    { tag: tg.strong, fontWeight: 'bold' },
    { tag: tg.invalid, color: 'var(--danger)' },
  ]);
}

/**
 * `renderWhitespace:'selection'` (FR-CMR-10) — **선택한 범위 안의** 공백·탭만 보인다.
 * CodeMirror 의 `highlightWhitespace` 는 문서 전체에 건다.
 */
function edCmSelectionWhitespace() {
  const space = CM.Decoration.mark({ class: 'cm-sel-ws cm-highlightSpace' });
  const tab = CM.Decoration.mark({ class: 'cm-sel-ws cm-highlightTab' });
  const build = (view) => {
    const b = new CM.RangeSetBuilder();
    for (const r of view.state.selection.ranges) {
      if (r.empty) continue;
      for (const vr of view.visibleRanges) {
        const from = Math.max(r.from, vr.from), to = Math.min(r.to, vr.to);
        if (from >= to) continue;
        const text = view.state.doc.sliceString(from, to);
        for (let i = 0; i < text.length; i++) {
          if (text[i] === ' ') b.add(from + i, from + i + 1, space);
          else if (text[i] === '\t') b.add(from + i, from + i + 1, tab);
        }
      }
    }
    return b.finish();
  };
  return CM.ViewPlugin.fromClass(class {
    constructor(view) { this.decorations = build(view) }
    update(u) { if (u.docChanged || u.selectionSet || u.viewportChanged) this.decorations = build(u.view) }
  }, { decorations: (v) => v.decorations });
}

/**
 * 괄호 쌍 색 (FR-CMR-10) — 깊이마다 `CM_BRACKET_COLORS` 를 순환한다.
 *
 * 깊이는 문서 처음부터 센다. 문자열·주석 노드 안의 괄호는 세지 않는다 — 구문 트리가 그
 * 범위를 알려 준다(legacy 언어도 토큰 이름에 string·comment 가 든다).
 */
function edCmBracketColors() {
  const marks = CM_BRACKET_COLORS.map((v) => CM.Decoration.mark({ attributes: { style: 'color:var(' + v + ')' } }));
  const build = (view) => {
    const { state } = view;
    const end = view.viewport.to;
    const skip = [];
    CM.syntaxTree(state).iterate({
      to: end,
      enter: (n) => {
        if (!CM_BRACKET_SKIP.test(n.name)) return undefined;
        skip.push([n.from, n.to]);
        return false;
      },
    });
    const b = new CM.RangeSetBuilder();
    const text = state.doc.sliceString(0, end);
    let depth = 0, si = 0;
    for (let i = 0; i < text.length; i++) {
      while (si < skip.length && skip[si][1] <= i) si++;
      if (si < skip.length && skip[si][0] <= i) { i = skip[si][1] - 1; continue }
      const ch = text[i];
      let d = -1;
      if (CM_BRACKET_OPEN.includes(ch)) d = depth++;
      else if (CM_BRACKET_CLOSE.includes(ch)) d = depth = Math.max(0, depth - 1);
      if (d >= 0 && i >= view.viewport.from) b.add(i, i + 1, marks[d % marks.length]);
    }
    return b.finish();
  };
  return CM.ViewPlugin.fromClass(class {
    constructor(view) { this.decorations = build(view) }
    update(u) {
      if (u.docChanged || u.viewportChanged || CM.syntaxTree(u.startState) !== CM.syntaxTree(u.state)) this.decorations = build(u.view);
    }
  }, { decorations: (v) => v.decorations });
}

/**
 * CODEMIRROR_MIGRATION_SRS §11.6 L1: 편집기에 그 파일의 LSP 확장을 넣는다. 서버가 없으면 뺀다.
 * 기다리는 사이 편집기가 바뀌었거나(`current()` 가 거짓) 경로가 바뀌었으면 버린다.
 */
async function edCmLspAttach(view, cmp, path, current) {
  if (!view || !cmp || !cmp.lsp || typeof app === 'undefined' || !app || !app.lspExtFor) return;
  const ext = path ? await app.lspExtFor(path) : null;
  if (!current()) return;
  view.dispatch({ effects: cmp.lsp.reconfigure(ext || []) });
}
