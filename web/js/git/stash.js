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
    // FR-GRF-22: 이 리포의 목록을 받아 본 적이 있는가 (branches.js 와 같은 규약).
    this._loadedFor=null;
    this._note=null;   // {kind,msg} — pop 잔류·실패 안내
    this._sel=null;    // 선택된 stash 의 oid (FR-GIT-169, REPO_FIX 01 §5.3)
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

  // oid 의 지금 위치 이름. 표시에만 쓴다 — 식별은 oid 다 (REPO_FIX 01 §5.3).
  _refOf(oid){
    const s=this._list.find(x=>x.oid===oid);
    return s?GitStash.ref(s.index):oid.slice(0,GIT_DIFF_REV_ABBREV);
  }

  // ── 골격 ──

  mount(el){
    if(!el) return;
    this._el=el;
    el.innerHTML=
      '<div class="git-stash-bar">'+
        '<button class="ui-btn ui-btn-sm git-stash-new"></button>'+
        '<input class="git-stash-filter" type="text">'+
        '<span class="git-stash-why"></span>'+
      '</div>'+
      '<div class="git-stash-note">'+
        '<span class="git-stash-note-msg"></span>'+
        '<button class="ui-btn ui-btn-sm ui-btn-attn git-stash-note-close"></button>'+
      '</div>'+
      '<div class="git-stash-main">'+
        '<div class="git-stash-list ui-scroll"></div>'+
        '<div class="git-stash-preview ui-scroll">'+
          '<div class="git-stash-preview-head"></div>'+
          '<div class="git-stash-files"></div>'+
        '</div>'+
      '</div>';
    const stNew=el.querySelector('.git-stash-new');
    stNew.textContent=GIT_STASH_NEW; stNew.title=GIT_STASH_NEW_TITLE;
    const stClose=el.querySelector('.git-stash-note-close');
    stClose.textContent=GIT_NOTE_CLOSE; stClose.title=GIT_TIP_NOTE_CLOSE;
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
    // FR-GRF-23: 빈 목록이 굳지 않는다 (branches.js 의 같은 자리와 한 쌍).
    else if(this._repo&&!this._loading&&this._loadedFor!==this._repo) this._load();
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
    /**
     * FR-TIP-1·2: 툴팁은 **언제나** 있고 영어다.
     *
     * 종전에는 사유(`why`)를 그대로 실었으므로 누를 수 있는 동안에는 title 이
     * 빈 문자열이었다 — 정상일 때 아무 안내도 없었다는 뜻이다. 막혔을 때의
     * 사유는 버튼 옆 한 줄이 이미 한국어로 말하므로(FR-TIP-3) 여기서는 그
     * 사실만 영어로 옮긴다.
     */
    btn.title=why?GIT_STASH_BLOCKED_TITLE:GIT_STASH_NEW_TITLE;
    const w=el.querySelector('.git-stash-why');
    w.textContent=why;
    w.classList.toggle('vis',!!why);
    // 리포가 바뀌면 reset 이 필터를 비운다 — 입력도 그것을 따라간다. 치는 중에는
    // 둘이 같으므로 이 대입이 사용자의 입력을 되돌리지 않는다.
    const fi=el.querySelector('.git-stash-filter');
    if(fi.value!==this._filter) fi.value=this._filter;
  }

  _paintNote(){
    gitPaintNote(this._el,'git-stash',this._note);
  }


  /**
   * GIT_REFRESH_LIFECYCLE_SRS FR-GRF-17·20 (`GP-9`): **목록을 비우지 않는다.**
   *
   *   이전 동작: `box.innerHTML=''` 후 전부 다시 만들었다
   *   새  동작: `reconcileList` 를 지난다
   *   이유:     이 뷰는 **바깥 계기로** 다시 그려진다 — 관측 회차마다
   *             `_reloadViews`(panel-poll.js:157)가 `reload()` 를 부른다.
   *             전면 교체는 hover·선택·글자 선택·우클릭 앵커를 그때마다
   *             끊었다 (FR-RPT-1~7 이 금하는 그것이다)
   *
   * 안내문도 같은 목록의 한 항목이다 (FR-GRF-20).
   */
  _paintList(){
    const box=this._el.querySelector('.git-stash-list');
    const list=this._err?[]:this.visible();
    let note=null;
    if(this._err) note=this._err;
    else if(!list.length){
      // 목록이 있는데 안 보이는 것과 stash 자체가 없는 것은 다른 사실이다 —
      // 뭉개면 사용자는 자기 stash 가 사라진 것으로 읽는다.
      note=this._loading?GIT_LOADING_HINT
        :(this._list.length?GIT_STASH_FILTER_NONE:GIT_STASH_EMPTY);
    }
    const items=note===null?list.map(x=>({row:x})):[{note}];
    reconcileList(box,items,{
      key:it=>it.note!==undefined?'__note':('s:'+it.row.oid),
      sig:it=>it.note!==undefined?('n:'+it.note):this._rowSig(it.row),
      build:it=>{
        if(it.note!==undefined){
          const d=document.createElement('div'); d.className='ui-empty git-stash-empty';
          d.textContent=it.note;
          return d;
        }
        return this._rowEl(it.row);
      },
    });
  }

  // 행의 보이는 값 전부 (FR-RPT-2 · FR-GRF-19).
  _rowSig(s){
    return [s.index,s.message||'',s.base||'',s.atUnixMs||0,this._sel===s.oid?1:0].join('\u0000');
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
    d.className='git-stash-row'+(this._sel===s.oid?' sel':'');
    d.dataset.index=String(s.index);
    d.dataset.oid=s.oid;
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
    d.addEventListener('click',()=>this._select(s.oid));
    d.addEventListener('contextmenu',ev=>{ev.preventDefault();GitMenu.open('stash',s,ev)});
    return d;
  }

  // ── 미리보기 (FR-GIT-169) ──

  _select(oid){
    if(this._sel===oid){this._sel=null;this._files=null;this._filesFor=null}
    else{this._sel=oid;this._files=null;this._filesErr=null;this._loadFiles(oid)}
    this._paintList();
    this._paintPreview();
  }

  // FR-GRF-17: 미리보기 목록도 같은 규약이다. 머리글은 값 하나라 그대로 되쓴다.
  _paintPreview(){
    const el=this._el.querySelector('.git-stash-preview');
    const head=el.querySelector('.git-stash-preview-head');
    const box=el.querySelector('.git-stash-files');
    const sel=this._sel;
    let files=[];
    if(sel==null) head.textContent=GIT_STASH_PICK;
    else if(this._filesErr) head.textContent=this._filesErr;
    else if(!this._files) head.textContent=GIT_LOADING_HINT;
    else{
      head.textContent=this._files.length
        ?GIT_STASH_FILES+' ('+this._files.length+')':GIT_STASH_NO_FILES;
      files=this._files;
    }
    reconcileList(box,files,{
      key:f=>f.path,
      sig:f=>[f.status,f.path,f.origPath||'',sel].join('\u0000'),
      build:f=>this._fileEl(sel,f),
    });
  }

  _fileEl(oid,f){
    const d=document.createElement('div');
    d.className='git-stash-file'; d.dataset.path=f.path;
    const st=document.createElement('span'); st.className='git-stash-file-st';
    st.textContent=f.status;
    const p=document.createElement('span'); p.className='git-stash-file-path';
    p.textContent=f.origPath?f.origPath+' → '+f.path:f.path;
    d.title=p.textContent;
    d.appendChild(st); d.appendChild(p);
    // 축은 커밋 축이다 — stash 는 커밋이므로 `<oid>^` 와 비교한다. 위치
    // (`stash@{n}`)로 걸면 목록이 바뀐 뒤 다른 stash 의 diff 가 열린다.
    d.addEventListener('click',()=>this.panel.showCommitDiff({
      repo:this._repo,axis:GIT_AXIS.COMMIT,
      oid:oid,parentOid:oid+'^',revLabel:this._refOf(oid),
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
    // FR-GRF-31: 앞선 조회를 끊는다 (branches.js 의 같은 자리와 한 쌍).
    const t=gitLoadTicket(this);
    this._loading=true;
    const res=await gitFetch('/api/git/stash',{repo},
      {stale:()=>this.panel.isStale(tok),echo:{repo},signal:t.signal});
    if(gitLoadTaken(this,t)) return;
    // FR-GRF-24: 낡은 응답이 잠금을 쥔 채 나가지 않는다.
    this._loading=false;
    if(res.stale) return;
    this._loadedFor=repo;
    if(!res.ok){
      this._err=GIT_STASH_LOAD_FAIL;
      if(this._el) this.paint();
      return;
    }
    this._err=null;
    this._list=Array.isArray(res.data.stashes)?res.data.stashes:[];
    if(this._el) this.paint();
  }

  async _loadFiles(oid){
    const repo=this._repo; if(!repo) return;
    const tok=this.panel.token();
    // 뒤늦게 온 다른 stash 의 응답을 자기 것으로 읽지 않는다 — 선택이 바뀐 것은
    // stale 이고, oid 가 어긋난 것은 echo 가 잡는다.
    const res=await gitFetch('/api/git/stash/show',{repo,oid},
      {stale:()=>this.panel.isStale(tok)||this._sel!==oid,echo:{repo,oid}});
    if(res.stale) return;
    if(!res.ok){
      const d=res.data||{};
      // REPO_FIX 01 §5.3: 그 stash 가 사라졌다 — 서버가 실은 현재 목록으로 갈고
      // 선택을 푼다. 미리보기 자리는 이유를 말한다.
      if(d.error==='stash_moved'){
        if(Array.isArray(d.stashes)) this._list=d.stashes;
        this._sel=null; this._files=null; this._filesFor=null;
        this._filesErr=GIT_STASH_GONE;
        if(this._el) this.paint();
        return;
      }
      this._filesErr=GIT_STASH_PREVIEW_FAIL;
      this._paintPreview();
      return;
    }
    const d=res.data;
    this._filesErr=null;
    this._files=Array.isArray(d.files)?d.files:[];
    this._filesFor=oid;
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
    // REPO_FIX 01 §5.3: 선택은 oid 라 목록이 바뀌어도 같은 stash 를 가리킨다 —
    // 그 stash 가 목록에 남아 있으면 선택을 유지하고, 없으면 푼다.
    if(this._sel&&!this._list.some(x=>x.oid===this._sel)){
      this._sel=null; this._files=null; this._filesFor=null;
    }
    if(res&&res.ok){
      this._note=null;
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

// 고전 스크립트의 class 선언은 window 의 속성이 되지 않는다 — GitPanel 과 e2e 가
// 창 밖에서 부르므로 명시적으로 붙인다 (git-confirm.js 와 같은 규약).
window.GitStash=GitStash;
