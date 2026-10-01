/**
 * Dongminal — Git Worktrees 탭 (GIT_REVIEW4_SRS §3.6.5 / FR-GIT-240~244)
 *
 * 목록의 진실은 `git worktree list` 다 (FR-GIT-240) — 이 목록이 그것과 다르면
 * 사용자가 "내가 만든 게 어디 갔지" 를 헛갈린다. 그래서 **main worktree 도, Run
 * 격리가 만든 것도, dongminal 밖에서 만든 것도 함께 보인다.**
 *
 * main 이 아닌 worktree 는 소유와 무관하게 전부 지울 수 있다 (FR-GIT-241 개정,
 * WORKTREE_REMOVE_ALL_SRS FR-WRA-7). 소유는 표식일 뿐이다. 서버는 등록·main 여부를
 * 스스로 확인한다 — 판정을 두 벌로 두지 않는다.
 *
 * 제거는 실패해도 **200 으로 온다.** `removed:false` 와 `residue` 가 사유이며, 그중
 * `dirty` 는 "사용자 작업이 있어 지우지 않았다" 다 (FR-GIT-243). 그때는 두 번째
 * 확인을 열어 강제 제거를 묻는다 (FR-WRA-8). 취소하면 사유가 그 자리에 남는다.
 */
class GitWorktrees extends GitListTab {
  constructor(panel){
    super(panel,'git-wt');
  }

  // ── 골격이 채워 달라는 자리 (GitListTab, FR-DRC-7) ──

  _headHTML(){return '<button class="ui-btn ui-btn-sm git-wt-add"></button>'}

  _mountHead(el){
    const add=el.querySelector('.git-wt-add');
    add.textContent=GIT_WT_ADD; add.title=GIT_WT_ADD_TITLE;
    add.addEventListener('click',()=>this._create());
  }

  _emptyText(){return GIT_WT_EMPTY}

  _sigParts(e){
    return [e.path,e.branch||'',e.detached?1:0,e.owner||'',e.main?1:0,
      this._canOpen(e)?1:0,this._isPinned(e.path)?1:0];
  }

  // 활성 리포 행에는 열기를 붙이지 않는다 — 이미 그것이다 (FR-GIT-180 의 근거).
  _canOpen(e){return this.panel.repo!==e.path}

  /**
   * FR-GIT-249: 핀 여부의 근거는 좌측 GIT 섹션과 **같은 목록**이다 — 두 벌로 세면
   * 어긋난다. 비교는 문자열 일치다 (unpin 이 그렇게 지운다, FR-GIT-12).
   */
  _isPinned(path){
    const d=this.app.gitRepos;
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
      acts.appendChild(UIKit.button({label:GIT_WT_ACT_LABEL[a],title:GIT_WT_ACT_TITLE[a],size:'sm',
        cls:'git-wt-act',dataset:{act:a},onClick:ev=>{ev.stopPropagation();this._act(a,e)}}));
    }
    d.appendChild(acts);
    return d;
  }

  /**
   * 행이 가질 수 있는 동작 (FR-GIT-244).
   *
   * **제거는 main 이 아닐 때** 붙는다 (FR-WRA-7) — main worktree 는 저장소 자신이므로
   * 지울 대상이 아니다.
   */
  _actsOf(e){
    const acts=[];
    if(this._canOpen(e)) acts.push('open');
    // FR-GIT-249: 핀은 **상태의 토글**이다. 이미 핀된 것에 Pin 을 다시 보이면 서버의
    // 멱등 응답이 성공으로 와서 "핀했습니다" 만 뜨고 아무 일도 일어나지 않는다 —
    // 사용자는 그것을 고장으로 읽는다 (FR-GIT-180 과 같은 근거).
    acts.push(this._isPinned(e.path)?'unpin':'pin','term');
    if(!e.main) acts.push('remove');
    return acts;
  }

  _act(act,e){
    /**
     * REPO_TAB_UNIFY_SRS FR-RTU-72: **활성 리포로 열기 = 그 경로의 Repo 창으로.**
     *
     * `setRepo` 는 Repo 창의 패널에서 조기 반환한다 (저장소가 창의 루트다) —
     * 헤더 드롭다운과 같은 결함이었다 (D-RTU-27). worktree 는 목록에 없는 경로일
     * 수 있고 `openGitWindow` 가 그때 먼저 더한다.
     */
    if(act==='open'){this.app.openGitWindow(e.path);return}
    if(act==='pin'||act==='unpin'){this._pin(e,act==='unpin');return}
    // FR-GIT-244: 터미널은 **Git 창이 아닌 창**에 연다 (FR-GIT-41·185 와 같은 경로).
    if(act==='term'){this.app.gitOpenTerminal(e.path);return}
    if(act==='remove'){this._remove(e);return}
  }

  /**
   * 핀·해제 (FR-GIT-249). 안내는 **한 일**을 말한다.
   *
   * 실패는 이 탭의 안내 줄에만 보인다 — `gitPin` 은 결과만 돌려주고 스스로
   * 알리지 않는다. 같은 사실을 두 번 알리면 사용자는 두 가지 일이 일어난 줄로 읽는다.
   */
  async _pin(e,off){
    const ok=off?await this.app.gitUnpin(e.path)
                :(await this.app.gitPin(e.path)).ok;
    this._note=ok?{kind:off?'unpinned':'pinned',msg:(off?GIT_WT_UNPINNED:GIT_WT_PINNED)+e.path}
                 :{kind:'fail',msg:off?GIT_WT_UNPIN_FAIL:GIT_WT_PIN_FAIL};
    if(!this._el) return;
    this._paintNote();
    this._paintList();
  }

  // ── 질의 ──

  async _load(){
    await gitLoadList(this,{url:GIT_API.worktrees,key:'worktrees',failMsg:GIT_WT_LOAD_FAIL});
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
  async _remove(e){
    this._dirty=false;
    const done=await GitDialog.confirm({
      action:'worktree_remove',title:GIT_WT_REMOVE_TITLE,targets:[e.path],
      hint:{note:GIT_WT_REMOVE_NOTE,command:'git worktree remove '+gitShQuote(e.path)},
      stages:2,
      run:()=>this._runRemove(e,false),
    });
    if(!done||!this._dirty) return done;
    // FR-WRA-8: 저장하지 않은 변경을 잃는 것은 "지운다" 와 다른 동의다 — 첫 창이
    // 닫힌 뒤 따로 묻는다.
    return GitDialog.confirm({
      action:'worktree_remove',title:GIT_WT_FORCE_TITLE,targets:[e.path],
      hint:{note:GIT_WT_FORCE_NOTE,command:'git worktree remove --force '+gitShQuote(e.path)},
      stages:2,
      run:()=>this._runRemove(e,true),
    });
  }

  async _runRemove(e,force){
    const res=await this.panel.post(GIT_API.worktreesRemove,{
      repo:this.panel.repo,path:e.path,
      // 서버는 이 값을 받지만 UI 는 늘 false 다 (FR-GIT-243) — API 를 좁히지 않는다.
      deleteBranch:false,confirm:true,force,
    });
    const d=(res&&res.data)||{};
    if(res.ok){
      // FR-WRA-8: 첫 요청의 dirty 는 실패가 아니라 두 번째 확인의 계기다. 첫 창은
      // 닫고(사유는 안내 줄에 남긴다 — 두 번째를 취소하면 그대로 보인다) `_remove`
      // 가 강제 제거를 묻는다.
      if(d.residue==='dirty'&&!force){
        this._dirty=true;
        this._note={kind:'dirty',msg:GIT_WT_RESIDUE.dirty};
        this._load();
        return {ok:true};
      }
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
    const res=await this.panel.post(GIT_API.worktreesCreate,{
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
