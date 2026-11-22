/**
 * TerminalTool — 파일 전송 (드롭 업로드 · OSC 내려받기 · 올리기, FILE_TRANSFER_SRS · TERMINAL_FOLDER_DROP_SRS · TERM_XFER_NOTICE_SRS).
 *
 * 부품 `TermTransfer`(터미널의 `xfer`) 이다 (REFACTOR3_FE_REST5_SRS D-FR5-9). 상태를 갖지 않는다 — 필드는 종전대로 터미널 인스턴스에
 * 있고 이 부품은 그것을 `this.pane` 으로 읽고 쓴다. 터미널의 이름은 전부 `this.pane.X` 로 부른다 — e2e·시험이 인스턴스에 갈아 끼운
 * 것을 부품도 본다. 파일 끝의 위임자 표가 이 부품의 이름을 `TerminalTool` 원형에 둔다.
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

  _downloadFile(path){
    const a=document.createElement('a');
    a.href=FILE_DOWNLOAD_API+'?path='+encodeURIComponent(path);
    a.download='';document.body.appendChild(a);a.click();a.remove();
    // 앵커 클릭은 끝나는 시점을 알려 주지 않는다 — 진행 문구를 잠시 보이고
    // 스스로 사라진다 (FR-TXN-8).
    this.pane._toast(TERM_DOWNLOAD_BUSY.replace('%s',path),'',TOAST_MS);
  }
  _uploadFiles(files){
    if(!files||!files.length)return;
    // FR-FTR-11: 이 도구의 폴더가 아닌 곳에 떨어뜨리지 않는다. 그 판정은 서버의 답이다
    // (SERVER_DRIVEN_ACTIONS_SRS X-c) — 화면은 cwd 를 들지 않고 `tool` 로 보낸다.
    apiGet(CWD_API,{query:{tool:this.pane.id}}).then(res=>{
      const a=res.ok&&res.data&&res.data.actions?res.data.actions['term.upload']:null;
      if(!a||!a.ok){this.pane._toast(TERM_UPLOAD_NO_CWD,'err',TOAST_ERR_MS);return}
      let i=0;
      const uploadNext=()=>{
        // FR-FTR-10: 끝나도 셸에 엔터를 보내지 않는다 — 그 순간 돌고 있는 것이
        // 셸이 아니면 그 프로그램이 엔터를 받는다.
        if(i>=files.length) return;
        // FR-TFD-12: `{file, relPath}` 도 받는다. `relPath` 가 있으면 서버가 그
        // 아래 폴더를 만든다 — `file` 보다 **먼저** 실어야 한다. 서버가 스트림으로
        // 파싱하므로 순서가 계약이다 (`file-tree-xfer.js` 의 근거와 같다).
        const it=files[i++];
        const f=it&&it.file?it.file:it;
        const rel=(it&&it.relPath)||'';
        const fd=new FormData();
        if(rel) fd.append('relPath',rel);
        fd.append('file',f);
        // FR-TXN-3·5: 파일 하나의 일은 팝업 하나에서 마친다. 진행 팝업은 스스로
        // 사라지지 않는다 — 전송이 소멸 시간보다 길면 시작한 일이 사라진다.
        // FR-TFD-13: 보이는 이름은 `relPath` 다 — `a/b/c.txt` 를 `c.txt` 로만
        // 보이면 어느 것이 끝났는지 알 수 없다.
        const label=rel||f.name;
        const toast=this.pane._toast(TERM_UPLOAD_BUSY.replace('%s',label),'',0);
        apiPost(UPLOAD_API,fd,{query:{tool:this.pane.id}})
          .then(r=>(r.ok&&r.data)?r.data:Promise.reject(r))
          .then(d=>{
            // FR-TFD-13: 폴더 맥락과 **실제 저장된 이름**을 함께 보인다. 서버는
            // 충돌 시 개명하므로(`c (1).txt`) 그 사실이 보여야 하고, 그렇다고
            // 마지막 조각만 보이면 어느 폴더의 것인지 알 수 없다.
            const at=rel?rel.replace(/[^/]*$/,'')+d.name:d.name;
            if(toast)toast.update(TERM_UPLOAD_OK.replace('%s',at).replace('%z',this._fmtSize(d.size)),'ok');
            uploadNext();
          }).catch(()=>{
            if(toast)toast.update(TERM_UPLOAD_FAIL.replace('%s',label),'err',TOAST_ERR_MS);
            uploadNext();
          });
      };
      uploadNext();
    }).catch(()=>this.pane._toast(TERM_UPLOAD_NO_CWD,'err',TOAST_ERR_MS));
  }
  _fmtSize(b){
    if(b<1024)return b+'B';
    if(b<1048576)return(b/1024).toFixed(1)+'KB';
    return(b/1048576).toFixed(1)+'MB';
  }
}
