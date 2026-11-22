/**
 * FileTree — 파일을 주고받는 일 (FILE_TRANSFER_SRS / SPLIT_REFACTOR_SRS 묶음 C).
 *
 * 올리기(`doUpload`·`_uploadOne`·`pickUpload`) · 우클릭 메뉴(`_onCtx`) ·
 * 드래그드롭(`_initDnd`·`_dropUpload`·`_spring*`)이 여기 산다. 내려받기는 file-tree-download.js 다.
 *
 * 이것들의 공통점은 **트리 밖과 닿는다**는 것이다 — 사용자의 파일 시스템, 브라우저의
 * DataTransfer, 서버의 업로드 종단. 트리 안에서 끝나는 일과 섞이지 않게 갈랐다.
 *
 * `static` 넷은 prototype 이 아니라 클래스 자체에 붙는다 — 인스턴스 없이 불린다.
 *
 * 부품 `FileTreeXfer`(탐색기의 `xfer`) 이다 (REFACTOR3_FE_REST5_SRS FR-FR5-31 — 옛 `Object.assign(FileTree.prototype, …)`). 상태는 종전대로
 * 탐색기 인스턴스에 있고 이 부품은 그것을 `this.tree` 로 읽고 쓴다. 제 이름은 `this.X`, 탐색기와 다른 부품의 이름은 `this.tree.X`·`this.tree.<부품>.X` 로
 * 부른다 — 시험·e2e 가 부품 인스턴스에 갈아 끼운 것을 부품끼리도 본다. 이 부품의 이름은 `FileTree` 원형에 없다 (REFACTOR3_FE_DELEG_SRS). 정적 넷(`_asUploadItems` 등)은
 * `FileTree` 클래스 본문으로 갔다.
 */
class FileTreeXfer {
  constructor(tree){
    this.tree=tree;
  }

  /**
   * FR-FTR-19 / FR-ETR-26~30: 항목을 **순차**로 올린다.
   *
   * 받는 것은 `{file, relPath}` 의 배열이다. `relPath` 가 있으면 서버가 대상
   * 아래로 구조를 세운다 (FR-ETR-17) — 파일 여럿을 고른 경우에는 비어 있고,
   * 그때 동작은 지금까지와 같다.
   *
   * **실패는 멈추고 묻는다** (D-9). 첫 실패에 통째로 멈추던 규약은 파일 몇 개일
   * 때의 것이다 — 폴더 하나가 수백 개일 수 있는 지금은 그것이 "처음부터 다시
   * 하라" 는 말이 된다.
   *
   * 낙관적 반영을 하지 않는 이유는 전송이 끝나야 이름이 확정되기 때문이다
   * (서버가 충돌을 거부한다 — FR-FTR-16). 그래서 조작 넷과 달리 `_optimAdd` 가
   * 없고, 끝난 뒤 그 폴더만 다시 읽는다 (FR-EDT-88).
   */
  async doUpload(dir,items){
    const list=FileTree._asUploadItems(items);
    if(!dir||!list.length) return;
    this.tree.painter._clearErr();
    // 올린 것이 보이지 않으면 사용자는 실패로 읽는다.
    if(dir!==this.tree.root&&!this.tree._open.has(dir)) this.tree._open.add(dir);
    this.tree._busy.add(dir); this.tree._paintAll();

    let skipped=0, aborted=0, err='';
    let skipAll=false;
    for(let i=0;i<list.length;i++){
      const it=list[i];
      const label=it.relPath||it.file.name;
      const why=await this._uploadOne(dir,it);
      if(!why) continue;
      if(skipAll){skipped++;continue}
      // FR-ETR-29: 물을 수 없으면 **중단**이다 — 안전한 쪽이다 (FR-GIT-97).
      const choice=await this._askUploadFailure(label,why);
      if(choice==='retry'){i--;continue}
      if(choice==='skip'){skipped++;continue}
      if(choice==='skipAll'){skipAll=true;skipped++;continue}
      aborted=list.length-i;
      err=EDITOR_UPLOAD_ABORTED.replace('%n',aborted)+' — '+label+' — '+why;
      break;
    }
    this.tree._busy.delete(dir);
    await this._after([dir]);
    // FR-ETR-30: 조용히 끝나면 사용자는 전부 올라간 줄 안다.
    if(!err&&skipped) err=EDITOR_UPLOAD_SKIPPED.replace('%n',skipped);
    if(err) this.tree.painter._fail(dir===this.tree.root?'':dir,err);
  }

  /**
   * 한 항목을 올린다. 성공이면 빈 문자열, 실패면 **사람의 말로 된 사유**다 —
   * 부르는 쪽이 그것을 다이얼로그와 행 표시 둘에 함께 쓴다.
   */
  async _uploadOne(dir,it){
    const fd=new FormData();
    // relPath 를 file 보다 **먼저** 싣는다. 서버는 전체를 파싱하므로 순서가
    // 동작을 바꾸지는 않지만, 큰 파일 뒤에 필드를 두면 그 필드가 본문 끝에 있어
    // 스트리밍 파서로 옮길 때 곤란해진다.
    if(it.relPath) fd.append('relPath',it.relPath);
    fd.append('file',it.file);
    const u=FS_UPLOAD_API+'?root='+encodeURIComponent(this.tree.root)+
      '&dir='+encodeURIComponent(dir);
    const r=await apiPost(u,fd);
    const d=r.data;
    if(r.ok&&d&&d.ok) return '';
    const why=d&&(d.code||d.message)?edFsReason(d):'';
    return why||josa(EDITOR_UPLOAD_FAIL.replace('%s',it.relPath||it.file.name));
  }

  /**
   * FR-ETR-26~29: 실패한 자리에서 무엇을 할지 묻는다.
   *
   * 브라우저의 `confirm` 을 쓰지 않는 이유는 어느 항목이 왜 실패했는지 보일
   * 자리가 없기 때문이다 (FR-ETR-27) — Git 의 다이얼로그가 이미 그 골격을 갖고
   * 있다 (FR-GIT-172·177).
   */
  async _askUploadFailure(label,why){
    if(typeof GitDialog==='undefined') return 'abort';
    const got=await GitDialog.open({
      id:'ed-upload-fail-dlg',ns:'euf',action:'upload_retry',
      title:EDITOR_UPLOAD_FAIL_TITLE,
      body:josa(EDITOR_UPLOAD_FAIL_BODY.replace('%s',label).replace('%r',why)),
      choices:[
        {id:'retry',label:EDITOR_UPLOAD_RETRY},
        {id:'skip',label:EDITOR_UPLOAD_SKIP},
        {id:'skipAll',label:EDITOR_UPLOAD_SKIP_ALL},
        {id:'abort',label:EDITOR_UPLOAD_ABORT},
      ],
      def:'skip',
      // 이 다이얼로그는 저장소 상태와 무관하다 — 기본 지문(FR-GIT-178)을 쓰면
      // 폴링 한 번에 "대상이 바뀌었다" 가 뜬다.
      fingerprint:()=>'',
    });
    // 열지 못했으면 `_safe` 가 def 를 준다. 그것을 그대로 받으면 "묻지 않고
    // 건너뛴다" 가 되므로, 문자열이 아닌 답은 중단으로 접는다 (FR-ETR-29).
    return typeof got==='string'&&got?got:'abort';
  }

  /**
   * FR-FTR-18 / FR-ETR-23: 파일 선택 창. input 은 한 번 쓰고 버린다 — 남겨 두면
   * 같은 파일을 다시 고를 때 change 가 오지 않는다.
   *
   * `asDir` 이면 `webkitdirectory` 다. 한 input 이 두 모드를 겸할 수 없어
   * 메뉴 항목이 둘로 나뉜다 — `multiple` 과 `webkitdirectory` 를 함께 세우면
   * 브라우저마다 다르게 읽는다.
   */
  pickUpload(dir,asDir){
    const inp=document.createElement('input');
    inp.type='file';
    if(asDir){ inp.webkitdirectory=true; inp.setAttribute('webkitdirectory',''); }
    else inp.multiple=true;
    inp.style.cssText='position:fixed;left:-9999px';
    inp.addEventListener('change',()=>{
      const files=[...(inp.files||[])];
      inp.remove();
      // FR-ETR-22: 상한을 넘으면 올리지 않는다. 홈 폴더를 잘못 골랐을 때
      // 수만 건의 요청을 만들지 않는다.
      if(files.length>EDITOR_UPLOAD_MAX_ENTRIES){
        this.tree.painter._fail(dir===this.tree.root?'':dir,
          EDITOR_UPLOAD_TOO_MANY.replace('%n',EDITOR_UPLOAD_MAX_ENTRIES));
        this.tree._paintAll();
        return;
      }
      if(files.length) this.doUpload(dir,files);
    });
    // 취소하면 change 가 오지 않는다 — 거두지 않으면 부를 때마다 하나씩 쌓인다.
    inp.addEventListener('cancel',()=>inp.remove());
    document.body.appendChild(inp);
    inp.click();
  }

  // FR-EDT-88·89: 영향받은 폴더**만** 다시 읽고 git 색을 다시 받는다. 트리 전체를
  // 새로 만들지 않는다.
  // REPO_FIX 04 §3A-3: 실패 사유를 지우지 않는다 — 재조회가 사유를 앗아가면 사용자는
  // 조작이 성공한 줄 안다 (#27).
  async _after(dirs){
    for(const d of dirs) await this.tree.loader.load(d);
    // FR-DIR-32: 방금 한 조작의 결과다 — 늦춰 보일 이유가 없다.
    this.tree.loader.pollGit({now:true});
  }

  // ── 진입점 둘 (FR-EDT-80) ──

  _onCtx(e){
    const row=e.target.closest('.ed-row');
    // CONTEXT_MENU_UNIFY_SRS FR-CMU-9 (`FUI-12`): 행 밖의 여백 — 자리는 루트다.
    // 행 메뉴의 같은 항목과 **같은 함수**를 부른다.
    if(!row&&this.tree.list.contains(e.target)){
      e.preventDefault();
      if(this.tree._edit) this.tree.edits.cancelEdit();
      const dir=this.tree.root;
      // CLAUDE_ACCOUNTS_SRS FR-CAC-97·95a: 빈 자리는 루트 폴더다 (FR-CMU-9).
      const ca=this.tree.app.claudeFolderMenu?this.tree.app.claudeFolderMenu(this.tree.root,dir,{x:e.clientX,y:e.clientY}):null;
      UIKit.menu([
        {id:'newFile',label:EDITOR_MENU_NEW_FILE,onClick:()=>this.tree.edits.startCreate(false,dir)},
        // FR-M9-23: 여백 메뉴도 행 메뉴와 같다 — 가림이 폐기됐다.
        {id:'newDir',label:EDITOR_MENU_NEW_DIR,onClick:()=>this.tree.edits.startCreate(true,dir)},
        {id:'upload',label:EDITOR_MENU_UPLOAD,onClick:()=>this.pickUpload(dir)},
        {id:'uploadDir',label:EDITOR_MENU_UPLOAD_DIR,onClick:()=>this.pickUpload(dir,true)},
        {sep:true},
        {id:'paste',label:EDITOR_MENU_PASTE,disabled:this.tree.app.edClipGet()?false:EDITOR_PASTE_NONE,onClick:()=>this.tree.edits.doPasteInto(dir)},
        ...(ca?[{sep:true},
          {id:'claudeLink',label:t('cacct.map.folder_menu'),disabled:ca.linkWhy||false,onClick:ca.link},
          {id:'claudeUnlink',label:t('cacct.map.folder_clear'),disabled:ca.unlinkWhy||false,onClick:ca.unlink}]:[]),
      ],{at:{x:e.clientX,y:e.clientY},cls:'edfs-blank-menu'});
      return;
    }
    if(!row||!this.tree.list.contains(row)||row.classList.contains('ed-edit')) return;
    e.preventDefault();
    const p=row.dataset.path,kind=row.dataset.kind;
    if(this.tree._edit) this.tree.edits.cancelEdit();
    /**
     * FR-EMS-24 와 같은 규약이다 (U-5): 우클릭한 행이 **선택 안이면 선택을
     * 지킨다.** 밖이면 그 하나로 되돌린다 — 고르지 않은 것에 메뉴를 열었는데
     * 고른 것이 지워지면 그것이 놀람이다.
     */
    if(!this.tree.selector._selHas(p)) this.tree.selector._selOnly(p);
    else this.tree._sel=p;
    this.tree._paintAll();
    // 만드는 자리는 우클릭한 행이 정한다 — 폴더면 그 안, 아니면 그 형제다
    // (FR-EDT-81 과 같은 규칙).
    const dir=kind==='dir'?p:this.tree.painter._parent(p);
    // SERVER_DRIVEN_ACTIONS_SRS F-f: 이름 바꾸기·옮기기·복사·삭제를 할 수 있는지는 서버가
    // 답한다. 메뉴를 연 행이 먼저이고, 삭제는 선택 전부를 본다.
    const paths=[p,...this.tree.selector._selTargets(p).filter(x=>x&&x!==p)];
    // UX_BATCH12 FR-EXM-3·4: 이름 바꾸기·새로 만들기·업로드 밖은 선택 전체가 대상이다.
    const many=this.tree.selector._selOrdered(p).filter(x=>x&&x!==this.tree.root),multi=many.length>1;
    // CLAUDE_ACCOUNTS_SRS FR-CAC-97·95a: 폴더 행에만. 대상은 우클릭한 행 하나다.
    const ca=kind==='dir'&&this.tree.app.claudeFolderMenu?this.tree.app.claudeFolderMenu(this.tree.root,p,{x:e.clientX,y:e.clientY}):null;
    GitMenu.openAsked([
      {id:'newFile',label:EDITOR_MENU_NEW_FILE,run:()=>this.tree.edits.startCreate(false,dir)},
      // FR-M9-23: 메모장에서도 보인다 — FR-EXR-32 의 가림은 폐기됐다.
      {id:'newDir',label:EDITOR_MENU_NEW_DIR,run:()=>this.tree.edits.startCreate(true,dir)},
      // FR-FTR-18: 업로드가 가는 자리도 같은 규칙이다 — 폴더면 그 안, 아니면 형제.
      {id:'upload',label:EDITOR_MENU_UPLOAD,run:()=>this.pickUpload(dir)},
      // FR-ETR-23: 폴더 업로드는 별개의 항목이다 — 한 input 이 두 모드를 겸할 수
      // 없다.
      {id:'uploadDir',label:EDITOR_MENU_UPLOAD_DIR,run:()=>this.pickUpload(dir,true)},
      // FR-FTR-13 / FR-ETR-16: 파일과 폴더에서 활성이고, 폴더는 zip 으로 온다.
      // 링크만 비활성이다 — 링크 자신을 내려받는다는 뜻이 정해져 있지 않다.
      // 여러 항목은 zip 하나다 (FR-EXD-7) — 링크는 서버가 건너뛴다 (FR-ETR-16).
      {id:'download',label:EDITOR_MENU_DOWNLOAD,
        disabled:()=>!multi&&kind==='link'?EDITOR_DOWNLOAD_LINK_NO:'',
        run:()=>this.tree.dl.downloadMany(multi?many:[p])},
      {sep:true},
      /**
       * M9_SRS FR-M9-19 (사용자 요구 2026-09-14): **경로 복사 둘.**
       *
       * 대상은 선택 전체다 (UX_BATCH12 FR-EXM-3 이 "우클릭한 행 하나" 를 개정).
       *
       * 자기 구획인 이유는 D-M9-10 이다: 아래 `copy` 는 **파일 클립보드**이고 이것은
       * **텍스트 클립보드**다. 나란히 두면 사용자가 둘을 같은 것으로 읽는다.
       */
      {id:'copyAbsPath',label:EDITOR_MENU_COPY_ABS_PATH,run:()=>this.copyPath(multi?many:p,false)},
      {id:'copyRelPath',label:EDITOR_MENU_COPY_REL_PATH,run:()=>this.copyPath(multi?many:p,true)},
      {sep:true},
      // FR-WBR-70: 복사·붙여넣기·복제. 붙여넣는 자리는 만들기와 같은 규칙이
      // 정한다 — 폴더면 그 안, 아니면 그 형제 (`dir` 이 그것이다).
      {id:'copy',label:EDITOR_MENU_COPY,act:FS_ACTION_COPY,run:()=>this.tree.app.edClipSet(this.tree.root,multi?many:p)},
      // FUI-11: 같은 클립보드에 **동사만** 다르게 놓는다. 붙여넣는 쪽이
      // `c.move` 로 갈린다 — 자리와 대상은 복사와 한 글자도 다르지 않다.
      {id:'cut',label:EDITOR_MENU_CUT,act:FS_ACTION_MOVE,run:()=>this.tree.app.edClipSet(this.tree.root,multi?many:p,true)},
      {id:'paste',label:EDITOR_MENU_PASTE,
        disabled:()=>this.tree.app.edClipGet()?'':EDITOR_PASTE_NONE,
        run:()=>this.tree.edits.doPasteInto(dir)},
      {id:'duplicate',label:EDITOR_MENU_DUPLICATE,act:FS_ACTION_COPY,run:()=>this.tree.edits.doDuplicate(multi?many:p)},
      {sep:true},
      {id:'rename',label:EDITOR_MENU_RENAME,act:FS_ACTION_RENAME,
        disabled:()=>multi?EDITOR_RENAME_MANY_NO:'',run:()=>this.tree.edits.startRename(p)},
      // 확인은 `doDelete` 가 한다 — 재귀 여부·항목 수·dirty 탭을 밝혀야 하므로
      // 메뉴의 일반 확인(GitDialog)으로는 FR-EDT-83·84 를 만족하지 못한다.
      {id:'delete',label:EDITOR_MENU_DELETE,act:FS_ACTION_DELETE,run:()=>this.tree.edits.doDelete(p)},
      ...(ca?[{sep:true},
        {id:'claudeLink',label:t('cacct.map.folder_menu'),disabled:()=>ca.linkWhy,run:ca.link},
        {id:'claudeUnlink',label:t('cacct.map.folder_clear'),disabled:()=>ca.unlinkWhy,run:ca.unlink}]:[]),
    ],'edfs',{path:p},e,async stale=>{
      const ans=await this.tree.app.edFsActions(this.tree.root,paths);
      return stale()?null:((ans&&ans.actions)||{});
    });
  }

  /**
   * FR-M9-19: 그 행의 경로를 클립보드에 담는다. `rel` 이면 **이 탐색기 루트** 기준이다.
   *
   * 쓰기는 `TermClipboard.write` 한 벌이다 (FR-ETR-40 의 3단 폴백) — 이 앱에서
   * 클립보드에 쓰는 길은 그것 하나이고, 새 길을 내면 secure context 밖에서 한쪽만
   * 동작한다. `toolId` 는 넘기지 않는다: 그 인자는 "지금 그 터미널을 보고 있는가"
   * 게이트를 켜는 것이고(FR-ETR-44), 여기는 사용자가 방금 누른 메뉴다.
   *
   * **성공했을 때만 말한다.** 클립보드는 눈에 보이지 않아 조용하면 눌린 것인지 알
   * 수 없으므로 성공에는 토스트가 필요하다. 거짓이 돌아오는 경우는 3단으로 내려가
   * **수동 복사창이 이미 떠 있는** 때뿐이므로(`_watchedHere` 는 `toolId` 없이 언제나
   * 참이다) 거기에 오류를 겹치면 같은 일을 두 번 말하는 것이 된다.
   */
  async copyPath(ps,rel){ // UX_BATCH12 FR-EXM-3: 여러 경로면 받은 순서대로 줄바꿈으로 잇는다.
    const text=[].concat(ps).map(p=>rel?pathRelative(this.tree.root,p):p).join('\n');
    if(await TermClipboard.write(text)) Toast.show(EDITOR_PATH_COPIED);
  }

  /**
   * FR-EDT-85 · FR-FTR-17·20·23: 드래그. 상태는 **이 인스턴스**가 쥔다 —
   * `app.drag` 는 탭 이동의 것이고(renderer.js) 거기 끼어들면 pane 이 이 드래그를
   * 받는다.
   *
   * 받는 것이 둘이다. **트리 내부의 이동**(`this._drag` 가 서 있다)과 **바깥에서
   * 온 파일**(`dataTransfer.types` 에 `Files`)이다. 둘을 가르는 근거가 이것뿐이라
   * 판정을 한 자리에 모은다.
   *
   * 리스너는 `this.list` 가 아니라 `this.el` 에 건다 — 헤더도 드롭 존이기
   * 때문이다 (FR-FTR-20). 행은 reconcile 로 다시 만들어지므로 컨테이너에만 건다.
   */
  _initDnd(){
    this.tree._dragEsc={phase:'bubble',propagate:true,active:()=>!!(this.tree._drag||this.tree._dropDir),close:()=>endDrag()};
    this.tree.list.addEventListener('dragstart',e=>{
      const row=e.target.closest('.ed-row[data-path]');
      if(!row||row.classList.contains('ed-edit')){e.preventDefault();return}
      this.tree._drag=row.dataset.path;
      EscapeStack.push(this.tree._dragEsc);   // REFACTOR3_FE_ESC_SRS FR-FEE-8
      /**
       * FR-EMS-24 (U-5): 끌기 시작한 행이 **선택 밖이면** 집합을 그 하나로
       * 되돌린다. 고르지 않은 것을 끌었는데 고른 것이 따라가면 그것이 놀람이다.
       */
      //
      // **여기서 다시 그리지 않는다.** `dragstart` 중에 목록을 다시 만들면 끌던
      // 요소가 사라져 드래그 자체가 깨진다 (이 저장소의 `FR-RPT-3` 과 같은
      // 함정 — 실측으로 O6·O7·O8 이 한 번에 무너졌다). 모델만 바꾸고 화면은
      // 이동이 끝난 뒤의 갱신에 맡긴다.
      if(!this.tree.selector._selHas(this.tree._drag)) this.tree.selector._selOnly(this.tree._drag);
      e.dataTransfer.effectAllowed='move';
      // 데이터가 없으면 일부 브라우저가 드래그를 시작조차 하지 않는다.
      e.dataTransfer.setData('text/plain',this.tree._drag);
      // §3A-5 (T-7.4): 트리 드래그의 표식 — 트리 밖(편집기 탭 등)의 드롭은 이 타입이
      // 있을 때만 트리 드래그로 읽는다.
      e.dataTransfer.setData(FILE_TREE_DRAG_TYPE,this.tree._drag);
      // UX_BATCH12 FR-EXD-1~5: 바깥(Finder)에 놓으면 내려받는다. 트리 안의 놓기는
      // `dragover` 가 `move` 로 정하므로 옮기기 그대로다 (R-6).
      const dl=this.tree.dl._dragDownloadURL(this.tree.selector._selOrdered(this.tree._drag).filter(x=>x!==this.tree.root));
      if(dl){e.dataTransfer.effectAllowed='copyMove';e.dataTransfer.setData('DownloadURL',dl)}
    });
    this.tree.el.addEventListener('dragover',e=>{
      const ext=FileTree._isFileDrag(e);
      if(!this.tree._drag&&!ext) return;
      e.preventDefault(); e.stopPropagation();
      e.dataTransfer.dropEffect=ext?'copy':'move';
      this._markDrop(this._dropDirAt(e.target));
      this._springSchedule(e.target);
    });
    // 탐색기 **바깥**으로 나갈 때만 지운다. 행에서 행으로 옮길 때마다 지우면
    // 표시가 깜빡이고, 그 사이의 drop 이 대상을 잃는다.
    this.tree.el.addEventListener('dragleave',e=>{
      if(e.relatedTarget&&this.tree.el.contains(e.relatedTarget)) return;
      this._dropClear();
    });
    this.tree.el.addEventListener('drop',e=>{
      const from=this.tree._drag;
      const ext=FileTree._isFileDrag(e);
      if(!from&&!ext) return;
      e.preventDefault(); e.stopPropagation();
      const dir=this._dropDirAt(e.target);
      // FR-ETR-21: `items` 는 **이 tick 안에서만** 살아 있다. 재귀 수집은
      // 비동기라, 걷기 전에 entry 를 전부 꺼내 두지 않으면 중간에 목록이 비어
      // 폴더가 통째로 사라진다 (실측되는 함정이다).
      const entries=ext?FileTree._dropEntries(e):null;
      const files=ext?[...((e.dataTransfer&&e.dataTransfer.files)||[])]:null;
      this.tree._drag=''; this._dropClear();
      EscapeStack.remove(this.tree._dragEsc);
      // 바깥에서 온 파일이 먼저다 — 내부 이동과 겹치는 자리가 없다.
      if(ext){
        this._dropUpload(dir,entries,files);
        return;
      }
      // FR-EMS-24: 선택 전부를 옮긴다. 조상이 함께 선택된 자손은 뺀다 (FR-EMS-22).
      // §3A-5 (T-7.2): 원본 자신·현재 부모 위의 드롭은 그 항목만 건너뛴다(오류 없음).
      const pairs=[];
      for(const src of this.tree.selector._selTargets(from)){
        if(src===dir||this.tree.painter._parent(src)===dir) continue;
        pairs.push([src,this.tree._join(dir,this.tree.painter._base(src))]);
      }
      if(pairs.length===1) this.tree.edits.doRename(pairs[0][0],pairs[0][1]);
      else if(pairs.length) this.tree.edits.doMoveMany(pairs);
    });
    // §3A-5 (T-7.4): 드래그가 어떻게 끝나든(놓기·Esc·밖에 놓기·창 blur) 상태를 반드시
    // 해제한다 — 남은 상태가 이후 다른 드롭에서 파일을 옮기지 않게.
    // Esc 는 EscapeStack 버블 층 항목이 준다 — 전파는 끊지 않는다(REFACTOR3_FE_ESC_SRS FR-FEE-8).
    const endDrag=()=>{
      EscapeStack.remove(this.tree._dragEsc);
      if(!this.tree._drag&&!this.tree._dropDir) return;
      this.tree._drag=''; this._dropClear(); this.tree._paintAll();
    };
    this.tree.el.addEventListener('dragend',endDrag);
    window.addEventListener('blur',endDrag);
  }

  /**
   * FR-ETR-21·22: 드롭된 것을 걸어 `{file, relPath}` 로 편다.
   *
   * 폴더가 하나도 없으면 `files` 로 충분하다 — 재귀를 돌 이유가 없고, entry API
   * 가 없는 브라우저도 그 길로 온다.
   */
  async _dropUpload(dir,entries,files){
    if(!entries){
      if(files&&files.length) this.doUpload(dir,files);
      return;
    }
    const items=[];
    let over=false;
    for(const en of entries){
      if(await FileTree._walkEntry(en,'',items)===false){over=true;break}
    }
    if(over){
      this.tree.painter._fail(dir===this.tree.root?'':dir,
        EDITOR_UPLOAD_TOO_MANY.replace('%n',EDITOR_UPLOAD_MAX_ENTRIES));
      this.tree._paintAll();
      return;
    }
    if(items.length) this.doUpload(dir,items);
  }

  /**
   * 드롭이 향하는 **폴더**. 폴더 행이면 그 폴더, 파일·링크 행이면 그 부모,
   * 헤더와 빈 여백이면 루트다 (FR-FTR-20).
   *
   * 파일 행을 그 부모로 읽는 것은 일반 탐색기의 동작이다 — 받지 않으면 사용자는
   * 목록 한가운데 놓을 자리가 없는 것으로 읽는다.
   */
  _dropDirAt(target){
    const row=target&&target.closest?target.closest('.ed-row[data-path]'):null;
    if(row&&this.tree.list.contains(row)){
      const p=row.dataset.path;
      return row.dataset.kind==='dir'?p:this.tree.painter._parent(p);
    }
    return this.tree.root;
  }

  // 표시는 바뀔 때만 손댄다 — dragover 는 초당 수십 번 온다.
  _markDrop(dir){
    if(this.tree._dropDir===dir) return;
    this.tree._dropDir=dir;
    if(dir) EscapeStack.push(this.tree._dragEsc);   // 바깥에서 온 끌기도 Esc 로 푼다(FR-FEE-8)
    for(const el of this.tree.list.querySelectorAll('.ed-drop')) el.classList.remove('ed-drop');
    this.tree.head.classList.toggle('ed-drop-root',dir===this.tree.root);
    this.tree.list.classList.toggle('ed-drop-root',dir===this.tree.root);
    if(dir===this.tree.root) return;
    for(const el of this.tree.list.querySelectorAll('.ed-row[data-path]')){
      if(el.dataset.path===dir){el.classList.add('ed-drop');break}
    }
  }

  _dropClear(){
    this.tree._dropDir='';
    this._springCancel();
    for(const el of this.tree.list.querySelectorAll('.ed-drop')) el.classList.remove('ed-drop');
    this.tree.head.classList.remove('ed-drop-root');
    this.tree.list.classList.remove('ed-drop-root');
  }

  /**
   * FR-FTR-23: 접힌 폴더 위에 머무르면 펼친다. 그러지 않으면 깊은 곳으로 옮기려면
   * 드래그를 놓고 폴더를 펼친 뒤 다시 잡아야 한다.
   *
   * 펼친 것은 드래그가 끝나도 접지 않는다 — 사용자가 방금 본 것을 되감지 않는다.
   */
  _springSchedule(target){
    const row=target&&target.closest?target.closest('.ed-row[data-kind="dir"]'):null;
    const p=row&&this.tree.list.contains(row)?row.dataset.path:'';
    if(this.tree._springPath===p) return;
    this._springCancel();
    if(!p||this.tree._open.has(p)) return;
    this.tree._springPath=p;
    this.tree._springTimer=TIMERS.after(EDITOR_SPRING_MS,()=>{
      this.tree._springTimer=null; this.tree._springPath='';
      if(!this.tree._open.has(p)) this.tree.selector.toggle(p);
    },{owner:this,label:'spring-open'});
  }

  _springCancel(){
    if(this.tree._springTimer){TIMERS.cancel(this.tree._springTimer);this.tree._springTimer=null}
    this.tree._springPath='';
  }
}
