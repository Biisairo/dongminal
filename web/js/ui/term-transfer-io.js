/**
 * TerminalTool — 파일 올리기·내려받기의 본체 (PERF 3.4.12.10, D-47). `uiact` 묶음이다.
 *
 * 부팅의 `TermTransfer`(`term-transfer.js`) 원형에 올리기·내려받기를 바꿔 단다. 드롭 판정과 리스너는 이벤트 안에서 곧바로
 * 답해야 하므로 부팅에 남고, 놓인 파일을 올리거나 OSC 로 내려받을 때 자리표시가 이 묶음을 싣는다(`Screens.call`).
 */
Object.assign(TermTransfer.prototype,{

  _downloadFile(path){
    const a=document.createElement('a');
    a.href=FILE_DOWNLOAD_API+'?path='+encodeURIComponent(path);
    a.download='';document.body.appendChild(a);a.click();a.remove();
    // 앵커 클릭은 끝나는 시점을 알려 주지 않는다 — 진행 문구를 잠시 보이고
    // 스스로 사라진다 (FR-TXN-8).
    this.pane._toast(TERM_DOWNLOAD_BUSY.replace('%s',path),'',TOAST_MS);
  },
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
  },
  _fmtSize(b){
    if(b<1024)return b+'B';
    if(b<1048576)return(b/1024).toFixed(1)+'KB';
    return(b/1048576).toFixed(1)+'MB';
  },
});
