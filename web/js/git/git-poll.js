/**
 * GitPoll — Git 패널의 폴링 부품: 접기 설정과 폴링 (SPLIT_REFACTOR_SRS 묶음 B · REFACTOR3_FE_GITPANEL_SRS 7d).
 * 접기 취향(`_fold`)을 소유한다. 새로고침·뷰 다시 받기·refs 회차는 `GitViewReload`(`git-view-reload.js`), 멈춘 관측의
 * 되살리기는 `GitWatchdog`(`git-watchdog.js`)다 (REFACTOR3_FE_REST5_SRS FR-FR5-21). 관측 상태는 패널의 접근자(관측기)이고, 타이머의
 * 주인은 종전대로 패널이다(`owner:this.p`). `collect`·`_pollOk` 는 패널의 위임자를 지나 부른다 — 패널
 * 인스턴스에서 그 둘을 덮는 자리(e2e)가 종전대로 듣는다.
 *
 * 앞쪽은 **기기에 남는 취향**이다 — 변경 없는 구간 접기. side-by-side·공백 무시는
 * `git-diff-pane.js` 로 갔다 (REFACTOR3_FE_GITPANEL_SRS 7c). 뒤쪽은 **관측을 받아 오는 일**이다 — `collect` 가
 * `/api/git/status` 를 한 벌만 내보내고(single-flight 는 GitObserver 가 쥔다),
 * `_applyStatus` 가 그 응답을 패널의 상태로 바꾸며, `_cadence` 가 실패 누적에 따라
 * 주기를 늦춘다 (FR-RMS-22).
 */
/**
 * status 응답 하나의 판정 (REFACTOR3_FE_REST3_SRS FR-FR3-20). 세대 검사 **뒤**에 부른다. `repo` 는 보낸 요청의 저장소다.
 *   net       상태 0 — 네트워크 오류. 이전 화면을 유지한다
 *   error     실패 응답 — 사유(`d.error`)로 간다
 *   drop      본문이 없거나 서버가 되돌려준 요청값이 다르다 — 같은 세대 안에서도 응답 순서가 뒤바뀔 수 있다 (②)
 *   not_repo  200 인데 답이 "저장소가 아니다" 다
 *   ok        받아들인다
 *
 * API_ANSWER_NOT_ABSENCE_SRS FR-ANA-1·4: **200 인데 답은 "저장소가 아니다" 다.**
 *
 *   이전 동작: 서버가 404 로 적었고 그것이 `r.ok===false` 를 지나 위의
 *             `_applyError` 로 갔다. 화면은 옳았으나 브라우저 콘솔에 정상
 *             동작이 오류로 쌓였다 — 노트 폴더처럼 git 이 아닌 루트를 보는
 *             동안 창을 옮길 때마다 한 줄씩 늘었다
 *   새  동작: 200 을 받아 같은 자리로 보낸다
 *   이유:     달라지는 것은 전송 계층의 표기뿐이다. 여기 도달한 뒤의 처리는
 *             한 글자도 바뀌지 않는다 — `_notRepo` 가 서고 `_stop()` 이
 *             폴링을 멈추며, 되살아나는 길 셋도 그대로다 (FR-DSP-1a)
 *
 * 세대 검사 **뒤**에 둔다. 이 응답의 임자가 지금 보는 저장소인지 먼저 가려야
 * 옛 요청의 답이 현재 화면을 끄지 않는다.
 */
function gitStatusVerdict(r,d,repo){
  if(r.status===0) return 'net';
  if(!r.ok) return 'error';
  if(!d||d.requested!==repo) return 'drop';
  if(d.isRepo===false) return 'not_repo';
  return 'ok';
}

class GitPoll extends GitPart {
  /**
   * **파일 목록의 크기·방향은 폐기됐다** (REPO_TAB_UNIFY_SRS FR-RTU-20).
   *
   * `_filesSizeKey`·`_filesVertical`·`_filesSizePref`·`_setFilesSizePref`·
   * `_clampFilesSize`·`_applyFilesSize`·`_wireFilesHandle` 이 여기 있었다 —
   * EDITOR_GIT_UX_SRS 묶음 D(FR-CSZ-1~8). 나눌 두 칸이 사라졌으므로(인라인
   * diff 미리보기가 본문 탭으로 갔다) 그 사이의 손잡이도 대상이 없다.
   */

  // FR-DOR-2·4: 변경 없는 구간의 접기. **기본은 꺼짐**이다 — 접으면 개요 눈금이
  // 접힌 좌표계 위에 서서 실제 파일의 줄 위치와 어긋난다.
  _foldPref(){
    if(this._fold==null) this._fold=PrefStore.local.bool(GIT_DIFF_FOLD_KEY,false);
    return this._fold;
  }

  _setFold(on){
    this._fold=!!on;
    PrefStore.local.setBool(GIT_DIFF_FOLD_KEY,this._fold);
    if(this.p._diffView) this.p._diffView.setHideUnchanged(this._fold);
    this.p._paint();
  }

  // ── 우클릭 (FR-GIT-41·146) ──
  // 메뉴는 GitMenu 프레임워크가 그린다 — 5단계의 자체 메뉴를 그것이 흡수했다.
  // 여기 남는 것은 항목이 부르는 동작뿐이다.

  /**
   * REPO_FIX 05 §3A-4 (F-3.1): 파일 절대경로 = 어휘적 저장소 최상위 + 상대경로. 창 루트가
   * 저장소 하위 폴더여도, 심볼릭 링크여도 편집기 경로(03 문서 키)와 같다.
   *   이전 동작: 창 루트에 이었다 — 하위 폴더 루트에서 `…/src/src/a.txt` 가 됐다(#6)
   */
  absPath(target){return pathJoin(this.repoTop(),target.path)}

  // 관측이 지금 저장소의 것일 때만 그 응답으로 잰다. 아직 없으면 창 루트다.
  repoTop(){
    const d=this.p._status;
    const top=d&&d.requested===this.p.repo?gitLexicalTop(d):'';
    return top||this.p.repo||'';
  }

  openFileDiff(target){this.p._openDiff(target.group,{path:target.path,origPath:target.origPath||''})}

  /**
   * 우클릭 메뉴의 복사 진입점. **이름과 서명은 계약이다** — 메뉴 일곱 항목과
   * e2e 둘이 이것을 가로챈다 (FR-STR-12).
   *
   *   이전 동작: 1단(`navigator.clipboard`) → 2단(임시 textarea). 둘 다 실패하면
   *             **아무 일도 일어나지 않는다.**
   *   새  동작: `ClipboardWriter.write` 가 3단(복사창)까지 내려간다 (FR-STR-14·15).
   *   이유:     1·2단의 실패는 환경이 정하는 것이라(비보안 컨텍스트·제스처 없음)
   *             3단이 없으면 이 기능은 "될 때도 있고 안 될 때도 있는 것" 이다
   *             (FR-ETR-40 · D-12). 그 3단은 이미 서 있었고 이름이 터미널을
   *             말해서 여기가 못 봤을 뿐이다.
   */
  copyText(text){
    if(!text) return;
    ClipboardWriter.write(text);
  }

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
  init(){ this._reschedule() }

  // signal 은 즉시 신호의 유일한 처리점이다 (FR-GIT-18·20). Git 창이 활성이 아니어도
  // 한 번은 수집한다 — 사용자 행동과 1:1 이라 폴링이 아니고, 상태바 chip 과 GIT
  // 섹션 배지가 창을 보지 않을 때도 딛는 값이다 (SRS §7.1 I1).
  signal(kind){
    if(document.hidden) return;
    if(!this.p.repo||this.p._gitMissing) return;
    // F-5.2: 파일 저장(편집기 탭 포함)은 작업 트리 Blame 을 낡게 한다.
    if(kind==='write') for(const p of this.p.obs.panels) p.blame.blameStale();
    TIMERS.cancel(this.p._sigT);
    // 연속 신호가 status 를 연발하지 않게 하나로 합친다.
    this.p._sigT=TIMERS.after(GIT_SIGNAL_DEBOUNCE_MS,()=>{this.p._sigT=null;this.p.collect()},
      {owner:this.p,label:'git-sig-debounce'});
  }

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
    if(this.p._gitMissing) return false;
    // REPO_TAB_UNIFY_SRS FR-RTU-62: **이 패널의 표면**이 화면에 있는가.
    //
    // 종전에는 `gitWindow()` 하나였다 — Git 창이 워크스페이스에 하나뿐이라
    // 그것이 곧 "그 표면" 이었기 때문이다. 창이 경로마다 생기면 패널도 여럿이고,
    // 그때 이 판정이 남의 창을 보면 비활성 창의 패널까지 git 을 부른다
    // (NFR-RTU-1 이 그것을 금한다).
    const w=this.p.root?this.app.edWindowFor(this.p.root):this.app.gitWindow();
    if(!w||!this.app.windowVisible(w.id)) return false;
    // 창이 보이는 것과 **이 패널의 표면**이 보이는 것은 다르다 — 사이드가
    // Explorer 이고 본문에 git 뷰 탭도 없으면 이 관측을 쓰는 화면이 없다.
    if(this.p.root&&!this.app.gitSurfaceOn(w)) return false;
    return !!this.p.repo;
  }

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
    if(this.p._missing) return st>0?GIT_REPO_MISSING_POLL_MS:0;
    const n=this.p._failStreak;
    if(n<=0) return st;
    return st>0?Math.min(st*Math.pow(2,n),GIT_FAIL_BACKOFF_MAX_MS):0;
  }

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
    if(!this.p.obs.pollOkAny()){this._stop();return false}
    const st=this._cadence(gitStatusInterval);
    if(this.p._pollOn&&this.p._pollSt===st) return false;
    this._stop();
    this.p._pollOn=true; this.p._pollSt=st;
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
    const opts={owner:this.p, whenHidden:'run'};
    if(st>0) this.p._stPoll=TIMERS.every({...opts,id:'git.status:'+(this.p.root||'-'),
      every:()=>st, run:()=>this.p.obs.tick()});
    return true;
  }

  // 조건이 참이 되면 즉시 1회 수집하고 주기를 건다 (FR-GIT-22).
  _reschedule(){
    if(this._applyCadence()) this.p.collect();
  }

  _stop(){
    if(this.p._stPoll){this.p._stPoll.stop();this.p._stPoll=null}
    this.p._pollOn=false;
  }

  // collect 는 status 1회다. single-flight — 진행 중이면 "끝나면 한 번 더" 플래그만
  // 세운다 (FR-GIT-21). 요청은 활성 리포에만 간다 (FR-GIT-24).
  async collect(){
    const repo=this.p.repo; if(!repo) return;
    if(this.p._busy){this.p._again=true;return}
    this.p._busy=true;
    const seq=++this.p._seq;
    const tok=this.p.token();
    const wg=this.p._writeGen;
    let r=null,d=null;
    // 시한이 있다 (FR-RMS-29). 이 요청은 single-flight 라 답이 오지 않으면 `_busy`
    // 가 영구히 참으로 남고, 그 뒤의 모든 `collect()` 가 조용히 되돌아간다 —
    // 타이머는 살아 있는데 status 만 멎는 모양이다 (TC-SVS-64 · Windows 러너 실측:
    // 46초 동안 signature 요청만 돌았다). 넘기면 망 실패와 같은 길을 간다 — 이전
    // 화면을 지키고 백오프를 지난다.
    // GIT_WATCH_LEASE_SRS FR-GWL-9: **누가 보는지를 함께 말한다.**
    //
    // 종전에는 이 요청 자체가 서버 감시의 수명이었다 — 90초 안에 다음 요청이 오지
    // 않으면 감시가 걷히고 `git_changed` 방송이 멎었다. 그래서 안전망을 끄면 본줄이
    // 끊겼다 (GP-1). `clientId` 를 실으면 그 신원의 SSE 구독이 임대를 쥐므로,
    // 이 요청이 뜸해져도 아예 끊겨도 감시가 산다.
    const q={repo};
    if(this.app&&this.app.clientId) q.clientId=this.app.clientId;
    /**
     * OPTIMIZE_REFACTOR_SRS FR-OPT-4-7 (IPC-30): **가진 관측의 mark 를 싣는다.**
     *
     *   이전 동작: 안전망·push 후속·가시성 복귀가 변화가 없어도 매번 목록 전량을 받았다
     *   새  동작: 서버가 같은 관측이면 `unchanged:true` 만 답하고, 보낼 때 잡아 둔
     *             본문으로 채워 그대로 적용한다 — 아래 경로는 달라지지 않는다
     *   이유:     그 요청들의 대부분은 변화가 없다. 옛 서버는 인자를 무시한다
     */
    const prev=this.p._status;
    if(prev&&prev.mark&&prev.requested===repo) q.ifMark=prev.mark;
    // 허브의 줄에 **떠날 때** 선다 — 먼저 떠난 쪽의 늦은 답이 나중 관측을 덮지 않는다.
    const hub=this.app&&this.app.gitStatusHub?this.app.gitStatusHub():null;
    const ht=hub?hub.depart(repo):0;
    r=gitStatusMerge(await gitFetch(GIT_API.status,q),prev);
    d=r.data;
    // FR-OPT-4-1 (FEU-M1): 이 관측을 탐색기와 나눈다 — 같은 root 를 보는 탐색기가
    // 다음 틱에 요청 없이 칠한다.
    if(this.p._seq===seq&&r.ok&&d&&hub) hub.feed(repo,r,ht);
    // 리포가 바뀌면 setRepo 가 소유권을 끊는다 — 그 뒤 도착한 응답은 플래그를
    // 건드리지 않는다.
    if(this.p._seq!==seq){this._applyStatus(tok,r,d);return}
    this.p._busy=false;
    const again=this.p._again; this.p._again=false;
    // REPO_FIX 05 §3A-5 (F-4.1): 보낸 뒤 쓰기가 시작·끝났으면 이 관측은 쓰기 이전의 것일 수
    // 있다 — 적용하지 않고 한 번 더 받는다. 이전: 쓰기 전에 출발한 status 가 방금 쓴
    // 결과를 덮어 다음 폴링까지 되돌아간 화면을 보였다(#41).
    if(this.p._writeGen!==wg){this.p.collect();return}
    this._applyStatus(tok,r,d);
    if(again) this.p.collect();
  }

  // REFACTOR3_FE_REST3_SRS FR-FR3-20 (FU-16): 세대 → 판정(순수) → 갈래. 성공은 받아들이기 → 칠하기 순서다.
  _applyStatus(tok,r,d){
    // ① 세대·리포 확인 (FR-GIT-16)
    if(this.p.isStale(tok)) return;
    const v=gitStatusVerdict(r,d,tok.repo);
    if(v==='net'){this._applyNetFail();return}
    if(v==='error'){this._applyError(d&&d.error);return}
    if(v==='drop') return;
    if(v==='not_repo'){this._applyError('not_a_git_repo');return}
    this._adoptObs(d);
    this._paintObs(d);
  }

  _applyNetFail(){
    // 네트워크 오류 — 이전 화면을 유지한다. **목록을 지우지 않는다.**
    // 사유가 붙은 화면은 관측으로 그린 화면이 아니다 — 근거를 버려 회복하는
    // 관측이 값이 같아도 다시 그리게 한다 (FR-GIT-227).
    this.p._obsSig=null;
    this._fail();
    this.p._staleNote=true; this.p.obs.paintAll();
  }

  // 성공한 관측을 패널의 상태로 받아들인다 — 실패 누적·관측 시각·주기·근거·뷰 따라가기·오류 표식 풀기.
  _adoptObs(d){
    // 관측이 성공했다 — 누적을 놓고 주기를 기준으로 되돌린다 (FR-RMS-24).
    // 소실이었다면 여기가 복구 지점이다 (FR-RMS-11).
    this.p._failStreak=0;
    // UX_BATCH9_SRS FR-GLR-2: 화면이 언제의 것인지를 남기는 유일한 자리다.
    this.p._lastObsAt=Date.now();
    this.p.viewRoots._leaveMissing();
    this._applyCadence();
    this.p._status=d;
    // 응답에 signature 가 함께 오므로 그 값으로 갱신한다 — 직후 signature 폴링이
    // 헛되이 변화를 보고하지 않게 한다.
    //
    this.p._lastSig=(d.signature&&d.signature.value)||'';
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
    const fp=this.p._viewFp(d);
    const prevFp=this.p._lastViewFp;
    this.p._lastViewFp=fp;
    // 첫 관측(`setRepo` 직후의 null)은 변화가 아니다 — 뷰는 열릴 때 스스로 받는다.
    if(prevFp!==null&&prevFp!==fp) this.p.obs.reloadViewsAll();
    // FR-GVR-8a: 변화가 없어도 **목록이 관측보다 낡았으면** 받는다. 뷰의 목록과 이
    // 관측은 서로 다른 시각의 저장소다 — 뷰의 `git log` 가 변경 **전**에 돌고 첫
    // status 가 변경 **후**에 돌면, 그 변경은 기준선에 이미 들어 있어 위의 비교는
    // 영영 "같다" 다 (V-GVR-26 · TC-SVS-60 의 trace 실측). 목록이 받아진 시각의
    // signature(log 응답이 싣는다)와 견주므로, 같은 시각이면 요청이 나가지 않는다 —
    // 무조건 한 번 더 받으면 늦게 온 기준선이 펼친 상세와 뒷장을 덮는다 (실측).
    else this.p.obs.reloadStaleViewsAll(this.p._lastSig);
    // FR-GLV-1: Diff 는 위 갈래 **밖**이다. 근거가 되는 것이 관측이 아니라 파일의
    // 내용이므로 fp 가 같아도 낡을 수 있다 — 그래서 매 회차 지난다.
    this.p.obs.reloadDiffAll();
    this.p._errMsg=null; this.p._staleNote=false;
    // 관측이 성공했다 — 저장소가 아니라는 판정은 더 이상 참이 아니다
    // (FR-RTU-25). `git init` 뒤의 첫 성공이 이 자리를 지난다.
    this.p._notRepo=false;
    /**
     * GIT_REFRESH_LIFECYCLE_SRS FR-GRF-4·5 (`GP-3`): **git 이 돌아왔다.**
     *
     *   이전 동작: `_gitMissing=true` 를 푸는 코드가 **생성자 한 줄뿐**이었다.
     *             git 을 찾지 못한 응답 한 번이면 그 관측기는 페이지 수명 내내
     *             `_pollOk()===false`·`signal()` 무시 상태로 남았고, 새로고침
     *             버튼으로 목록을 되살려도 자동 갱신은 돌아오지 않았다
     *   새  동작: 성공한 관측이 푼다 — `_notRepo=false` 와 같은 자리다
     *   이유:     `_notRepo`·`_missing` 은 둘 다 복구 경로를 갖는다.
     *             `git_missing` 만 빠져 있었다 (`11 GP-3`)
     *
     * 푼 뒤에 주기를 다시 건다 (FR-GRF-5) — 해제만 하면 `_pollOk()` 가 참이 돼도
     * 타이머는 걷힌 채 남는다. 위의 `_applyCadence()` 는 이 해제 **전**에 돌았다.
     */
    if(this.p._gitMissing){this.p._gitMissing=false;this._applyCadence()}
  }

  // 받아들인 관측을 화면과 이웃에 알린다 — 같은 관측이면 칠하지 않는다.
  _paintObs(d){
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
    // REPO_FIX 05 §3A-6 (F-6.1 / §3A-0 X5): 관측 동일성은 서버의 `mark` 하나로 판정한다 —
    // (저장소, mark) 가 직전 적용분과 같으면 재조정을 건너뛴다. `mark:""` 는 비교하지 않는다.
    // 이전: 매 회차 status 전체를 JSON 으로 만들어 견줬다.
    // SERVER_DRIVEN_ACTIONS_SRS GR-1d: 1층 답(`actions`)은 mark 밖이다 — 잡이 시작·끝나면
    // 관측은 같아도 버튼은 바뀐다. 그래서 답도 근거에 넣는다.
    const obs=d.mark?rptKey(d.repo||'',d.mark+'|'+JSON.stringify(d.actions||null)):'';
    if(!obs||obs!==this.p._obsSig){this.p.obs.paintAll(); this.p._obsSig=obs||null}
    // 활성 리포의 배지가 따라 갱신된다. 다른 리포는 서버의 마지막 관측값이다.
    this.app.gitReposKick();
    // 상태바 chip 은 Git 창 밖에서도 보이므로 관측마다 갱신한다 (FR-GIT-57).
    this.app.updateStatusBar();
    // FR-GIT-111 (FR-RPT-8): 충돌 판정은 관측마다 돈다 — 다시 그리기에 업히면
    // 관측이 같은 회차에 판정이 멈춘다.
    this.p.obs.notifyStatusAll();
    // FR-GIT-178: 다이얼로그가 열려 있으면 대상 변경을 알린다. 실행은 막지 않는다.
    if(typeof GitConfirm!=='undefined') GitConfirm.notify(this.p._lastSig);
    if(typeof GitDialog!=='undefined') GitDialog.notify();
  }

  // 성공하지 못한 관측 하나. 사유를 가리지 않는다 (FR-RMS-22) — 갈래마다 다른
  // 규칙을 두면 "가장 느릴 때" 가 화면마다 달라진다.
  _fail(){
    this.p._failStreak++;
    this._applyCadence();
  }

  _applyError(code){
    // 사유가 붙은 화면은 관측으로 그린 화면이 아니다 (FR-GIT-227).
    this.p._obsSig=null;
    // FR-RMS-6·7: 소실은 **활성 리포를 해제하지 않는다.** 해제하면 무엇을 다시 볼지
    // 잃어 자동 복구가 불가능해진다 (D-RMS-5). 주기는 백오프가 아니라 고정이다
    // (FR-RMS-26) — 확정된 사실은 점증할 이유가 없다.
    if(code===GIT_RMS_CODE){
      this.p._failStreak=0;
      this.p.viewRoots._enterMissing();
      this._applyCadence();
      return;
    }
    this._fail();
    if(code==='not_a_git_repo'){
      this.p._errMsg=GIT_ERR_NOT_REPO; this.p._status=null;
      // REPO_TAB_UNIFY_SRS FR-RTU-25: Repo 창은 **그 자리에서 만들 수 있다.**
      // `setRepo(null)` 은 옛 표면의 처리다 — 거기서는 활성 리포를 놓는 것이
      // 곧 "고를 자리로 돌아간다" 였지만, Repo 창의 저장소는 창의 루트라
      // 놓을 대상이 없다 (그래서 `setRepo` 도 no-op 이다).
      this.p._notRepo=true;
      this.p.setRepo(null);
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
      this.p.obs.paintAll();
      return;
    }
    if(code==='git_missing'){
      this.p._errMsg=GIT_ERR_GIT_MISSING; this.p._gitMissing=true;
      this._stop(); this.p.obs.paintAll();
      return;
    }
    this.p._staleNote=true; this.p.obs.paintAll();
  }
}
