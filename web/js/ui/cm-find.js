/**
 * 파일 안 찾기의 일치 계산 — CODEMIRROR_MIGRATION_SRS FR-CMR-31·32 / EDITOR_FIND_PANEL_SRS.
 *
 * 돌려주는 것은 `{from, to, caps}` 의 배열이다. `caps` 는 정규식일 때만 싣는다(FR-ERS-6) —
 * `[0]` 이 전체 일치이고 리터럴 찾기에는 쓸 곳이 없다.
 *
 * 단어 단위는 CodeMirror 의 단어 판정(언어마다 다르다 — JS 는 `$` 를 단어 글자로 본다)을
 * 쓰지 않고 `ED_FIND_WORD_SEPARATORS` 를 경계로 쓴다. 언어에 따라 결과가 달라지지 않는다.
 * 공백·줄바꿈과 문서의 처음·끝도 경계다.
 *
 * 빈 일치(`x*` 같은 정규식)는 내지 않는다 — 셀 수도, 칠할 수도 없다.
 */
function edFindHits(doc, query, opts, max) {
  if (!query) return [];
  const o = opts || {};
  const fold = o.case ? undefined : (s) => s.toLowerCase();
  const test = o.word ? edFindWordTest(doc) : undefined;
  const out = [];
  const cursor = o.regex
    ? new CM.RegExpCursor(doc, query, { ignoreCase: !o.case, test })
    : new CM.SearchCursor(doc, query, 0, doc.length, fold, test);
  for (let r = cursor.next(); !r.done && out.length < max; r = cursor.next()) {
    const { from, to } = r.value;
    if (from === to) continue;
    out.push(o.regex ? { from, to, caps: Array.from(r.value.match) } : { from, to });
  }
  return out;
}

// 일치 앞뒤 한 글자가 경계인가. 커서가 넘겨 주는 `(from, to)` 는 문서 offset 이다.
function edFindWordTest(doc) {
  const isSep = (ch) => !ch || /\s/.test(ch) || ED_FIND_WORD_SEPARATORS.includes(ch);
  const at = (pos) => (pos < 0 || pos >= doc.length ? '' : doc.sliceString(pos, pos + 1));
  return (from, to) => isSep(at(from - 1)) && isSep(at(to));
}

/**
 * 일치 표시 — 칸마다의 `StateField`. 편집이 오면 표시가 그 변경을 따라 옮겨진다.
 * `edCmExtensions` 가 편집기마다 넣는다 (`edFindMarks().field`).
 */
// 처음 쓸 때 만든다 — 이 파일은 `CM` 이 실리기 전에 읽힌다 (`cm-buffer.js` 와 같은 이유).
function edFindMarks() {
  if (edFindMarks.parts) return edFindMarks.parts;
  const set = CM.StateEffect.define();
  const field = CM.StateField.define({
    create: () => CM.Decoration.none,
    update(marks, tr) {
      let m = marks.map(tr.changes);
      for (const e of tr.effects) if (e.is(set)) m = e.value;
      return m;
    },
    provide: (f) => CM.EditorView.decorations.from(f),
  });
  edFindMarks.parts = { set, field };
  return edFindMarks.parts;
}

/**
 * FR-CMR-72 · FR-M9-9: 일치는 ruler(오른쪽)와 미니맵에도 찍힌다. 현재 일치는 다른 색이다 (FR-EFP-14).
 */
function edFindSources() {
  const hits = (st) => {
    const out = [];
    const set = st.field(edFindMarks().field, false);
    if (!set) return out;
    set.between(0, st.doc.length, (from, to, d) => {
      const cls = d.spec.class || '';
      const cur = cls.includes(ED_FIND_HIT_CUR_CLASS);
      out.push({ from, to, cls, color: cur ? ED_FIND_MARK_COLOR_CUR : ED_FIND_MARK_COLOR, cur });
    });
    return out;
  };
  return [
    edRulerSource().of((st) => hits(st).map((h) => ({ from: h.from, to: h.to, lane: 'right', color: h.color, cls: h.cls }))),
    // 같은 줄에 일치가 여럿이면 현재 일치의 색이 이긴다 — 미니맵은 줄마다 한 색이다.
    edMinimapSource().of((st) => hits(st).sort((a, b) => a.cur - b.cur)
      .map((h) => ({ line: st.doc.lineAt(h.from).number, kind: 'mark', color: h.color, cls: h.cls }))),
  ];
}

/**
 * 찾기 패널이 CodeMirror 편집기에 닿는 자리 (`ED_FIND_MIXIN` 의 엔진).
 * 일치는 `{from, to, caps}` 다 (`edFindHits`).
 */
function edFindEngineCm(view) {
  const hitMark = CM.Decoration.mark({ class: ED_FIND_HIT_CLASS });
  const curMark = CM.Decoration.mark({ class: ED_FIND_HIT_CLASS + ' ' + ED_FIND_HIT_CUR_CLASS });
  return {
    // FR-EFP-9: 한 줄 안의 선택만 질의로 싣는다.
    selText() {
      const { doc, selection } = view.state;
      const r = selection.main;
      if (r.empty || doc.lineAt(r.from).number !== doc.lineAt(r.to).number) return null;
      return doc.sliceString(r.from, r.to);
    },
    hits: (query, opts) => edFindHits(view.state.doc, query, opts, ED_FIND_MAX_HITS),
    paint(hits, cur) {
      const b = new CM.RangeSetBuilder();
      hits.forEach((h, i) => b.add(h.from, h.to, i === cur ? curMark : hitMark));
      view.dispatch({ effects: edFindMarks().set.of(b.finish()) });
    },
    // FR-CMR-33: 고칠 것 전부가 트랜잭션 하나다 — 실행 취소 한 번에 되돌아간다.
    replace(edits) {
      view.dispatch({
        changes: edits.map((e) => ({ from: e.hit.from, to: e.hit.to, insert: e.text })),
        userEvent: 'input.' + ED_FIND_EDIT_SOURCE,
        annotations: CM.isolateHistory.of('full'),
      });
    },
    // FR-EFP-15: 화면 밖이면 가운데로 옮긴다.
    reveal(h) {
      const seen = view.visibleRanges.some((r) => r.from <= h.from && h.to <= r.to);
      if (!seen) view.dispatch({ effects: CM.EditorView.scrollIntoView(h.from, { y: 'center' }) });
    },
    focus: () => view.focus(),
  };
}
