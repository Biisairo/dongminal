/**
 * FileTree — 내려받기 (FILE_TRANSFER_SRS FR-FTR-14 · UX_BATCH12 FR-EXD-1~7).
 *
 * 메뉴의 다운로드와 바깥(Finder)으로 끌어 내려받기가 같은 URL 을 쓴다.
 * file-tree-xfer.js 에서 갈랐다 — 모듈 크기 게이트(FR-STR-40)가 그 파일의 성장을 막는다.
 *
 * 부품 `FileTreeDownload`(탐색기의 `dl`) 이다 (REFACTOR3_FE_REST5_SRS FR-FR5-31 — 옛 `Object.assign(FileTree.prototype, …)`). 상태는 종전대로
 * 탐색기 인스턴스에 있고 이 부품은 그것을 `this.tree` 로 읽고 쓴다. 탐색기의 이름은 전부 `this.tree.X` 로 부른다 — 시험·e2e 가
 * 인스턴스에 갈아 끼운 것을 부품도 본다. 파일 끝의 위임자 표가 이 부품의 이름을 `FileTree` 원형에 둔다.
 */
class FileTreeDownload {
  constructor(tree){
    this.tree=tree;
  }

  /**
   * FR-FTR-14 / FR-ETR-16: 앵커로 일으킨다. `fetch` 로 blob 을 받으면 파일 전체가
   * 메모리에 올라가고 스트리밍을 잃는다 (D-1).
   *
   * 폴더면 zip 종단으로 간다 (FR-ETR-9). 브라우저는 폴더를 폴더 그대로 받지
   * 못한다 — 그 길(File System Access API)은 secure context 를 요구하는데 서버는
   * 평문 HTTP 다 (D-4).
   */
  download(p){ this.tree.downloadMany([p]) }
  downloadMany(ps){
    const d=this.tree._dlOf(ps);
    if(!d) return;
    const a=document.createElement('a');
    a.href=d.href; a.download=d.name;
    document.body.appendChild(a); a.click(); a.remove();
  }

  /**
   * 내려받을 URL·이름·형식. 하나면 파일·폴더 종단이고, 여럿이면 zip 하나다(FR-EXD-3 —
   * 이름은 서버의 `zipManyName` 과 같다). 링크 하나는 null 이다 (FR-ETR-16 · FR-EXD-5).
   */
  _dlOf(ps){
    const q=p=>'&path='+encodeURIComponent(p);
    const at='?root='+encodeURIComponent(this.tree.root);
    if(ps.length>1){
      return {href:FS_DOWNLOAD_MANY_API+at+ps.map(q).join(''),
        name:this.tree._base(this.tree.root)+'-'+ps.length+'-items.zip',mime:'application/zip'};
    }
    const p=ps[0];
    if(!p) return null;
    const kind=p===this.tree.root?'dir':this.tree._kindOf(p);
    if(kind!=='file'&&kind!=='dir') return null;
    const dir=kind==='dir';
    return {href:(dir?FS_DOWNLOAD_DIR_API:FS_DOWNLOAD_API)+at+q(p),
      name:this.tree._base(p)+(dir?'.zip':''),mime:dir?'application/zip':'application/octet-stream'};
  }

  /**
   * FR-EXD-1·6: Chromium 은 `<mime>:<이름>:<절대 URL>` 을 실은 끌기를 OS 에 놓으면 그 URL 을
   * 내려받는다. 상대 URL 은 무시되므로 `location.origin` 을 붙인다 (R-5).
   */
  _dragDownloadURL(ps){
    const d=this.tree._dlOf(ps);
    return d?d.mime+':'+d.name+':'+location.origin+d.href:'';
  }
}

// 탐색기 원형의 이름 — 앱·렌더러·e2e·시험과 다른 부품이 `FileTree` 에서 부른다 (REFACTOR3_FE_REST5_SRS FR-FR5-32).
Controller.delegate(FileTree,'dl',['download','downloadMany','_dlOf','_dragDownloadURL']);
