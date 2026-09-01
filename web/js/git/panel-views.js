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
Object.assign(GitPanel.prototype, {
  // 커밋 영역은 지연 생성한다 — Git 창을 열지 않은 브라우저 창은 만들지 않는다.
  _commit(){
    if(!this._commitView) this._commitView=new GitCommit(this);
    return this._commitView;
  },

  // ── 원격 작업 (FR-GIT-98~112) ──

  // 원격 조각도 지연 생성한다. 진행 중 작업의 상태를 들고 있으므로 Changes 탭의
  // 골격보다 오래 산다.
  _remote(){
    if(!this._remoteView) this._remoteView=new GitRemote(this);
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

  // ── History 탭 (FR-GIT-113~139) ──

  _history(){
    if(!this._historyView) this._historyView=new GitHistory(this);
    return this._historyView;
  },

  _renderHistory(el){
    if(!this.repo){
      el.dataset.built=''; el.innerHTML='';
      // 골격을 버렸으므로 History 도 자기 DOM 을 놓아야 한다.
      this._history().unmount();
      const d=document.createElement('div'); d.className='git-empty';
      d.textContent=this._errMsg||GIT_NO_REPO_HINT;
      el.appendChild(d);
      return;
    }
    if(el.dataset.built!=='1'){this._history().mount(el);el.dataset.built='1'}
    this._history().paint();
    // FR-GHM-3·5: 머리는 History 의 것이 아니라 관측의 것이다 — GitHistory 는
    // 자리만 내주고 칠하기는 여기서 한다.
    this._paintHeadIn(el);
  },

  // ── Branches 탭 (FR-GIT-147~160) ──

  _branches(){
    if(!this._branchesView) this._branchesView=new GitBranches(this);
    return this._branchesView;
  },

  _renderBranches(el){
    if(!this.repo){
      el.dataset.built=''; el.innerHTML='';
      this._branches().unmount();
      const d=document.createElement('div'); d.className='git-empty';
      d.textContent=this._errMsg||GIT_NO_REPO_HINT;
      el.appendChild(d);
      return;
    }
    if(el.dataset.built!=='1'){this._branches().mount(el);el.dataset.built='1'}
    this._branches().paint();
  },

  // ── Console 탭 (FR-GIT-218) ──

  _console(){
    if(!this._consoleView) this._consoleView=new GitConsole(this);
    return this._consoleView;
  },

  _renderConsole(el){
    if(!this.repo){
      el.dataset.built=''; el.innerHTML='';
      this._console().unmount();
      const d=document.createElement('div'); d.className='git-empty';
      d.textContent=this._errMsg||GIT_NO_REPO_HINT;
      el.appendChild(d);
      return;
    }
    if(el.dataset.built!=='1'){this._console().mount(el);el.dataset.built='1'}
    this._console().paint();
  },

  // ── Worktrees 탭 (GIT_REVIEW4_SRS §3.6.5 / FR-GIT-240~244) ──

  _worktrees(){
    if(!this._worktreesView) this._worktreesView=new GitWorktrees(this);
    return this._worktreesView;
  },

  _renderWorktrees(el){
    if(!this.repo){
      el.dataset.built=''; el.innerHTML='';
      this._worktrees().unmount();
      const d=document.createElement('div'); d.className='git-empty';
      d.textContent=this._errMsg||GIT_NO_REPO_HINT;
      el.appendChild(d);
      return;
    }
    if(el.dataset.built!=='1'){this._worktrees().mount(el);el.dataset.built='1'}
    this._worktrees().paint();
  },

  // ── Stash 탭 (FR-GIT-161~170) ──

  _stash(){
    if(!this._stashView) this._stashView=new GitStash(this);
    return this._stashView;
  },

  _renderStash(el){
    if(!this.repo){
      el.dataset.built=''; el.innerHTML='';
      this._stash().unmount();
      const d=document.createElement('div'); d.className='git-empty';
      d.textContent=this._errMsg||GIT_NO_REPO_HINT;
      el.appendChild(d);
      return;
    }
    if(el.dataset.built!=='1'){this._stash().mount(el);el.dataset.built='1'}
    this._stash().paint();
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
      st.ahead||0,st.behind||0].join('\u0000');
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
  branchDelete(t){return GitBranches.del(this,t)},
  branchDeleteTargets(t){return GitBranches.targetsOf(this,t)},
  branchMerge(ref){return GitBranches.merge(this,ref)},
  branchRebase(ref){return GitBranches.rebase(this,ref)},
  branchSetUpstream(t){return GitBranches.setUpstream(this,t)},
  branchUnsetUpstream(t){return GitBranches.unsetUpstream(this,t)},
  branchPush(t){return GitBranches.push(this,t)},
  branchFetchInto(short){return GitBranches.fetchInto(this,short)},
  branchDeleteRemote(short){return GitBranches.deleteRemote(this,short)},
  // BRANCH_MENU_UNIFY_SRS FR-BMU-10: 로컬과 원격을 한 번에.
  branchDeleteBoth(t){return GitBranches.delBoth(this,t)},

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
