/**
 * Git Diff 뷰의 CodeMirror 조각 — CODEMIRROR_MIGRATION_SRS 묶음 G (FR-CMR-50~57) · §11.4.
 *
 *   gitDiffIgnoreWs     앞뒤 공백 무시 diff — `diffConfig.override` 자리 (FR-CMR-53)
 *   gitDiffRulerItems   조각 → ruler 항목 (FR-CMR-57)
 *   gitDiffHunkBar      hunk 툴바를 커서 줄에 띄우는 tooltip 필드 (FR-CMR-55)
 *   gitDiffCursorHost   panel-hunks.js 가 편집기에 닿는 유일한 자리
 */

// 줄 번호(1-기반) → 그 줄의 시작 offset. 줄 수를 넘으면 문서 끝이다.
function gitDiffLineStarts(text) {
  const starts = [0];
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
  return (n) => (n - 1 < starts.length ? starts[n - 1] : text.length);
}

/**
 * FR-CMR-53: 줄마다 앞뒤 공백을 걷어 줄 단위로 비교한다. 결과는 원래 텍스트의 offset 으로 된 `Change` 다 —
 * 줄째 바뀐 범위이므로 줄 안의 강조는 줄 전체다 (§3.16 Diff 공백 무시). 상한을 넘으면 기본 diff 로 돌아간다.
 */
function gitDiffIgnoreWs(a, b) {
  const la = a.split('\n'), lb = b.split('\n');
  const r = edDiffLines(la.map((s) => s.trim()), lb.map((s) => s.trim()));
  if (!r.ok) return CM.diff(a, b);
  const sa = gitDiffLineStarts(a), sb = gitDiffLineStarts(b);
  const out = [];
  for (const c of r.changes) {
    let fromA = sa(c.baseStart), toA = sa(c.baseStart + c.baseCount);
    let fromB = sb(c.line), toB = sb(c.line + c.count);
    // 줄바꿈 없는 마지막 줄 **뒤에** 더하거나 지우면, 그 줄을 끊는 줄바꿈이 상대 쪽 범위에 든다.
    if (fromA === toA && fromA === a.length && a.length && !a.endsWith('\n')) fromB--;
    if (fromB === toB && fromB === b.length && b.length && !b.endsWith('\n')) fromA--;
    out.push(new CM.Change(fromA, toA, fromB, toB));
  }
  return out;
}

/** FR-CMR-57: 조각을 ruler 항목으로 — 지운 것은 왼쪽, 더한 것은 오른쪽. 자리는 수정본(B) 쪽 offset 이다. */
function gitDiffRulerItems(chunks) {
  const out = [];
  for (const c of chunks || []) {
    if (c.toA > c.fromA) out.push({ from: c.fromB, to: c.toB, lane: 'left', color: GIT_DIFF_RULER_DEL });
    if (c.toB > c.fromB) out.push({ from: c.fromB, to: c.toB, lane: 'right', color: GIT_DIFF_RULER_ADD });
  }
  return out;
}

// 처음 쓸 때 만든다 — 이 파일은 `CM` 이 실리기 전에 읽힌다.
/**
 * FR-CMR-55 · DIFF_HUNK_BAR_SRS FR-DHB-12: hunk 툴바는 커서 줄 위에 뜨는 tooltip 이다. 위에 자리가 없으면
 * CodeMirror 가 아래로 뒤집는다. 툴바의 DOM 은 하나다(FR-DHB-21) — 효과의 값이 `{pos, node}` 또는 `null` 이다.
 */
function gitDiffHunkBar() {
  if (gitDiffHunkBar.parts) return gitDiffHunkBar.parts;
  const set = CM.StateEffect.define();
  const field = CM.StateField.define({
    create: () => null,
    update(v, tr) {
      for (const e of tr.effects) if (e.is(set)) return e.value;
      // 자리는 줄 머리 offset 이다 — 편집이 오면 따라 옮긴다.
      return v && tr.docChanged ? { pos: tr.changes.mapPos(v.pos), node: v.node } : v;
    },
    // tooltip 마다 얇은 그릇을 둔다 — 자리가 바뀌면 엔진이 새 tooltip 을 붙인 **뒤에** 옛 것을 떼므로, 툴바 노드를
    // 그대로 넘기면 옛 것과 함께 떨어진다.
    provide: (f) => CM.showTooltip.from(f, (v) => (v ? { pos: v.pos, above: true, create: () => {
      const dom = document.createElement('div');
      dom.className = 'git-hunk-tip';
      dom.appendChild(v.node);
      return { dom };
    } } : null)),
  });
  gitDiffHunkBar.parts = { set, field };
  return gitDiffHunkBar.parts;
}

/**
 * panel-hunks.js 가 수정본 편집기에 닿는 자리 (§11.4). 엔진의 이벤트와 선택을 이 모양으로만 내보낸다:
 *
 *   sel()        `{s, e, empty}` — 선택의 줄 범위. 다음 줄 1열에서 끝나는 선택은 그 줄을 넣지 않는다 (FR-DHB-11a)
 *   hasFocus()   편집기가 포커스를 가졌는가
 *   on(fn)       `fn('cursor' | 'focus' | 'blur')`
 *   place(line, node) / unplace()
 */
function gitDiffCursorHost(view) {
  const subs = new Set();
  const host = {
    view,
    sel() {
      const st = view.state, r = st.selection.main, doc = st.doc;
      const a = doc.lineAt(r.from), b = doc.lineAt(r.to);
      if (r.empty) return { s: a.number, e: a.number, empty: true };
      let e = b.number;
      if (r.to === b.from && e > a.number) e--;
      return { s: a.number, e, empty: false };
    },
    hasFocus: () => view.hasFocus,
    on(fn) { subs.add(fn); return () => subs.delete(fn) },
    place(line, node) {
      const doc = view.state.doc;
      const pos = doc.line(Math.min(Math.max(1, line), doc.lines)).from;
      const cur = view.state.field(gitDiffHunkBar().field, false);
      if (cur && cur.pos === pos && cur.node === node) return;
      view.dispatch({ effects: gitDiffHunkBar().set.of({ pos, node }) });
    },
    unplace() {
      if (view.state.field(gitDiffHunkBar().field, false)) view.dispatch({ effects: gitDiffHunkBar().set.of(null) });
    },
    // 편집기의 갱신을 관측자에게 옮긴다 (`GitDiffView` 가 updateListener 에서 부른다). 관측자는 툴바를
    // 놓으며 이 편집기에 dispatch 하므로, 갱신이 끝난 뒤로 미룬다 — 갱신 중의 dispatch 는 엔진이 거부한다.
    _update(u) {
      const evs = [];
      if (u.focusChanged) evs.push(view.hasFocus ? 'focus' : 'blur');
      if (u.selectionSet) evs.push('cursor');
      if (!evs.length) return;
      queueMicrotask(() => { for (const ev of evs) for (const fn of subs) fn(ev) });
    },
    _dispose() { subs.clear() },
  };
  return host;
}
