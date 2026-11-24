/**
 * Otterminal — 편집기·문서 렌더 뷰의 생명주기 (`FileEditor`·`DocRender` 의 prototype 증강, PERF M3 §3.5 · FR-SPA-3)
 *
 * 렌더러가 탭 본문의 주인으로 `wake`·`sleep` 을 부른다(`ScreenLife`). 처음 보일 때의 `wake` 는 할 일이 없다.
 *
 * 놓는 것은 관측·그리기뿐이다. 내용·커서·선택·실행 취소는 칸의 `EditorState` 에 있고, 칸은 버퍼에서 떼지 않는다 —
 * 떼었다 다시 붙이면 버퍼가 내용을 통째로 갈아 끼워 실행 취소 기록을 잃는다. LSP 연결도 그대로 둔다.
 *
 *   이전: 가려진 편집기도 찾기를 끝까지 셌고, 진단·변경 표시를 그렸고, 문서는 바깥 변경을 감시·재읽기했다.
 *         가려진 렌더 탭은 버퍼를 구독해 편집마다 타이머를 걸었다
 *   새:   가려지고 2초 뒤 잠들면 놓는다. 깨면 남은 찾기를 이어 끝내고 밀린 것을 한 번 그린다. 문서의 뷰가 모두
 *         잠들면 바깥 변경 관측에서 빠지고, 첫 뷰가 깰 때 감시를 맞추고 stamp 를 한 번 묻는다
 *   이유: 잠든 화면은 구독·타이머·그리기를 하지 않고, 깨면 필요한 상태를 다시 받아 그린다 (FR-SPA-3·D-36)
 *
 * 로드 순서: `file-editor-find.js`·`doc-render.js` **뒤**.
 */

// 문서 단위의 관측을 맞춘다. 마지막 깬 뷰가 잠들면 감시 집합을 줄이고, 첫 뷰가 깨면 감시를 되살리고 바깥 변경을 묻는다.
function edViewLifeDoc(view, wasAsleep) {
  const open = app.editor.open;
  const now = open.edDocAsleep(view._doc);
  if (now === wasAsleep) return;
  app.editor.watch.edWatchSync();
  if (!now) open.edPollDocStamps();
}

Object.assign(FileEditor.prototype, {
  sleep() {
    if (this.asleep) return;
    const was = app.editor.open.edDocAsleep(this._doc);
    this.asleep = true;
    // 찾기는 세던 것(`_findScan`)을 남기고 타이머만 놓는다. 알림 줄·저장 실패 깜빡임은 지금 끝낸다.
    TIMERS.disposeOwner(this);
    this._findT = null;
    if (this.notice.noteEl) this.notice.noteEl.classList.remove('vis');
    this.el.classList.remove('fe-save-failed');
    if (this._view) ED_LSP_ASLEEP.add(this._view);
    edViewLifeDoc(this, was);
  },

  wake() {
    if (!this.asleep) return;
    const was = app.editor.open.edDocAsleep(this._doc);
    this.asleep = false;
    if (this._view) ED_LSP_ASLEEP.delete(this._view);
    if (this._findStale) { this._findStale = false; this._findRun(true) }
    else if (this._findScan) this._findT = TIMERS.defer(() => this._findSlice(), { owner: this, label: 'find' });
    if (this._view && this._buf) edLspDiagShow(this._buf, lspDiagOn, this._view);
    if (this._dd) {
      if (this._dd.stale) { this._dd.stale = false; this._dd.refresh() }
      else this._dd.recompute();
    }
    edViewLifeDoc(this, was);
  },
});

Object.assign(DocRender.prototype, {
  sleep() {
    if (this.asleep) return;
    const was = app.editor.open.edDocAsleep(this._doc);
    this.asleep = true;
    if (this._sub) { this._sub(); this._sub = null }
    // 그리기를 기다리던 것(예약·가려져 미룬 표식)은 버전 불일치로 바꿔 깰 때 한 번만 그린다.
    const owed = !!this._timer || this._stale;
    TIMERS.cancel(this._timer);
    this._timer = null;
    this._stale = false;
    this._sleptVer = owed || !this._buf ? -1 : this._buf.version;
    edViewLifeDoc(this, was);
  },

  wake() {
    if (!this.asleep) return;
    const was = app.editor.open.edDocAsleep(this._doc);
    this.asleep = false;
    this._bindBuf(this._buf);
    if (!this._buf || this._buf.version !== this._sleptVer) this._paint();
    edViewLifeDoc(this, was);
  },
});
