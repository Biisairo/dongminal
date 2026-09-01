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
  // FR-CSZ-5: 가로와 세로를 따로 담는다. 한 값을 공유하면 데스크톱에서 정한
  // 폭이 모바일에서 높이가 된다.
  _filesSizeKey(){
    return this._filesVertical()?GIT_FILES_H_KEY:GIT_FILES_W_KEY;
  },

  // 배치 방향은 CSS(`body.mobile`)가 정하므로 그것을 그대로 읽는다 — 여기서
  // 폭으로 다시 판정하면 두 곳이 어긋난다.
  _filesVertical(){
    return document.body.classList.contains('mobile');
  },

  // FR-CSZ-6: 저장값이 없거나 망가졌으면 기본값이다. 범위 밖의 값도 기본으로
  // 되돌린다 — 옛 판이 남긴 값이 화면을 접힌 채로 띄우지 않게.
  _filesSizePref(){
    let v=null; try{v=localStorage.getItem(this._filesSizeKey())}catch{}
    const n=parseFloat(v);
    if(!isFinite(n)||n<GIT_FILES_SIZE_MIN||n>GIT_FILES_SIZE_MAX) return GIT_FILES_SIZE_DEFAULT;
    return n;
  },

  _setFilesSizePref(pct){
    try{localStorage.setItem(this._filesSizeKey(),String(pct))}catch{}
  },

  _clampFilesSize(pct){
    return Math.max(GIT_FILES_SIZE_MIN,Math.min(GIT_FILES_SIZE_MAX,pct));
  },

  // 크기는 flex-basis 하나로 준다. width/height 로 주면 방향이 바뀔 때 옛 축의
  // 값이 남아 두 축이 동시에 걸린다.
  _applyFilesSize(files,pct){
    files.style.flex='0 0 '+pct+'%';
  },

  /**
   * FR-CSZ-1·2: 드래그 중에는 **화면만** 바꾸고 확정은 놓는 순간 한 번이다.
   * `.ed-ex-handle` 의 `_rEdHandle` 과 같은 규약이다 — 드래그마다 저장하면
   * localStorage 쓰기가 초당 수십 번 난다.
   *
   * 포인터 이벤트를 쓰는 이유는 FR-CSZ-7 이다. mouse 로만 달면 터치에서 잡히지
   * 않고, 둘을 따로 달면 같은 계산이 두 벌이 된다.
   */
  _wireFilesHandle(el,files){
    const h=el.querySelector('.git-files-handle');
    if(!h) return;
    this._applyFilesSize(files,this._filesSizePref());
    h.addEventListener('pointerdown',e=>{
      const body=el.querySelector('.git-changes-body');
      if(!body) return;
      e.preventDefault();
      const vert=this._filesVertical();
      const total=vert?body.clientHeight:body.clientWidth;
      if(total<=0) return;
      const start=vert?e.clientY:e.clientX;
      const startPct=(vert?files.offsetHeight:files.offsetWidth)/total*100;
      // 포인터를 잡아 둔다 — 커서가 미리보기의 Monaco 위로 가면 그쪽이 이벤트를
      // 먹어 드래그가 중간에 끊긴다.
      try{h.setPointerCapture(e.pointerId)}catch{}
      const pctAt=ev=>this._clampFilesSize(
        startPct+((vert?ev.clientY:ev.clientX)-start)/total*100);
      const mv=ev=>this._applyFilesSize(files,pctAt(ev));
      const up=ev=>{
        h.removeEventListener('pointermove',mv);
        h.removeEventListener('pointerup',up);
        h.removeEventListener('pointercancel',up);
        try{h.releasePointerCapture(e.pointerId)}catch{}
        const pct=pctAt(ev);
        this._applyFilesSize(files,pct);
        this._setFilesSizePref(pct);
      };
      h.addEventListener('pointermove',mv);
      h.addEventListener('pointerup',up);
      h.addEventListener('pointercancel',up);
    });
  },

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
    // 미리보기와 Diff 탭은 같은 상태다.
    for(const v of [this._diffView,this._previewView]) if(v) v.setIgnoreWhitespace(this._ignWs);
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
    // FR-DOR-5: 두 뷰가 함께 움직인다.
    for(const v of [this._diffView,this._previewView]) if(v) v.setHideUnchanged(this._fold);
    this._paint();
  },

  // ── 우클릭 (FR-GIT-41·146) ──
  // 메뉴는 GitMenu 프레임워크가 그린다 — 5단계의 자체 메뉴를 그것이 흡수했다.
  // 여기 남는 것은 항목이 부르는 동작뿐이다.

  absPath(t){return (this.repo||'')+'/'+t.path},

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
      for(const p of this.obs.panels) jobs.push(...p._reloadViews(true));
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
      if(withConsole&&this._consoleView) jobs.push(this._consoleView.reload());
      if(this._worktreesView) jobs.push(this._worktreesView.reload());
    }
    return jobs;
  },

  // 받는 동안 진입점은 다시 눌리지 않는다 (FR-GIT-238). `_refreshing` 이 실제
  // 방어이고 `disabled` 는 그것을 화면에 보이는 것이다.
  _paintRefresh(){
    const el=this._els.get('changes'); if(!el) return;
    const b=el.querySelector('.git-head-refresh');
    if(b) b.disabled=this._refreshing;
  },

  // ── 변경 감지 3계층 (FR-GIT-18~24) ──

  // init 은 재평가 계기를 붙인다. 폴링과 즉시 신호는 게이팅이 다르므로 같은
  // 리스너에서 둘을 각각 부른다.
  /**
   * 문서 이벤트는 **앱당 한 벌**이다 (FR-SVS-30) — 칸마다 등록하면 같은 신호가
   * 칸 수만큼 온다. 리스너가 붙잡는 것도 특정 패널이 아니라 observer 다: 등록한
   * 칸이 먼저 사라져도 신호는 계속 들어야 한다.
   */
  init(){
    if(this.obs._inited){ this._reschedule(); return }
    this.obs._inited=true;
    const live=()=>this.obs.any();
    document.addEventListener('visibilitychange',()=>{
      const p=live(); if(!p) return;
      p._reschedule();
      if(!document.hidden) p.signal('visible');
    });
    window.addEventListener('focus',()=>{
      const p=live(); if(!p) return;
      p._reschedule(); p.signal('focus');
    });
    this._reschedule();
  },

  // signal 은 즉시 신호의 유일한 처리점이다 (FR-GIT-18·20). Git 창이 활성이 아니어도
  // 한 번은 수집한다 — 사용자 행동과 1:1 이라 폴링이 아니고, 상태바 chip 과 GIT
  // 섹션 배지가 창을 보지 않을 때도 딛는 값이다 (SRS §7.1 I1).
  signal(kind){
    if(document.hidden) return;
    if(!this.repo||this._gitMissing) return;
    if(this._sigT) clearTimeout(this._sigT);
    // 연속 신호가 status 를 연발하지 않게 하나로 합친다.
    this._sigT=setTimeout(()=>{this._sigT=null;this.collect()},GIT_SIGNAL_DEBOUNCE_MS);
  },

  // 폴링 두 계층은 세 조건이 전부 참일 때만 돈다 (FR-GIT-22).
  _pollOk(){
    if(document.hidden) return false;
    if(this._gitMissing) return false;
    const w=this.app._gitWindow();
    if(!w||this.app.ws.activeWindow!==w.id) return false;
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
   */
  _cadence(st,sig){
    const fix=v=>v>0?GIT_REPO_MISSING_POLL_MS:0;
    if(this._missing) return {st:fix(st),sig:fix(sig)};
    const n=this._failStreak;
    if(n<=0) return {st,sig};
    const slow=v=>v>0?Math.min(v*Math.pow(2,n),GIT_FAIL_BACKOFF_MAX_MS):0;
    return {st:slow(st),sig:slow(sig)};
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
    if(!this._pollOk()){this._stop();return false}
    const {st,sig}=this._cadence(gitStatusInterval,gitSignatureInterval);
    if(this._pollOn&&this._pollSig===sig&&this._pollSt===st) return false;
    this._stop();
    this._pollOn=true; this._pollSig=sig; this._pollSt=st;
    // 주기 0 은 그 계층을 걸지 않는다 (FR-GIT-23).
    // FR-SVS-30: 콜백은 **observer** 를 지난다. 특정 패널을 캡처하면 그 칸이
    // 사라진 뒤에도 죽은 패널을 붙들고 부른다.
    if(sig>0) this._sigPoll=setInterval(()=>this.obs.tick('sig'),sig);
    if(st>0) this._stPoll=setInterval(()=>this.obs.tick('status'),st);
    return true;
  },

  // 조건이 참이 되면 즉시 1회 수집하고 주기를 건다 (FR-GIT-22).
  _reschedule(){
    if(this._applyCadence()) this.collect();
  },

  _stop(){
    if(this._sigPoll){clearInterval(this._sigPoll);this._sigPoll=null}
    if(this._stPoll){clearInterval(this._stPoll);this._stPoll=null}
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
    try{r=await fetch('/api/git/status?repo='+encodeURIComponent(repo))}catch{r=null}
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
    this._errMsg=null; this._staleNote=false;
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
      this.setRepo(null);
      return;
    }
    if(code==='git_missing'){
      this._errMsg=GIT_ERR_GIT_MISSING; this._gitMissing=true;
      this._stop(); this.obs.paintAll();
      return;
    }
    this._staleNote=true; this.obs.paintAll();
  },

  // signature 는 git 을 실행하지 않는 감지 경로다. 값이 그대로면 아무것도 하지
  // 않는다 (FR-GIT-19).
  async _pollSignature(){
    const repo=this.repo; if(!repo) return;
    if(this._sigBusy) return;
    this._sigBusy=true;
    const tok=this.token();
    const res=await gitFetch('/api/git/signature',{repo});
    const d=res.ok?res.data:null;
    // 단일 비행 플래그는 **무조건** 되돌린다. 여기서 `_seq` 로 소유권을 따지면
    // 안 된다 — 그것은 status 의 일련번호이고 `collect()` 가 관측마다 올린다.
    // 상태 폴링이 도는 동안 signature 응답은 늘 "내 것이 아니다" 로 판정되어
    // 플래그가 영구히 참으로 남고, 감지 계층이 첫 회차에 죽는다 (FR-GIT-19).
    // 리포가 바뀐 경우의 되돌림은 이미 `setRepo` 가 한다.
    this._sigBusy=false;
    if(!d||this.isStale(tok)||d.requested!==tok.repo) return;
    const v=(d.signature&&d.signature.value)||'';
    if(v===this._lastSig) return;
    this._lastSig=v;
    // 뷰의 갱신은 여기서 부르지 않는다. 근거(`_viewFp`)는 status 응답이 실어
    // 오므로 `collect()` 의 응답이 도착한 자리에서 판정한다 — 여기서 부르면
    // 아직 옛 값을 들고 다시 받는다.
    this.collect();
  },
});
