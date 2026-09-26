/**
 * GitPanel — 뷰 지연 생성과 하위 모듈 위임 (SPLIT_REFACTOR_SRS 묶음 B).
 *
 * History·Branches·Stash·Console·Worktrees·커밋·원격은 각자 클래스이고, 이 파일은
 * **그것들을 언제 만들고 무엇을 넘기는지**만 안다. Git 창을 열지 않은 브라우저는
 * 아무것도 만들지 않는다.
 *
 * 뒤쪽 한 줄짜리들(`branchMerge`·`tagPush` 등)은 파사드다 — 메뉴와 다이얼로그가
 * 패널 하나만 알면 되도록, 하위 모듈의 정적 메서드를 여기서 받는다.
 */
/**
 * OPTIMIZE_REFACTOR_SRS FR-OPT-12-2 (FEU-13): 목록 뷰 서술자. `make` 는 지연 생성, `afterPaint`
 * 는 뷰가 칠한 뒤 패널이 더 칠할 것이다.
 *
 * FR-GHM-3·5: History 의 머리는 History 의 것이 아니라 관측의 것이다 — GitHistory 는 자리만
 * 내주고 칠하기는 패널이 한다.
 */
const GIT_VIEW_KINDS={
  history:{make:p=>new GitHistory(p),afterPaint:(p,el)=>p._paintHeadIn(el)},
  branches:{make:p=>new GitBranches(p)},
  stash:{make:p=>new GitStash(p)},
  console:{make:p=>new GitConsole(p)},
  worktrees:{make:p=>new GitWorktrees(p)},
  submodules:{make:p=>new GitSubmodules(p)},
};

Object.assign(GitPanel.prototype, {
  // 커밋 영역은 지연 생성한다 — Git 창을 열지 않은 브라우저 창은 만들지 않는다.
  _commit(){
    if(!this._commitView) this._commitView=new GitCommit(this);
    return this._commitView;
  },

  // ── 원격 작업 (FR-GIT-98~112) ──

  // 원격 조각도 지연 생성한다. 진행 중 작업의 상태를 들고 있으므로 Changes 탭의
  // 골격보다 오래 산다. REPO_FIX 01 §6.4: 잡은 원격만이 아니고 칸이 둘이다 —
  // `GitJobs` 가 두 칸의 표시기를 하나로 묶는다.
  _remote(){
    if(!this._remoteView) this._remoteView=new GitJobs(this);
    return this._remoteView;
  },

  // 상태바 폴링이 받은 진행 중 작업 목록 (FR-GIT-101·112). 같은 리포의 작업이면
  // 원격 버튼이 막히고 출력이 이어진다.
  adoptJobs(jobs){
    // FR-SVS-44: 원격 작업은 리포의 사실이므로 **모든 칸**이 같은 진행을 본다.
    for(const p of this.obs.panels){
      if(!p._remoteView&&!(jobs||[]).length) continue;
      p._remote().adoptJobs(jobs);
    }
  },

  // 그룹 하나를 펼친다. pull 이 충돌로 끝나면 충돌 그룹이 접혀 있어서는 안 된다
  // (FR-GIT-111).
  expandGroup(key){
    if(!this._collapsed.has(key)) return;
    this._collapsed.delete(key);
    this._paint();
  },

  // ── 목록 뷰: History(FR-GIT-113~139) · Branches(FR-GIT-147~160) · Stash(FR-GIT-161~170) ·
  //    Console(FR-GIT-218) · Worktrees(FR-GIT-240~244) · Submodules(FR-SUB-6~11) ──
  // 여섯이 같은 골격이다 — 서술자는 `GIT_VIEW_KINDS`, 필드 이름은 `GIT_VIEWS` 가 갖는다.

  _viewOf(key){
    const f=GIT_VIEW_FIELD_BY_KEY[key];
    if(!this[f]) this[f]=GIT_VIEW_KINDS[key].make(this);
    return this[f];
  },
  _history(){return this._viewOf('history')},
  _branches(){return this._viewOf('branches')},
  _console(){return this._viewOf('console')},
  _worktrees(){return this._viewOf('worktrees')},
  _submodules(){return this._viewOf('submodules')},
  _stash(){return this._viewOf('stash')},

  _renderView(key,el){
    const v=this._viewOf(key);
    if(!this.repo){
      el.dataset.built=''; el.innerHTML='';
      // 골격을 버렸으므로 뷰도 자기 DOM 을 놓아야 한다.
      v.unmount();
      this._emptyHint(el,this._errMsg||GIT_NO_REPO_HINT);
      return;
    }
    if(el.dataset.built!=='1'){v.mount(el);el.dataset.built='1'}
    v.paint();
    const after=GIT_VIEW_KINDS[key].afterPaint;
    if(after) after(this,el);
  },

  // 저장소가 없을 때의 안내 한 줄.
  _emptyHint(el,text){
    const d=document.createElement('div'); d.className='ui-empty ui-empty-center git-empty';
    d.textContent=text;
    el.appendChild(d);
  },

  // 마지막 유효 status. Branches 의 현재 브랜치와 Stash 의 "담을 것이 있는지" 가
  // 같은 값을 딛는다 (FR-GIT-152·167).
  statusOf(){return (this._status&&this._status.status)||null},

  /**
   * FR-GVR-8: "Changes 밖의 뷰가 낡았는가" 의 근거.
   *
   * signature 는 창 안의 변화를 싸게 잡지만 원격 추적 ref 를 보지 않는다. 그
   * 구멍을 status 가 이미 들고 온 값으로 메운다 — `ahead`·`behind` 는 push·fetch
   * 가 움직이는 바로 그 수이고, `oid`·`branch`·`upstream` 은 History·Branches 가
   * 읽는 것이다. 파일 목록은 넣지 않는다: 그것은 Changes 의 몫이고, 넣으면 파일
   * 하나 저장할 때마다 History 를 다시 받는다.
   */
  _viewFp(d){
    const st=(d&&d.status)||{};
    return [(d&&d.signature&&d.signature.value)||'',
      st.oid||'',st.branch||'',st.upstream||'',
      st.ahead||0,st.behind||0].join(RPT_SEP);
  },

  // 지금 HEAD 가 가리키는 이름. detached 면 커밋 해시다 — 둘을 같게 보면 detached
  // 로 옮겨 간 것을 목록이 알아채지 못한다.
  headName(){
    const s=this.statusOf(); if(!s) return null;
    return s.detached?('#'+(s.oid||'')):(s.branch||'');
  },

  // ── 브랜치·태그 쓰기 (GIT_MENUS branch·tag 가 부른다) ──
  // 실행은 git-branches.js 에 있다 — 메뉴는 History 의 refs 사이드바에서도 열리므로
  // Branches 탭 인스턴스에 묶여 있으면 그쪽에서 쓸 수 없다.

  checkoutRef(ref,o){return GitBranches.checkout(this,ref,o||{})},
  checkoutRemote(short){return GitBranches.checkoutRemote(this,short)},

  // 묶음 B — 브랜치 동작 (GIT_ACTIONS_SRS §3.2 FR-GIT-253~259 · §3.5 FR-GIT-268).
  // 여기도 포워더뿐이다 — 실행은 git-branches.js 에 있다.
  branchRename(t){return GitBranches.rename(this,t)},
  branchDelete(t,names){return GitBranches.del(this,t,names)},
  branchDeleteTargets(t){return GitBranches.targetsOf(this,t)},
  branchMerge(ref){return GitBranches.merge(this,ref)},
  branchRebase(ref){return GitBranches.rebase(this,ref)},
  branchSetUpstream(t){return GitBranches.setUpstream(this,t)},
  branchUnsetUpstream(t){return GitBranches.unsetUpstream(this,t)},
  branchPush(t){return GitBranches.push(this,t)},
  branchFetchInto(short){return GitBranches.fetchInto(this,short)},
  branchDeleteRemote(short){return GitBranches.deleteRemote(this,short)},
  // BRANCH_MENU_UNIFY_SRS FR-BMU-10: 로컬과 원격을 한 번에.
  branchDeleteBoth(t,names){return GitBranches.delBoth(this,t,names)},
  // FR-BMU-16e: 메뉴가 짝과 그 사유를 묻는다 — 판정은 한 자리에 있다.
  branchDeletePair(t){return GitBranches.pairOf(this,t)},
  /**
   * FR-BMU-16h: ref 목록을 받는 자리. 부르는 쪽은 둘이다 (Branches · History).
   *
   * **덮어쓴다.** 둘은 같은 종단(`/api/git/refs`)을 보므로 나중 것이 더 새롭고,
   * 합치려 들면 사라진 ref 가 살아남는다.
   */
  adoptRefs(refs){this._knownRefs=Array.isArray(refs)?refs:[]},

  /**
   * OPTIMIZE_REFACTOR_SRS FR-OPT-4-9 (FEU-6): `/api/git/refs` 를 받는 한 자리. 회차
   * (`_inRefsRound`) 안이면 리포당 하나를 나눠 쓴다 — 그때는 부른 쪽의 `signal` 을 싣지
   * 않는다(한쪽이 끊으면 다른 쪽도 잃는다). 낡음은 부른 쪽마다 따로 본다.
   */
  fetchRefs(repo,opts){
    const o=opts||{};
    const round=this._refsRound;
    if(!round) return gitFetch(GIT_API.refs,{repo},{stale:o.stale,echo:{repo},signal:o.signal});
    if(!round.has(repo)) round.set(repo,gitFetch(GIT_API.refs,{repo},{echo:{repo}}));
    return round.get(repo).then(res=>
      (o.stale&&o.stale())?{ok:false,data:null,stale:true,status:res.status}:res);
  },

  // FR-GIT-255: 머지·리베이스의 충돌은 실패가 아니라 진행 중 상태다 — 사유를
  // Changes 탭 머리에 남기고 화면을 그리로 보낸다 (FR-GIT-111 과 같은 경로).
  branchNote(msg){this._note={msg,partial:false,changed:[]};this._paint()},

  // FR-GIT-249: 핀 목록이 바뀌었을 수 있다. 그것을 읽는 목록에만 넘긴다 — 판정을
  // 다시 그리기에 업지 않기 위한 통지 경로다 (FR-RPT-8, GitDialog.notify 와 같은 규약).
  notifyPins(){
    // FR-RMS-10: 소실 안내의 `핀 제거` 는 핀 여부를 딛는다. 핀이 바깥에서 바뀌면
    // 버튼이 따라와야 한다 — 안 그러면 방금 핀한 리포에 진입점이 없다 (FR-RPT-8).
    if(this._missing) this.obs.paintAllViews();
    for(const p of this.obs.panels) if(p._worktreesView) p._worktreesView.notifyPins();
  },

  // FR-GIT-141: 커밋 우클릭의 "여기서 브랜치 생성". 18단계의 생성 다이얼로그에
  // 시작점만 고정해 넘긴다 — 이름 검증도 그것이 이미 안다 (FR-GIT-158·159).
  createBranchFrom(oid){return GitBranches.create(this,{startRef:oid||''})},

  // ── 태그 쓰기 (GIT_MENUS tag·commit 이 부른다, FR-GIT-260~262) ──
  // 실행은 git/tag.js 에 있다 — 브랜치와 같은 이유로 static 이다: 태그 메뉴는
  // History 의 커밋 배지에서도 열린다.
  //
  // 삭제가 둘인 것은 로컬과 원격이 **다른 항목**이기 때문이다 (FR-GIT-261).

  createTag(oid){return GitTag.create(this,{ref:oid||''})},
  tagDelete(name){return GitTag.deleteLocal(this,name)},
  tagDeleteRemote(name){return GitTag.deleteRemote(this,name)},
  tagPush(name){return GitTag.push(this,name,false)},
  tagPushAll(){return GitTag.push(this,'',true)},

});
