/**
 * Dongminal — Editor 창의 파일 탐색기 (EDITOR_TAB_SRS 묶음 X / FR-EDT-57~78)
 *
 * **인스턴스는 창별로 하나이고 렌더러보다 오래 산다.** 렌더러의 `_rLayout` 은 매
 * render 마다 `.ed-win` 을 지우고 다시 만드는데(renderer.js), 트리를 거기서 함께
 * 만들면 SSE 한 번에 펼침·선택·스크롤이 전부 사라진다 (FR-EDT-66). 그래서 요소는
 * 여기서 한 번 만들고 렌더러는 `mount()` 가 준 것을 **옮겨 붙이기만** 한다.
 *
 * 갱신 계기는 셋뿐이다 (FR-EDT-67) — 새로고침 · 조작 후 재조회(M5) · git 색 폴링.
 * 파일 감시는 하지 않는다.
 */
class FileTree {
  constructor(app,win){
    this.app=app;
    this.winId=win.id;
    this.root=app._edRootOf(win);

    // 펼침·선택은 **창별 런타임 상태**다 — 워크스페이스에 저장하지 않는다 (FR-EDT-62).
    this._open=new Set();
    this._sel='';
    // path → {entries,truncated,err}. 지연 로드의 캐시이자 그리기의 근거다 (FR-EDT-59).
    this._kids=new Map();
    this._busy=new Set();
    // M4 의 색. rel path → 상태문자. 폴더는 접어 올린 값이 따로 산다 (FR-EDT-73).
    this._st=new Map();
    this._partial=new Set();
    this._dirSt=new Map();
    // FR-EDT-69: 루트가 저장소 **루트**가 아니면 색이 없다. 판정은 한 번이고
    // 그 뒤로는 묻지 않는다.
    this._gitOff=false;
    this._gitBusy=false;
    // FR-ETR-5·6: 무시된 이름. 겹(디렉터리 경로)별로 Set 을 들고, 그 겹을 다시
    // 읽을 때 갱신한다. `_gitOff` 와 나누는 이유는 근거가 다르기 때문이다 —
    // 저쪽은 status, 이쪽은 check-ignore 이고 저장소가 아니어도 서로 다른 답을
    // 낼 수 있다.
    this._ign=new Map();
    this._ignOff=false;
    this._scrollY=0;
    // M5 의 조작 상태 (FR-EDT-79~92). 셋 다 **런타임 상태**이고 워크스페이스에
    // 저장하지 않는다 — 새로고침 뒤에 반쯤 쓰다 만 이름이 살아날 이유가 없다.
    this._edit=null;   // 인라인 입력 하나. 두 개가 동시에 열리는 자리가 없다.
    this._err=null;    // 마지막 실패. {anchor,msg} — 그 자리에 붙는다 (FR-EDT-92).
    this._drag='';     // 끌고 있는 경로. dataTransfer 는 dragover 에서 읽을 수 없다.
    this._focusEdit=false;

    // FR-FTR-20: 헤더는 루트 드롭 존이다 — 표시를 위해 들고 있는다.
    this._dropDir='';
    this._springTimer=null;
    this._springPath='';

    this.el=document.createElement('div');
    this.el.className='ed-explorer';
    this.head=this._head();
    this.el.appendChild(this.head);
    this.list=document.createElement('div');
    this.list.className='ed-tree';
    this.el.appendChild(this.list);

    // 행은 reconcile 로 다시 만들어질 수 있다 — 리스너는 컨테이너 하나에만 건다.
    this.list.addEventListener('click',e=>this._onClick(e));
    // FR-EDT-80: 진입점 둘 중 하나. 같은 이유로 여기 한 번만 건다.
    this.list.addEventListener('contextmenu',e=>this._onCtx(e));
    this._initDnd();
    this.list.addEventListener('scroll',()=>{
      if(this.el.isConnected) this._scrollY=this.list.scrollTop;
    });

    this.load(this.root);
  }

  _head(){
    const h=document.createElement('div'); h.className='ed-head';
    const n=document.createElement('span'); n.className='ed-head-name';
    n.textContent=this.app._edName(this.root); n.title=this.root;
    h.appendChild(n);
    // FR-EDT-80: 상단 버튼 셋 — 새 파일 · 새 폴더 · 새로고침. 만드는 자리는
    // 선택이 정한다 (FR-EDT-81) — 버튼은 그 규칙을 다시 적지 않는다.
    h.appendChild(this._headBtn('ed-head-new-file',EDITOR_TREE_NEW_FILE,
      EDITOR_TREE_NEW_FILE_TITLE,()=>this.startCreate(false)));
    h.appendChild(this._headBtn('ed-head-new-dir',EDITOR_TREE_NEW_DIR,
      EDITOR_TREE_NEW_DIR_TITLE,()=>this.startCreate(true)));
    h.appendChild(this._headBtn('ed-head-refresh',EDITOR_TREE_REFRESH,
      EDITOR_TREE_REFRESH_TITLE,()=>this.refresh()));
    return h;
  }

  /**
   * 머리의 버튼 하나. `label` 이 **알려진 아이콘**이면 그림으로, 아니면 글자로
   * 넣는다.
   *
   * 판정이 "SVG 처럼 생겼는가" 가 아니라 `EDITOR_HEAD_ICONS` 에 **있는가** 인
   * 것이 요점이다 — 모양으로 판정하면 언젠가 사용자 입력이 그 모양을 하고
   * 들어온다. 목록에 있는 것만 그림이 되므로 그 경로가 아예 없다.
   */
  _headBtn(cls,label,title,fn){
    const b=document.createElement('button'); b.className='ed-head-btn '+cls;
    if(EDITOR_HEAD_ICONS.has(label)) b.innerHTML=label;
    else b.textContent=label;
    b.title=title;
    b.addEventListener('click',fn);
    return b;
  }

  /**
   * 렌더러의 마운트 지점. 요소를 **돌려줄 뿐** 다시 만들지 않는다.
   *
   * 떼었다 붙이는 사이에 scrollTop 은 브라우저마다 다르게 남는다 (term-pane 의
   * 뷰포트 복원이 같은 함정을 다룬다). 값으로 되돌리는 쪽이 확실하다 (FR-EDT-68).
   */
  mount(){
    const y=this._scrollY;
    if(y) requestAnimationFrame(()=>{ if(this.list.scrollTop!==y) this.list.scrollTop=y });
    // FR-EDT-66: 스크롤과 같은 함정이 인라인 입력에도 있다. 요소가 문서에서
    // 떨어지는 순간 포커스가 사라지므로(SSE 한 번이면 충분하다) 값으로 되돌린다 —
    // 입력이 **열려 있는 동안**에만이다.
    if(this._edit) this._restoreEditFocus();
    return this.el;
  }

  /**
   * 포커스와 선택 구간을 되돌린다. 구간까지 되돌리지 않으면 폴링 한 번에 캐럿이
   * 끝으로 튀어 타이핑하던 자리를 잃는다 (FR-EDT-82 의 미리 선택도 같이 사라진다).
   *
   * 붙기 전에는 focus() 가 아무 일도 하지 않으므로 다음 프레임에 건다 — 렌더러는
   * `mount()` 가 준 요소를 그 뒤에 붙인다 (renderer.js `_rEditorWin`).
   */
  _restoreEditFocus(){
    const el=this.list.querySelector('.ed-input');
    if(!el) return;
    const a=el.selectionStart,b=el.selectionEnd;
    requestAnimationFrame(()=>{
      if(!this._edit||!el.isConnected||document.activeElement===el) return;
      // 다른 요소가 포커스를 쥐고 있으면 뺏지 않는다. 떨어져 나가면서 잃은
      // 포커스는 `body` 로 돌아가므로 그 경우만 우리 것이다 — 입력이 잃은 blur 는
      // 요소가 다시 붙은 **뒤에** 도착해서 (실측) 플래그로는 가릴 수 없다.
      const cur=document.activeElement;
      if(cur&&cur!==document.body) return;
      el.focus();
      el.setSelectionRange(a,b);
    });
  }

  destroy(){
    this._springCancel();
    if(this.el.parentNode) this.el.parentNode.removeChild(this.el);
  }

  // ── 조회 (FR-EDT-59·63·65) ──

  _join(dir,name){ return dir==='/'?'/'+name:dir+'/'+name }

  // 루트 기준 상대경로. git status 의 경로가 그 형식이다.
  _rel(p){
    if(p===this.root) return '';
    return p.slice(this.root==='/'?1:this.root.length+1);
  }

  /**
   * 한 겹만 읽는다 (FR-EDT-59). 실패는 그 폴더의 캐시에만 남으므로 트리의 나머지는
   * 그대로다 (FR-EDT-63).
   */
  async load(dir){
    if(this._busy.has(dir)) return;
    this._busy.add(dir); this.paint();
    const u=FS_LIST_API+'?root='+encodeURIComponent(this.root)+'&path='+encodeURIComponent(dir);
    let r=null,d=null;
    try{r=await fetch(u)}catch{r=null}
    if(r){try{d=await r.json()}catch{d=null}}
    this._busy.delete(dir);
    if(!r||!r.ok){
      this._kids.set(dir,{entries:[],truncated:false,err:(d&&d.code)||EDITOR_TREE_ERR});
    }else{
      this._kids.set(dir,{
        // 순서는 서버가 정한다 (D-20) — 여기서 다시 정렬하면 잘림의 경계가
        // 요청마다 달라진다 (FR-EDT-61·65).
        entries:Array.isArray(d.entries)?d.entries:[],
        truncated:!!d.truncated, err:'',
      });
    }
    this.paint();
    // FR-ETR-5: 겹을 읽은 **뒤에** 그 겹의 이름들로 한 번 묻는다. 목록보다 먼저
    // 물으면 무엇을 물어야 할지 모른다.
    this.loadIgnored(dir);
  }

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
      this.paint();
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
      if(r.status>=400&&r.status<500){this._ignOff=true;this._ign.clear();this.paint()}
      return;
    }
    if(!d||!Array.isArray(d.ignored)) return;
    this._ign.set(dir,new Set(d.ignored));
    this.paint();
  }

  // FR-ETR-7: 이 경로가 무시되었는가. 판정은 **그 겹의 답**에 있다 — 부모가
  // 무시면 loadIgnored 가 자식 전부를 그 겹의 Set 에 넣어 두었다.
  _isIgnored(p){
    if(p===this.root) return false;
    const s=this._ign.get(this._parent(p));
    return !!(s&&s.has(this._base(p)));
  }

  // FR-EDT-64: **펼쳐져 있는 폴더만** 다시 읽는다. 펼침은 보존된다.
  refresh(){
    this.load(this.root);
    for(const p of this._open) this.load(p);
  }

  toggle(p){
    if(this._open.has(p)){this._open.delete(p);this.paint();return}
    this._open.add(p);
    this.paint();
    // 이미 읽어 둔 폴더는 다시 묻지 않는다 — 갱신의 계기는 FR-EDT-67 의 셋뿐이다.
    if(!this._kids.has(p)) this.load(p);
  }

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
    else this.paint();
  }

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
  }

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
    this.paint();
  }

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
  }

  // FR-GIT-190: 일부만 스테이지된 파일인가. 폴더에는 뜻이 없다 — 파일 하나의
  // 사실이므로 접어 올리지 않는다 (Git 패널도 행 단위로만 표시한다).
  _isPartial(p){
    const rel=this._rel(p);
    return !!(rel&&this._partial&&this._partial.has(rel));
  }

  // FR-EDT-75: 폴더 자신이 상태를 갖는 일은 없다 — git 은 폴더를 추적하지 않는다.
  _stOf(p,kind){
    const rel=this._rel(p);
    if(!rel) return '';
    return (kind==='dir'?this._dirSt.get(rel):this._st.get(rel))||'';
  }

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
  }

  paint(){
    reconcileList(this.list,this._items(),{
      key:it=>it.k, sig:it=>it.s, build:it=>this._el(it),
    });
    this._focusInput();
  }

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
  }

  _pad(el,depth){ el.style.paddingLeft=(GIT_TREE_PAD0+depth*GIT_TREE_INDENT)+'px' }

  _span(cls,text){
    const s=document.createElement('span'); s.className=cls; s.textContent=text; return s;
  }

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
  }

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
  }

  // ── 파일 조작 (FR-EDT-79~93) ──

  _base(p){ return String(p||'').split('/').pop() }
  _parent(p){ const i=String(p||'').lastIndexOf('/'); return i<=0?'/':p.slice(0,i) }

  // 종류는 **부모의 캐시**가 안다 — 행을 그리는 근거와 같은 값을 쓴다.
  _kindOf(p){
    if(p===this.root) return 'dir';
    const st=this._kids.get(this._parent(p));
    const e=st&&st.entries.find(x=>x&&x.name===this._base(p));
    if(!e) return '';
    return e.link?'link':(e.dir?'dir':'file');
  }

  // FR-EDT-81: 만드는 자리. 선택이 폴더면 그 아래, 파일이면 그 부모, 없으면 루트다.
  _targetDir(){
    const k=this._sel?this._kindOf(this._sel):'';
    if(k==='dir') return this._sel;
    if(k) return this._parent(this._sel);
    return this.root;
  }

  _fail(anchor,msg){ this._err={anchor,msg}; this.paint() }
  _clearErr(){ if(this._err){this._err=null} }

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
    this.paint();
  }

  startRename(p){
    if(!p||p===this.root) return;
    this._clearErr();
    this._edit={mode:'rename',dir:this._parent(p),path:p,
      isDir:this._kindOf(p)==='dir',init:this._base(p)};
    this._focusEdit=true;
    this.paint();
  }

  cancelEdit(){
    if(!this._edit) return;
    this._edit=null; this._clearErr(); this.paint();
  }

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
  }

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
  }

  _restore(snap){
    for(const [d,st] of snap){
      if(st) this._kids.set(d,st); else this._kids.delete(d);
    }
    this.paint();
  }

  // 아직 서버가 모르는 항목을 **끝에** 붙인다. 순서는 서버가 정하므로(D-20)
  // 여기서 자리를 맞추지 않는다 — 다시 읽으면 제자리로 간다 (FR-EDT-88).
  _optimAdd(dir,name,isDir){
    const st=this._kids.get(dir);
    if(!st) return;
    st.entries=st.entries.concat([{name,dir:!!isDir,link:false,linkDir:false}]);
  }

  _optimDel(p){
    const st=this._kids.get(this._parent(p));
    if(!st) return;
    const n=this._base(p);
    st.entries=st.entries.filter(e=>!e||e.name!==n);
  }

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
  }

  _rekey(from,to){
    const pre=from+'/';
    const map=p=>p===from?to:(p.startsWith(pre)?to+p.slice(from.length):p);
    const kids=new Map();
    for(const [k,v] of this._kids) kids.set(map(k),v);
    this._kids=kids;
    const open=new Set();
    for(const p of this._open) open.add(map(p));
    this._open=open;
    if(this._sel) this._sel=map(this._sel);
  }

  // 사라진 가지의 캐시·펼침·선택을 거둔다. 남겨 두면 같은 이름이 다시 생겼을 때
  // 낡은 목록이 먼저 보인다.
  _forget(p){
    const pre=p+'/';
    for(const k of [...this._kids.keys()]) if(k===p||k.startsWith(pre)) this._kids.delete(k);
    for(const k of [...this._open]) if(k===p||k.startsWith(pre)) this._open.delete(k);
    if(this._sel===p||this._sel.startsWith(pre)) this._sel='';
  }

  // ── 조작 넷 (FR-EDT-88·89·90·91·92) ──

  async doCreate(dir,name,isDir){
    const path=this._join(dir,name);
    const snap=this._snap([dir]);
    this._optimAdd(dir,name,isDir);
    this._sel=path;
    this.paint();
    const r=await this.app._edFs(FS_CREATE_API,{root:this.root,path,dir:!!isDir});
    if(!r.ok){this._restore(snap);this._fail(dir===this.root?'':dir,r.msg);return}
    await this._after([dir]);
  }

  /**
   * 이름 변경과 이동은 같은 조작이다 (FR-EDT-109) — 다른 것은 `to` 의 부모뿐이다.
   *
   * 같은 이름이 있으면 **서버가 거부한다** (FR-EDT-86·115). 덮어쓰기도 자동 개명도
   * 여기에 없다.
   */
  async doRename(from,to){
    if(!from||!to||from===to) return;
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
    this.paint();
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
  }

  /**
   * FR-EDT-83·84: 영구 삭제. 확인창이 재귀 여부·항목 수·dirty 탭을 밝힌다.
   *
   * 세는 것이 확인창보다 먼저다 — 수를 모른 채 "재귀 삭제합니다" 만 말하면
   * 사용자가 무엇을 잃는지 모른다.
   */
  async doDelete(p){
    if(!p||p===this.root) return;
    const isDir=this._kindOf(p)==='dir';
    const count=isDir?await this.app._edCountTree(this.root,p):null;
    const dirty=this.app._edDirtyUnder(p);
    if(!await this.app._edConfirmDelete(p,isDir,count,dirty)) return;
    const d=this._parent(p);
    const snap=this._snap([d]);
    this._optimDel(p);
    this.paint();
    const r=await this.app._edFs(FS_DELETE_API,{root:this.root,path:p});
    if(!r.ok){this._restore(snap);this._fail(p,r.msg);return}
    // FR-EDT-91: 그 파일의 탭을 닫는다. 폴더면 하위 전부. 확인창은 다시 띄우지
    // 않는다 — FR-EDT-84 에서 이미 밝혔다.
    await this.app._edCloseTabsUnder(p);
    this._forget(p);
    await this._after([d]);
  }

  // ── 전송 (FILE_TRANSFER_SRS FR-FTR-13·14·19 · EXPLORER_TRANSFER_IGNORE_SRS
  //    묶음 B·C·D) ──

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
    this._clearErr();
    // 올린 것이 보이지 않으면 사용자는 실패로 읽는다.
    if(dir!==this.root&&!this._open.has(dir)) this._open.add(dir);
    this._busy.add(dir); this.paint();

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
    const u=FS_UPLOAD_API+'?root='+encodeURIComponent(this.root)+
      '&dir='+encodeURIComponent(dir);
    let r=null,d=null;
    try{r=await fetch(u,{method:'POST',body:fd})}catch{r=null}
    if(r){try{d=await r.json()}catch{d=null}}
    if(r&&r.ok&&d&&d.ok) return '';
    const why=EDITOR_FS_ERR_MSG[(d&&d.code)||'']||(d&&d.message)||'';
    return why||EDITOR_UPLOAD_FAIL.replace('%s',it.relPath||it.file.name);
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
  }

  /**
   * 입력을 `{file, relPath}` 로 고른다. `File` 배열(파일 여럿 고르기)과 이미
   * 상대경로가 붙은 항목(폴더 드롭·폴더 고르기) 둘을 같은 자리에서 받는다 —
   * 부르는 곳이 셋이라 형식 판정이 흩어지면 한 곳만 고쳐진다.
   */
  static _asUploadItems(items){
    if(!Array.isArray(items)) return [];
    return items.map(x=>{
      if(!x) return null;
      if(x.file) return {file:x.file,relPath:x.relPath||''};
      // <input webkitdirectory> 는 File 에 webkitRelativePath 를 실어 준다.
      return {file:x,relPath:x.webkitRelativePath||''};
    }).filter(Boolean);
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
        this._fail(dir===this.root?'':dir,
          EDITOR_UPLOAD_TOO_MANY.replace('%n',EDITOR_UPLOAD_MAX_ENTRIES));
        this.paint();
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
  async _after(dirs){
    this._clearErr();
    for(const d of dirs) await this.load(d);
    this.pollGit();
  }

  // ── 진입점 둘 (FR-EDT-80) ──

  _onCtx(e){
    const row=e.target.closest('.ed-row');
    if(!row||!this.list.contains(row)||row.classList.contains('ed-edit')) return;
    e.preventDefault();
    const p=row.dataset.path,kind=row.dataset.kind;
    if(this._edit) this.cancelEdit();
    this._sel=p; this.paint();
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
  }

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
  }

  // 바깥에서 온 파일인가. 내부 이동은 `text/plain` 만 싣는다.
  static _isFileDrag(e){
    const t=e.dataTransfer&&e.dataTransfer.types;
    return !!t&&[...t].includes('Files');
  }

  /**
   * FR-EDT-21: 드롭된 최상위 entry 들. **동기적으로** 꺼낸다 — `dataTransfer` 의
   * `items` 는 이벤트 핸들러가 끝나면 비워지므로, 재귀(비동기) 안에서 꺼내면
   * 아무것도 없다.
   *
   * `webkitGetAsEntry` 가 없는 브라우저에서는 null 이고, 그때는 `files` 로
   * 폴백한다 — 폴더는 못 올리지만 파일은 올라간다.
   */
  static _dropEntries(e){
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
      this._fail(dir===this.root?'':dir,
        EDITOR_UPLOAD_TOO_MANY.replace('%n',EDITOR_UPLOAD_MAX_ENTRIES));
      this.paint();
      return;
    }
    if(items.length) this.doUpload(dir,items);
  }

  /**
   * entry 하나를 걷는다. 파일이면 담고 디렉터리면 그 안으로 내려간다.
   * 상한을 넘으면 `false` 를 돌려 **걷기 자체를 멈춘다** (FR-ETR-22) — 홈 폴더를
   * 잘못 놓았을 때 브라우저가 멎지 않아야 한다.
   *
   * `readEntries` 는 한 번에 전부 주지 않는다. 빈 배열이 올 때까지 되풀이해야
   * 하며, 그러지 않으면 항목이 100개쯤에서 잘린다 (Chrome 의 실제 동작이다).
   */
  static async _walkEntry(en,prefix,out){
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
    if(row&&this.list.contains(row)){
      const p=row.dataset.path;
      return row.dataset.kind==='dir'?p:this._parent(p);
    }
    return this.root;
  }

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
  }

  _dropClear(){
    this._dropDir='';
    this._springCancel();
    for(const el of this.list.querySelectorAll('.ed-drop')) el.classList.remove('ed-drop');
    this.head.classList.remove('ed-drop-root');
    this.list.classList.remove('ed-drop-root');
  }

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
  }

  _springCancel(){
    if(this._springTimer){clearTimeout(this._springTimer);this._springTimer=null}
    this._springPath='';
  }
}

// 고전 스크립트의 class 선언은 window 의 속성이 되지 않는다 — e2e 가 창 밖에서
// 부르므로 명시적으로 붙인다 (repaint.js 와 같은 규약).
window.FileTree=FileTree;
