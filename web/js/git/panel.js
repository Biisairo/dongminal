/**
 * Dongminal — Git 창의 표면 (GIT_SRS §3.4)
 *
 * Git 창은 워크스페이스에 하나이므로(FR-GIT-26) 이 객체도 앱에 하나다. GIT_VIEWS 의
 * 고정 탭은 각자 루트 DOM 을 갖고, 활성 탭의 루트만 pane 본문에 붙는다 — 숫자를 여기
 * 적지 않는다 (FR-GIT-28 이 개정될 때 이 주석이 낡는다).
 *
 * 활성 리포가 바뀌면 진행 중인 응답은 전부 버린다 (FR-GIT-16). 세대 카운터
 * 하나로 판정한다 — 나중에 비동기 경로를 하나씩 훑어 가드를 덧붙이는 상황을
 * 만들지 않으려고 처음부터 둔다.
 *
 * **메서드는 이 파일에 없다.** 클래스 본문에는 `constructor` 와 접근자만 남고, 나머지
 * 187개는 주제별 파일이 `Object.assign(GitPanel.prototype, …)` 로 얹는다
 * (SPLIT_REFACTOR_SRS 묶음 B). 접근자가 여기 남은 이유는 `Object.assign` 이 getter 를
 * **호출해 그 반환값을 복사**하기 때문이다 — 옮기면 통로가 값으로 굳는다.
 *
 *   panel-life.js     리포 전환 · 뷰 루트 · 파괴 · 소실 복구
 *   panel-changes.js  Changes 탭 — 목록 · 트리 · 그룹 · 머리
 *   panel-views.js    뷰 지연 생성 · 상태 접근 · 브랜치/태그 파사드
 *   panel-write.js    쓰기 한 번의 전과 후 — 후처리 훅 · 결과 해석 · 오퍼레이션
 *   panel-files.js    파일 작업 · 선택 · 스테이징 · discard
 *   panel-diff.js     선택 → diff · blame · hunk · 미리보기
 *   panel-poll.js     보기 설정 · 폴링 · 상태 적용
 *
 * 관측(`GitObserver`)은 observer.js, Monaco diff(`GitDiffView`)는 diff-view.js 다.
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
    this.obs=app._gitObs(this.root);
    this.obs.attach(this);

    this._els=new Map(); // view key → 루트 DOM. **칸마다 따로다** (FR-SVS-42)
    this._collapsed=new Set();    // 접힌 그룹. 뷰의 성질이라 리포 전환에도 남는다
    this._dirCollapsed=new Set(); // 접힌 트리 디렉터리 (group:path)
    this._shown=new Map();        // 그룹별로 그린 행 수 (FR-GIT-42)
    this._fileView=null;          // 'flat' | 'tree'
    this.previewFile=null;        // {repo,group,axis,path,origPath}. 미리보기와 Diff 탭이 같이 쓴다
    this._diffView=null;          // Diff 탭의 GitDiffView
    this._diffKey=null;           // 그 뷰에 이미 보인 대상 (재요청 방지)
    // 부분 스테이징 (FR-GIT-278·279). 조각은 서버가 만든 diff 에서 온다 — 여기서
    // 만들지 않는다. _hunkKey 는 이미 받아 둔 대상, _hunks 는 그 관측이다.
    this._hunkKey=null;
    this._hunks=null;             // {diffId,list,note} 또는 {err}
    this._hunkSel=null;           // {hunk,from,to,anchor} — 한 덩어리 안의 줄 범위
    this._diffPos=0;              // 목록에서 사라진 대상을 클램프할 기준 (FR-GIT-53)
    this._sideBy=null;            // FR-GIT-51 의 보기 모드
    this._ignWs=null;             // FR-GIT-50 의 공백무시 토글
    this._sel=new Set();          // 다중 선택 (FR-GIT-69). group\0path
    this._anchor=null;            // Shift 범위 선택의 기준 행
    this._note=null;              // 쓰기 실패·부분 적용 안내 (FR-GIT-73)
    this._commitView=null;        // 커밋 영역 (FR-GIT-74~85)
    this._historyView=null;       // History 탭 (FR-GIT-113~139)
    this._branchesView=null;      // Branches 탭 (FR-GIT-147~160)
    this._stashView=null;         // Stash 탭 (FR-GIT-161~170)
    this._consoleView=null;       // Console 탭 (FR-GIT-218)
    this._worktreesView=null;     // Worktrees 탭 (FR-GIT-240~244)
    this._remoteView=null;        // 원격 작업 (FR-GIT-98~112)
    // 커밋 축의 diff 대상 (FR-GIT-138). previewFile 과 자리를 나눈다 — 같은 자리에
    // 두면 Changes 탭의 미리보기가 커밋의 diff 를 보이면서 목록에는 아무 행도
    // 선택되지 않는다.
    this.commitFile=null;
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
  get _writing(){ return this.obs._writing } set _writing(v){ this.obs._writing=v }
  get _busy(){ return this.obs._busy } set _busy(v){ this.obs._busy=v }
  get _again(){ return this.obs._again } set _again(v){ this.obs._again=v }
  get _sigBusy(){ return this.obs._sigBusy } set _sigBusy(v){ this.obs._sigBusy=v }
  get _sigT(){ return this.obs._sigT } set _sigT(v){ this.obs._sigT=v }
  get _pollOn(){ return this.obs._pollOn } set _pollOn(v){ this.obs._pollOn=v }
  get _pollSig(){ return this.obs._pollSig } set _pollSig(v){ this.obs._pollSig=v }
  get _pollSt(){ return this.obs._pollSt } set _pollSt(v){ this.obs._pollSt=v }
  get _sigPoll(){ return this.obs._sigPoll } set _sigPoll(v){ this.obs._sigPoll=v }
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
    const w=this.app._gitWindow();
    return (w&&w.git&&w.git.repo)||null;
  }
}

