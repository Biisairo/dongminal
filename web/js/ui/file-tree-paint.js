/**
 * FileTree — 조회와 그리기 (SPLIT_REFACTOR_SRS 묶음 C).
 *
 * 서버에서 한 겹을 받아(`load`) git 색을 입히고(`pollGit`) 무시된 이름을 가려
 * (`loadIgnored`), 펼침 상태를 평평한 목록으로 접은 뒤(`_items`) 그린다(`paint`).
 *
 * 이 파일이 대답하는 질문은 **"지금 무엇이 보이는가"** 다. 그것을 바꾸는 일
 * (생성·이름변경·삭제)은 file-tree-edit.js, 파일을 주고받는 일은 file-tree-xfer.js 다.
 */
Object.assign(FileTree.prototype, {
  /**
   * 한 겹만 읽는다 (FR-EDT-59). 실패는 그 폴더의 캐시에만 남으므로 트리의 나머지는
   * 그대로다 (FR-EDT-63).
   */
  async load(dir){
    if(this._busy.has(dir)) return;
    this._busy.add(dir); this._paintAll();
    const u=FS_LIST_API+'?root='+encodeURIComponent(this.root)+'&path='+encodeURIComponent(dir);
    let r=null,d=null;
    try{r=await fetch(u)}catch{r=null}
    if(r){try{d=await r.json()}catch{d=null}}
    this._busy.delete(dir);
    if(!r||!r.ok){
      this._kids.set(dir,{entries:[],truncated:false,err:(d&&d.code)||EDITOR_TREE_ERR});
      // 읽지 못한 겹의 스탬프는 근거가 없다. 남겨 두면 다음 폴링이 "안 바뀌었다"
      // 로 읽어 실패한 겹을 영영 다시 읽지 않는다.
      this._stamps.delete(dir);
    }else{
      this._kids.set(dir,{
        // 순서는 서버가 정한다 (D-20) — 여기서 다시 정렬하면 잘림의 경계가
        // 요청마다 달라진다 (FR-EDT-61·65).
        entries:Array.isArray(d.entries)?d.entries:[],
        truncated:!!d.truncated, err:'',
      });
      // NOTES_LIVE_EXPLORER_SRS FR-FSL-10: 방금 읽은 목록과 **같은 관측**의
      // 스탬프를 기억한다. 폴링에서만 채우면 그 사이의 변경이 "처음 본 겹" 으로
      // 삼켜져 영영 재조회되지 않는다.
      if(typeof d.stamp==='string'&&d.stamp) this._stamps.set(dir,d.stamp);
      else this._stamps.delete(dir);
    }
    this._paintAll();
    // FR-ETR-5: 겹을 읽은 **뒤에** 그 겹의 이름들로 한 번 묻는다. 목록보다 먼저
    // 물으면 무엇을 물어야 할지 모른다.
    this.loadIgnored(dir);
  },

  /**
   * FR-ETR-5·6: 한 겹의 무시 여부를 묻는다.
   *
   * **무시된 폴더의 하위는 묻지 않는다.** `gitignore(5)` 가 "제외된 부모 아래의
   * 파일은 다시 포함될 수 없다" 고 못박으므로 그 생략은 판정을 바꾸지 않는다
   * (D-2). 이것이 없으면 `node_modules` 를 펼칠 때마다 프로세스가 뜬다.
   */
  async loadIgnored(dir){
    if(this._ignOff||!this.root) return;
    const st=this._kids.get(dir);
    if(!st||!st.entries.length) return;
    // 부모가 무시면 이 겹 전부가 무시다 — 서버에 묻지 않는다.
    if(this._isIgnored(dir)){
      this._ign.set(dir,new Set(st.entries.map(e=>e&&e.name).filter(Boolean)));
      this._paintAll();
      return;
    }
    const names=st.entries.map(e=>e&&e.name).filter(Boolean);
    let r=null,d=null;
    try{
      r=await fetch(FS_IGNORED_API,{method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({root:this.root,dir,names})});
    }catch{r=null}
    if(r){try{d=await r.json()}catch{d=null}}
    if(!r) return;   // 전송 실패는 판정이 아니다 — 다음 기회에 다시 묻는다
    // FR-ETR-4: 4xx 는 "이 경로로는 물을 수 없다" 는 서버의 답이다. 굳히지
    // 않으면 겹을 펼칠 때마다 영영 묻는다 (`pollGit` 의 `_gitOff` 와 같은 관례).
    if(!r.ok){
      if(r.status>=400&&r.status<500){this._ignOff=true;this._ign.clear();this._paintAll()}
      return;
    }
    if(!d||!Array.isArray(d.ignored)) return;
    this._ign.set(dir,new Set(d.ignored));
    this._paintAll();
  },

  // FR-ETR-7: 이 경로가 무시되었는가. 판정은 **그 겹의 답**에 있다 — 부모가
  // 무시면 loadIgnored 가 자식 전부를 그 겹의 Set 에 넣어 두었다.
  _isIgnored(p){
    if(p===this.root) return false;
    const s=this._ign.get(this._parent(p));
    return !!(s&&s.has(this._base(p)));
  },

  // FR-EDT-64: **펼쳐져 있는 폴더만** 다시 읽는다. 펼침은 보존된다.
  refresh(){
    this.load(this.root);
    for(const p of this._open) this.load(p);
  },

  /**
   * 이 경로가 트리에 **보이게** 한다 — 조상 폴더를 루트까지 펼치고, 아직 읽지
   * 않은 겹은 읽고, 그 행으로 스크롤한다.
   *
   * 검색으로 연 파일이 트리 어디에 있는지는 그 자체가 답의 일부다. 파일만 열고
   * 탐색기를 그대로 두면 사용자가 경로를 눈으로 따라가며 폴더를 하나씩 펼쳐야
   * 한다 — 검색이 방금 알려 준 것을 손으로 다시 찾는 셈이다.
   *
   * 겹은 **순차로** 읽는다. 병렬로 던지면 각 응답의 paint 가 서로를 덮어 중간
   * 상태가 깜빡인다. 펼친 것은 되접지 않는다 (`_springSchedule` 과 같은 근거).
   */
  async revealPath(p){
    if(!p||!this.root) return;
    const root=String(this.root).replace(/\/+$/,'');
    if(p!==root&&!String(p).startsWith(root+'/')) return;   // 이 트리의 것이 아니다
    // 부모부터 위로 훑어 루트 바로 아래까지 모은다. 상한을 두는 이유는 `_parent`
    // 가 최상위에서 `'/'` 를 내기 때문이다 — 루트가 `'/'` 면 멈추지 않는다.
    const chain=[];
    let d=this._parent(p);
    for(let i=0;i<EDITOR_TREE_REVEAL_MAX&&d&&d!==root&&d.startsWith(root+'/');i++){
      chain.unshift(d);
      d=this._parent(d);
    }
    for(const dir of chain){
      this._open.add(dir);
      if(!this._kids.has(dir)) await this.load(dir);
    }
    this._sel=p;
    this._paintAll();
    const row=this.list.querySelector('.ed-row.sel');
    if(row&&row.scrollIntoView) row.scrollIntoView({block:'nearest'});
  },

  toggle(p){
    if(this._open.has(p)){this._open.delete(p);this._paintAll();return}
    this._open.add(p);
    this._paintAll();
    // 이미 읽어 둔 폴더는 다시 묻지 않는다 — 갱신의 계기는 FR-EDT-67 의 셋뿐이다.
    if(!this._kids.has(p)) this.load(p);
  },

  _onClick(e){
    // 인라인 입력 자신을 누른 것은 행 선택이 아니다 — 캐럿을 옮기는 중이다.
    if(e.target.closest('.ed-edit')) return;
    const row=e.target.closest('.ed-row');
    if(!row||!this.list.contains(row)) return;
    // 다른 자리를 누르면 쓰다 만 이름은 버린다. 커밋하지 않는 이유는 클릭 한 번이
    // 파일을 만드는 것보다 잃는 쪽이 안전하기 때문이다 (FR-GIT-97 과 같은 근거).
    if(this._edit) this.cancelEdit();
    const p=row.dataset.path,kind=row.dataset.kind;
    this._sel=p;
    // FR-EDT-60: 링크는 펼치지도 열지도 않는다 — 선택만 바뀐다. 링크된 디렉터리를
    // 파일로 취급하면 `apiFileRead` 가 not a file 400 을 낸다 (§2.6).
    if(kind==='dir') this.toggle(p);
    else if(kind==='file') this.app._edOpenFile(p);
    else this._paintAll();
  },

  // ── 겹의 변경 감지 (NOTES_LIVE_EXPLORER_SRS 묶음 L / FR-FSL-6~14) ──

  /**
   * FR-FSL-8: 지금 화면이 딛고 있는 겹들 — 루트와 펼쳐진 폴더들이다.
   *
   * `_kids` 를 근거로 삼되 `_open` 으로 거른다. 접힌 폴더는 캐시가 남아 있어도
   * 화면에 없으므로 물을 이유가 없고, 그것을 묻기 시작하면 사용자가 한 번
   * 펼쳤다 접은 폴더가 영영 관측 대상으로 남는다.
   */
  _stampDirs(){
    const out=[this.root];
    for(const p of this._open) if(this._kids.has(p)) out.push(p);
    // FR-FSL-5: 서버의 상한과 같은 값으로 먼저 자른다. 넘겨 보내면 서버가
    // 요청 전체를 거절하므로 관측이 통째로 멎는다 — 일부만 보는 편이 낫다.
    return out.length>FS_STAMP_MAX?out.slice(0,FS_STAMP_MAX):out;
  },

  /**
   * FR-FSL-7·9: 겹들이 바뀌었는지 한 번에 묻고, **달라진 겹만** 다시 읽는다.
   *
   * 이것이 "펼친 폴더 전부 재조회" 와 갈리는 자리다 — 요청 수가 겹의 수가 아니라
   * **변경의 수**에 비례한다. 아무것도 바뀌지 않은 주기에는 이 요청 하나가
   * 전부다.
   *
   * git 과 무관하다 (FR-FSL-13). 저장소가 아닌 루트에서도, `_gitOff` 로 색이
   * 굳은 루트에서도 목록은 따라간다 — 메모 루트가 바로 그런 루트다.
   */
  async pollStamp(){
    if(this._stampOff||this._stampBusy||!this.root) return;
    const dirs=this._stampDirs();
    if(!dirs.length) return;
    this._stampBusy=true;
    let r=null,d=null;
    try{
      r=await fetch(FS_STAMP_API,{method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({root:this.root,dirs})});
    }catch{r=null}
    if(r){try{d=await r.json()}catch{d=null}}
    this._stampBusy=false;
    if(!r) return;   // 전송 실패는 판정이 아니다 — 다음 회차에 다시 묻는다
    // FR-FSL-12: 4xx 는 "이 루트로는 물을 수 없다" 는 서버의 답이다. 종단이
    // 아예 없는 옛 서버도 여기로 온다 (404). 5xx 는 서버 쪽 사정이므로 굳히지
    // 않는다 — `pollGit` 과 같은 관례이되, git 없음을 뜻하는 503 이 여기에는
    // 없으므로 그 예외도 없다.
    if(!r.ok){
      if(r.status>=400&&r.status<500) this._stampOff=true;
      return;
    }
    const st=d&&d.stamps;
    if(!st||typeof st!=='object') return;
    const stale=[];
    for(const dir of dirs){
      const now=st[dir];
      // FR-FSL-11: 응답에서 빠진 겹은 기억에서도 지운다. 사라진 폴더가 다시
      // 생기면 그때는 "처음 본 겹" 이다.
      if(typeof now!=='string'){this._stamps.delete(dir);continue}
      const had=this._stamps.has(dir);
      const was=this._stamps.get(dir);
      this._stamps.set(dir,now);
      // FR-FSL-10: 처음 본 겹은 재조회하지 않는다 — 방금 읽어 온 겹을 곧바로
      // 다시 읽는 것이 되기 때문이다. 값만 기억한다.
      if(had&&was!==now) stale.push(dir);
    }
    // 순차로 읽는다. 병렬로 던지면 각 응답의 paint 가 서로를 덮어 중간 상태가
    // 깜빡인다 (`revealPath` 와 같은 근거).
    for(const dir of stale) await this.load(dir);
  },

  // ── git 색 (FR-EDT-69~78) ──

  /**
   * FR-EDT-69·71: 근거는 `status` 하나다. 응답의 `repo` 가 루트와 다르면 루트는
   * 저장소의 **루트**가 아니므로 색을 입히지 않는다.
   *
   * 판정은 한 번이고 결과는 인스턴스가 기억한다 — 다만 **확정은 서버가 "이 루트는
   * 저장소가 아니다" 라고 답했을 때뿐**이다. 전송 실패와 5xx 는 판정이 아니라
   * 이번 회차를 건너뛰는 사유다 — 한 번 끊겼다고 창의 색이 영영 죽으면 안 된다.
   */
  async pollGit(){
    if(this._gitOff||this._gitBusy||!this.root) return;
    this._gitBusy=true;
    let r=null,d=null;
    try{r=await fetch(GIT_STATUS_API+'?repo='+encodeURIComponent(this.root))}catch{r=null}
    if(r){try{d=await r.json()}catch{d=null}}
    this._gitBusy=false;
    if(!r) return;
    // 4xx 는 "이 경로로는 저장소를 물을 수 없다" 는 서버의 답이다 (not_repo 는
    // 404). 503 도 답이다 — git 자체가 없다는 뜻이라 다시 물어도 같고, 그대로
    // 두면 3초마다 영영 묻는다. Git 패널이 503 을 `_gitOff` 로 굳히는 것과 같은
    // 관례다 (`app-git.js:264`). 그 밖의 5xx·게이트웨이 실패는 서버 쪽 사정이므로
    // 다음 회차에 다시 묻는다.
    if(!r.ok){
      if((r.status>=400&&r.status<500)||r.status===503){this._gitOff=true;this._setStatus(null)}
      return;
    }
    // 200 인데 본문을 읽지 못한 것은 답이 아니다 — 중간의 프록시일 수 있으므로
    // 건너뛴다. 루트가 다르다는 답만이 "여기는 저장소의 루트가 아니다" 이다.
    if(!d) return;
    if(d.repo!==this.root){this._gitOff=true;this._setStatus(null);return}
    this._setStatus(d.status);
  },

  /**
   * 상태 응답을 경로→문자 맵 둘로 옮긴다.
   *
   * FR-EDT-72: staged 와 unstaged 를 함께 가진 파일은 **unstaged 쪽 문자**를 쓴다 —
   * 나중에 놓는 쪽이 이긴다. 충돌은 그 위에 온다 (먼저 손봐야 하는 상태다).
   */
  _setStatus(st){
    const m=new Map();
    const put=(arr,ch)=>{
      for(const e of arr||[]){
        const c=ch(e);
        // '.' 는 porcelain 의 "변화 없음" 이다 — 상태가 아니다.
        if(e&&e.path&&c&&c!=='.') m.set(e.path,c);
      }
    };
    put(st&&st.staged,e=>(e.xy||'..')[0]);
    put(st&&st.changes,e=>(e.xy||'..')[1]);
    put(st&&st.untracked,()=>'?');
    put(st&&st.conflicts,()=>'U');
    this._st=m;
    // FR-GIT-190: staged 와 unstaged 를 함께 가진 파일. **Git 패널이 이것을
    // 상태색보다 앞세워 `--attn` 으로 칠하므로 탐색기도 같아야 한다** — 같은
    // 사실을 두 화면이 다른 색으로 말하지 않는다 (FR-STC-1 의 근거).
    // FR-EDT-72 는 **문자**의 규칙이고 이것은 **색**의 규칙이라 서로 다르다.
    this._partial=new Set();
    for(const e of (st&&st.staged)||[]){
      if(e&&e.path&&e.staged&&e.unstaged) this._partial.add(e.path);
    }
    this._dirSt=this._rollup(m);
    this._paintAll();
  },

  /**
   * FR-EDT-73·74: 폴더는 하위의 상태를 접어 올린다. 근거가 `status` 의 경로들이므로
   * **펼쳐지지 않은 폴더에도** 색이 나온다.
   *
   * 우선순위는 `EDITOR_TREE_ST_RANK` 하나가 정하고 표에 없는 문자(D 포함)는
   * 전파하지 않는다 (D-5).
   */
  _rollup(m){
    const out=new Map();
    for(const [p,ch] of m){
      const rk=EDITOR_TREE_ST_RANK[ch];
      if(!rk) continue;
      for(let i=p.lastIndexOf('/');i>0;i=p.lastIndexOf('/',i-1)){
        const dir=p.slice(0,i);
        const cur=out.get(dir);
        if(cur&&EDITOR_TREE_ST_RANK[cur]>=rk) break;
        out.set(dir,ch);
      }
    }
    return out;
  },

  // FR-GIT-190: 일부만 스테이지된 파일인가. 폴더에는 뜻이 없다 — 파일 하나의
  // 사실이므로 접어 올리지 않는다 (Git 패널도 행 단위로만 표시한다).
  _isPartial(p){
    const rel=this._rel(p);
    return !!(rel&&this._partial&&this._partial.has(rel));
  },

  // FR-EDT-75: 폴더 자신이 상태를 갖는 일은 없다 — git 은 폴더를 추적하지 않는다.
  _stOf(p,kind){
    const rel=this._rel(p);
    if(!rel) return '';
    return (kind==='dir'?this._dirSt.get(rel):this._st.get(rel))||'';
  },

  // ── 그리기 (FR-EDT-66·68) ──

  /**
   * 보이는 행을 평평한 목록으로 편다. 중첩 DOM 이 아니라 패딩으로 들여쓴다 —
   * Git 패널의 트리와 같은 규약이고(FR-GIT-211) reconcile 이 성립하는 형태다.
   */
  _items(){
    const out=[];
    const ed=this._edit;
    // FR-EDT-92: 실패는 **그 자리**에 붙는다. 붙을 행이 지금 보이지 않으면 뿌리
    // 위에 붙인다 — 어디에도 못 붙어 사라지면 사용자는 조작이 성공한 줄 안다.
    let errPut=false;
    const err=depth=>{
      if(!this._err||errPut) return null;
      errPut=true;
      return {t:'operr',depth,msg:this._err.msg,
        k:'oe',s:'oe\u0001'+depth+'\u0001'+this._err.msg};
    };
    const errAt=(anchor,depth)=>{
      if(!this._err||errPut||this._err.anchor!==anchor) return;
      const it=err(depth); if(it) out.push(it);
    };
    // FR-EDT-81·82: 인라인 입력. 만들기는 대상 폴더의 **첫 자리**에, 이름 변경은
    // 그 행 **자리 그대로** 선다.
    const input=depth=>({t:'in',depth,mode:ed.mode,isDir:!!ed.isDir,init:ed.init,
      k:'in',s:'in\u0001'+ed.mode+'\u0001'+depth+'\u0001'+(ed.isDir?1:0)});
    const walk=(dir,depth)=>{
      const st=this._kids.get(dir);
      if(!st) return;
      if(ed&&ed.mode==='create'&&ed.dir===dir){
        out.push(input(depth));
        errAt('input',depth);
      }
      for(const e of st.entries){
        if(!e||!e.name) continue;
        const p=this._join(dir,e.name);
        // FR-EDT-60: `dir` 은 Lstat 기준이라 링크는 언제나 false 이고, 대상 종류는
        // `linkDir` 이 알린다. 셋을 여기 한 번만 가른다.
        const kind=e.link?'link':(e.dir?'dir':'file');
        const sub=this._kids.get(p);
        const it={t:'row',path:p,name:e.name,kind,depth,
          linkDir:!!e.linkDir,
          open:kind==='dir'&&this._open.has(p),
          busy:this._busy.has(p),
          err:(sub&&sub.err)||'',
          sel:this._sel===p,
          st:this._stOf(p,kind),
          ignored:this._isIgnored(p),
          partial:kind!=='dir'&&this._isPartial(p)};
        it.k='r:'+p;
        // 근거는 이 행이 읽는 값 **전부**다 — 좁히면 갱신이 조용히 멈춘다 (FR-RPT-2).
        it.s=[kind,depth,it.open?1:0,it.busy?1:0,it.err,it.sel?1:0,it.st,it.linkDir?1:0,
          it.partial?1:0,it.ignored?1:0]
          .join('\u0001');
        if(ed&&ed.mode==='rename'&&ed.path===p){
          out.push(input(depth));
          errAt('input',depth);
        }else{
          out.push(it);
        }
        errAt(p,depth);
        if(it.open) walk(p,depth+1);
      }
      // FR-EDT-65: 잘린 폴더. 조회가 실패한 것이 아니므로 행 뒤에 사실만 덧붙인다.
      if(st.truncated){
        out.push({t:'more',path:dir,depth,n:st.entries.length,
          k:'m:'+dir,s:'m\u0001'+st.entries.length+'\u0001'+depth});
      }
    };
    // 뿌리에는 행이 없으므로(이름은 머리가 보인다) 뿌리의 실패는 여기 실어 보인다.
    const rs=this._kids.get(this.root);
    if(rs&&rs.err) out.push({t:'err',depth:0,msg:rs.err,k:'e:root',s:'e\u0001'+rs.err});
    walk(this.root,0);
    // 붙을 자리를 못 찾은 실패는 맨 앞에 선다.
    const rest=err(0); if(rest) out.unshift(rest);
    return out;
  },

  paint(){
    reconcileList(this.list,this._items(),{
      key:it=>it.k, sig:it=>it.s, build:it=>this._el(it),
    });
    this._focusInput();
  },

  /**
   * FR-EDT-82: 이름 변경은 **확장자 앞까지** 미리 선택한다 — 바꾸려는 것은 거의
   * 언제나 확장자가 아니다.
   *
   * 요소는 reconcile 이 보존하므로(키·서명이 그대로다) 포커스는 **만들어진 직후
   * 한 번**만 준다. 매 paint 마다 주면 폴링이 캐럿을 계속 되돌린다.
   */
  _focusInput(){
    if(!this._focusEdit) return;
    const el=this.list.querySelector('.ed-input');
    if(!el) return;
    this._focusEdit=false;
    el.focus();
    const v=el.value, i=v.lastIndexOf('.');
    el.setSelectionRange(0,(!this._edit.isDir&&i>0)?i:v.length);
  },

  _pad(el,depth){ el.style.paddingLeft=(GIT_TREE_PAD0+depth*GIT_TREE_INDENT)+'px' },

  _span(cls,text){
    const s=document.createElement('span'); s.className=cls; s.textContent=text; return s;
  },

  _el(it){
    if(it.t==='more'){
      const d=document.createElement('div'); d.className='ed-more';
      this._pad(d,it.depth);
      d.textContent=EDITOR_TREE_TRUNCATED.replace('%s',it.n);
      return d;
    }
    if(it.t==='err'){
      const d=document.createElement('div'); d.className='ed-tree-err';
      this._pad(d,it.depth);
      d.textContent=EDITOR_TREE_ERR+' — '+it.msg;
      return d;
    }
    // FR-EDT-92: 조작 실패의 사유. 조회 실패(`ed-tree-err`)와 다른 종류이므로
    // 클래스를 나눈다 — 하나로 합치면 어느 실패인지 화면이 말하지 못한다.
    if(it.t==='operr'){
      const d=document.createElement('div'); d.className='ed-op-err';
      this._pad(d,it.depth);
      d.textContent=it.msg;
      return d;
    }
    if(it.t==='in') return this._elInput(it);
    const d=document.createElement('div');
    // 상태 클래스는 Git 패널과 **같은 표**에서 나온다 (GIT_ST_CLASS) — 색값의
    // 정의 자리를 늘리지 않기 위해서다 (FR-EDT-70 / D-4).
    d.className='ed-row ed-'+it.kind
      +(it.sel?' sel':'')+(it.err?' ed-err':'')
      +(it.st?' st-'+(GIT_ST_CLASS[it.st]||'other'):'')
      +(it.partial?' st-partial':'')
      // FR-ETR-7: 무시는 **상태색보다 약하다.** 클래스를 뒤에 두되 CSS 가
      // 상태색을 이기지 않게 한다 — 실제로 겹치는 자리는 없지만(무시된 파일은
      // status 에 나오지 않는다) 규칙을 적어 두지 않으면 순서가 뒤집힌다.
      +(it.ignored?' ed-ignored':'');
    d.dataset.path=it.path; d.dataset.kind=it.kind;
    if(it.st) d.dataset.st=it.st;
    // FR-EDT-85: 드래그 이동의 출발점. 링크도 옮길 수 있다 — 조작은 링크 **자신**을
    // 대상으로 삼는다 (D-21).
    d.draggable=true;
    this._pad(d,it.depth);
    d.title=it.err?(it.path+' — '+EDITOR_TREE_ERR+' ('+it.err+')'):it.path;
    d.appendChild(this._span('ed-tw',it.kind!=='dir'?''
      :(it.busy?EDITOR_TREE_TW_BUSY:(it.open?EDITOR_TREE_TW_OPEN:EDITOR_TREE_TW_CLOSED))));
    d.appendChild(this._span('ed-name',it.name));
    if(it.kind==='link'){
      d.appendChild(this._span('ed-mark',it.linkDir?EDITOR_TREE_LINK_DIR:EDITOR_TREE_LINK));
    }
    return d;
  },

  /**
   * FR-EDT-81·82 의 인라인 입력. 만들기와 이름 변경이 **같은 요소**를 쓴다 — 받는
   * 것이 이름 하나로 같기 때문이다.
   *
   * 키 이벤트를 여기서 멈춘다 — 앱의 전역 단축키가 타이핑을 먹으면 `n` 하나에
   * 창이 열린다.
   */
  _elInput(it){
    const d=document.createElement('div');
    d.className='ed-row ed-edit'+(it.mode==='rename'?' ed-edit-rename':' ed-edit-new');
    this._pad(d,it.depth);
    d.appendChild(this._span('ed-tw',it.isDir?EDITOR_TREE_TW_CLOSED:''));
    const i=document.createElement('input');
    i.className='ed-input'; i.type='text'; i.value=it.init; i.spellcheck=false;
    i.addEventListener('keydown',e=>{
      e.stopPropagation();
      if(e.key==='Enter'){e.preventDefault();this._commitEdit(i.value)}
      else if(e.key==='Escape'){e.preventDefault();this.cancelEdit()}
    });
    d.appendChild(i);
    return d;
  },

  // ── 파일 조작 (FR-EDT-79~93) ──

  _base(p){ return String(p||'').split('/').pop() },
  _parent(p){ const i=String(p||'').lastIndexOf('/'); return i<=0?'/':p.slice(0,i) },

  // 종류는 **부모의 캐시**가 안다 — 행을 그리는 근거와 같은 값을 쓴다.
  _kindOf(p){
    if(p===this.root) return 'dir';
    const st=this._kids.get(this._parent(p));
    const e=st&&st.entries.find(x=>x&&x.name===this._base(p));
    if(!e) return '';
    return e.link?'link':(e.dir?'dir':'file');
  },

  // FR-EDT-81: 만드는 자리. 선택이 폴더면 그 아래, 파일이면 그 부모, 없으면 루트다.
  _targetDir(){
    const k=this._sel?this._kindOf(this._sel):'';
    if(k==='dir') return this._sel;
    if(k) return this._parent(this._sel);
    return this.root;
  },

  _fail(anchor,msg){ this._err={anchor,msg}; this._paintAll() },
  _clearErr(){ if(this._err){this._err=null} },

});
