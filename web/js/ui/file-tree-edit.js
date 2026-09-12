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
    // FR-EXR-30: 메모장에는 폴더가 없다. 진입점마다 막으면 한쪽만 고쳐지므로
    // (이 저장소가 여러 번 겪은 형태다) **여기 한 번**에서 막는다 — 앞으로 생길
    // 진입점도 자동으로 덮인다. 버튼·메뉴를 감추는 것은 그와 별개다 (D-5).
    if(isDir&&this._noDirs()) return;
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
    const pre=from+pathSep(from);
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
    // FR-EMS-7: 집합도 함께 따라간다 — 앵커만 고치면 이름이 바뀐 뒤 화면의
    // 선택과 조작의 대상이 갈린다.
    if(this._selSet&&this._selSet.size)
      this._selSet=new Set([...this._selSet].map(map));
  },

  // 사라진 가지의 캐시·펼침·선택을 거둔다. 남겨 두면 같은 이름이 다시 생겼을 때
  // 낡은 목록이 먼저 보인다.
  _forget(p){
    const pre=p+pathSep(p);
    for(const k of [...this._kids.keys()]) if(k===p||k.startsWith(pre)) this._kids.delete(k);
    for(const v of this.store.views) v._forgetView(p,pre);
  },

  _forgetView(p,pre){
    for(const k of [...this._open]) if(k===p||k.startsWith(pre)) this._open.delete(k);
    if(this._sel===p||this._sel.startsWith(pre)) this._sel='';
    // 사라진 것은 집합에서도 빠진다 (FR-EMS-7).
    if(this._selSet&&this._selSet.size)
      for(const q of [...this._selSet]) if(q===p||q.startsWith(pre)) this._selSet.delete(q);
  },

  // ── 조작 넷 (FR-EDT-88·89·90·91·92) ──

  async doCreate(dir,name,isDir){
    // FR-WBR-1: 지난 실패의 사유는 다음 조작이 **시작될 때** 사라진다.
    this._clearErr();
    const path=this._join(dir,name);
    const snap=this._snap([dir]);
    this._optimAdd(dir,name,isDir);
    this._selOnly(path);
    this._paintAll();
    const r=await this.app.edFs(FS_CREATE_API,{root:this.root,path,dir:!!isDir});
    if(!r.ok){this._restore(snap);this._fail(dir===this.root?'':dir,r.msg);return}
    await this._after([dir]);
    /**
     * FR-EXR-20~24: 만든 **파일**은 곧바로 연다. 진입점(툴바·메뉴·빈 여백
     * 더블클릭)을 가리지 않으려면 여기 한 자리여야 한다.
     *
     * **성공을 확인한 뒤다** (FR-EXR-21) — 위는 응답 전에 먼저 그리고(`_optimAdd`)
     * 실패하면 되돌리므로(`_restore`), 앞에서 열면 없는 파일의 탭이 남는다.
     *
     * 미리보기가 아니라 **고정**이다 (FR-EXR-23 / D-3). 방금 이름까지 지어 준
     * 파일이 다음 클릭에 대체되면 사용자는 만들기가 실패한 것으로 읽는다.
     * 폴더는 열지 않는다 (FR-EXR-22).
     */
    if(!isDir) await this.app.edOpenFile(path,{preview:false});
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
    if(pathUnder(from,to)){this._fail(from,EDITOR_MOVE_INTO_SELF);return}
    const sd=this._parent(from),dd=this._parent(to);
    // FR-FTR-20b: 도착 폴더를 펼친다. 접힌 폴더로 옮기면 옮긴 것이 화면에서
    // 사라지고, 사용자는 잃은 것으로 읽는다 (업로드가 같은 이유로 펼친다).
    if(dd!==this.root&&!this._open.has(dd)) this._open.add(dd);
    const snap=this._snap(sd===dd?[sd]:[sd,dd]);
    this._optimMove(from,to);
    this._selOnly(to);
    this._paintAll();
    const r=await this.app.edFs(FS_RENAME_API,{root:this.root,from,to});
    if(!r.ok){
      this._rekey(to,from);
      this._restore(snap);
      this._fail(from,r.msg);
      return;
    }
    // FR-EDT-90: 열린 탭의 경로와 이름이 따라간다. 폴더면 그 아래 전부다.
    this.app.edRetargetTabs(from,to);
    // FR-EDT-88: 이동이면 출발·도착 **둘 다** 다시 읽는다.
    await this._after(sd===dd?[sd]:[sd,dd]);
  },

  /**
   * FR-EDT-83·84: 영구 삭제. 확인창이 재귀 여부·항목 수·dirty 탭을 밝힌다.
   *
   * 세는 것이 확인창보다 먼저다 — 수를 모른 채 "재귀 삭제합니다" 만 말하면
   * 사용자가 무엇을 잃는지 모른다.
   */
  /**
   * FR-EMS-20~23 (U-5): 대상은 **선택 전부**다. 고른 것이 없으면 인자 하나다.
   *
   * 확인창은 **하나**다 (D-3) — 열 개를 지우는데 창이 열 번 뜨면 사용자는 읽지
   * 않고 누르고, 그 순간 확인창은 방어가 아니라 통과 의식이 된다.
   *
   * 하나가 실패해도 나머지는 계속한다 (`FR-EMS-23`) — 첫 실패에서 멈추면 절반만
   * 지워진 채 이유를 모른다.
   */
  async doDelete(p){
    const targets=this._selTargets(p).filter(x=>x&&x!==this.root);
    if(!targets.length) return;
    this._clearErr();
    // 세는 것이 확인창보다 먼저다. 합산이므로 폴더가 여럿이면 그 합이다.
    let count=null,isDir=false;
    for(const t of targets){
      if(this._kindOf(t)!=='dir') continue;
      isDir=true;
      const c=await this.app.edCountTree(this.root,t);
      if(!c) continue;
      count={n:((count&&count.n)||0)+(c.n||0),more:!!((count&&count.more)||c.more)};
    }
    const dirty=[];
    for(const t of targets) for(const n of this.app.edDirtyUnder(t)) if(!dirty.includes(n)) dirty.push(n);
    if(!await this.app.edConfirmDelete(targets,isDir,count,dirty)) return;

    const dirs=[];
    for(const t of targets){const d=this._parent(t);if(!dirs.includes(d))dirs.push(d)}
    const snap=this._snap(dirs);
    for(const t of targets) this._optimDel(t);
    this._paintAll();
    let failed=null;
    for(const t of targets){
      const r=await this.app.edFs(FS_DELETE_API,{root:this.root,path:t});
      if(!r.ok){failed={path:t,msg:r.msg};continue}
      // FR-EDT-91: 그 파일의 탭을 닫는다. 폴더면 하위 전부. 확인창은 다시 띄우지
      // 않는다 — FR-EDT-84 에서 이미 밝혔다.
      await this.app.edCloseTabsUnder(t);
      this._forget(t);
    }
    if(failed){
      // 하나라도 실패했으면 낙관적 반영을 믿을 수 없다 — 서버의 답으로 다시 읽는다.
      this._restore(snap);
      this._fail(failed.path,failed.msg);
    }
    this._selOnly('');
    await this._after(dirs);
  },

  /**
   * FR-WBR-70: 복사·붙여넣기·복제. 종단은 **하나**다 (`/api/fs/copy`) — 복제는
   * "원본의 형제 자리에 붙여넣기" 이기 때문이다.
   *
   * 낙관적 반영이 **없다.** 최종 이름을 서버가 정하므로(FR-WBR-62·63) 무엇이
   * 생길지 클라이언트가 미리 알 수 없다 — 만들기·이동과 다른 자리다. 대신
   * 응답의 `path` 를 받아 그 자리를 고른다.
   *
   * 루트가 갈려도 된다 (FR-WBR-61) — 복사한 트리의 루트와 붙여넣는 트리의 루트를
   * 둘 다 보낸다. 둘 다 Editor 목록에 있는지는 서버가 본다.
   */
  async doPasteInto(dir){
    const c=this.app.edClipGet();
    if(!c||!dir) return;
    // FR-WBR-1: 지난 실패의 사유는 다음 조작이 시작될 때 사라진다.
    this._clearErr();
    /**
     * `FUI-11`: 잘라내기면 **옮긴다.**
     *
     * 복사+삭제로 흉내 내지 않는다 — 그 둘 사이에서 실패하면 사본 둘이나 아무
     * 것도 없는 상태가 남고, 되돌릴 근거가 클라이언트에 없다. 서버의 `rename`
     * 이 한 연산이며, 루트를 건너는 것도 그쪽이 받는다.
     *
     * 이름은 **원본의 것**이다 (`pathBase`). 복사와 달리 개명하지 않으므로
     * 충돌하면 서버가 거절하고 그 사유가 그 자리에 붙는다 — 옮기려던 자리에
     * 다른 것이 있다는 사실은 사용자가 알아야 한다.
     */
    const r=c.move
      ? await this.app.edFs(FS_RENAME_API,{
        srcRoot:c.root,from:c.path,
        dstRoot:this.root,to:pathJoin(dir,pathBase(c.path)),
      })
      : await this.app.edFs(FS_COPY_API,
        {srcRoot:c.root,src:c.path,dstRoot:this.root,dstDir:dir});
    // FR-WBR-73: 원본이 사라졌으면 그 자리에 사유가 붙는다 (FR-EDT-92 의 규약).
    if(!r.ok){this._fail(dir===this.root?'':dir,r.msg);return}
    if(c.move){
      const to=pathJoin(dir,pathBase(c.path));
      // 옮긴 것의 열린 탭이 새 자리를 가리킨다 (FR-EDT-90 · `doRename` 과 같은 자리).
      this.app.edRetargetTabs(c.path,to);
      // 클립보드를 비운다 — **잘라낸 것은 한 번만 붙는다.** 남겨 두면 다음
      // 붙여넣기가 이미 없는 원본을 찾아 "사라졌다" 로 실패한다.
      this.app.edClipSet(null,null);
      // FR-FTR-20b 와 같은 이유로 도착 폴더를 펼친다 — 접힌 폴더에 놓으면 놓은
      // 것이 화면에서 사라지고 사용자는 실패로 읽는다.
      if(dir!==this.root&&!this._open.has(dir)) this._open.add(dir);
      this._selOnly(to);
      /**
       * FR-EDT-88: 이동이면 **출발·도착 둘 다** 다시 읽는다 (`doRename` 과 같은
       * 규약). 루트를 건넜으면 출발 트리는 **남의 인스턴스**이므로 자기
       * `_after` 로는 닿지 않는다.
       */
      const srcDir=this._parent(c.path);
      if(c.root===this.root){
        await this._after(srcDir===dir?[dir]:[srcDir,dir]);
      }else{
        this.app.edRefreshTreesFor(c.root,srcDir);
        await this._after([dir]);
      }
      return;
    }
    // FR-FTR-20b 와 같은 이유로 도착 폴더를 펼친다 — 접힌 폴더에 만들면 만든
    // 것이 화면에서 사라지고 사용자는 실패로 읽는다.
    if(dir!==this.root&&!this._open.has(dir)) this._open.add(dir);
    const made=(r.data&&r.data.path)||'';
    if(made) this._selOnly(made);
    // FR-WBR-74: 영향받은 것은 **대상 폴더 하나**다 (FR-EDT-88).
    await this._after([dir]);
  },

  // 복제는 원본의 형제 자리에 붙여넣는 것이다 — 클립보드를 거치지 않는다.
  async doDuplicate(p){
    if(!p||p===this.root) return;
    const keep=this.app.edClipGet();
    this.app.edClipSet(this.root,p);
    await this.doPasteInto(this._parent(p));
    // 복제가 사용자의 클립보드를 덮지 않는다 — 그것은 다른 조작이다.
    this.app.edClipSet(keep&&keep.root,keep&&keep.path);
  },

  // ── 전송 (FILE_TRANSFER_SRS FR-FTR-13·14·19 · EXPLORER_TRANSFER_IGNORE_SRS
  //    묶음 B·C·D) ──

});
