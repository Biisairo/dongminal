/**
 * FileEditorSave — 문서를 못 얻은 칸(이진·이미지·로딩 실패)의 저장 한 번과 저장 실패의 알림 (FR-EXC-12 · `FUI-05`).
 *
 * `FileEditor` 의 부품이다 (REFACTOR3_FE_REST5_SRS FR-FR5-21). 문서가 있는 칸의 저장은 종전대로 문서(`app.edDocSave`)가 하고,
 * 그 길이 칸에서 부르는 `_noteSaveFailed`·`_noteUnmappable`·`_confirmConflict` 는 칸의 위임자가 여기로 잇는다.
 * 쓰기·경합 확인·실패 알림은 칸의 이름(`this.ed._write` 등)을 지나 부른다 — 칸에 갈아 끼운 것을 본다.
 */
class FileEditorSave {
  constructor(ed) {
    this.ed = ed;
  }

  // 문서를 못 얻은 뷰(이진·이미지·로딩 실패)의 저장이다. 문서가 있으면 `edDocSave`.
  async once() {
    if (!this.ed._view || !this.ed._dirty) return false;
    const sentDoc = this.ed._view.state.doc;
    const content = this.ed._buf ? this.ed._buf.text(sentDoc) : sentDoc.toString();
    try {
      let r = await this.ed._write(content, this.ed._stamp, null);
      if (r.status === 409) {
        if (!await this.ed._confirmConflict()) return false;
        r = await this.ed._write(content, '', null);
      }
      if (!r.ok) {
        this.ed._noteSaveFailed(r);
        return false;
      }
      this.ed._stamp = (r.data && r.data.stamp) || '';
      if (this.ed._view && this.ed._view.state.doc.eq(sentDoc)) this.ed.__dirty = false;
      this.ed._tabLabelAll();
      if (typeof app !== 'undefined' && app) app.git.gitSignal('write');
      return true;
    } catch (e) {
      console.error('[FileEditor] save error:', e);
      this.ed._noteSaveFailed(null);
      return false;
    }
  }

  /**
   * 저장이 실패했음을 화면에 남긴다 (`FUI-05`).
   *
   * 붉은 테두리는 **무언가 잘못됐다**만 말한다. 사용자가 알아야 하는 것은 **무엇이**
   * 잘못됐는가이고, 서버는 그것을 본문에 실어 보낸다 — 경계 거부인지 디스크
   * 오류인지에 따라 할 일이 다르다.
   *
   * `r` 이 없으면(망 실패·예외) 사유를 모른다. 그때 지어내지 않는다.
   */
  noteFailed(r) {
    // 색은 JS 가 들지 않는다 — 클래스만 토글하고 값은 CSS 가 갖는다 (FR-WRD-14).
    this.ed.el.classList.add('fe-save-failed');
    TIMERS.after(FILE_SAVE_FAIL_FLASH_MS, () => { this.ed.el.classList.remove('fe-save-failed'); }, {owner:this.ed,label:'flash'});
    let why = '';
    if (r) why = (r.text || '').trim().split('\n')[0].slice(0, 200);
    this.ed.note(why ? FILE_SAVE_FAIL + ': ' + why : FILE_SAVE_FAIL);
  }

  /**
   * REPO_FIX 03 §3A-2: 문서 인코딩으로 쓸 수 없는 글자가 있어 서버가 거절했다 — 파일은
   * 그대로다. 그 자리로 커서를 옮기고, 사유와 "UTF-8 로 변환해 저장" 을 함께 보인다.
   */
  noteUnmappable(u, doc) {
    const line = Number(u.line) || 1, col = Number(u.col) || 1;
    if (this.ed._view) {
      const pos = edCmPos(this.ed._view.state.doc, line, col);
      this.ed._view.dispatch({ selection: { anchor: pos }, effects: CM.EditorView.scrollIntoView(pos, { y: 'center' }) });
    }
    const enc = doc && doc.encoding ? (ENC_LABEL[doc.encoding] || doc.encoding) : '';
    this.ed.note(t('editor.enc_unmappable', { line, col, char: u.char || '', enc }), FE_NOTE_ACTION_MS,
      { label: ENC_CONVERT, run: () => app.editor.doc.edDocConvertUtf8(this.ed.filePath) });
  }

  write(content, stamp, doc) { return app.editor.doc.edDocWrite(this.ed.filePath, content, stamp, doc) }

  // FR-EXC-9: 경합의 확인창 — 문서 저장과 같은 것을 쓴다 (`app.edConfirmConflict`).
  confirmConflict() { return app.editor.doc.edConfirmConflict(this.ed.name, this.ed.filePath) }
}
