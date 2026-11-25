/**
 * Otterminal — 문서 렌더 뷰의 생명주기 (`DocRender` 의 prototype 증강, PERF M3 §3.5 · FR-SPA-3)
 *
 * 편집기 뷰와 규약이 같다 — `editor-view-life.js` 머리말. 문서 단위 관측은 그 파일의 `edViewLifeDoc` 을 쓴다.
 * `docrender` 묶음에 있으므로 따로 둔다(PERF 3.4.8).
 *
 * 로드 순서: `doc-render.js` **뒤**.
 */

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
