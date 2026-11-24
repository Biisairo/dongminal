/**
 * Otterminal — Git 창의 표면 (GIT_SRS §3.4)
 *
 * Git 창은 워크스페이스에 하나이므로(FR-GIT-26) 이 객체도 앱에 하나다. GIT_VIEWS 의
 * 고정 탭은 각자 루트 DOM 을 갖고, 활성 탭의 루트만 pane 본문에 붙는다 — 숫자를 여기
 * 적지 않는다 (FR-GIT-28 이 개정될 때 이 주석이 낡는다).
 *
 * 활성 리포가 바뀌면 진행 중인 응답은 전부 버린다 (FR-GIT-16). 세대 카운터
 * 하나로 판정한다 — 나중에 비동기 경로를 하나씩 훑어 가드를 덧붙이는 상황을
 * 만들지 않으려고 처음부터 둔다. 판정은 이 클래스의 `token`/`isStale` 이다.
 *
 * 클래스 본문에는 생성자·접근자·리포 전환과 수명(옛 `panel-life.js`)이 있다. 접근자가
 * 클래스 본문에 있는 이유는 `Object.assign` 이 getter 를 **호출해 그 반환값을 복사**하기 때문이다 —
 * 원형에 얹으면 통로가 값으로 굳는다 (REFACTOR3_FE_GITPANEL_SRS INV-P3).
 *
 * 나머지는 부품 클래스(`GitPart` 하위, REFACTOR3_FE_GITPANEL_SRS)다. 부품은 혼자 쓰는 필드까지 갖고
 * 생성자가 만들어 든다. 바깥·다른 부품은 `panel.<부품>.X` 로 부품 메서드를 부른다 — 패널에 위임자를 두지 않는다 (REFACTOR3_FE_DELEG_SRS).
 *
 *   git-blame.js      Blame (`this.blame`)
 *   git-hunks.js      부분 스테이징 · hover 툴바 (`this.hunks`)
 *   git-diff-pane.js  Diff 탭 · Diff 탭 전용 패널의 몫 · 보기 설정 (`this.diffPane`)
 *   git-poll.js       접기 설정 · 폴링 · 상태 적용 (`this.poll`)
 *   git-view-reload.js 새로고침 · 뷰 다시 받기 · refs 회차 (`this.viewReload`)
 *   git-write.js      쓰기 한 번의 전과 후 — 후처리 훅 · 결과 해석 · 오퍼레이션 (`this.write`)
 *   git-changes.js    Changes 탭 — 골격 · 칠하기 · 머리 · git init (`this.changes`)
 *   git-change-rows.js Changes 탭의 그룹 · 트리 · 행 (`this.changeRows`)
 *   git-files.js      파일 작업 · 스테이징 · discard (`this.files`)
 *   git-selection.js  선택(→ diff) · 뷰 열기 · 디렉터리 항목의 사유와 진입점 (`this.selection`)
 *   git-views.js      뷰 지연 생성 · 상태 접근 · 브랜치/태그 파사드 (`this.views`)
 *   git-view-roots.js 뷰 루트 · 그리기 분기 · 낡음 배너 · 소실 안내와 복구 (`this.viewRoots`)
 *
 * 관측(`GitObserver`)은 observer.js, Diff 편집기(`GitDiffView`)는 diff-view.js 다.
 */
class GitPanel {
  /**
   * REPO_TAB_UNIFY_SRS FR-RTU-60: 패널은 **(루트, 칸)마다** 하나다.
   *
   * `root` 는 이 패널이 속한 Repo 창의 루트다. 빈 문자열은 **옛 Git 창**의
   * 것이며(마이그레이션 전까지 공존한다, FR-RTU-70) 그 창이 사라지면 함께
   * 사라진다.
   *
   * 종전에는 키가 칸 번호뿐이었고 그 근거가 "Git 창은 워크스페이스에 하나" 였다
   * (FR-GIT-26). 창이 경로마다 생기는 순간 그 전제가 깨져, 두 창이 같은 패널을
   * 다투게 된다 — 한쪽에서 고른 파일이 다른 쪽의 diff 에 뜬다.
   */
  constructor(app,root){
    this.app=app;
    this.root=root||'';
    // FR-SVS-30·40: 관측은 앱에 하나이고 이 패널은 그것을 **빌려 본다**. 아래
    // 접근자들이 `this._status` 같은 이름을 그대로 observer 로 잇는다 — 패널의
    // 본문이 관측의 자리를 알 필요가 없다.
    // 관측은 **이 패널의 저장소**의 것이다 (FR-RTU-64) — 앱에 하나가 아니다.
    this.obs=app.git.surfaces.gitObs(this.root);
    this.obs.attach(this);

    this._els=new Map(); // view key → 루트 DOM. **칸마다 따로다** (FR-SVS-42)
    this._collapsed=new Set();    // 접힌 그룹. 뷰의 성질이라 리포 전환에도 남는다
    this._dirCollapsed=new Set(); // 접힌 트리 디렉터리 (group:path)
    this._shown=new Map();        // 그룹별로 그린 행 수 (FR-GIT-42)
    this.previewFile=null;        // {repo,group,axis,path,origPath}. 미리보기와 Diff 탭이 같이 쓴다
    this._diffView=null;          // Diff 탭의 GitDiffView
    this._diffKey=null;           // 그 뷰에 이미 보인 대상 (재요청 방지)
    // 부분 스테이징 (FR-GIT-278·279). 조각은 서버가 만든 diff 에서 온다 — 여기서
    // 만들지 않는다. _hunkKey 는 이미 받아 둔 대상, _hunks 는 그 관측이다.
    this._hunkKey=null;
    this._hunks=null;             // {diffId,list,note} 또는 {err}
    this._diffPos=0;              // 목록에서 사라진 대상을 클램프할 기준 (FR-GIT-53)
    this._sel=new Set();          // 다중 선택 (FR-GIT-69). group\0path
    this._anchor=null;            // Shift 범위 선택의 기준 행
    this._note=null;              // 쓰기 실패·부분 적용 안내 (FR-GIT-73)
    this._commitView=null;        // 커밋 영역 (FR-GIT-74~85)
    this._historyView=null;       // History 탭 (FR-GIT-113~139)
    this._branchesView=null;      // Branches 탭 (FR-GIT-147~160)
    this._stashView=null;         // Stash 탭 (FR-GIT-161~170)
    this._consoleView=null;       // Console 탭 (FR-GIT-218)
    this._worktreesView=null;     // Worktrees 탭 (FR-GIT-240~244)
    this._submodulesView=null;    // Submodules 탭 (UX_BATCH5_SRS 묶음 SUB)
    this._remoteView=null;        // 원격 작업 (FR-GIT-98~112)
    // 커밋 축의 diff 대상 (FR-GIT-138). previewFile 과 자리를 나눈다 — 같은 자리에
    // 두면 Changes 탭의 미리보기가 커밋의 diff 를 보이면서 목록에는 아무 행도
    // 선택되지 않는다.
    this.commitFile=null;
    // 부품 (REFACTOR3_FE_GITPANEL_SRS FR-FEP-3). 혼자 쓰는 필드는 부품이 갖는다.
    this.blame=new GitBlame(this);
    this.hunks=new GitHunks(this);
    this.diffPane=new GitDiffPane(this);
    this.poll=new GitPoll(this);
    this.viewReload=new GitViewReload(this);
    this.write=new GitWrite(this);
    this.changes=new GitChanges(this);
    this.changeRows=new GitChangeRows(this);
    this.files=new GitFiles(this);
    this.selection=new GitSelection(this);
    this.views=new GitViews(this);
    this.viewRoots=new GitViewRoots(this);
  }

  // ── 관측으로 가는 통로 (FR-SVS-30) ──
  //
  // 이름은 예전과 같으므로 패널의 본문은 한 줄도 바뀌지 않는다 — 바뀐 것은 **그
  // 값이 어디 사는지**뿐이다. `_writing` 과 폴링 타이머가 여기 있는 덕에 칸이
  // 넷이어도 요청과 쓰기는 한 벌이다 (FR-SVS-31·45).
  get _gen(){ return this.obs._gen } set _gen(v){ this.obs._gen=v }
  get _status(){ return this.obs._status } set _status(v){ this.obs._status=v }
  get _lastSig(){ return this.obs._lastSig } set _lastSig(v){ this.obs._lastSig=v }
  get _lastViewFp(){ return this.obs._lastViewFp } set _lastViewFp(v){ this.obs._lastViewFp=v }
  get _errMsg(){ return this.obs._errMsg } set _errMsg(v){ this.obs._errMsg=v }
  get _staleNote(){ return this.obs._staleNote } set _staleNote(v){ this.obs._staleNote=v }
  get _refreshing(){ return this.obs._refreshing } set _refreshing(v){ this.obs._refreshing=v }
  get _gitMissing(){ return this.obs._gitMissing } set _gitMissing(v){ this.obs._gitMissing=v }
  get _seq(){ return this.obs._seq } set _seq(v){ this.obs._seq=v }
  get _missing(){ return this.obs._missing } set _missing(v){ this.obs._missing=v }
  get _failStreak(){ return this.obs._failStreak } set _failStreak(v){ this.obs._failStreak=v }
  get _obsSig(){ return this.obs._obsSig } set _obsSig(v){ this.obs._obsSig=v }
  get _lastObsAt(){ return this.obs._lastObsAt } set _lastObsAt(v){ this.obs._lastObsAt=v }
  get _writing(){ return this.obs._writing } set _writing(v){ this.obs._writing=v }
  get _writeGen(){ return this.obs._writeGen } set _writeGen(v){ this.obs._writeGen=v }
  get _notRepo(){ return this.obs._notRepo } set _notRepo(v){ this.obs._notRepo=v }
  get _busy(){ return this.obs._busy } set _busy(v){ this.obs._busy=v }
  get _again(){ return this.obs._again } set _again(v){ this.obs._again=v }
  get _sigT(){ return this.obs._sigT } set _sigT(v){ this.obs._sigT=v }
  get _pollOn(){ return this.obs._pollOn } set _pollOn(v){ this.obs._pollOn=v }
  get _pollSt(){ return this.obs._pollSt } set _pollSt(v){ this.obs._pollSt=v }
  get _stPoll(){ return this.obs._stPoll } set _stPoll(v){ this.obs._stPoll=v }

  // 활성 리포. Git 창의 win.git.repo 가 진실이고 이것은 그 읽기다 (FR-GIT-29).
  /**
   * 이 패널이 보는 저장소.
   *
   * **소유자가 둘로 갈린다** (REPO_TAB_UNIFY_SRS FR-RTU-60·65).
   *
   *   Repo 창(`root` 있음)  창의 루트가 곧 저장소다. **바뀌지 않는다** — 창
   *                          하나가 저장소 하나이므로 갈아탈 대상이 없다
   *   옛 Git 창             사용자가 사이드바에서 고른 리포이며 창 레코드
   *                          (`w.git.repo`)가 그것을 든다 (FR-GIT-29)
   *
   * 종전에는 아래 절만 있었다. 그래서 Repo 창의 패널은 Git 창이 없는 순간
   * `null` 을 돌려주었고, Changes 사이드가 "리포를 선택하세요" 로 굳었다(실측).
   */
  get repo(){
    if(this.root) return this.root;
    const w=this.app.git.gitWindow();
    return (w&&w.git&&w.git.repo)||null;
  }

  // ── 리포 전환과 수명 (옛 panel-life.js) — 이 패널이 지금 무엇을 보고 있으며 그것이 유효한가 ──

  setRepo(path){
    // FR-RTU-60: Repo 창의 패널은 저장소가 **고정**이다 (창의 루트가 그것이다) —
    // 갈아탈 대상이 없으므로 전환도 없다. 그 값은 `repo` getter 가 준다.
    if(this.root) return;
    const w=this.app.git.gitWindow(); if(!w) return;
    if(!w.git) w.git={repo:null};
    if(w.git.repo===path) return;
    w.git.repo=path;
    this._gen++;
    // 이전 리포의 목록이 새 리포의 헤더와 함께 보이는 순간이 있어서는 안 된다
    // (FR-GIT-16). 화면을 "불러오는 중" 으로 되돌린다.
    this._status=null; this._lastSig=null; this._lastViewFp=null; this._staleNote=false;
    // 소실과 실패 누적은 **리포에 붙은 것**이다 — 새 리포로 넘겨 오면 남의 사실이
    // 된다 (FR-RMS-6·22).
    this._missing=null; this._failStreak=0;
    // 관측을 버렸으므로 근거도 버린다 — 새 리포의 첫 관측은 무조건 그린다.
    this._obsSig=null;
    GitMenu.close();
    if(path) this._errMsg=null;
    // 진행 중인 요청의 소유권을 끊는다 — 그 응답은 가드에 걸려 버려지고, 새 리포는
    // 앞선 요청이 끝나기를 기다리지 않는다.
    this._seq++; this._busy=false; this._again=false;
    // F-4.2: 앞 저장소를 향해 줄 선 stage/unstage/discard 는 보내지 않는다.
    this.obs.wqDrop();
    if(this._sigT){TIMERS.cancel(this._sigT);this._sigT=null}
    // FR-SVS-34: 활성 리포는 창의 것이므로 **모든 칸이 같은 리포를 본다.** 그래서
    // 리포에 붙은 시선은 칸마다 되돌아간다 — 한 칸만 되돌리면 다른 칸이 이전
    // 리포의 선택·diff 를 새 리포의 헤더와 함께 보인다.
    for(const p of this.obs.panels) p._repoSwitchView(path);
    // 마지막 관측을 버렸으므로 chip 도 사라져야 한다 (FR-GIT-59).
    this.app.statusbar.updateStatusBar();
    // 상단의 창 이름은 활성 리포에서 온다 — 같은 창에서 리포만 바뀌면 render 가
    // 돌지 않으므로(아래 주석의 조기 반환) 여기서 직접 고쳐 그린다.
    this.app.renderer._rTopbar();
    this.poll._stop(); this.poll._reschedule();
    // 활성 리포는 창에 붙어 영속한다 (FR-GIT-29). switchWindow 가 이미 활성인
    // 창에서는 조기 반환하므로 여기서 직접 저장한다 — 저장을 그쪽에 맡기면
    // "같은 창에서 리포만 바꾼" 경우가 새로고침에서 사라진다.
    this.app.wsSave.save();
  }

  /**
   * 리포가 바뀔 때 **이 칸의** 시선을 되돌린다 (FR-SVS-34).
   *
   * `setRepo` 에서 뽑아낸 것이며 동작은 그대로다 — 달라진 것은 칸마다 한 번씩
   * 돈다는 것뿐이다. 이전 리포의 목록이 새 리포의 헤더와 함께 보이는 순간이
   * 어느 칸에도 있어서는 안 된다 (FR-GIT-16).
   */
  _repoSwitchView(path){
    this._shown.clear(); this.previewFile=null;
    // FR-OPT-4-9: 낡음 표식은 앞 리포의 것이다 — 새 리포는 각 뷰의 `_adopt` 가 받는다.
    if(this._staleViews) this._staleViews.clear();
    // 선택과 쓰기 안내는 리포에 붙은 것이다 — 새 리포로 넘겨 오면 다른 파일을
    // 가리킨다.
    this._sel.clear(); this._anchor=null; this._note=null;
    // 원격 작업은 리포에 붙은 것이다 — 이전 리포의 출력이 새 리포의 헤더와 함께
    // 보이는 순간이 있어서는 안 된다. 작업 자체는 서버에서 계속 돈다.
    if(this._remoteView) this._remoteView.detachRepo();
    // 앞 리포의 실행 기록이 새 리포의 이력에 섞이면 이력이 아니라 잡음이다
    // (FR-GIT-218).
    if(this._consoleView) this._consoleView.reset();
    // 이전 리포의 diff 가 새 리포의 헤더와 함께 보이는 순간이 있어서는 안 된다.
    this._diffKey=null; this._diffPos=0; this.commitFile=null;
    this._hunkKey=null; this._hunks=null;
    // 앞 리포의 조각을 가리키던 툴바가 새 리포의 diff 위에 남아서는 안 된다.
    this.hunks._hunkBarHide();
    // blame 은 파일에 붙은 것이다 — 새 리포로 넘겨 오면 다른 파일을 가리킨다.
    this._blameOn=false; this.blame.reset();
    if(this._diffView) this._diffView.clear(path?GIT_PREVIEW_HINT:GIT_NO_REPO_HINT);
    for(const v of GIT_VIEWS) if(this._els.has(v.key)) this.viewRoots._render(v.key);
  }

  // Git 창이 사라졌을 때 루트를 area 로 되돌린다. 인스턴스는 살아 있다 —
  // 창은 다시 열릴 수 있다.
  /**
   * FR-SVS-46: 이 칸이 사라진다. `detach` 는 루트를 `#area` 로 되돌려 **다시
   * 열릴 수 있게** 두지만, 이쪽은 되돌아올 자리가 없으므로 DOM 까지 버린다.
   * 편집기는 DOM 을 떼는 것으로 풀리지 않으므로 `_destroyViews` 를 지나야 한다
   * (FR-GIT-56).
   */
  destroy(){
    this.detach();
    for(const el of this._els.values()) if(el.parentNode) el.parentNode.removeChild(el);
    this._els.clear();
    this.obs.detach(this);
    // UX_BATCH6_SRS FR-GLV-4: 목록에서 빠진 **뒤에** 다시 세운다. `detach()` 안의
    // 재정착은 아직 자신이 목록에 있으므로, 이 패널이 마지막이었을 때에도 남은
    // 것으로 세었다 — 그 판정을 여기서 한 번 더 지나 바로잡는다.
    this.obs.resettle();
    this.blame.dispose(); this.hunks.dispose(); this.diffPane.dispose(); this.poll.dispose(); this.write.dispose();
    this.viewReload.dispose();
    this.changes.dispose(); this.changeRows.dispose(); this.files.dispose(); this.selection.dispose();
    this.views.dispose(); this.viewRoots.dispose();
  }

  detach(){
    this.poll._stop(); GitMenu.close(); this.diffPane._destroyViews();
    // 창이 사라지면 커밋 영역의 토스트도 함께 사라진다 — 진입점이 화면 없이
    // 남아 있어서는 안 된다 (FR-GIT-83).
    this.views._commit().unmount();
    // REFACTOR_STABILIZATION_SRS FR-RST-20: **게터를 부르지 않는다.**
    //
    // `this._history()` 류는 없으면 만든다. 그래서 종전 코드는 창을 닫을 때
    // 한 번도 열지 않은 뷰 여섯 개를 새로 만든 뒤 언마운트했다 — `git-views.js`
    // 가 표방한 지연 생성("Git 창을 열지 않은 브라우저는 아무것도 만들지 않는다")을
    // 창을 닫는 경로가 깨뜨리고 있었다.
    //
    // 목록에 `_submodulesView` 가 빠져 있던 것도 여기서 함께 고친다 — 창을 닫아도
    // Submodules 뷰가 언마운트되지 않았다.
    for(const f of GIT_PANEL_VIEW_FIELDS) if(this[f]) this[f].unmount();
    const area=document.getElementById('area');
    for(const el of this._els.values()){
      el.classList.remove('vis');
      if(area) area.appendChild(el);
    }
  }

  // ── stale 가드 (FR-GIT-16) ──
  token(){return {gen:this._gen,repo:this.repo}}
  isStale(tok){return !tok||tok.gen!==this._gen||tok.repo!==this.repo}
}
