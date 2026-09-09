/**
 * GitPanel — 보기 설정과 폴링 (SPLIT_REFACTOR_SRS 묶음 B).
 *
 * 앞쪽은 **기기에 남는 취향**이다 — 파일 목록의 크기·방향, side-by-side, 공백 무시,
 * 변경 없는 구간 접기. 뒤쪽은 **관측을 받아 오는 일**이다 — `collect` 가
 * `/api/git/status` 를 한 벌만 내보내고(single-flight 는 GitObserver 가 쥔다),
 * `_applyStatus` 가 그 응답을 패널의 상태로 바꾸며, `_cadence` 가 실패 누적에 따라
 * 주기를 늦춘다 (FR-RMS-22).
 */
Object.assign(GitPanel.prototype, {
  /**
   * **파일 목록의 크기·방향은 폐기됐다** (REPO_TAB_UNIFY_SRS FR-RTU-20).
   *
   * `_filesSizeKey`·`_filesVertical`·`_filesSizePref`·`_setFilesSizePref`·
   * `_clampFilesSize`·`_applyFilesSize`·`_wireFilesHandle` 이 여기 있었다 —
   * EDITOR_GIT_UX_SRS 묶음 D(FR-CSZ-1~8). 나눌 두 칸이 사라졌으므로(인라인
   * diff 미리보기가 본문 탭으로 갔다) 그 사이의 손잡이도 대상이 없다.
   */

  // 보기 모드와 공백무시는 기기별 취향이라 localStorage 에 남는다 (§3.3).
  _sideBySidePref(){
    if(this._sideBy==null){
      let v=null; try{v=localStorage.getItem(GIT_DIFF_SIDE_KEY)}catch{}
      this._sideBy=v!=='0';
    }
    return this._sideBy;
  },

  _ignoreWsPref(){
    if(this._ignWs==null){
      let v=null; try{v=localStorage.getItem(GIT_DIFF_WS_KEY)}catch{}
      // 기본은 공백을 무시하지 않는다 — git 과 같은 판정이다 (FR-GIT-50).
      this._ignWs=v==='1';
    }
    return this._ignWs;
  },

  _toggleSideBySide(){
    this._sideBy=!this._sideBySidePref();
    try{localStorage.setItem(GIT_DIFF_SIDE_KEY,this._sideBy?'1':'0')}catch{}
    this._diff().setSideBySide(this._sideBy);
    this._paint();
  },

  _setIgnoreWs(on){
    this._ignWs=!!on;
    try{localStorage.setItem(GIT_DIFF_WS_KEY,this._ignWs?'1':'0')}catch{}
    if(this._diffView) this._diffView.setIgnoreWhitespace(this._ignWs);
    this._paint();
  },

  // FR-DOR-2·4: 변경 없는 구간의 접기. **기본은 꺼짐**이다 — 접으면 개요 눈금이
  // 접힌 좌표계 위에 서서 실제 파일의 줄 위치와 어긋난다.
  _foldPref(){
    if(this._fold==null){
      let v=null; try{v=localStorage.getItem(GIT_DIFF_FOLD_KEY)}catch{}
      this._fold=v==='1';
    }
    return this._fold;
  },

  _setFold(on){
    this._fold=!!on;
    try{localStorage.setItem(GIT_DIFF_FOLD_KEY,this._fold?'1':'0')}catch{}
    if(this._diffView) this._diffView.setHideUnchanged(this._fold);
    this._paint();
  },

  // ── 우클릭 (FR-GIT-41·146) ──
  // 메뉴는 GitMenu 프레임워크가 그린다 — 5단계의 자체 메뉴를 그것이 흡수했다.
  // 여기 남는 것은 항목이 부르는 동작뿐이다.

  absPath(t){return pathJoin(this.repo||'',t.path)},

  openFileDiff(t){this._openDiff(t.group,{path:t.path,origPath:t.origPath||''})},

  // 복사 유틸이 기존에 없다. clipboard 가 막힌 환경(비보안 컨텍스트)에서는
  // 임시 textarea 로 떨어진다.
  copyText(text){
    if(!text) return;
    if(navigator.clipboard&&navigator.clipboard.writeText){
      navigator.clipboard.writeText(text).catch(()=>this._copyFallback(text));
      return;
    }
    this._copyFallback(text);
  },

  _copyFallback(text){
    const ta=document.createElement('textarea');
    ta.value=text; ta.style.cssText='position:fixed;left:-9999px;top:0';
    document.body.appendChild(ta); ta.select();
    try{document.execCommand('copy')}catch{}
    ta.remove();
  },

  /**
   * FR-GIT-238: 새로고침. **전부 다시 받는다** — status · History · Branches ·
   * Console · Worktrees 다. 어느 탭을 보고 있는지에 따라 달라지지 않는다: 같은
   * 버튼이 늘 같은 일을 한다. `collect()` 하나로는 끝나지 않는다 — 그것은 status
   * 만 받고 Console 을 건드리지 않는다.
   *
   * 범위는 **이미 만들어진 뷰 전부**다. 탭의 뷰는 처음 열 때 지연 생성되므로 한 번도
   * 열지 않은 탭은 대상이 아니다 — 보인 적이 없는 것은 낡을 수 없고, 열 때 새로
   * 받는다.
   *
   * **자기 계기다** (FR-RPT-5). 관측 동일성 가드의 대상이 아니므로 값이 같아도 다시
   * 받는다.
   *
   * 실패는 각 경로가 이미 자기 자리에 알린다 — 새 표현을 만들지 않는다. status 의
   * 실패는 `.git-stale-note` 로 드러난다.
   */
  async refresh(){
    if(this._refreshing||!this.repo) return;
    this._refreshing=true;
    for(const p of this.obs.panels) p._paintRefresh();
    /**
     * 플래그 해제는 `finally` 가 한다 (선례: `_wsApply` 의 `_wsApplyInflight`).
     *
     * 뷰의 `reload()` 는 async 가 아니다 — 동기 throw 가 나면 배열을 만드는 이
     * 자리에서 터진다. `Promise.allSettled` 는 그 앞이므로 아무것도 삼켜 주지
     * 못하고, `_refreshing` 이 참으로 남아 **진입점이 영구히 잠긴다.** 버튼은
     * disabled 인 채로 굳고, 사용자에게는 "새로고침이 아무 일도 하지 않는다" 로
     * 보인다.
     */
    try{
      // 새로고침은 **전부** 다시 받는다 — 사용자가 그것을 뜻하고 눌렀다.
      // FR-SVS-42: 뷰는 칸마다 있으므로 칸마다 받는다. 두 칸이 같은 뷰를 보면
      // 같은 요청이 두 번 나가지만, 그 목록은 각 칸의 것이다 (§7 R-1).
      const jobs=[];
      // 뷰 하나의 동기 throw 가 **관측까지 삼키지 않는다.**
      //
      // `_reloadViews` 는 async 가 아니므로 여기서 터지면 아래 줄에 닿지 못하고,
      // 그러면 사용자가 새로고침을 눌렀는데 status 를 다시 받지 않는다. 종전에는
      // 1초 폴링이 그 자리를 곧 메웠기 때문에 드러나지 않았다 — 폴링이 서버 푸시로
      // 바뀌며 보이게 됐다 (GIT_PUSH_OBSERVE_SRS §2.10).
      //
      // 위 `finally` 가 지키는 것은 **잠금**이고, 여기가 지키는 것은 **관측**이다.
      try{ for(const p of this.obs.panels) jobs.push(...p._reloadViews(true)) }
      catch(e){ console.error('[git] reloadViews',e) }
      await Promise.allSettled([this.collect(),...jobs]);
    }finally{
      this._refreshing=false;
      for(const p of this.obs.panels) p._paintRefresh();
    }
  },

  /**
   * FR-GVR-8·9: Changes 밖의 뷰를 다시 받는다. **새로고침 버튼과 폴링이 같은
   * 것을 돌린다** — 자동 경로가 수동 경로보다 적게 하면 "새로고침을 눌러야
   * 보인다" 가 남는다 (D-8: 새로고침은 백업이다).
   *
   * 열지 않은 뷰는 각자의 `_el`·`_repo` 판정이 조기 반환하므로 요청이 나가지
   * 않는다 (FR-GVR-4).
   */
  _reloadViews(withConsole){
    const jobs=[];
    {
      if(this._historyView) jobs.push(this._historyView.reload());
      if(this._branchesView) jobs.push(this._branchesView.reload());
      // FR-GVR-6: Stash 도 대상이다 — 빠져 있어서 터미널에서 `git stash` 한 뒤
      // 새로고침을 눌러도 목록이 그대로였다.
      if(this._stashView) jobs.push(this._stashView.reload());
      // Console 은 **기본으로 받지 않는다.** 그 목록은 dongminal 자신의 쓰기로만
      // 늘어나고(`post()` 와 잡의 `RecordWrite`), 터미널에서 친 git 은 기록에
      // 남지 않는다 — 폴링이 받아 봐야 늘 같은 값이다. 받는 자리는 쓰기가 끝난
      // 곳(FR-GVR-3)과 사용자가 명시적으로 누른 새로고침(FR-GVR-6)뿐이다.
      // FR-GLV-1 / D-8: 새로고침이 자동 경로보다 **적게** 하지 않는다. 오히려
      // 하나 더 한다 — `withConsole` 은 "사용자가 눌렀다" 의 표식이고, 그때는
      // 거부 표식(FR-GLV-6)도 넘어 다시 시도한다.
      if(this._diffView) jobs.push(this.reloadDiff(!!withConsole));
      if(withConsole&&this._consoleView) jobs.push(this._consoleView.reload());
      if(this._worktreesView) jobs.push(this._worktreesView.reload());
      if(this._submodulesView) jobs.push(this._submodulesView.reload());
    }
    return jobs;
  },

  // FR-GVR-8a: 관측보다 낡은 뷰만 다시 받는다. 지금은 History 만 자기 목록의
  // signature 를 안다 — 나머지 뷰는 종전대로 변화 비교(FR-GVR-8)만 딛는다.
  _reloadStaleViews(sig){
    if(this._historyView&&this._historyView.staleFor(sig)) this._historyView.reload();
  },

  // 받는 동안 진입점은 다시 눌리지 않는다 (FR-GIT-238). `_refreshing` 이 실제
  // 방어이고 `disabled` 는 그것을 화면에 보이는 것이다.
  _paintRefresh(){
    const el=this._els.get('changes'); if(!el) return;
    // GIT_CHANGES_CONTROLS_SRS FR-GCC-10: 버튼은 이제 **뷰 밖**(사이드 최상단의
    // 진입점 줄)에 산다. 슬롯이 둘이면 사이드도 둘이므로, 이 뷰가 담긴 사이드에서
    // 찾아야 남의 칸을 끄지 않는다.
    const side=el.closest('.ed-side');
    const b=side&&side.querySelector('.git-head-refresh');
    if(b) b.disabled=this._refreshing;
  },

  // ── 변경 감지 3계층 (FR-GIT-18~24) ──

  // init 은 부팅의 첫 관측이다.
  /**
   * **문서 이벤트는 더 이상 여기 있지 않다** (GIT_LIVE_TRIGGERS_SRS FR-GLW-1~3).
   *
   *   이전 동작: `visibilitychange`·`focus` 리스너를 `this.obs._inited` 가드
   *             아래에서 달고, `live=()=>this.obs.any()` 로 **그 관측기의** 패널
   *             하나만 되살렸다
   *   새  동작: 계기는 `_initGitSection` 이 버스 토픽으로 앱당 한 번 잡고, 되살릴
   *             대상은 살아 있는 패널 전부다
   *   이유:     가드가 **관측기의 것**이라 규칙이 "앱당 한 번" 이 아니라 "관측기
   *             마다 한 번" 이었다. `init()` 의 호출처는 부팅의 한 곳뿐이고 그때
   *             잡히는 것은 활성 창의 관측기 — 활성 창이 Repo 창이 아니면 루트
   *             `''` 다. 사용자가 그 뒤에 여는 저장소의 관측기는 복귀 계기를
   *             **한 번도 갖지 못했고**, 90초를 숨었다 돌아오면 서버 감시가
   *             만료된 채 남았다 (SRS §2.1)
   */
  init(){ this._reschedule() },

  // signal 은 즉시 신호의 유일한 처리점이다 (FR-GIT-18·20). Git 창이 활성이 아니어도
  // 한 번은 수집한다 — 사용자 행동과 1:1 이라 폴링이 아니고, 상태바 chip 과 GIT
  // 섹션 배지가 창을 보지 않을 때도 딛는 값이다 (SRS §7.1 I1).
  signal(kind){
    if(document.hidden) return;
    if(!this.repo||this._gitMissing) return;
    TIMERS.cancel(this._sigT);
    // 연속 신호가 status 를 연발하지 않게 하나로 합친다.
    this._sigT=TIMERS.after(GIT_SIGNAL_DEBOUNCE_MS,()=>{this._sigT=null;this.collect()},
      {owner:this,label:'git-sig-debounce'});
  },

  // 폴링 두 계층은 세 조건이 전부 참일 때만 돈다 (FR-GIT-22).
  /**
   * FR-SVS-36: 관측이 도는 조건은 **Git 창이 화면에 있는가**이지 *활성 창인가*가
   * 아니다.
   *
   * 슬롯이 생기기 전에는 둘이 같았다. 지금은 칸마다 다른 창이 동시에 보이므로,
   * 터미널 칸에 서 있는 동안 옆 칸의 Git 창이 눈앞에 있는데도 관측이 멎었다 —
   * History 도 Changes 도 Branches 도 함께 (FR-SVS-39a).
   *
   * 요청 수는 늘지 않는다 (FR-SVS-31·39) — 관측자는 하나이고 주기도 하나다.
   */
  _pollOk(){
    if(document.hidden) return false;
    if(this._gitMissing) return false;
    // REPO_TAB_UNIFY_SRS FR-RTU-62: **이 패널의 표면**이 화면에 있는가.
    //
    // 종전에는 `_gitWindow()` 하나였다 — Git 창이 워크스페이스에 하나뿐이라
    // 그것이 곧 "그 표면" 이었기 때문이다. 창이 경로마다 생기면 패널도 여럿이고,
    // 그때 이 판정이 남의 창을 보면 비활성 창의 패널까지 git 을 부른다
    // (NFR-RTU-1 이 그것을 금한다).
    const w=this.root?this.app._edWindowFor(this.root):this.app._gitWindow();
    if(!w||!this.app._windowVisible(w.id)) return false;
    // 창이 보이는 것과 **이 패널의 표면**이 보이는 것은 다르다 — 사이드가
    // Explorer 이고 본문에 git 뷰 탭도 없으면 이 관측을 쓰는 화면이 없다.
    if(this.root&&!this.app._gitSurfaceOn(w)) return false;
    return !!this.repo;
  },

  // 조건이 거짓이면 clearInterval 로 완전히 멈춘다 — 콜백에서 return 으로 넘기지
  // 않는다. 참이 되면 즉시 1회 수집하고 주기를 건다 (FR-STAT-17 과 같은 규약).
  /**
   * 유효 주기 (GIT_REPO_MISSING_SRS FR-RMS-13·23·25·26).
   *
   * **기준 0 은 0 으로 남는다.** 0 은 "그 계층을 끈다" 는 뜻이므로(FR-GIT-23),
   * 실패가 그것을 되살리면 사용자가 끈 것이 저절로 켜진다.
   *
   * 소실은 확정된 사실이라 점증하지 않고 곧바로 고정 주기다. 그 밖의 실패는
   * 일시적일 수 있으므로 기준 × 2ⁿ 으로 늘리되 같은 값을 상한으로 둔다.
   *
   * POLL_INTERVAL_SETTINGS_SRS FR-PIS-4: 인자가 둘에서 하나가 됐다 — 브라우저
   * signature 폴링이 사라지면서 실효 주기를 계산할 계층이 status 하나만 남았다.
   */
  _cadence(st){
    if(this._missing) return st>0?GIT_REPO_MISSING_POLL_MS:0;
    const n=this._failStreak;
    if(n<=0) return st;
    return st>0?Math.min(st*Math.pow(2,n),GIT_FAIL_BACKOFF_MAX_MS):0;
  },

  /**
   * 주기만 다시 건다. **즉시 수집을 하지 않는다** (FR-RMS-28).
   *
   * `_reschedule()` 은 "참이 되면 즉시 1회 수집" 을 계약으로 갖는다 (FR-GIT-22).
   * 관측 결과로 주기를 바꾸는 자리에서 그것을 부르면 관측이 관측을 부른다 —
   * 실패·성공이 번갈아 오는 동안 요청이 배로 늘어난다 (D-RMS-10).
   */
  // 다시 걸었으면 true 다 — 호출자가 "즉시 1회 수집" 을 붙일지 그것으로 정한다.
  _applyCadence(){
    /**
     * GIT_OBSERVE_REVIVE_SRS FR-GOR-4·5: 판정의 대상은 **관측기에 딸린 패널
     * 전부**다.
     *
     *   이전 동작: `this._pollOk()` — 부른 패널 자기 것
     *   새  동작: `this.obs.pollOkAny()` — 하나라도 보고 있으면 돈다
     *   이유:     타이머는 관측기의 것이고 패널은 칸마다 있다. 자기 것만 보면
     *             보이지 않는 칸의 `_reschedule()` 한 번이 **보이는 칸의 폴링을
     *             끈다** (SRS §2.3). 전 패널을 도는 자리에서는 순서가 결과를
     *             정했다 — 마지막에 도는 패널이 이겼다
     *
     * 멈추는 조건은 그대로 좁다: 전부 거짓이어야 멈춘다 (NFR-RTU-1 · FR-GLR-3).
     */
    if(!this.obs.pollOkAny()){this._stop();return false}
    const st=this._cadence(gitStatusInterval);
    if(this._pollOn&&this._pollSt===st) return false;
    this._stop();
    this._pollOn=true; this._pollSt=st;
    // 주기 0 은 그 계층을 걸지 않는다 (FR-GIT-23).
    // FR-SVS-30: 콜백은 **observer** 를 지난다. 특정 패널을 캡처하면 그 칸이
    // 사라진 뒤에도 죽은 패널을 붙들고 부른다.
    //
    // EVENT_TIMER_HUB_SRS FR-OBS-1: 두 계층이 `TimerHub` 의 `every` 로 표현된다.
    // **주기를 함수로 주지 않고 값으로 준다** — 이 자리는 `_applyCadence` 가
    // 이미 실효 주기를 계산해 넘긴 뒤이고, 주기가 바뀌면 `_applyCadence` 가
    // `_stop()` 후 다시 걸기 때문이다 (FR-RMS-28: 다시 거는 것과 수집하는 것은
    // 다른 일이다). 여기서 `every:()=>...` 로 다시 계산하면 두 곳이 같은 판단을
    // 하게 되고, 그 둘이 어긋나면 어느 쪽이 맞는지 알 수 없다.
    //
    // **조건을 스케줄러에 주지 않는다.** 이 계층의 계약은 위 주석이 정한 그대로
    // "조건이 거짓이면 완전히 멈춘다 — 콜백에서 return 으로 넘기지 않는다" 이고,
    // 참이 되면 `_reschedule()` 이 **즉시 1회 수집한 뒤** 주기를 건다
    // (FR-GIT-22). `when` 이나 `whenHidden:'pause'` 를 주면 정확히 그 금지된
    // 모양이 된다 — 타이머는 살아 있고 콜백만 빈손으로 돌아가며, 조건이 참으로
    // 바뀐 순간의 즉시 수집도 사라진다.
    //
    // 가시성 판정이 스케줄러의 것보다 넓기도 하다. `_pollOk()` 는
    // `document.hidden` 뿐 아니라 창이 보이는지, **이 패널의 표면**이 화면에
    // 있는지까지 본다 (FR-RTU-62 · FR-SVS-39a).
    const opts={owner:this, whenHidden:'run'};
    if(st>0) this._stPoll=TIMERS.every({...opts,id:'git.status:'+(this.root||'-'),
      every:()=>st, run:()=>this.obs.tick()});
    return true;
  },

  /**
   * UX_BATCH9_SRS FR-GLR-1~4: **멈춰 있으면 스스로 되살아난다.**
   *
   * 종전의 자동 갱신은 두 경로처럼 보였으나 하나였다 (SRS §2.3): 주기 폴링이
   * 멎으면 `/api/git/status` 가 나가지 않고, 그 요청이 곧 서버의 관심 표명이므로
   * 90초 뒤에는 `git_changed` 방송까지 함께 멎는다. 그리고 폴링은 조건이 거짓이면
   * **완전히 멈추며**(`_applyCadence` → `_stop`), 되살아나는 계기는 밖에서 알려
   * 주는 것뿐이다 — 그 계기가 하나라도 새면 그 패널의 자동 갱신은 영구히 죽고,
   * 죽었다는 것을 아무도 알지 못한다. 접수된 증상이 그것이다: 보고 있는데도
   * 바뀌지 않고, 새로고침을 누를 때까지 영영 그대로.
   *
   * 새는 계기를 하나 더 메우는 대신 **조용한 정지를 없앤다** (D-2).
   *
   * 판정은 시각이 아니라 **관측의 나이**다 (D-3) — 타이머의 유무로는 "타이머는
   * 살아 있는데 답이 오지 않는" 모양을 놓친다.
   *
   * 되살릴 때 두 가드를 푼다 (FR-GLR-4). 멈춰 있던 동안의 변화가 "지난번과 같다"
   * 로 판정되면 화면은 낡은 채 남고, 그러면 되살린 뜻이 없다.
   *
   * 요청은 **멈춰 있을 때만** 는다 (FR-GLR-7). 정상 회차에서는 나이가 주기보다
   * 어리므로 이 함수는 산술 몇 번으로 끝난다.
   *
   * GIT_OBSERVE_REVIVE_SRS: "멈춰 있다" 에는 **타이머가 도는데 답이 오지 않는**
   * 것도 든다 (D-3 이 처음부터 그렇게 적었다). 그 회차에서도 수집까지 간다
   * (FR-GOR-1) — 종전에는 경고만 찍었다. 대신 물어보는 일에 주기를 걸어 요청은
   * 멎어 있는 관측기당 주기마다 한 번을 넘지 않는다 (FR-GOR-2).
   */
  _watchdog(){
    // FR-GLR-3: 되살리기도 같은 판정을 먼저 지난다 — 아무도 보지 않는 저장소를
    // 깨우지 않는다.
    if(!this._pollOk()) return false;
    const st=this._cadence(gitStatusInterval);
    // 주기 0 은 사용자가 끈 것이다 (FR-GIT-23). 끈 것을 되살리지 않는다.
    if(st<=0) return false;
    const age=this._lastObsAt?Date.now()-this._lastObsAt:Infinity;
    if(this._pollOn&&age<st*GIT_WATCHDOG_FACTOR) return false;
    /**
     * GIT_OBSERVE_REVIVE_SRS FR-GOR-2: **물어보는 일에만 주기를 건다.**
     *
     * 아래가 수집까지 가게 된 이상(FR-GOR-1) 이 자리는 요청원이다. 답이 오지
     * 않는 동안 나이는 줄지 않으므로, 문턱이 없으면 렌더마다(1초) 한 건씩 나간다
     * (R-B9-1). 정상 회차는 위 나이 판정에서 이미 돌아갔으므로 이 문턱이 여는
     * 것은 **멎어 있는 관측기당 주기마다 한 번**뿐이다 (NFR-GOR-1).
     *
     * **주기를 다시 거는 일은 이 문턱 밖이다** — 그것은 요청이 아니고, 함께 묶으면
     * 직전에 한 번 물어본 탓에 꺼진 타이머가 한 주기를 더 꺼진 채로 남는다.
     */
    const ask=!this._wdTryAt||Date.now()-this._wdTryAt>=st;
    if(!ask&&this._pollOn) return false;   // 걸 것도 물을 것도 없다
    // FR-GLR-6 (FR-GOR-7): 관측기는 **루트마다** 서므로 `repo` 만으로는 어느
    // 표면이 멎었는지 특정되지 않는다 — 같은 문자열이 여럿이다 (SRS §2.4).
    console.warn('[git] 관측이 멈춰 있어 되살립니다 — age='+(age===Infinity?'never':Math.round(age/1000)+'s')
      +' poll='+(this._pollOn?'on':'off')+' repo='+this.repo+' root='+(this.root||'-'));
    this._obsSig=null; this._lastViewFp=null;                    // FR-GLR-4
    /**
     * FR-GOR-1: **주기를 다시 걸고, 그 자리에서 한 번 수집한다.**
     *
     *   이전 동작: `_reschedule()` — 수집은 `_applyCadence()` 가 참을 돌려줄
     *             때만 따라왔다. 폴링이 이미 켜져 있고 주기가 그대로면 그 값은
     *             거짓이므로(`:293`) **경고만 찍고 물러났다**
     *   새  동작: 두 일을 따로 부른다
     *   이유:     `_applyCadence` 의 반환값이 답하는 것은 "주기를 다시 걸었는가"
     *             이고 워치독이 묻는 것은 "관측이 낡았는가" 다. 둘을 묶어 둔 탓에
     *             `D-3` 이 이 장치의 존재 이유로 든 상태 — 타이머는 살아 있는데
     *             응답이 오지 않는 모양 — 에서 아무 일도 하지 않았다 (SRS §2.1).
     *             적재 직후 5.4초 동안 관측이 없던 자리가 그것이다 (§2.2 실측)
     *
     * `_reschedule()` 은 건드리지 않는다 — 그쪽은 "조건이 참이 된 순간" 의 규약
     * 이며(FR-GIT-22) 부르는 자리가 여럿이다.
     */
    this._applyCadence();
    if(ask){ this._wdTryAt=Date.now(); this.collect() }
    return true;
  },

  // 조건이 참이 되면 즉시 1회 수집하고 주기를 건다 (FR-GIT-22).
  _reschedule(){
    if(this._applyCadence()) this.collect();
  },

  _stop(){
    if(this._stPoll){this._stPoll.stop();this._stPoll=null}
    this._pollOn=false;
  },

  // collect 는 status 1회다. single-flight — 진행 중이면 "끝나면 한 번 더" 플래그만
  // 세운다 (FR-GIT-21). 요청은 활성 리포에만 간다 (FR-GIT-24).
  async collect(){
    const repo=this.repo; if(!repo) return;
    if(this._busy){this._again=true;return}
    this._busy=true;
    const seq=++this._seq;
    const tok=this.token();
    let r=null,d=null;
    // 시한이 있다 (FR-RMS-29). 이 요청은 single-flight 라 답이 오지 않으면 `_busy`
    // 가 영구히 참으로 남고, 그 뒤의 모든 `collect()` 가 조용히 되돌아간다 —
    // 타이머는 살아 있는데 status 만 멎는 모양이다 (TC-SVS-64 · Windows 러너 실측:
    // 46초 동안 signature 요청만 돌았다). 넘기면 망 실패와 같은 길을 간다 — 이전
    // 화면을 지키고 백오프를 지난다.
    try{r=await fetch('/api/git/status?repo='+encodeURIComponent(repo),
      {signal:AbortSignal.timeout(GIT_STATUS_FETCH_TIMEOUT_MS)})}catch{r=null}
    if(r){try{d=await r.json()}catch{d=null}}
    // 리포가 바뀌면 setRepo 가 소유권을 끊는다 — 그 뒤 도착한 응답은 플래그를
    // 건드리지 않는다.
    if(this._seq!==seq){this._applyStatus(tok,r,d);return}
    this._busy=false;
    const again=this._again; this._again=false;
    this._applyStatus(tok,r,d);
    if(again) this.collect();
  },

  _applyStatus(tok,r,d){
    // ① 세대·리포 확인 (FR-GIT-16)
    if(this.isStale(tok)) return;
    if(!r){
      // 네트워크 오류 — 이전 화면을 유지한다. **목록을 지우지 않는다.**
      // 사유가 붙은 화면은 관측으로 그린 화면이 아니다 — 근거를 버려 회복하는
      // 관측이 값이 같아도 다시 그리게 한다 (FR-GIT-227).
      this._obsSig=null;
      this._fail();
      this._staleNote=true; this.obs.paintAll(); return;
    }
    if(!r.ok){this._applyError(d&&d.error);return}
    // ② 서버가 되돌려준 요청값 확인. 같은 세대 안에서도 응답 순서가 뒤바뀔 수 있다.
    if(!d||d.requested!==tok.repo) return;
    // 관측이 성공했다 — 누적을 놓고 주기를 기준으로 되돌린다 (FR-RMS-24).
    // 소실이었다면 여기가 복구 지점이다 (FR-RMS-11).
    this._failStreak=0;
    // UX_BATCH9_SRS FR-GLR-2: 화면이 언제의 것인지를 남기는 유일한 자리다.
    this._lastObsAt=Date.now();
    this._leaveMissing();
    this._applyCadence();
    this._status=d;
    // 응답에 signature 가 함께 오므로 그 값으로 갱신한다 — 직후 signature 폴링이
    // 헛되이 변화를 보고하지 않게 한다.
    //
    this._lastSig=(d.signature&&d.signature.value)||'';
    // FR-GVR-8: Changes 밖의 뷰가 따라갈 근거다.
    //
    // **signature 만으로는 모자란다.** 그것은 HEAD·index·현재 브랜치 ref 만 보고
    // **원격 추적 ref 를 보지 않는다** (`query/signature.go`). 그래서 터미널에서
    // 친 `git push` 는 signature 를 한 톨도 움직이지 않는다 — History 의
    // `origin/main` 과 Branches 의 ahead/behind 가 낡은 채로 남는다.
    //
    // status 응답이 이미 그 답을 싣고 온다. ahead·behind·upstream·oid 를 근거에
    // 함께 넣으면 push 는 `ahead 1→0` 으로 드러난다 — 서버를 고치지 않고, 요청을
    // 늘리지 않고 감지된다.
    const fp=this._viewFp(d);
    const prevFp=this._lastViewFp;
    this._lastViewFp=fp;
    // 첫 관측(`setRepo` 직후의 null)은 변화가 아니다 — 뷰는 열릴 때 스스로 받는다.
    if(prevFp!==null&&prevFp!==fp) this.obs.reloadViewsAll();
    // FR-GVR-8a: 변화가 없어도 **목록이 관측보다 낡았으면** 받는다. 뷰의 목록과 이
    // 관측은 서로 다른 시각의 저장소다 — 뷰의 `git log` 가 변경 **전**에 돌고 첫
    // status 가 변경 **후**에 돌면, 그 변경은 기준선에 이미 들어 있어 위의 비교는
    // 영영 "같다" 다 (V-GVR-26 · TC-SVS-60 의 trace 실측). 목록이 받아진 시각의
    // signature(log 응답이 싣는다)와 견주므로, 같은 시각이면 요청이 나가지 않는다 —
    // 무조건 한 번 더 받으면 늦게 온 기준선이 펼친 상세와 뒷장을 덮는다 (실측).
    else this.obs.reloadStaleViewsAll(this._lastSig);
    // FR-GLV-1: Diff 는 위 갈래 **밖**이다. 근거가 되는 것이 관측이 아니라 파일의
    // 내용이므로 fp 가 같아도 낡을 수 있다 — 그래서 매 회차 지난다.
    this.obs.reloadDiffAll();
    this._errMsg=null; this._staleNote=false;
    // 관측이 성공했다 — 저장소가 아니라는 판정은 더 이상 참이 아니다
    // (FR-RTU-25). `git init` 뒤의 첫 성공이 이 자리를 지난다.
    this._notRepo=false;
    /**
     * FR-GIT-227 (FR-RPT-1·2): 관측이 지난 회차와 같으면 다시 그리지 않는다.
     *
     * 폴링이 1초마다 도는데 그때마다 목록을 새로 만들면 화면은 그대로인 채 요소만
     * 버려진다 — 누르려던 행 버튼이 손 밑에서 교체되고, 더블클릭의 두 번째
     * 클릭이 새 요소에 떨어져 `dblclick` 이 만들어지지 않는다 (FR-GIT-52).
     *
     * 근거는 **화면이 읽는 값 전부**다. 그리는 쪽이 보는 것은 `_status.status`
     * 하나이고(`statusOf`), `observedAtUnixMs`·`cached` 는 회차마다 달라지지만
     * 화면에 닿지 않는다 — 그것까지 넣으면 근거가 늘 달라 가드가 죽는다.
     *
     * **근거는 그린 뒤에 기록한다.** 먼저 기록하면 `_paint()` 가 한 번 터진 순간
     * 그 관측이 "이미 그렸다" 로 남아, 같은 값이 계속 와도 다시 그리지 않는다 —
     * 화면은 낡은 채로 영구히 굳고 사유는 어디에도 보이지 않는다. 순서를 뒤집으면
     * 실패한 회차는 근거를 남기지 않으므로 다음 관측이 다시 시도한다.
     */
    const obs=JSON.stringify(d.status||null);
    if(obs!==this._obsSig){this.obs.paintAll(); this._obsSig=obs}
    // 활성 리포의 배지가 따라 갱신된다. 다른 리포는 서버의 마지막 관측값이다.
    this.app._gitReposRefresh();
    // 상태바 chip 은 Git 창 밖에서도 보이므로 관측마다 갱신한다 (FR-GIT-57).
    this.app._updateStatusBar();
    // FR-GIT-111 (FR-RPT-8): 충돌 판정은 관측마다 돈다 — 다시 그리기에 업히면
    // 관측이 같은 회차에 판정이 멈춘다.
    this.obs.notifyStatusAll();
    // FR-GIT-178: 다이얼로그가 열려 있으면 대상 변경을 알린다. 실행은 막지 않는다.
    if(typeof GitConfirm!=='undefined') GitConfirm.notify(this._lastSig);
    if(typeof GitDialog!=='undefined') GitDialog.notify();
  },

  // 성공하지 못한 관측 하나. 사유를 가리지 않는다 (FR-RMS-22) — 갈래마다 다른
  // 규칙을 두면 "가장 느릴 때" 가 화면마다 달라진다.
  _fail(){
    this._failStreak++;
    this._applyCadence();
  },

  _applyError(code){
    // 사유가 붙은 화면은 관측으로 그린 화면이 아니다 (FR-GIT-227).
    this._obsSig=null;
    // FR-RMS-6·7: 소실은 **활성 리포를 해제하지 않는다.** 해제하면 무엇을 다시 볼지
    // 잃어 자동 복구가 불가능해진다 (D-RMS-5). 주기는 백오프가 아니라 고정이다
    // (FR-RMS-26) — 확정된 사실은 점증할 이유가 없다.
    if(code===GIT_RMS_CODE){
      this._failStreak=0;
      this._enterMissing();
      this._applyCadence();
      return;
    }
    this._fail();
    if(code==='not_a_git_repo'){
      this._errMsg=GIT_ERR_NOT_REPO; this._status=null;
      // REPO_TAB_UNIFY_SRS FR-RTU-25: Repo 창은 **그 자리에서 만들 수 있다.**
      // `setRepo(null)` 은 옛 표면의 처리다 — 거기서는 활성 리포를 놓는 것이
      // 곧 "고를 자리로 돌아간다" 였지만, Repo 창의 저장소는 창의 루트라
      // 놓을 대상이 없다 (그래서 `setRepo` 도 no-op 이다).
      this._notRepo=true;
      this.setRepo(null);
      /**
       * UX_BATCH6_SRS FR-DSP-1a: **확정된 "저장소가 아니다" 는 폴링을 멈춘다.**
       *
       *   이전 동작: 사유만 그리고 주기는 그대로 돌았다. `_applyCadence` 는 성공
       *             경로에만 있으므로 실패 백오프도 걸리지 않아, 기준 주기(3초)로
       *             영원히 물었다
       *   새  동작: `git_missing` 과 같이 멈춘다
       *   이유:     사이드의 기본이 Changes 가 되면서(FR-DSP-1) **저장소가 아닌
       *             루트**도 그 표면을 갖게 됐다 — `~` 와 메모장이 그렇다. 그
       *             자리에서 물을 것은 없다: 화면에 서는 것은 목록이 아니라
       *             `git init` 버튼이다
       *
       * 되살아나는 길은 셋이다 — 창·탭에 포커스가 오면 `signal()` 이 한 번 묻고
       * (그쪽은 `_pollOk` 를 보지 않는다), 새로고침 버튼이 묻고, 이 창의
       * `git init`(FR-RTU-26)이 성공하면 그 자리에서 다시 선다.
       */
      this._stop();
      this.obs.paintAll();
      return;
    }
    if(code==='git_missing'){
      this._errMsg=GIT_ERR_GIT_MISSING; this._gitMissing=true;
      this._stop(); this.obs.paintAll();
      return;
    }
    this._staleNote=true; this.obs.paintAll();
  },
});
