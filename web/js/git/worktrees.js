/**
 * Dongminal — Git Worktrees 탭 (GIT_REVIEW4_SRS §3.6.5 / FR-GIT-240~244)
 *
 * 목록의 진실은 `git worktree list` 다 (FR-GIT-240) — 이 목록이 그것과 다르면
 * 사용자가 "내가 만든 게 어디 갔지" 를 헛갈린다. 그래서 **main worktree 도, Run
 * 격리가 만든 것도, dongminal 밖에서 만든 것도 함께 보인다.**
 *
 * 보이는 것과 지울 수 있는 것은 다르다 (FR-GIT-241). Run 것과 바깥 것에는 제거
 * 진입점을 **만들지 않는다** — 비활성으로 보이지도 않는다: 눌리지만 아무 일도 하지
 * 않는 버튼은 고장으로 읽힌다 (FR-GIT-180). 서버도 같은 것을 따로 판정하지 않고
 * `checkPath` 가 자기 영역 밖을 거부하는 것으로 막는다 — 판정을 두 벌로 두면 둘이
 * 어긋날 때 구멍이 생긴다.
 *
 * 제거는 실패해도 **200 으로 온다.** `removed:false` 와 `residue` 가 사유이며, 그중
 * `dirty` 는 "사용자 작업이 있어 지우지 않았다" 다 (FR-GIT-243). 조용히 넘기지 않고
 * 그 자리에 보인다 — 눌렀는데 아무 일도 없으면 사용자는 고장으로 읽는다.
 */
class GitWorktrees {
  constructor(panel){
    this.panel=panel;
    this.app=panel.app;
    this._el=null;
    this._repo=undefined;
    this.reset();
  }

  reset(){
    this._list=[];
    this._err=null;
    this._loading=false;
    this._note=null;   // {kind,msg}
  }

  // ── 골격 ──

  mount(el){
    if(!el) return;
    this._el=el;
    el.innerHTML=
      '<div class="git-wt-head">'+
        '<button class="git-wt-add"></button>'+
        '<span class="git-wt-spacer"></span>'+
      '</div>'+
      '<div class="git-wt-note">'+
        '<span class="git-wt-note-msg"></span>'+
        '<button class="git-wt-note-close"></button>'+
      '</div>'+
      '<div class="git-wt-list"></div>'+
      '<div class="git-wt-empty"></div>';
    el.querySelector('.git-wt-add').textContent=GIT_WT_ADD;
    el.querySelector('.git-wt-note-close').textContent=GIT_NOTE_CLOSE;
    el.querySelector('.git-wt-add').addEventListener('click',()=>this._create());
    el.querySelector('.git-wt-note-close').addEventListener('click',()=>{
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
    this._paintNote();
    this._paintList();
  }

  // FR-GIT-238: 새로고침이 부르는 공개 진입점. 목록만 다시 받는다.
  reload(){
    if(!this._el||this.panel.repo!==this._repo) return;
    return this._load();
  }

  _adopt(){
    this._repo=this.panel.repo;
    this.reset();
    if(!this._repo) return;
    this._load();
  }

  _paintNote(){
    const box=this._el.querySelector('.git-wt-note');
    const n=this._note;
    box.classList.toggle('vis',!!n);
    box.dataset.kind=(n&&n.kind)||'';
    box.querySelector('.git-wt-note-msg').textContent=(n&&n.msg)||'';
  }

  /**
   * FR-GIT-245: 이 목록이 바깥 계기로 다시 그려지면 FR-RPT-1·3 을 따른다. 지금
   * 계기는 자기 것뿐이지만 공통 수단을 쓴다 — 목록마다 손으로 막으면 다음 목록에서
   * 또 빠진다 (FR-RPT-6). 판정 근거는 **행이 읽는 값 전부**다 (FR-RPT-2).
   */
  _paintList(){
    const box=this._el.querySelector('.git-wt-list');
    const empty=this._el.querySelector('.git-wt-empty');
    const msg=this._err||(this._list.length?'':(this._loading?GIT_LOADING_HINT:GIT_WT_EMPTY));
    empty.textContent=msg;
    empty.classList.toggle('vis',!!msg);
    reconcileList(box,this._err?[]:this._list,{
      key:e=>e.path,
      sig:e=>this._sig(e),
      build:e=>this._rowEl(e),
    });
  }

  _sig(e){
    return [e.path,e.branch||'',e.detached?1:0,e.owner||'',e.main?1:0,
      this._canOpen(e)?1:0,this._isPinned(e.path)?1:0].join('\u0001');
  }

  // 활성 리포 행에는 열기를 붙이지 않는다 — 이미 그것이다 (FR-GIT-180 의 근거).
  _canOpen(e){return this.panel.repo!==e.path}

  /**
   * FR-GIT-249: 핀 여부의 근거는 좌측 GIT 섹션과 **같은 목록**이다 — 두 벌로 세면
   * 어긋난다. 비교는 문자열 일치다 (unpin 이 그렇게 지운다, FR-GIT-12).
   */
  _isPinned(path){
    const d=this.app._gitRepos;
    return !!(d&&Array.isArray(d.pinned)&&d.pinned.some(p=>p&&p.path===path));
  }

  /**
   * FR-GIT-249 (FR-RPT-8): 핀 목록이 **도착하는 자리**에서 불린다 — 판정을 그리기에
   * 업으면 상태 관측이 같은 회차에 버튼이 낡은 채로 남는다 (FR-GIT-227). 행의
   * `_sig` 가 핀 여부를 읽으므로 바뀐 행만 다시 만들어진다.
   */
  notifyPins(){
    if(this._el&&this.panel.repo===this._repo) this._paintList();
  }

  _rowEl(e){
    const d=document.createElement('div');
    d.className='git-wt-row'+(e.main?' main':'');
    d.dataset.path=e.path; d.dataset.own=e.owner||'';

    const p=document.createElement('span'); p.className='git-wt-path';
    // 만들어진 경로를 보인다 (FR-GIT-242) — 어디에 생겼는지 모르면 터미널에서
    // 찾을 수 없다. 좁으면 잘리므로 title 로 항상 닿게 한다.
    p.textContent=e.path; p.title=e.path;

    const b=document.createElement('span');
    b.className='git-wt-branch'+(e.detached?' detached':'');
    b.textContent=e.detached?GIT_WT_DETACHED:(e.branch||'');

    const o=document.createElement('span'); o.className='git-wt-own';
    o.dataset.own=e.owner||'';
    o.textContent=GIT_WT_OWN_LABEL[e.owner]||'';
    if(GIT_WT_OWN_TITLE[e.owner]) o.title=GIT_WT_OWN_TITLE[e.owner];

    d.appendChild(p); d.appendChild(b); d.appendChild(o);
    if(e.main){
      const m=document.createElement('span'); m.className='git-wt-main';
      m.textContent=GIT_WT_MAIN;
      d.appendChild(m);
    }
    const sp=document.createElement('span'); sp.className='git-wt-rowspacer';
    d.appendChild(sp);

    const acts=document.createElement('span'); acts.className='git-wt-acts';
    for(const a of this._actsOf(e)){
      const btn=document.createElement('button');
      btn.className='git-wt-act'; btn.dataset.act=a;
      btn.textContent=GIT_WT_ACT_LABEL[a]; btn.title=GIT_WT_ACT_TITLE[a];
      btn.addEventListener('click',ev=>{ev.stopPropagation();this._act(a,e)});
      acts.appendChild(btn);
    }
    d.appendChild(acts);
    return d;
  }

  /**
   * 행이 가질 수 있는 동작 (FR-GIT-244).
   *
   * **제거는 사용자 것에만, main 이 아닐 때만** 붙는다 (FR-GIT-241) — main worktree
   * 는 저장소 자신이므로 지울 대상이 아니다.
   */
  _actsOf(e){
    const acts=[];
    if(this._canOpen(e)) acts.push('open');
    // FR-GIT-249: 핀은 **상태의 토글**이다. 이미 핀된 것에 Pin 을 다시 보이면 서버의
    // 멱등 응답이 성공으로 와서 "핀했습니다" 만 뜨고 아무 일도 일어나지 않는다 —
    // 사용자는 그것을 고장으로 읽는다 (FR-GIT-180 과 같은 근거).
    acts.push(this._isPinned(e.path)?'unpin':'pin','term');
    if(e.owner==='user'&&!e.main) acts.push('remove');
    return acts;
  }

  _act(act,e){
    if(act==='open'){this.panel.setRepo(e.path);return}
    if(act==='pin'||act==='unpin'){this._pin(e,act==='unpin');return}
    // FR-GIT-244: 터미널은 **Git 창이 아닌 창**에 연다 (FR-GIT-41·185 와 같은 경로).
    if(act==='term'){this.app._gitOpenTerminal(e.path);return}
    if(act==='remove'){this._remove(e);return}
  }

  /**
   * 핀·해제 (FR-GIT-249). 안내는 **한 일**을 말한다.
   *
   * 실패는 이 탭의 안내 줄에만 보인다 — `_gitPin` 은 결과만 돌려주고 스스로
   * 알리지 않는다. 같은 사실을 두 번 알리면 사용자는 두 가지 일이 일어난 줄로 읽는다.
   */
  async _pin(e,off){
    const ok=off?await this.app._gitUnpin(e.path)
                :(await this.app._gitPin(e.path)).ok;
    this._note=ok?{kind:off?'unpinned':'pinned',msg:(off?GIT_WT_UNPINNED:GIT_WT_PINNED)+e.path}
                 :{kind:'fail',msg:off?GIT_WT_UNPIN_FAIL:GIT_WT_PIN_FAIL};
    if(!this._el) return;
    this._paintNote();
    this._paintList();
  }

  // ── 질의 ──

  async _load(){
    const repo=this._repo; if(!repo) return;
    const tok=this.panel.token();
    this._loading=true;
    // stale 가드는 **보낸 값의 echo** 로 짝을 맞춘다 (FR-GIT-16). `d.repo` 는
    // 서버가 정규화한 루트라 보낸 값과 다를 수 있고, 그것으로 비교하면 목록이
    // 영원히 실패로 남는다 — gitEchoOk 가 그 함정을 안다.
    const res=await gitFetch('/api/git/worktrees',{repo},
      {stale:()=>this.panel.isStale(tok),echo:{repo}});
    if(res.stale) return;
    this._loading=false;
    if(!res.ok){
      this._err=GIT_WT_LOAD_FAIL;
      if(this._el) this.paint();
      return;
    }
    const d=res.data;
    this._err=null;
    this._list=Array.isArray(d.worktrees)?d.worktrees:[];
    if(this._el) this.paint();
  }

  // ── 생성·제거 ──

  _create(){
    if(!this.panel.repo) return;
    new GitWorktreeCreate(this)._show();
  }

  /**
   * 제거 (FR-GIT-243). 파괴적이므로 확인을 거친다 — 기존 확인 규약을 그대로 쓴다.
   *
   * **트리만 지운다.** 브랜치 삭제를 여기 싣지 않는 이유는 파괴적 확인이 옵션 폼을
   * 받지 않기 때문이다 — `GitConfirm.open` 의 인자에 `fields` 가 없고 `GitDialog` 가
   * "옵션 폼을 얹은 파괴적 동작은 아직 없다" 고 적어 두었다 (`dialog.js`). 한 동작에
   * 창을 둘 띄우지도 않는다. 브랜치 삭제의 자리는 Branches 탭이다.
   */
  _remove(e){
    return GitDialog.confirm({
      action:'worktree_remove',title:GIT_WT_REMOVE_TITLE,targets:[e.path],
      hint:{note:GIT_WT_REMOVE_NOTE,command:'git worktree remove '+gitShQuote(e.path)},
      stages:2,
      run:()=>this._runRemove(e),
    });
  }

  async _runRemove(e){
    const res=await this.panel.post('/api/git/worktrees/remove',{
      repo:this.panel.repo,path:e.path,
      // 서버는 이 값을 받지만 UI 는 늘 false 다 (FR-GIT-243) — API 를 좁히지 않는다.
      deleteBranch:false,confirm:true,
    });
    const d=(res&&res.data)||{};
    if(res.ok){
      // **`residue` 는 `removed` 와 독립이다.** 지우지 않은 경우(`dirty`)뿐 아니라
      // "지웠으나 남은 것이 있는" 경우(`branch-retained`)도 성공 응답으로 온다 —
      // `removed` 만 보면 뒤쪽을 조용히 넘긴다.
      if(d.residue){
        const why=GIT_WT_RESIDUE[d.residue]||GIT_WT_REMOVE_FAIL;
        this._note={kind:d.residue,msg:why+(d.detail?' — '+d.detail:'')};
        this._load();
        // 트리가 지워졌으면 이 동작은 끝난 것이다 — 남은 것은 안내로만 알린다.
        return d.removed?{ok:true}:{ok:false,reason:why,stderrTail:d.detail||''};
      }
      this._note=null;
      this._load();
      return {ok:true};
    }
    return {ok:false,reason:this.panel.writeReason(res),
      stderrTail:(d&&d.message)||''};
  }
}

/**
 * worktree 생성 다이얼로그 (FR-GIT-242).
 *
 * 골격은 `GitDialog` 다 (FR-GIT-171) — 이름 / 대상 ref / 새 브랜치 여부 3필드를 그것에
 * 선언한다. **경로를 묻지 않는다**: 경로는 이름에서 파생하며(FR-WKT-13) 서버가 임의
 * 경로에 디렉터리를 만드는 표면을 열지 않는다. 대신 **만들어진 경로를 보인다** —
 * 어디에 생겼는지 모르면 터미널에서 찾을 수 없다.
 */
class GitWorktreeCreate {
  constructor(view){
    this.view=view;
    this.panel=view.panel;
    this.repo=view.panel.repo;
  }

  _show(){
    return GitDialog.open({
      id:'git-wt-create',ns:'gwc',action:'worktree_create',
      title:GIT_WT_CREATE_TITLE,runLabel:GIT_WT_CREATE_RUN,focus:'name',
      fields:[
        {key:'name',type:GIT_DIALOG_TEXT,cls:'gwc-name',placeholder:GIT_WT_NAME_PH},
        {key:'ref',type:GIT_DIALOG_TEXT,cls:'gwc-ref',placeholder:GIT_WT_REF_PH},
        {key:'newBranch',type:GIT_DIALOG_CHECK,cls:'gwc-newbranch',
         fieldCls:'gwc-optrow',label:GIT_WT_OPT_NEWBRANCH},
      ],
      validate:v=>this._why(v),
      run:v=>this._run(v),
    });
  }

  _why(v){
    if(!(v.name||'').trim()) return GIT_WT_NEED_NAME;
    if(!(v.ref||'').trim()) return GIT_WT_NEED_REF;
    return '';
  }

  async _run(v){
    const res=await this.panel.post('/api/git/worktrees/create',{
      repo:this.repo,name:(v.name||'').trim(),ref:(v.ref||'').trim(),
      newBranch:!!v.newBranch,
    });
    const d=(res&&res.data)||{};
    if(res.ok){
      this.view._note={kind:'created',msg:GIT_WT_CREATED+(d.path||'')};
      this.view._load();
      return {ok:true};
    }
    // 실패 사유는 다이얼로그 안에 남는다 — 닫아 버리면 읽을 자리가 사라진다
    // (FR-GIT-175).
    return {ok:false,reason:this.panel.writeReason(res),
      stderrTail:(d&&d.message)||''};
  }
}

// 고전 스크립트의 class 선언은 window 의 속성이 되지 않는다 — GitPanel 과 e2e 가
// 창 밖에서 부르므로 명시적으로 붙인다 (stash.js 와 같은 규약).
window.GitWorktrees=GitWorktrees;
