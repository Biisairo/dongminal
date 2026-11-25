/**
 * Otterminal — 편집기 칸의 생명주기 (`FileEditor` 의 prototype 증강, PERF M3 §3.5 · FR-SPA-3)
 *
 * 규약과 이전/새 동작은 `editor-view-life.js` 머리말에 있다. 그 파일은 부팅 묶음이고(문서 렌더 뷰와 공용 함수
 * `edViewLifeDoc`), 이 파일은 `FileEditor` 와 함께 `editor` 묶음에 든다 (PERF 3.4.7).
 *
 * 로드 순서: `file-editor.js`·`editor-view-life.js` **뒤**.
 */

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
