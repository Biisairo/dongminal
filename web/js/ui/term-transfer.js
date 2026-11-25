/**
 * TerminalTool — 파일 전송 (드롭 업로드 · OSC 내려받기 · 올리기, FILE_TRANSFER_SRS · TERMINAL_FOLDER_DROP_SRS · TERM_XFER_NOTICE_SRS).
 *
 * 부품 `TermTransfer`(터미널의 `xfer`) 이다 (REFACTOR3_FE_REST5_SRS D-FR5-9). 상태를 갖지 않는다 — 필드는 종전대로 터미널 인스턴스에
 * 있고 이 부품은 그것을 `this.pane` 으로 읽고 쓴다. 부르는 쪽은 이 부품을 소유 경로로 부른다
 * (`tool.sizer.doFit()`) — e2e·시험도 이 부품에 갈아 끼운다 (REFACTOR3_FE_DELEG_SRS D-DLG-6).
 *
 * PERF 3.4.12.10 (D-47): 드롭 리스너는 여기 있고, 올리기·내려받기의 본체는 `uiact` 묶음의 `term-transfer-io.js` 가
 * 이 원형에 바꿔 단다. 실리기 전의 부름은 묶음을 실은 뒤 본체로 넘긴다.
 */
class TermTransfer {
  constructor(pane){
    this.pane=pane;
  }

  // 파일·폴더 드롭 업로드.
  _wireDnd(){
    // FR-M9-30: 아래 `drop` 과 **같은 판정**이다. 두 문장이 갈리면 그 차이가 곧 결함이다.
    this.pane.el.addEventListener('dragover',e=>{e.preventDefault();if(isFileDrag(e)){e.stopPropagation();this.pane.el.classList.add('dragover')}});
    this.pane.el.addEventListener('dragleave',()=>this.pane.el.classList.remove('dragover'));
    /**
     * TERMINAL_FOLDER_DROP_SRS FR-TFD-10: **폴더도 받는다.**
     *
     * `dataTransfer.files` 만 보면 폴더는 오지 않거나 크기 0 의 실패가 된다 —
     * 그런데 README·features.md 는 "폴더를 놓으면 하위 구조가 그대로 올라간다"
     * 고 두 표면을 함께 말해 왔다. 없던 것은 기능이 아니라 이음매다.
     *
     * `items` 를 **먼저** 본다 (`dropEntries`). entry API 가 없는 브라우저에서만
     * `files` 로 내려가며, 그때는 지금까지와 같은 동작이다 (파일만 올라간다).
     *
     * 한계(`EDITOR_UPLOAD_MAX_ENTRIES`)는 탐색기와 **같은 값**을 쓴다 — 같은
     * 한 가지 사실을 두 벌로 적으면 한쪽만 바뀐다.
     */
    this.pane.el.addEventListener('drop',e=>{
      /**
       * M9_SRS FR-M9-30 (사용자 접수 2026-09-14): **판정은 `dragover` 와 같은
       * 문장이어야 한다.**
       *
       *   이전 동작: `files` 나 `items` 가 하나라도 있으면 파일 드롭으로 보고
       *             `stopPropagation()` 했다
       *   새  동작: `types` 에 `Files` 가 있을 때만. 바로 위 `dragover` 가 쓰는
       *             그 판정이다
       *   이유:     **탭 드래그에도 `items` 가 실리는 판이 있다.** 그때 터미널이
       *             그 드롭을 삼켜 `.pn-body` 의 drop 이 영영 돌지 않고, 분할이
       *             조용히 사라진다. 사용자 콘솔 로그가 그 자리다 —
       *             `ZONE right` · `DROP` 발생 · `app.drag='tab'` 인데
       *             `splitPaneWithTab` 은 불리지 않았다
       *
       * 두 핸들러가 같은 물음에 다른 문장으로 답하면 그 차이가 곧 결함이다.
       * 파일·폴더 드롭은 둘 다 `types` 에 `Files` 를 싣는다 (폴더는 `items` 의
       * `webkitGetAsEntry` 로 읽지만 `types` 는 같다).
       */
      if(!isFileDrag(e)) return;
      const hasFiles=e.dataTransfer.files&&e.dataTransfer.files.length;
      e.preventDefault();e.stopPropagation();
      this.pane.el.classList.remove('dragover');
      walkDrop(e,EDITOR_UPLOAD_MAX_ENTRIES).then(r=>{
        if(!r){ if(hasFiles) this._uploadFiles(e.dataTransfer.files); return }
        // FR-TFD-14: 상한을 넘으면 **하나도** 올리지 않는다. 절반만 올라간
        // 폴더는 되돌릴 길이 없다.
        if(r.over){
          this.pane._toast(EDITOR_UPLOAD_TOO_MANY.replace('%n',EDITOR_UPLOAD_MAX_ENTRIES),'err',TOAST_ERR_MS);
          return;
        }
        if(r.items.length) this._uploadFiles(r.items);
      });
    });
  }

  _downloadFile(...a){ return Screens.call('uiact',this,'_downloadFile',a) }
  _uploadFiles(...a){ return Screens.call('uiact',this,'_uploadFiles',a) }
  _fmtSize(...a){ return Screens.call('uiact',this,'_fmtSize',a) }
}
