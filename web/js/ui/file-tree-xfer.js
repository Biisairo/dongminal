/**
 * FileTree — 파일을 주고받는 일 (FILE_TRANSFER_SRS / SPLIT_REFACTOR_SRS 묶음 C).
 *
 * 내려받기(`download`) · 올리기(`doUpload`·`_uploadOne`·`pickUpload`) · 우클릭
 * 메뉴(`_onCtx`) · 드래그드롭(`_initDnd`·`_dropUpload`·`_spring*`)이 여기 산다.
 *
 * 이것들의 공통점은 **트리 밖과 닿는다**는 것이다 — 사용자의 파일 시스템, 브라우저의
 * DataTransfer, 서버의 업로드 종단. 트리 안에서 끝나는 일과 섞이지 않게 갈랐다.
 *
 * `static` 넷은 prototype 이 아니라 클래스 자체에 붙는다 — 인스턴스 없이 불린다.
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
  download(p){
    if(!p) return;
    const kind=p===this.root?'dir':this._kindOf(p);
    // 링크는 자신을 내려받는다는 뜻이 정해져 있지 않다 (FR-ETR-16).
    if(kind!=='file'&&kind!=='dir') return;
    const dir=kind==='dir';
    const a=document.createElement('a');
    a.href=(dir?FS_DOWNLOAD_DIR_API:FS_DOWNLOAD_API)+
      '?root='+encodeURIComponent(this.root)+'&path='+encodeURIComponent(p);
    a.download=this._base(p)+(dir?'.zip':'');
    document.body.appendChild(a); a.click(); a.remove();
  },

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
    this._clearErr();
    // 올린 것이 보이지 않으면 사용자는 실패로 읽는다.
    if(dir!==this.root&&!this._open.has(dir)) this._open.add(dir);
    this._busy.add(dir); this._paintAll();

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
    this._busy.delete(dir);
    await this._after([dir]);
    // FR-ETR-30: 조용히 끝나면 사용자는 전부 올라간 줄 안다.
    if(!err&&skipped) err=EDITOR_UPLOAD_SKIPPED.replace('%n',skipped);
    if(err) this._fail(dir===this.root?'':dir,err);
  },

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
    const u=FS_UPLOAD_API+'?root='+encodeURIComponent(this.root)+
      '&dir='+encodeURIComponent(dir);
    let r=null,d=null;
    try{r=await fetch(u,{method:'POST',body:fd})}catch{r=null}
    if(r){try{d=await r.json()}catch{d=null}}
    if(r&&r.ok&&d&&d.ok) return '';
    const why=EDITOR_FS_ERR_MSG[(d&&d.code)||'']||(d&&d.message)||'';
    return why||EDITOR_UPLOAD_FAIL.replace('%s',it.relPath||it.file.name);
  },

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
      body:EDITOR_UPLOAD_FAIL_BODY.replace('%s',label).replace('%r',why),
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
  },

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
        this._fail(dir===this.root?'':dir,
          EDITOR_UPLOAD_TOO_MANY.replace('%n',EDITOR_UPLOAD_MAX_ENTRIES));
        this._paintAll();
        return;
      }
      if(files.length) this.doUpload(dir,files);
    });
    // 취소하면 change 가 오지 않는다 — 거두지 않으면 부를 때마다 하나씩 쌓인다.
    inp.addEventListener('cancel',()=>inp.remove());
    document.body.appendChild(inp);
    inp.click();
  },

  // FR-EDT-88·89: 영향받은 폴더**만** 다시 읽고 git 색을 다시 받는다. 트리 전체를
  // 새로 만들지 않는다.
  async _after(dirs){
    this._clearErr();
    for(const d of dirs) await this.load(d);
    // FR-DIR-32: 방금 한 조작의 결과다 — 늦춰 보일 이유가 없다.
    this.pollGit({now:true});
  },

  // ── 진입점 둘 (FR-EDT-80) ──

  _onCtx(e){
    const row=e.target.closest('.ed-row');
    if(!row||!this.list.contains(row)||row.classList.contains('ed-edit')) return;
    e.preventDefault();
    const p=row.dataset.path,kind=row.dataset.kind;
    if(this._edit) this.cancelEdit();
    this._sel=p; this._paintAll();
    // 만드는 자리는 우클릭한 행이 정한다 — 폴더면 그 안, 아니면 그 형제다
    // (FR-EDT-81 과 같은 규칙).
    const dir=kind==='dir'?p:this._parent(p);
    GitMenu.openList([
      {id:'newFile',label:EDITOR_MENU_NEW_FILE,run:()=>this.startCreate(false,dir)},
      {id:'newDir',label:EDITOR_MENU_NEW_DIR,run:()=>this.startCreate(true,dir)},
      // FR-FTR-18: 업로드가 가는 자리도 같은 규칙이다 — 폴더면 그 안, 아니면 형제.
      {id:'upload',label:EDITOR_MENU_UPLOAD,run:()=>this.pickUpload(dir)},
      // FR-ETR-23: 폴더 업로드는 별개의 항목이다 — 한 input 이 두 모드를 겸할 수
      // 없다.
      {id:'uploadDir',label:EDITOR_MENU_UPLOAD_DIR,run:()=>this.pickUpload(dir,true)},
      // FR-FTR-13 / FR-ETR-16: 파일과 폴더에서 활성이고, 폴더는 zip 으로 온다.
      // 링크만 비활성이다 — 링크 자신을 내려받는다는 뜻이 정해져 있지 않다.
      {id:'download',label:EDITOR_MENU_DOWNLOAD,
        disabled:()=>kind==='link'?EDITOR_DOWNLOAD_LINK_NO:'',
        run:()=>this.download(p)},
      {sep:true},
      {id:'rename',label:EDITOR_MENU_RENAME,run:()=>this.startRename(p)},
      // 확인은 `doDelete` 가 한다 — 재귀 여부·항목 수·dirty 탭을 밝혀야 하므로
      // 메뉴의 일반 확인(GitDialog)으로는 FR-EDT-83·84 를 만족하지 못한다.
      {id:'delete',label:EDITOR_MENU_DELETE,run:()=>this.doDelete(p)},
    ],'edfs',p,e);
  },

  /**
   * FR-EDT-85 · FR-FTR-17·20·23: 드래그. 상태는 **이 인스턴스**가 쥔다 —
   * `app._drag` 는 탭 이동의 것이고(renderer.js) 거기 끼어들면 pane 이 이 드래그를
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
    this.list.addEventListener('dragstart',e=>{
      const row=e.target.closest('.ed-row[data-path]');
      if(!row||row.classList.contains('ed-edit')){e.preventDefault();return}
      this._drag=row.dataset.path;
      e.dataTransfer.effectAllowed='move';
      // 데이터가 없으면 일부 브라우저가 드래그를 시작조차 하지 않는다.
      e.dataTransfer.setData('text/plain',this._drag);
    });
    this.el.addEventListener('dragover',e=>{
      const ext=FileTree._isFileDrag(e);
      if(!this._drag&&!ext) return;
      e.preventDefault(); e.stopPropagation();
      e.dataTransfer.dropEffect=ext?'copy':'move';
      this._markDrop(this._dropDirAt(e.target));
      this._springSchedule(e.target);
    });
    // 탐색기 **바깥**으로 나갈 때만 지운다. 행에서 행으로 옮길 때마다 지우면
    // 표시가 깜빡이고, 그 사이의 drop 이 대상을 잃는다.
    this.el.addEventListener('dragleave',e=>{
      if(e.relatedTarget&&this.el.contains(e.relatedTarget)) return;
      this._dropClear();
    });
    this.el.addEventListener('drop',e=>{
      const from=this._drag;
      const ext=FileTree._isFileDrag(e);
      if(!from&&!ext) return;
      e.preventDefault(); e.stopPropagation();
      const dir=this._dropDirAt(e.target);
      // FR-ETR-21: `items` 는 **이 tick 안에서만** 살아 있다. 재귀 수집은
      // 비동기라, 걷기 전에 entry 를 전부 꺼내 두지 않으면 중간에 목록이 비어
      // 폴더가 통째로 사라진다 (실측되는 함정이다).
      const entries=ext?FileTree._dropEntries(e):null;
      const files=ext?[...((e.dataTransfer&&e.dataTransfer.files)||[])]:null;
      this._drag=''; this._dropClear();
      // 바깥에서 온 파일이 먼저다 — 내부 이동과 겹치는 자리가 없다.
      if(ext){
        this._dropUpload(dir,entries,files);
        return;
      }
      // 이미 그 폴더에 있으면 아무 일도 아니다 — 서버에 묻지 않는다 (FR-FTR-21).
      if(this._parent(from)===dir) return;
      this.doRename(from,this._join(dir,this._base(from)));
    });
    this.el.addEventListener('dragend',()=>{this._drag='';this._dropClear()});
  },

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
      this._fail(dir===this.root?'':dir,
        EDITOR_UPLOAD_TOO_MANY.replace('%n',EDITOR_UPLOAD_MAX_ENTRIES));
      this._paintAll();
      return;
    }
    if(items.length) this.doUpload(dir,items);
  },

  /**
   * 드롭이 향하는 **폴더**. 폴더 행이면 그 폴더, 파일·링크 행이면 그 부모,
   * 헤더와 빈 여백이면 루트다 (FR-FTR-20).
   *
   * 파일 행을 그 부모로 읽는 것은 일반 탐색기의 동작이다 — 받지 않으면 사용자는
   * 목록 한가운데 놓을 자리가 없는 것으로 읽는다.
   */
  _dropDirAt(target){
    const row=target&&target.closest?target.closest('.ed-row[data-path]'):null;
    if(row&&this.list.contains(row)){
      const p=row.dataset.path;
      return row.dataset.kind==='dir'?p:this._parent(p);
    }
    return this.root;
  },

  // 표시는 바뀔 때만 손댄다 — dragover 는 초당 수십 번 온다.
  _markDrop(dir){
    if(this._dropDir===dir) return;
    this._dropDir=dir;
    for(const el of this.list.querySelectorAll('.ed-drop')) el.classList.remove('ed-drop');
    this.head.classList.toggle('ed-drop-root',dir===this.root);
    this.list.classList.toggle('ed-drop-root',dir===this.root);
    if(dir===this.root) return;
    for(const el of this.list.querySelectorAll('.ed-row[data-path]')){
      if(el.dataset.path===dir){el.classList.add('ed-drop');break}
    }
  },

  _dropClear(){
    this._dropDir='';
    this._springCancel();
    for(const el of this.list.querySelectorAll('.ed-drop')) el.classList.remove('ed-drop');
    this.head.classList.remove('ed-drop-root');
    this.list.classList.remove('ed-drop-root');
  },

  /**
   * FR-FTR-23: 접힌 폴더 위에 머무르면 펼친다. 그러지 않으면 깊은 곳으로 옮기려면
   * 드래그를 놓고 폴더를 펼친 뒤 다시 잡아야 한다.
   *
   * 펼친 것은 드래그가 끝나도 접지 않는다 — 사용자가 방금 본 것을 되감지 않는다.
   */
  _springSchedule(target){
    const row=target&&target.closest?target.closest('.ed-row[data-kind="dir"]'):null;
    const p=row&&this.list.contains(row)?row.dataset.path:'';
    if(this._springPath===p) return;
    this._springCancel();
    if(!p||this._open.has(p)) return;
    this._springPath=p;
    this._springTimer=setTimeout(()=>{
      this._springTimer=null; this._springPath='';
      if(!this._open.has(p)) this.toggle(p);
    },EDITOR_SPRING_MS);
  },

  _springCancel(){
    if(this._springTimer){clearTimeout(this._springTimer);this._springTimer=null}
    this._springPath='';
  },
});

Object.assign(FileTree, {
  /**
   * 입력을 `{file, relPath}` 로 고른다. `File` 배열(파일 여럿 고르기)과 이미
   * 상대경로가 붙은 항목(폴더 드롭·폴더 고르기) 둘을 같은 자리에서 받는다 —
   * 부르는 곳이 셋이라 형식 판정이 흩어지면 한 곳만 고쳐진다.
   */
  _asUploadItems(items){
    if(!Array.isArray(items)) return [];
    return items.map(x=>{
      if(!x) return null;
      if(x.file) return {file:x.file,relPath:x.relPath||''};
      // <input webkitdirectory> 는 File 에 webkitRelativePath 를 실어 준다.
      return {file:x,relPath:x.webkitRelativePath||''};
    }).filter(Boolean);
  },

  // 바깥에서 온 파일인가. 내부 이동은 `text/plain` 만 싣는다.
  _isFileDrag(e){
    const t=e.dataTransfer&&e.dataTransfer.types;
    return !!t&&[...t].includes('Files');
  },

  /**
   * FR-EDT-21: 드롭된 최상위 entry 들. **동기적으로** 꺼낸다 — `dataTransfer` 의
   * `items` 는 이벤트 핸들러가 끝나면 비워지므로, 재귀(비동기) 안에서 꺼내면
   * 아무것도 없다.
   *
   * `webkitGetAsEntry` 가 없는 브라우저에서는 null 이고, 그때는 `files` 로
   * 폴백한다 — 폴더는 못 올리지만 파일은 올라간다.
   */
  _dropEntries(e){
    const items=(e.dataTransfer&&e.dataTransfer.items)||null;
    if(!items||!items.length) return null;
    const out=[];
    // `DataTransferItemList` 는 배열이 아니다 — 인덱스로 읽는다.
    for(let i=0;i<items.length;i++){
      const it=items[i];
      if(!it||it.kind!=='file'||typeof it.webkitGetAsEntry!=='function') continue;
      const en=it.webkitGetAsEntry();
      if(en) out.push(en);
    }
    return out.length?out:null;
  },

  /**
   * entry 하나를 걷는다. 파일이면 담고 디렉터리면 그 안으로 내려간다.
   * 상한을 넘으면 `false` 를 돌려 **걷기 자체를 멈춘다** (FR-ETR-22) — 홈 폴더를
   * 잘못 놓았을 때 브라우저가 멎지 않아야 한다.
   *
   * `readEntries` 는 한 번에 전부 주지 않는다. 빈 배열이 올 때까지 되풀이해야
   * 하며, 그러지 않으면 항목이 100개쯤에서 잘린다 (Chrome 의 실제 동작이다).
   */
  async _walkEntry(en,prefix,out){
    if(!en) return true;
    if(out.length>=EDITOR_UPLOAD_MAX_ENTRIES) return false;
    const rel=prefix?prefix+'/'+en.name:en.name;
    if(en.isFile){
      const f=await new Promise(res=>en.file(res,()=>res(null)));
      // 읽지 못한 항목은 건너뛴다. 드롭한 것 중 하나를 못 읽었다고 나머지를
      // 버리지 않는다 — 실패는 업로드 단계에서 사용자에게 묻는다 (FR-ETR-26).
      if(f) out.push({file:f,relPath:rel});
      return true;
    }
    if(!en.isDirectory) return true;
    const reader=en.createReader();
    for(;;){
      const batch=await new Promise(res=>reader.readEntries(res,()=>res([])));
      if(!batch||!batch.length) return true;
      for(const child of batch){
        if(await FileTree._walkEntry(child,rel,out)===false) return false;
      }
    }
  },
});
