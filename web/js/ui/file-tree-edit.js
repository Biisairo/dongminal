/**
 * FileTree — 파일 조작 (FR-EDT-79~92 / SPLIT_REFACTOR_SRS 묶음 C).
 *
 * 인라인 입력(`startCreate`·`startRename`)과 그 커밋(`_commitEdit`), 서버 호출
 * (`doCreate`·`doRename`·`doDelete`), 그리고 **응답을 기다리지 않고 먼저 그리는**
 * 낙관적 갱신(`_optim*`·`_rekey`·`_forget`)이 여기 산다.
 *
 * 낙관적 갱신이 조회와 같은 파일에 있으면 "지금 보이는 것" 과 "곧 보일 것" 이
 * 뒤섞인다 — 그래서 갈랐다.
 */
Object.assign(FileTree.prototype, {
  startCreate(isDir,at){
    const d=at||this._targetDir();
    this._clearErr();
    // 입력 행이 그 폴더 안에 보이려면 폴더가 펼쳐져 있어야 한다.
    if(d!==this.root&&!this._open.has(d)){
      this._open.add(d);
      if(!this._kids.has(d)) this.load(d);
    }
    this._edit={mode:'create',dir:d,path:'',isDir:!!isDir,init:''};
    this._focusEdit=true;
    this._paintAll();
  },

  startRename(p){
    if(!p||p===this.root) return;
    this._clearErr();
    this._edit={mode:'rename',dir:this._parent(p),path:p,
      isDir:this._kindOf(p)==='dir',init:this._base(p)};
    this._focusEdit=true;
    this._paintAll();
  },

  cancelEdit(){
    if(!this._edit) return;
    this._edit=null; this._clearErr(); this._paintAll();
  },

  // 이름을 받아 조작으로 넘긴다. 빈 이름은 취소이고, `/` 는 서버에 묻지 않고
  // 그 자리에서 막는다 — 이름 하나를 받는 자리에 경로가 들어오면 그것은 오타다.
  _commitEdit(raw){
    const e=this._edit; if(!e) return;
    const name=String(raw||'').trim();
    if(!name){this.cancelEdit();return}
    if(name.includes('/')){this._fail('input',EDITOR_NAME_INVALID);return}
    if(e.mode==='rename'){
      if(name===e.init){this.cancelEdit();return}
      this._edit=null; this._clearErr();
      this.doRename(e.path,this._join(e.dir,name));
      return;
    }
    this._edit=null; this._clearErr();
    this.doCreate(e.dir,name,e.isDir);
  },

  // ── 낙관적 반영과 되돌리기 (FR-EDT-92) ──

  // 조작 전의 캐시를 뜬다. 되돌릴 근거는 이것 하나다 — 실패마다 다시 읽으면
  // 사라진 행이 잠깐 살아 있는 화면이 생긴다.
  _snap(dirs){
    const m=new Map();
    for(const d of dirs){
      const st=this._kids.get(d);
      m.set(d,st?{entries:st.entries.slice(),truncated:st.truncated,err:st.err}:null);
    }
    return m;
  },

  _restore(snap){
    for(const [d,st] of snap){
      if(st) this._kids.set(d,st); else this._kids.delete(d);
    }
    this._paintAll();
  },

  // 아직 서버가 모르는 항목을 **끝에** 붙인다. 순서는 서버가 정하므로(D-20)
  // 여기서 자리를 맞추지 않는다 — 다시 읽으면 제자리로 간다 (FR-EDT-88).
  _optimAdd(dir,name,isDir){
    const st=this._kids.get(dir);
    if(!st) return;
    st.entries=st.entries.concat([{name,dir:!!isDir,link:false,linkDir:false}]);
  },

  _optimDel(p){
    const st=this._kids.get(this._parent(p));
    if(!st) return;
    const n=this._base(p);
    st.entries=st.entries.filter(e=>!e||e.name!==n);
  },

  /**
   * 이름 변경·이동의 낙관적 반영. 출발지에서 빼고 도착지에 넣는다.
   *
   * 옮겨진 폴더의 **하위 캐시·펼침·선택도 접두사를 갈아탄다** — 그러지 않으면
   * 펼쳐 놓은 폴더가 이동 한 번에 접히고, 사용자는 트리를 잃은 것으로 읽는다.
   */
  _optimMove(from,to){
    const e=(this._kids.get(this._parent(from))||{entries:[]})
      .entries.find(x=>x&&x.name===this._base(from));
    this._optimDel(from);
    this._optimAdd(this._parent(to),this._base(to),!!(e&&e.dir));
    this._rekey(from,to);
  },

  _rekey(from,to){
    const pre=from+'/';
    const map=p=>p===from?to:(p.startsWith(pre)?to+p.slice(from.length):p);
    // 캐시는 공유다 — 한 번만 갈아탄다.
    const kids=new Map();
    for(const [k,v] of this._kids) kids.set(map(k),v);
    this._kids=kids;
    // 펼침·선택은 칸마다 있다. **보는 칸 전부**가 갈아타야 한다 (FR-SVS-21) —
    // 조작한 칸만 갈아타면 다른 칸의 펼침이 옛 경로를 가리켜 그 가지가 접힌다.
    for(const v of this.store.views) v._rekeyView(map);
  },

  _rekeyView(map){
    const open=new Set();
    for(const p of this._open) open.add(map(p));
    this._open=open;
    if(this._sel) this._sel=map(this._sel);
  },

  // 사라진 가지의 캐시·펼침·선택을 거둔다. 남겨 두면 같은 이름이 다시 생겼을 때
  // 낡은 목록이 먼저 보인다.
  _forget(p){
    const pre=p+'/';
    for(const k of [...this._kids.keys()]) if(k===p||k.startsWith(pre)) this._kids.delete(k);
    for(const v of this.store.views) v._forgetView(p,pre);
  },

  _forgetView(p,pre){
    for(const k of [...this._open]) if(k===p||k.startsWith(pre)) this._open.delete(k);
    if(this._sel===p||this._sel.startsWith(pre)) this._sel='';
  },

  // ── 조작 넷 (FR-EDT-88·89·90·91·92) ──

  async doCreate(dir,name,isDir){
    // FR-WBR-1: 지난 실패의 사유는 다음 조작이 **시작될 때** 사라진다.
    this._clearErr();
    const path=this._join(dir,name);
    const snap=this._snap([dir]);
    this._optimAdd(dir,name,isDir);
    this._sel=path;
    this._paintAll();
    const r=await this.app._edFs(FS_CREATE_API,{root:this.root,path,dir:!!isDir});
    if(!r.ok){this._restore(snap);this._fail(dir===this.root?'':dir,r.msg);return}
    await this._after([dir]);
  },

  /**
   * 이름 변경과 이동은 같은 조작이다 (FR-EDT-109) — 다른 것은 `to` 의 부모뿐이다.
   *
   * 같은 이름이 있으면 **서버가 거부한다** (FR-EDT-86·115). 덮어쓰기도 자동 개명도
   * 여기에 없다.
   */
  async doRename(from,to){
    if(!from||!to||from===to) return;
    // FR-WBR-1·4: 끌어 옮기는 길(`file-tree-xfer`)은 `_commitEdit` 를 지나지
    // 않으므로 여기가 그 조작의 시작이다.
    this._clearErr();
    // FR-EDT-85: 자기 자신·자기 하위로는 옮길 수 없다. 서버의 rename 은 이것을
    // 성공시키고 트리를 통째로 잃어버리므로 클라이언트가 막는 유일한 자리다.
    if(to===from||to.startsWith(from+'/')){this._fail(from,EDITOR_MOVE_INTO_SELF);return}
    const sd=this._parent(from),dd=this._parent(to);
    // FR-FTR-20b: 도착 폴더를 펼친다. 접힌 폴더로 옮기면 옮긴 것이 화면에서
    // 사라지고, 사용자는 잃은 것으로 읽는다 (업로드가 같은 이유로 펼친다).
    if(dd!==this.root&&!this._open.has(dd)) this._open.add(dd);
    const snap=this._snap(sd===dd?[sd]:[sd,dd]);
    this._optimMove(from,to);
    this._sel=to;
    this._paintAll();
    const r=await this.app._edFs(FS_RENAME_API,{root:this.root,from,to});
    if(!r.ok){
      this._rekey(to,from);
      this._restore(snap);
      this._fail(from,r.msg);
      return;
    }
    // FR-EDT-90: 열린 탭의 경로와 이름이 따라간다. 폴더면 그 아래 전부다.
    this.app._edRetargetTabs(from,to);
    // FR-EDT-88: 이동이면 출발·도착 **둘 다** 다시 읽는다.
    await this._after(sd===dd?[sd]:[sd,dd]);
  },

  /**
   * FR-EDT-83·84: 영구 삭제. 확인창이 재귀 여부·항목 수·dirty 탭을 밝힌다.
   *
   * 세는 것이 확인창보다 먼저다 — 수를 모른 채 "재귀 삭제합니다" 만 말하면
   * 사용자가 무엇을 잃는지 모른다.
   */
  async doDelete(p){
    if(!p||p===this.root) return;
    this._clearErr();
    const isDir=this._kindOf(p)==='dir';
    const count=isDir?await this.app._edCountTree(this.root,p):null;
    const dirty=this.app._edDirtyUnder(p);
    if(!await this.app._edConfirmDelete(p,isDir,count,dirty)) return;
    const d=this._parent(p);
    const snap=this._snap([d]);
    this._optimDel(p);
    this._paintAll();
    const r=await this.app._edFs(FS_DELETE_API,{root:this.root,path:p});
    if(!r.ok){this._restore(snap);this._fail(p,r.msg);return}
    // FR-EDT-91: 그 파일의 탭을 닫는다. 폴더면 하위 전부. 확인창은 다시 띄우지
    // 않는다 — FR-EDT-84 에서 이미 밝혔다.
    await this.app._edCloseTabsUnder(p);
    this._forget(p);
    await this._after([d]);
  },

  // ── 전송 (FILE_TRANSFER_SRS FR-FTR-13·14·19 · EXPLORER_TRANSFER_IGNORE_SRS
  //    묶음 B·C·D) ──

});
