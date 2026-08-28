/**
 * Dongminal — Git Stash 탭 (GIT_SRS §3D.2 / FR-GIT-161~170)
 *
 * 목록은 `/api/git/stash` 다. 조작(`push`/`apply`/`pop`/`drop`)의 응답에는 **실행
 * 후 목록과 status 가 함께** 오므로 폴링 주기를 기다리지 않고 그것으로 갱신한다
 * (FR-GIT-170).
 *
 * 두 가지를 조용히 넘기지 않는다:
 *
 * - **pop 이 충돌로 끝나면 git 이 stash 를 남긴다** (FR-GIT-165, 검증 V57). 서버가
 *   실패 응답에 `stashKept` 와 남은 목록을 함께 주는 이유는 사용자가 그 자리에서
 *   "작업은 사라지지 않았다" 를 확인해야 하기 때문이다.
 * - **담을 것이 없으면 생성이 비활성이고 사유가 보인다** (FR-GIT-167). 사유 없이
 *   꺼진 버튼은 사용자가 해소할 수 없다.
 */
class GitStash {
  constructor(panel){
    this.panel=panel;
    this.app=panel.app;
    this._el=null;
    this._repo=undefined;
    this.reset();
  }

  reset(){
    this._list=[];
    this._filter='';    // 메시지·기준 브랜치 필터 (FR-GIT-272)
    this._err=null;
    this._loading=false;
    this._note=null;   // {kind,msg} — pop 잔류·실패 안내
    this._sel=null;    // 선택된 stash 인덱스 (FR-GIT-169)
    this._files=null;
    this._filesErr=null;
    this._filesFor=null;
  }

  // stash 하나의 사람이 읽는 이름. 확인 다이얼로그의 대상 목록도 이것을 쓴다 —
  // 인덱스만 보이면 무엇을 지우는지 알 수 없다 (FR-GIT-91).
  static label(s){
    if(!s) return '';
    return GitStash.ref(s.index)+' '+(s.message||'');
  }

  static ref(i){return 'stash@{'+i+'}'}

  // ── 골격 ──

  mount(el){
    if(!el) return;
    this._el=el;
    el.innerHTML=
      '<div class="git-stash-bar">'+
        '<button class="git-stash-new"></button>'+
        '<input class="git-stash-filter" type="text">'+
        '<span class="git-stash-why"></span>'+
      '</div>'+
      '<div class="git-stash-note">'+
        '<span class="git-stash-note-msg"></span>'+
        '<button class="git-stash-note-close"></button>'+
      '</div>'+
      '<div class="git-stash-main">'+
        '<div class="git-stash-list"></div>'+
        '<div class="git-stash-preview">'+
          '<div class="git-stash-preview-head"></div>'+
          '<div class="git-stash-files"></div>'+
        '</div>'+
      '</div>';
    el.querySelector('.git-stash-new').textContent=GIT_STASH_NEW;
    el.querySelector('.git-stash-note-close').textContent=GIT_NOTE_CLOSE;
    el.querySelector('.git-stash-new').addEventListener('click',()=>this._create());
    // FR-GIT-272: 필터는 **이미 받아 둔 목록**에만 건다 — 다시 받을 이유가 없고,
    // 키 하나마다 요청을 사면 목록이 깜빡인다.
    const fi=el.querySelector('.git-stash-filter');
    fi.placeholder=GIT_STASH_FILTER_PH;
    fi.addEventListener('input',ev=>{
      this._filter=ev.target.value;
      this._paintList();
    });
    el.querySelector('.git-stash-note-close').addEventListener('click',()=>{
      this._note=null; this._paintNote();
    });
    this._repo=undefined;
  }

  unmount(){
    this._el=null;
    this._repo=undefined;
  }

  // ── 칠하기 ──

  paint(){
    if(!this._el) return;
    if(this.panel.repo!==this._repo) this._adopt();
    if(!this._el) return;
    this._paintBar();
    this._paintNote();
    this._paintList();
    this._paintPreview();
  }

  // 폴링이 새 status 를 얻을 때마다 불린다. 목록에 영향을 주는 것은 "담을 것이
  // 있는지" 하나뿐이다 (FR-GIT-167) — 목록 자체는 stash 조작으로만 바뀐다.
  paintStatus(){
    if(!this._el||this.panel.repo!==this._repo) return;
    this._paintBar();
  }

  _adopt(){
    this._repo=this.panel.repo;
    this.reset();
    if(!this._repo) return;
    this._load();
  }

  /**
   * 생성 가능 여부와 사유 (FR-GIT-167).
   *
   * untracked 뿐이면 "담을 것이 없다" 가 **아니다** — `--include-untracked` 를 켜면
   * 담긴다. 그러므로 버튼은 열어 두고 그 사실을 다이얼로그가 판정한다. 진짜로
   * 아무 변경도 없을 때만 막는다.
   */
  _why(){
    const s=this.panel.statusOf();
    if(!s) return GIT_LOADING_HINT;
    const n=(s.staged||[]).length+(s.changes||[]).length+(s.conflicts||[]).length+
      (s.untracked||[]).length;
    return n?'':GIT_STASH_NOTHING;
  }

  _paintBar(){
    const el=this._el;
    const why=this._why();
    const btn=el.querySelector('.git-stash-new');
    btn.disabled=!!why;
    btn.title=why;
    const w=el.querySelector('.git-stash-why');
    w.textContent=why;
    w.classList.toggle('vis',!!why);
    // 리포가 바뀌면 reset 이 필터를 비운다 — 입력도 그것을 따라간다. 치는 중에는
    // 둘이 같으므로 이 대입이 사용자의 입력을 되돌리지 않는다.
    const fi=el.querySelector('.git-stash-filter');
    if(fi.value!==this._filter) fi.value=this._filter;
  }

  _paintNote(){
    const box=this._el.querySelector('.git-stash-note');
    const n=this._note;
    box.classList.toggle('vis',!!n);
    box.dataset.kind=(n&&n.kind)||'';
    box.querySelector('.git-stash-note-msg').textContent=(n&&n.msg)||'';
  }

  _paintList(){
    const box=this._el.querySelector('.git-stash-list');
    box.innerHTML='';
    if(this._err){
      const d=document.createElement('div'); d.className='git-stash-empty';
      d.textContent=this._err;
      box.appendChild(d);
      return;
    }
    const list=this.visible();
    if(!list.length){
      const d=document.createElement('div'); d.className='git-stash-empty';
      // 목록이 있는데 안 보이는 것과 stash 자체가 없는 것은 다른 사실이다 —
      // 뭉개면 사용자는 자기 stash 가 사라진 것으로 읽는다.
      d.textContent=this._loading?GIT_LOADING_HINT
        :(this._list.length?GIT_STASH_FILTER_NONE:GIT_STASH_EMPTY);
      box.appendChild(d);
      return;
    }
    for(const s of list) box.appendChild(this._rowEl(s));
  }

  /**
   * FR-GIT-272: 필터에 맞는 stash 만. 메시지와 **기준 브랜치**를 함께 본다 —
   * 브랜치로 찾는 것이 stash 를 고르는 두 번째 단서다.
   *
   * 대소문자를 가리지 않는다. 필터가 비면 목록 전체다.
   */
  visible(){
    const q=(this._filter||'').trim().toLowerCase();
    if(!q) return this._list;
    return this._list.filter(s=>
      ((s.message||'')+' '+(s.base||'')).toLowerCase().includes(q));
  }

  _rowEl(s){
    const d=document.createElement('div');
    d.className='git-stash-row'+(this._sel===s.index?' sel':'');
    d.dataset.index=String(s.index);
    const r=document.createElement('span'); r.className='git-stash-ref';
    r.textContent=GitStash.ref(s.index);
    const m=document.createElement('span'); m.className='git-stash-msg';
    m.textContent=s.message||''; m.title=s.message||'';
    const b=document.createElement('span'); b.className='git-stash-base';
    b.textContent=s.base||'';
    // O12 와 같은 규약: 상대시간이 기본이고 절대시간은 title 로 항상 닿는다.
    const t=document.createElement('span'); t.className='git-stash-date';
    const abs=GitHistory.absTime(s.atUnixMs);
    t.textContent=GitHistory.relTime(s.atUnixMs); t.title=abs;
    d.appendChild(r); d.appendChild(m); d.appendChild(b); d.appendChild(t);
    d.addEventListener('click',()=>this._select(s.index));
    d.addEventListener('contextmenu',ev=>{ev.preventDefault();GitMenu.open('stash',s,ev)});
    return d;
  }

  // ── 미리보기 (FR-GIT-169) ──

  _select(i){
    if(this._sel===i){this._sel=null;this._files=null;this._filesFor=null}
    else{this._sel=i;this._files=null;this._filesErr=null;this._loadFiles(i)}
    this._paintList();
    this._paintPreview();
  }

  _paintPreview(){
    const el=this._el.querySelector('.git-stash-preview');
    const head=el.querySelector('.git-stash-preview-head');
    const box=el.querySelector('.git-stash-files');
    box.innerHTML='';
    if(this._sel==null){
      head.textContent=GIT_STASH_PICK;
      return;
    }
    if(this._filesErr){head.textContent=this._filesErr;return}
    if(!this._files){head.textContent=GIT_LOADING_HINT;return}
    head.textContent=this._files.length
      ?GIT_STASH_FILES+' ('+this._files.length+')':GIT_STASH_NO_FILES;
    for(const f of this._files) box.appendChild(this._fileEl(this._sel,f));
  }

  _fileEl(index,f){
    const d=document.createElement('div');
    d.className='git-stash-file'; d.dataset.path=f.path;
    const st=document.createElement('span'); st.className='git-stash-file-st';
    st.textContent=f.status;
    const p=document.createElement('span'); p.className='git-stash-file-path';
    p.textContent=f.origPath?f.origPath+' → '+f.path:f.path;
    d.title=p.textContent;
    d.appendChild(st); d.appendChild(p);
    // 축은 커밋 축이다 — stash 는 커밋이므로 `stash@{n}^` 과 비교한다.
    d.addEventListener('click',()=>this.panel.showCommitDiff({
      repo:this._repo,axis:GIT_AXIS.COMMIT,
      oid:GitStash.ref(index),parentOid:GitStash.ref(index)+'^',
      path:f.path,origPath:f.origPath||'',
    }));
    return d;
  }

  // ── 질의 ──

  // 다른 네 뷰(History·Branches·Console·Worktrees)와 같은 이름의 진입점이다.
  // 바깥에서 `_load()` 를 직접 부르면 뷰마다 부르는 이름이 갈린다.
  reload(){return this._load()}

  async _load(){
    const repo=this._repo; if(!repo) return;
    const tok=this.panel.token();
    this._loading=true;
    let r=null,d=null;
    try{r=await fetch('/api/git/stash?repo='+encodeURIComponent(repo))}catch{r=null}
    if(r&&r.ok){try{d=await r.json()}catch{d=null}}
    if(this.panel.isStale(tok)) return;
    this._loading=false;
    if(!d||!d.requested||d.requested.repo!==repo){
      this._err=GIT_STASH_LOAD_FAIL;
      if(this._el) this.paint();
      return;
    }
    this._err=null;
    this._list=Array.isArray(d.stashes)?d.stashes:[];
    if(this._el) this.paint();
  }

  async _loadFiles(index){
    const repo=this._repo; if(!repo) return;
    const tok=this.panel.token();
    const q=new URLSearchParams({repo,index:String(index)});
    let r=null,d=null;
    try{r=await fetch('/api/git/stash/show?'+q.toString())}catch{r=null}
    if(r&&r.ok){try{d=await r.json()}catch{d=null}}
    if(this.panel.isStale(tok)) return;
    // 뒤늦게 온 다른 stash 의 응답을 자기 것으로 읽지 않는다.
    if(this._sel!==index) return;
    const req=d&&d.requested;
    if(!d||!req||req.repo!==repo||req.index!==index){
      this._filesErr=GIT_STASH_PREVIEW_FAIL;
      this._paintPreview();
      return;
    }
    this._filesErr=null;
    this._files=Array.isArray(d.files)?d.files:[];
    this._filesFor=index;
    this._paintPreview();
  }

  /**
   * 조작 응답 하나의 처리 (FR-GIT-165·170).
   *
   * **실패 응답도 목록을 싣고 온다.** pop 이 충돌로 끝난 경우가 그것이며, 그 자리에
   * "stash 를 남겨 두었습니다" 를 보인다 — 조용히 넘기면 사용자가 작업을 잃었다고
   * 오해한다.
   */
  adoptWrite(res){
    const d=(res&&res.data)||{};
    if(Array.isArray(d.stashes)) this._list=d.stashes;
    if(res&&res.ok){
      this._note=null;
      // 선택은 인덱스로 매겨진 것이므로 목록이 바뀌면 뜻을 잃는다.
      this._sel=null; this._files=null; this._filesFor=null;
    }else if(d.stashKept){
      this._note={kind:'stash_kept',
        msg:GIT_STASH_KEPT+(d.stashKeptReason?' — '+d.stashKeptReason:'')};
    }else{
      this._note={kind:(d.error||'fail'),msg:this.panel.writeError(res)};
    }
    if(this._el) this.paint();
  }

  // stash 생성 다이얼로그 (FR-GIT-166).
  _create(){
    if(this._why()) return;
    new GitStashCreate(this.panel)._show();
  }
}

/**
 * stash 생성 다이얼로그 (FR-GIT-166, 검증 V58).
 *
 * 골격은 20단계의 `GitDialog` 다 (FR-GIT-171) — 메시지 / `--include-untracked` /
 * `--keep-index` 3필드를 그것에 선언하고, 이 클래스는 담길 것이 있는지의 판정과
 * 실행만 안다. 옵션의 기본값은 안전한 쪽이므로 둘 다 꺼져 있다 (FR-GIT-173).
 *
 * untracked 뿐인 저장소에서는 `--include-untracked` 없이 담길 것이 없다 — 그것을
 * 실행 전에 보인다 (FR-GIT-167). 서버도 `nothing_to_stash` 로 막지만, 실행해 보고
 * 알려 주면 사용자는 왜 아무 일도 없었는지 모른다.
 */
class GitStashCreate {
  constructor(panel){
    this.panel=panel;
    this.repo=panel.repo;
  }

  _show(){
    return GitDialog.open({
      id:'git-stash-create',ns:'gsc',action:'stash_push',
      title:GIT_STASH_CREATE_TITLE,runLabel:GIT_STASH_CREATE_RUN,focus:'message',
      fields:[
        {key:'message',type:GIT_DIALOG_TEXT,cls:'gsc-msg',
         placeholder:GIT_STASH_MSG_PLACEHOLDER},
        {key:'includeUntracked',type:GIT_DIALOG_CHECK,cls:'gsc-untracked',
         fieldCls:'gsc-optrow',label:GIT_STASH_OPT_UNTRACKED},
        {key:'keepIndex',type:GIT_DIALOG_CHECK,cls:'gsc-keepindex',
         fieldCls:'gsc-optrow',label:GIT_STASH_OPT_KEEPINDEX},
      ],
      validate:v=>this._why(v),
      run:v=>this._run(v),
    });
  }

  // 이 옵션으로 담길 것이 있는지 (FR-GIT-167). 서버의 StashableCount 와 같은 규칙이다.
  _why(v){
    const s=this.panel.statusOf();
    if(!s) return GIT_LOADING_HINT;
    const n=(s.staged||[]).length+(s.changes||[]).length+(s.conflicts||[]).length+
      (v.includeUntracked?(s.untracked||[]).length:0);
    if(n) return '';
    return (s.untracked||[]).length?GIT_STASH_UNTRACKED_ONLY:GIT_STASH_NOTHING;
  }

  async _run(v){
    const res=await this.panel.post('/api/git/stash/push',{
      repo:this.repo,
      message:(v.message||'').trim(),
      includeUntracked:!!v.includeUntracked,
      keepIndex:!!v.keepIndex,
    });
    // 조작 응답은 실행 후 목록과 status 를 함께 싣고 온다 (FR-GIT-170) — 실패
    // 응답도 그렇다.
    this.panel.afterStashWrite(res);
    if(res.ok) return {ok:true};
    // 실패 사유는 다이얼로그 안에 남는다 — 닫아 버리면 읽을 자리가 사라진다
    // (FR-GIT-175).
    return {ok:false,reason:this.panel.writeReason(res),
      stderrTail:(res.data&&res.data.message)||''};
  }
}

/**
 * Branch from stash 다이얼로그 (FR-GIT-272, 검증 V199).
 *
 * 골격은 20단계의 `GitDialog` 다 (FR-GIT-171) — 이름 한 필드를 선언하고, 이 클래스는
 * 실행만 안다. **파괴적이 아니다**: git 은 적용이 끝난 뒤에만 그 stash 를 지우므로
 * 실패하면 stash 가 그대로 남는다.
 *
 * 이름 규칙 전체를 여기서 판정하지 않는다 — 그것은 서버가 git 에 묻는다
 * (FR-GIT-159). 여기서 막는 것은 비어 있는 이름뿐이다.
 */
class GitStashBranch {
  constructor(panel,stash){
    this.panel=panel;
    this.repo=panel.repo;
    this.stash=stash;
  }

  _show(){
    return GitDialog.open({
      id:'git-stash-branch',ns:'gsb',action:'stash_branch',
      title:GIT_STASH_BRANCH_TITLE,runLabel:GIT_STASH_BRANCH_RUN,focus:'name',
      // 무엇에서 만드는지 보이지 않으면 사용자는 어느 stash 인지 알 수 없다
      // (FR-GIT-91 의 정신).
      body:GitStash.label(this.stash),
      fields:[
        {key:'name',type:GIT_DIALOG_TEXT,cls:'gsb-name',
         placeholder:GIT_STASH_BRANCH_NAME_PH},
      ],
      validate:v=>(v.name||'').trim()?'':GIT_STASH_BRANCH_NEED_NAME,
      run:v=>this._run(v),
    });
  }

  async _run(v){
    const res=await this.panel.post('/api/git/stash/branch',{
      repo:this.repo,index:this.stash.index,name:(v.name||'').trim(),
    });
    // 조작 응답은 실행 후 목록과 status 를 함께 싣고 온다 (FR-GIT-170) — 실패
    // 응답도 그렇다. **ref 가 바뀌므로 refs 도 다시 받는다** (FR-GIT-160):
    // status 만으로는 새 브랜치가 생겼는지 알 수 없다.
    this.panel.afterStashRefWrite(res);
    if(res.ok) return {ok:true};
    // 실패 사유는 다이얼로그 안에 남는다 — 닫아 버리면 읽을 자리가 사라진다
    // (FR-GIT-175).
    return {ok:false,reason:this.panel.writeReason(res),
      stderrTail:(res.data&&res.data.message)||''};
  }
}

// 고전 스크립트의 class 선언은 window 의 속성이 되지 않는다 — GitPanel 과 e2e 가
// 창 밖에서 부르므로 명시적으로 붙인다 (git-confirm.js 와 같은 규약).
window.GitStash=GitStash;
window.GitStashCreate=GitStashCreate;
window.GitStashBranch=GitStashBranch;
