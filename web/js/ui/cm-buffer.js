/**
 * 편집기 문서의 내용 — CODEMIRROR_MIGRATION_SRS §11.1 · FR-CMR-16·21·22·24.
 *
 * 같은 파일을 연 칸(sink)들이 한 버퍼에 붙는다. 칸마다 `EditorState` 가 따로 있고, 한 칸의
 * 편집은 나머지 칸에 그대로 전달된다. 전달된 변경은 받은 칸의 실행 취소 기록에 들어가지
 * 않는다 — 실행 취소는 칸마다 따로다 (§3.16).
 *
 * sink 는 `{state, dispatch(spec), scrollSnapshot?()}` 이다. `EditorView` 가 그 모양이고,
 * 단위 테스트는 `EditorState` 로 흉내낸다. 칸의 편집은 `fromSink` 로 버퍼에 들어온다
 * (`EditorView` 의 `dispatchTransactions` 가 부른다).
 *
 * 디스크 재읽기(`replace`)는 편집이 아니라 초기화다 — 모든 칸의 내용을 바꾸고 실행 취소
 * 기록을 끊는다(종전 `model.setValue` 와 같다). 그래서 칸의 `history()` 는
 * `EdBuffer.HISTORY` Compartment 안에 있어야 한다.
 */
class EdBuffer {
  constructor(text) {
    this.eol = EdBuffer._eol(text);
    this._doc = EdBuffer._text(text);
    this._sinks = new Set();
    this._subs = new Set();
    this.version = 0;
    this.disposed = false;
  }

  get doc() { return this._doc }
  get sinkCount() { return this._sinks.size }
  value() { return this._doc.toString() }
  /** 디스크에 쓸 내용. 줄 끝은 문서의 것(`eol`)이다 — 문서 줄에는 `\r` 이 없다. */
  text(doc = this._doc) { return doc.sliceString(0, doc.length, this.eol) }

  /** 칸을 붙인다. 칸의 내용이 버퍼와 다르면 버퍼의 것으로 맞춘다. */
  attach(sink) {
    if (this.disposed) return false;
    this._sinks.add(sink);
    if (!sink.state.doc.eq(this._doc)) {
      sink.dispatch({
        changes: { from: 0, to: sink.state.doc.length, insert: this._doc },
        annotations: [EdBuffer.REMOTE.of(true), EdBuffer.FLUSH.of(true), CM.Transaction.addToHistory.of(false)],
      });
    }
    return true;
  }

  detach(sink) { this._sinks.delete(sink) }

  /** 칸의 트랜잭션들. 전달받은 것은 다시 보내지 않는다. */
  fromSink(sink, trs) {
    if (this.disposed || !this._sinks.has(sink)) return;
    for (const tr of trs) {
      if (!tr.docChanged || tr.annotation(EdBuffer.REMOTE)) continue;
      this._doc = tr.state.doc;
      for (const other of this._sinks) {
        if (other === sink) continue;
        other.dispatch({
          changes: tr.changes,
          annotations: [EdBuffer.REMOTE.of(true), CM.Transaction.addToHistory.of(false)],
        });
      }
      this._bump(false);
    }
  }

  /**
   * 바깥 내용으로 갈아 끼운다. 같으면 아무것도 하지 않는다(커서·실행 취소를 지킨다).
   * 칸마다 커서를 (줄, 열) 로 남기고, 줄이 사라졌으면 가장 가까운 자리로 접는다.
   */
  replace(text) {
    if (this.disposed) return false;
    this.eol = EdBuffer._eol(text);
    const next = EdBuffer._text(text);
    if (next.eq(this._doc)) return true;
    const prev = this._doc;
    this._doc = next;
    for (const sink of this._sinks) {
      const snap = sink.scrollSnapshot ? sink.scrollSnapshot() : null;
      const sel = sink.state.selection.main;
      sink.dispatch({
        changes: { from: 0, to: sink.state.doc.length, insert: next },
        selection: { anchor: EdBuffer._carry(prev, next, sel.anchor), head: EdBuffer._carry(prev, next, sel.head) },
        annotations: [EdBuffer.REMOTE.of(true), EdBuffer.FLUSH.of(true), CM.Transaction.addToHistory.of(false)],
        effects: EdBuffer.HISTORY.reconfigure([]),
      });
      sink.dispatch({
        effects: snap ? [EdBuffer.HISTORY.reconfigure(CM.history()), snap] : EdBuffer.HISTORY.reconfigure(CM.history()),
        annotations: EdBuffer.REMOTE.of(true),
      });
    }
    this._bump(true);
    return true;
  }

  onChange(fn) {
    this._subs.add(fn);
    return () => this._subs.delete(fn);
  }

  dispose() {
    this.disposed = true;
    this._sinks.clear();
    this._subs.clear();
  }

  _bump(flush) {
    this.version++;
    for (const fn of this._subs) fn({ flush });
  }

  // 줄 끝(CRLF·CR·LF)은 모두 줄 구분이다. 줄에 `\r` 이 남으면 줄 끝에 친 글자가 그 뒤에 붙는다.
  static _text(text) { return CM.Text.of(String(text).split(/\r\n?|\n/)) }

  // 섞여 있으면 CRLF 가 절반을 넘을 때 CRLF 다 — Monaco 가 모델을 세울 때의 규칙이다.
  static _eol(text) {
    const s = String(text);
    const all = (s.match(/\r\n?|\n/g) || []).length;
    const crlf = (s.match(/\r\n/g) || []).length;
    return all && crlf > all / 2 ? '\r\n' : '\n';
  }

  // 옛 문서의 offset 을 (줄, 열) 로 읽어 새 문서에 놓는다.
  static _carry(prev, next, pos) {
    const at = prev.lineAt(Math.min(pos, prev.length));
    const n = Math.min(at.number, next.lines);
    const line = next.line(n);
    return line.from + Math.min(pos - at.from, line.length);
  }
}

// 표식과 Compartment 는 처음 쓸 때 만든다 — 이 파일은 `CM` 이 실리기 전(페이지 로드)에 읽히고,
// `CM` 은 편집기를 처음 열 때 온다 (`loadCodeMirror`).
const EdBufferParts = {};
Object.defineProperties(EdBuffer, {
  // 전달받은 변경의 표식. 이 표식이 붙은 트랜잭션은 다시 전달하지 않는다.
  REMOTE: { get: () => EdBufferParts.remote || (EdBufferParts.remote = CM.Annotation.define()) },
  // 편집이 아니라 내용을 갈아 끼운 변경(디스크 재읽기·붙일 때 맞춤)의 표식. 칸은 이것을 보고
  // 편집과 구별한다 — 미리보기 고정(FR-RTU-42)은 편집에만 반응한다.
  FLUSH: { get: () => EdBufferParts.flush || (EdBufferParts.flush = CM.Annotation.define()) },
  // 칸의 `history()` 가 사는 자리. `replace` 가 비웠다가 다시 세워 기록을 끊는다.
  HISTORY: { get: () => EdBufferParts.history || (EdBufferParts.history = new CM.Compartment()) },
});
