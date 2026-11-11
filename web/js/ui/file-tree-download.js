/**
 * FileTree — 내려받기 (FILE_TRANSFER_SRS FR-FTR-14 · UX_BATCH12 FR-EXD-1~7).
 *
 * 메뉴의 다운로드와 바깥(Finder)으로 끌어 내려받기가 같은 URL 을 쓴다.
 * file-tree-xfer.js 에서 갈랐다 — 모듈 크기 게이트(FR-STR-40)가 그 파일의 성장을 막는다.
 */
Object.assign(FileTree.prototype, {
  /**
   * FR-FTR-14 / FR-ETR-16: 앵커로 일으킨다. `fetch` 로 blob 을 받으면 파일 전체가
   * 메모리에 올라가고 스트리밍을 잃는다 (D-1).
   *
   * 폴더면 zip 종단으로 간다 (FR-ETR-9). 브라우저는 폴더를 폴더 그대로 받지
   * 못한다 — 그 길(File System Access API)은 secure context 를 요구하는데 서버는
   * 평문 HTTP 다 (D-4).
   */
  download(p){ this.downloadMany([p]) },
  downloadMany(ps){
    const d=this._dlOf(ps);
    if(!d) return;
    const a=document.createElement('a');
    a.href=d.href; a.download=d.name;
    document.body.appendChild(a); a.click(); a.remove();
  },

  /**
   * 내려받을 URL·이름·형식. 하나면 파일·폴더 종단이고, 여럿이면 zip 하나다(FR-EXD-3 —
   * 이름은 서버의 `zipManyName` 과 같다). 링크 하나는 null 이다 (FR-ETR-16 · FR-EXD-5).
   */
  _dlOf(ps){
    const q=p=>'&path='+encodeURIComponent(p);
    const at='?root='+encodeURIComponent(this.root);
    if(ps.length>1){
      return {href:FS_DOWNLOAD_MANY_API+at+ps.map(q).join(''),
        name:this._base(this.root)+'-'+ps.length+'-items.zip',mime:'application/zip'};
    }
    const p=ps[0];
    if(!p) return null;
    const kind=p===this.root?'dir':this._kindOf(p);
    if(kind!=='file'&&kind!=='dir') return null;
    const dir=kind==='dir';
    return {href:(dir?FS_DOWNLOAD_DIR_API:FS_DOWNLOAD_API)+at+q(p),
      name:this._base(p)+(dir?'.zip':''),mime:dir?'application/zip':'application/octet-stream'};
  },

  /**
   * FR-EXD-1·6: Chromium 은 `<mime>:<이름>:<절대 URL>` 을 실은 끌기를 OS 에 놓으면 그 URL 을
   * 내려받는다. 상대 URL 은 무시되므로 `location.origin` 을 붙인다 (R-5).
   */
  _dragDownloadURL(ps){
    const d=this._dlOf(ps);
    return d?d.mime+':'+d.name+':'+location.origin+d.href:'';
  },
});
