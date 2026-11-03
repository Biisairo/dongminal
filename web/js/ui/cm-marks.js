/**
 * 선택 · 같은 낱말 · 진단 · 커서의 ruler·미니맵 표식 — EDITOR_LINK_LSP_SRS FR-ELS-30~36.
 *
 * 출처는 두 덩이다. 그리는 순서(FR-ELS-32)가 찾기 일치를 사이에 두기 때문이다:
 * `low`(같은 낱말 → 선택)는 찾기 출처 앞에, `high`(진단 → 커서)는 그 뒤에 등록한다.
 * 미니맵의 진단은 포크의 진단 층이 이미 그리므로 여기서 더하지 않는다.
 */

/** FR-ELS-31: 선택 하나의 글자열을 문서 전체에서 찾는다. 선택 자신은 뺀다. */
function edCmMatches(state) {
  const sel = state.selection;
  if (sel.ranges.length !== 1) return [];
  const r = sel.main;
  const len = r.to - r.from;
  if (len < 1 || len > ED_MATCH_SEL_MAX) return [];
  const query = state.sliceDoc(r.from, r.to);
  const out = [];
  const cur = new CM.SearchCursor(state.doc, query);
  while (!cur.next().done && out.length < ED_RULER_MATCH_MAX) {
    const { from, to } = cur.value;
    if (from !== r.from || to !== r.to) out.push({ from, to });
  }
  return out;
}

// NFR-ELS-3: 선택·문서가 바뀔 때만 다시 센다. `CM` 이 선 뒤에 만든다.
function edCmMatchField() {
  if (!edCmMatchField.field) {
    edCmMatchField.field = CM.StateField.define({
      create: (st) => edCmMatches(st),
      update: (v, tr) => (tr.docChanged || tr.selection ? edCmMatches(tr.state) : v),
    });
  }
  return edCmMatchField.field;
}

function edCmMatchesOf(state) {
  const v = state.field(edCmMatchField(), false);
  return v || edCmMatches(state);
}

function edCmSelRanges(state) {
  return state.selection.ranges.filter((r) => !r.empty);
}

/** FR-ELS-30·32·33: ruler 항목. `phase` 는 `'low'`·`'high'` 다. */
function edCmMarkRuler(state, phase) {
  if (phase === 'low') {
    return [
      ...edCmMatchesOf(state).map((m) => ({ ...m, lane: 'right', color: ED_MARK_COLOR.match, cls: 'ed-mark-match' })),
      ...edCmSelRanges(state).map((r) => ({ from: r.from, to: r.to, lane: 'right', color: ED_MARK_COLOR.sel, cls: 'ed-mark-sel' })),
    ];
  }
  const out = [];
  CM.forEachDiagnostic(state, (d, from, to) => {
    if (d.severity !== 'error' && d.severity !== 'warning') return;
    out.push({ from, to, lane: 'left', color: ED_MARK_COLOR[d.severity], cls: 'ed-mark-' + d.severity });
  });
  const head = state.selection.main.head;
  out.push({ from: head, to: head, lane: 'full', color: ED_MARK_COLOR.cursor, cls: 'ed-mark-cursor' });
  return out;
}

/** FR-ELS-30: 미니맵 항목 — 줄마다 한 색이다. 여러 줄 선택은 줄마다 찍고 한도에서 자른다. */
function edCmMarkMinimap(state, phase) {
  if (phase !== 'low') return [];
  const doc = state.doc;
  const out = edCmMatchesOf(state).map((m) => ({ line: doc.lineAt(m.from).number, kind: 'mark', color: ED_MARK_COLOR.match, cls: 'ed-mark-match' }));
  let left = ED_RULER_MATCH_MAX;
  for (const r of edCmSelRanges(state)) {
    const a = doc.lineAt(r.from).number;
    const b = doc.lineAt(r.to).number;
    for (let n = a; n <= b && left > 0; n++, left--) {
      out.push({ line: n, kind: 'mark', color: ED_MARK_COLOR.sel, cls: 'ed-mark-sel' });
    }
  }
  return out;
}

/** 편집기 칸의 표식 확장 — `{low, high}`. Git Diff 뷰에는 넣지 않는다 (FR-ELS-36). */
function edCmMarks() {
  const src = (phase) => [
    edRulerSource().of((st) => edCmMarkRuler(st, phase)),
    edMinimapSource().of((st) => edCmMarkMinimap(st, phase)),
  ];
  return { low: [edCmMatchField(), src('low')], high: src('high') };
}
