/**
 * Remote Terminal — git 조정자 (PACKAGE_RESTRUCTURE_SRS FR-APP-2)
 *
 * `GitController` 가 창 종류의 판정·Git 표면으로 가기·파일과 터미널 열기·GIT 섹션 배선·즉시 신호를 진다.
 * App 은 이것을 `git` 으로 든다(REFACTOR3_FE_APPCTL_SRS 9d, 옛 `app-git.js`). 부품 둘 — 패널과 관측기의 등록부
 * `GitSurfaces`(`git-surfaces.js`) `.surfaces` · Repo 목록·핀·변화 관측·작업 `GitSync`(`git-sync.js`) `.sync`.
 * 패널 맵 `gitPanels`·관측기 `_gitObservers`·워치독 문턱 `_gitWdAt`·작업 `_gitJobs` 는 App 에 남는다 — 렌더러·계약·e2e 가 읽는다.
 * app.js 이후 main.js 이전에 로드된다 (FR-APP-5).
 */
class GitController extends Controller {
  constructor(app){
    super(app);
    this.surfaces=new GitSurfaces(app);
    this.sync=new GitSync(app);
  }

  // gitWindow 는 워크스페이스의 Git 창이다. 없으면 null (FR-GIT-26).
  gitWindow(){return this.app.ws.windows.find(s=>s&&s.type===WINDOW_TYPE_GIT)||null}

  // FR-GIT-179·182: Git 창은 닫힌 창이고 창 목록·순환의 대상이 아니다. 판정은
  // 이 두 곳에만 둔다 — 조건이 흩어지면 한 곳이 빠져도 조용히 지나간다.
  isGitWin(s){return !!(s&&s.type===WINDOW_TYPE_GIT)}
  // EDITOR_TAB_SRS FR-EDT-45: Editor 창도 같은 근거로 창 목록·창 순회의 대상이
  // 아니다 — 진입점은 Editor 탭의 행뿐이다. 판정을 여기 하나에 모은다.
  // CHAT_WINDOW_SRS FR-CW-1·5: 채팅 창도 같다 — 진입점은 메인 패널의 `채팅` 탭이다.
  isChatWin(s){return !!(s&&s.type===WINDOW_TYPE_CHAT)}
  /** 일반(터미널) 창이 아닌 창 — Git·Repo·채팅. 창 목록·순회·대체의 판정은 이것 하나다. */
  isKindWin(s){return this.isGitWin(s)||this.app.isEditorWin(s)||this.isChatWin(s)}
  plainWindows(){return this.app.ws.windows.filter(s=>!this.isKindWin(s))}

  /**
   * FR-GIT-183a → FR-SBT-23·24: Git 창을 떠날 때 가는 창.
   *
   * **직전에 활성이었던 일반 창**이고, 그 창이 이미 닫혔거나 기억이 없으면 일반 창
   * 목록의 첫 번째다. 일반 창이 하나도 없으면 null 이다.
   *
   * 옛 `Close Git` 버튼과 `Windows` 탭이 같은 곳으로 가야 하므로 계산은 여기 하나다
   * (FR-SBT-36) — 두 벌로 만들면 한쪽만 고쳐진다.
   */
  /**
   * 지금 보고 있던 리포가 목록에서 사라졌을 때 떠나는 자리.
   *
   * **REPO_TAB_UNIFY_SRS FR-RTU-70 으로 할 일이 없어졌다.** 옛 Git 창은 리포를
   * 갈아타는 창이라 "보고 있던 것이 사라졌다" 는 상태가 있었지만, Repo 창은
   * 저장소 하나에 창 하나라 그 창 자체가 재조정으로 사라진다 — 그 처리는
   * `_edAfterChange` 가 목록이 바뀌는 모든 경로에서 이미 한다.
   *
   * 자리를 남겨 두는 이유는 호출자(`gitUnpin`)가 하나 있기 때문이다. 지우면서
   * 그쪽 배선까지 건드리면 이 마일스톤의 범위를 넘는다.
   */
  _gitLeaveIfRemoved(){}

  // Windows 탭이 돌아갈 자리이기도 하다 (FR-SBT-23·36) — Git 창이 사라져도
  // 그 계산은 남는다.
  gitBackTarget(){
    const plain=this.plainWindows();
    return plain.find(s=>s.id===this.app._lastPlainWindow)||plain[0]||null;
  }

  // FR-RTU-70: 옛 워크스페이스의 Git 창을 걷어낸다. 그 안의 남의 탭은 일반
  // 창으로 건져 내고 고정 뷰 탭은 버린다 (D-RTU-14).
  // 판정과 이동은 layout-tree.js 의 순수 함수(`migrateGitWindows`)가 한다 — 로드 경로가 둘이라 여기서 두 벌로
  // 만들면 한쪽만 고쳐진다.
  _migrateGitWindow(list){
    const ws=list||this.app.ws.windows;
    const n=migrateGitWindows(ws,()=>{
      // 받을 일반 창이 없으면 껍데기 창을 만든다 (O19). PTY 는 붙이지 않는다 —
      // 옮겨 온 탭이 이미 자기 실체를 들고 온다.
      const w={id:newEntityId(),name:'Window',
        layout:{type:'pane',id:newEntityId(),tabs:[],activeTab:null}};
      ws.push(w);
      return w;
    });
    if(n) this.app.save();
  }

  /**
   * REPO_TAB_UNIFY_SRS FR-RTU-72: **그 저장소의 Repo 창으로 간다.**
   *
   * 이름과 계약(경로 하나를 받아 그 표면을 연다)은 그대로 두었다 — 부르는 자리가
   * 셋이기 때문이다: 사이드바 행, `dmctl`, e2e. 달라진 것은 가는 곳뿐이다.
   *
   * 목록에 없는 경로면 **먼저 더한다.** 연동이 핀까지 함께 만들고(FR-EDT-33)
   * 재조정이 창을 세운다 (FR-EDT-42) — 즉 이 한 번이 요구 ①의 "add 하면 git·
   * editor 가 같이" 그대로다.
   */
  async openGitWindow(repo){
    if(!repo) return null;
    if(!this.app.edWindowFor(repo)) await this.app.edMutate('/add',{path:repo});
    const win=this.app.edWindowFor(repo);
    if(!win) return null;
    this.app.switchWindow(win.id);
    return win.id;
  }

  // ── 좌측 GIT 섹션 (FR-GIT-9~17) ──

  // GIT 섹션 배선. 진입점은 정적 요소이므로 리스너는 여기서 한 번만 붙인다.
  _initGitSection(){
    // FR-RTU-5: `+ Add` 는 Repo 탭 하나이고 그 배선은 `editor-section.js` 가 든다 —
    // 두 목록이 한 종단(`/api/editors/add`)으로 함께 바뀌므로 진입점도 하나다.
    // 옛 `#git-add-repo` 는 사라졌다.
    this.sync._startGitReposPoll();
    this.app.gitPanel.init();
    /**
     * GIT_LIVE_TRIGGERS_SRS FR-GLW-1~3: 가시성·포커스 복귀의 계기.
     *
     * **여기가 앱당 한 벌인 자리다** — 이 함수는 부팅에서 한 번 돈다 (app.js).
     * 종전에는 같은 리스너가 `panel-poll.js`(지금 `git-poll.js`) 의 `init()` 에 있었고 가드가
     * 관측기의 것이라 부팅 때 활성이던 관측기 하나에만 결선됐다 (SRS §2.1).
     *
     * **문서에 리스너를 새로 달지 않는다** (FR-GLW-2 · FR-BUS-8). `EventBus` 가
     * 이미 `visibilitychange`·`focus` 를 한 번 듣고 세 토픽으로 발행한다 —
     * 거기 붙으면 FR-SVS-30("문서 이벤트는 앱당 한 벌")이 가드가 아니라 구조로
     * 지켜진다.
     *
     * 숨김도 같은 자리를 지난다. 숨으면 전 패널이 조건을 다시 보고 폴링을
     * 걷어야 한다 — 되살리기만 넓히면 아무도 보지 않는 저장소가 폴링을 이어간다
     * (FR-GLW-3 · FR-GLR-3).
     *
     * 토픽 이름이 `life:` 로 시작하는 것은 규약이다 (FR-GLW-8) — 접두 없는
     * `focus` 는 서버 SSE 의 명령 이름이기도 해서, 그것을 구독하면 그 명령이
     * 처리기에 닿지 못한다.
     */
    for(const [topic,kind] of [[LIFE_VISIBLE,'visible'],[LIFE_FOCUS,'focus'],[LIFE_HIDDEN,null]])
      this.app.bus.subscribe(topic,()=>this._gitLifecycle(kind),{owner:'git:lifecycle'});
    /**
     * FR-GLW-4·5: 워치독의 **주기** 계기.
     *
     * 렌더 훅(renderer.js)은 그대로 남는다 (D-5) — 표면이 막 바뀐 직후를 가장
     * 이르게 잡는 것은 여전히 렌더다. 모자랐던 것은 렌더가 **주기적이지 않다**는
     * 것이다: 사용자 조작과 `workspace_changed` 로만 돈다.
     *
     * `when` 은 주지 않는다 — 판정은 `gitWatchdogAll` 자신이 하고(문턱 → 나이),
     * 그것을 스케줄러로 옮기면 같은 판단이 두 곳에 선다 (FR-SCH-4).
     *
     * `whenHidden:'pause'` 인 것은 git status job(`'run'`)과 근거가 다르다. 그쪽은
     * "조건이 참이 된 순간 즉시 1회 수집" 을 스케줄러에 넘길 수 없어서 `'run'`
     * 이고, 이쪽은 숨김 중에 모든 `_pollOk()` 가 거짓이라 되살릴 것이 정의상
     * 없다 — 다시 보이는 순간은 바로 위 `visible` 구독이 든다.
     */
    this.app.timers.every({
      id:'git.watchdog', owner:'git:lifecycle', whenHidden:'pause',
      every:()=>GIT_WATCHDOG_CHECK_MS,
      run:()=>this.app.git.surfaces.gitWatchdogAll(),
    });
  }

  /**
   * FR-GLW-1·3: 복귀·숨김 신호 하나가 **살아 있는 패널 전부**의 조건을 다시 보게
   * 한다.
   *
   * 수집을 관측기마다 흩지 않는다 (D-3). 숨김 동안 폴링은 걷혀 있으므로 복귀 시
   * `_reschedule()` 이 `_applyCadence()` 의 참을 받아 **그 자리에서 수집하고**
   * (FR-GIT-22), 그 status 가 곧 저장소마다의 관심 표명이다 — 보이는 표면마다
   * 한 건이면 족하다.
   *
   * `signal()` 은 종전대로 **포커스 패널 하나**에만 준다. 그 값을 딛는 것이 상태바
   * chip 과 사이드바 배지이고(git-poll 의 `signal` 주석), 관측기 전부에 주면
   * 보이지 않는 표면까지 복귀 신호마다 요청을 하나씩 낸다 (NFR-GLW-2).
   */
  _gitLifecycle(kind){
    this.app.git.surfaces._gitRescheduleAll();
    if(kind) this.gitSignal(kind);
  }

  // gitSignal 은 즉시 신호의 단일 진입점이다 (FR-GIT-18). 어디서 왔는지는 라벨로만
  // 남기고 처리는 GitPanel 이 한다 — 디바운스와 게이팅이 한 곳에 있어야 한다.
  //
  // 순서가 계약이다 (REFACTOR3_FE_APPCTL_SRS FR-FEA-5 — 옛 `app-editor-pane.js` 가 로드 시점에 원형을 감싸던 것).
  // ① 허브를 먼저 무효화한다 (OPTIMIZE_REFACTOR_SRS FR-OPT-4-1) — 신호 **뒤의** 답이어야 하고, 그 전에 떠난
  // 요청과 캐시는 나눠 쓰지 않는다 ② 포커스 패널의 신호 ③ 편집기의 후속(`_edAfterGitSignal`, FR-EDT-78) —
  // 저장은 탐색기 색과 dirty-diff 기준의 즉시 갱신 계기다.
  gitSignal(kind){
    this.gitStatusHub().invalidate();
    if(this.app.gitPanel) this.app.gitPanel.signal(kind);
    this.app._edAfterGitSignal(kind);
  }

  // OPTIMIZE_REFACTOR_SRS FR-OPT-4-1: 탐색기·dirty-diff 가 나눠 쓰는 status. 요청은
  // 이 탭의 신원을 싣는다 — 탐색기도 서버 감시의 임대를 쥔다 (IPC-8).
  gitStatusHub(){
    if(!this._gitHub) this._gitHub=new GitStatusHub({clientId:()=>this.app.clientId||''});
    return this._gitHub;
  }

  /**
   * FR-GIT-41·185 의 Open File. addTab 의 editor 분기를 그대로 쓴다 — 이미 열려
   * 있으면 그 탭으로 이동한다.
   *
   * **Git 창에는 열지 않는다** (FR-GIT-179). 대상은 직전에 활성이었던 일반 창이고,
   * 없으면 만든다 (O15). 연 뒤 그 창을 활성화한다 — 열었는데 보이지 않으면
   * 사용자는 실패로 읽는다.
   */
  async gitOpenFile(filePath,opts){
    if(!filePath) return;
    // FR-EDT-94·97: 편집기 탭은 일반 창에 열리지 않는다. 대상 창은 **활성 리포
    // 경로에 연결된 Editor** 다 — 파일 경로로 고르지 않는다. 연동(FR-EDT-31)으로
    // 핀이 걸린 리포에는 그 Editor 가 늘 있다.
    if(this.app.edOn()){ await this.app.edOpenFile(filePath,{anchor:this._gitActiveRepo(),preview:!!(opts||{}).preview}); return }
    const w=await this._gitPlainTarget(); if(!w) return;
    const rid=this._gitPaneOf(w);
    if(rid) await this.app.addTab(rid,TAB_TYPE_EDITOR,{filePath,windowId:w.id});
  }

  /**
   * FR-GIT-274: `HEAD:<path>` 의 내용을 연다 (Open File (HEAD)).
   *
   * **Open File 과 같은 규약이다** — Git 창이 아닌 창에 연다 (FR-GIT-179·185).
   * 다른 것은 여는 대상뿐이다: 서버가 HEAD 의 내용을 저장소 밖에 놓아 준 경로이며,
   * 탭 이름에 그것이 HEAD 의 것임을 적는다 — 워킹 트리의 파일과 구분되지 않으면
   * 사용자가 그 자리에서 편집한 것이 저장소에 반영된다고 오해한다.
   */
  async gitOpenFileHead(openPath,relPath){
    if(!openPath) return;
    const name=pathBase(relPath||openPath)+GIT_HEAD_TAB_SUFFIX;
    // FR-EDT-94·98: Open File 과 같은 규약이다 — **리포로 고른다.** 서버는 HEAD 의
    // 내용을 저장소 밖에 놓으므로 파일로 고르면 언제나 폴백으로 떨어진다. 그 임시
    // 파일이 탐색기 루트 밖인 것은 정상이다 (FR-EDT-99).
    if(this.app.edOn()){ await this.app.edOpenFile(openPath,{name,anchor:this._gitActiveRepo()}); return }
    const w=await this._gitPlainTarget(); if(!w) return;
    const rid=this._gitPaneOf(w);
    if(rid) await this.app.addTab(rid,TAB_TYPE_EDITOR,{filePath:openPath,name,windowId:w.id});
  }

  /**
   * FR-GIT-244: worktree 에서 터미널 탭을 연다. Open File 과 **같은 대상 창**을
   * 쓴다 — Git 창에는 열지 않는다 (FR-GIT-179).
   */
  async gitOpenTerminal(cwd){
    if(!cwd) return;
    const w=await this._gitPlainTarget(); if(!w) return;
    const rid=this._gitPaneOf(w);
    if(rid) await this.app.addTab(rid,TAB_TYPE_TERMINAL,{cwd,windowId:w.id,name:pathBase(cwd)});
  }

  /**
   * FR-GIT-185 의 대상 창. 직전에 활성이었던 일반 창이고, 없으면 만든다. 연 뒤
   * 활성화하는 것까지 여기서 한다 — 열었는데 보이지 않으면 사용자는 실패로 읽는다.
   *
   * Open File 과 터미널 열기가 이 한 자리를 쓴다 — 두 벌로 두면 한쪽만 고쳐진다.
   */
  async _gitPlainTarget(){
    const plain=this.plainWindows();
    let w=plain.find(s=>s.id===this.app._lastPlainWindow)||plain[0];
    if(!w) w=await this.app._mkWindow();
    if(!w||!w.layout) return null;
    this.app.switchWindow(w.id);
    return w;
  }

  // FR-EDT-97: 라우팅의 기준이 되는 **활성 리포**. 창에 붙어 있는 값을 패널이
  // 쥐고 있다 (FR-GIT-29) — 판정 자리를 늘리지 않으려고 여기 하나로 읽는다.
  _gitActiveRepo(){ return (this.app.gitPanel&&this.app.gitPanel.repo)||'' }

  /**
   * REPO_TAB_UNIFY_SRS FR-RTU-6: 그 경로의 마지막 git 관측값.
   *
   * 두 목록이 같은 집합이므로(§2.1) 경로로 짝지으면 된다. 저장소가 아닌 행에는
   * 배지가 없다 — `gitPinnedEntries` 가 그때 `badge:null` 을 싣는다.
   */
  gitBadgeFor(path){
    if(!path) return null;
    const hit=this.gitPinEntry(path);
    return (hit&&hit.badge)||null;
  }

  /**
   * FR-RMS-11·17: 그 경로의 핀 항목. `isRepo`·`reason` 이 여기 실려 온다.
   *
   * `Repo` 탭의 행이 소실 사유를 보이려면 배지만으로는 부족하다 — 사라진 저장소는
   * 배지가 `null` 이고, 그 상태는 "관측이 아직 없다" 와 구분되지 않는다. 옛 `Git`
   * 목록의 행이 이 값을 읽고 있었고, 두 탭을 합칠 때 그 절반이 빠졌다 (실측:
   * V-RMS-11 이 행의 title 에서 사유를 찾지 못했다).
   */
  gitPinEntry(path){
    if(!path) return null;
    const pinned=((this.app.gitRepos||{}).pinned)||[];
    return pinned.find(e=>e&&e.path===path)||null;
  }

  _gitPaneOf(w){
    return (w.focusedPane&&findPane(w.layout,w.focusedPane))?w.focusedPane:firstPane(w.layout)?.id;
  }

  /**
   * _gitTermToolId 는 `+ Add` 가 "지금 터미널의 리포" 를 물을 때 딛는 도구다
   * (FR-FLW-6). **목록은 이것을 쓰지 않는다** — 목록은 핀에서만 온다.
   *
   * 포커스가 터미널이 아닐 때(Git 창·편집기 탭) **마지막 터미널을 유지한다.**
   * 빈 값을 보내면 서버가 자기 cwd 로 답하는데, 그것은 사용자가 가 본 적 없는
   * 리포다 — Git 창에 들어간 순간 대상이 dongminal 자신으로 바뀌는 결함이
   * 그것이었다 (D-FLW-6, 옛 FR-GIT-210).
   */
  _gitTermToolId(){
    const p=this.app.focusedTerminal();
    if(p){this.app._lastTermTool=p.id; return p.id}
    // 포커스가 터미널이 아니면(Git·Editor 창) **워크스페이스를 다시 읽는다.**
    //
    // 기억을 먼저 쓰면 그것이 낡는다. 기억의 갱신 계기는 칸 포커스(공개
    // `setFocus`) 하나뿐인데, 포커스가 실제로 옮겨 가는 통로는 그것 말고도
    // 창 전환(`switchWindow`)·탭 전환(`switchTab`)·탭 추가(`addTab`)가 있고
    // 셋 다 그 계기를 지나지 않는다. 그래서 `+ Add` 가 사용자가 방금 떠나온
    // 자리가 아니라 마지막으로 **클릭한** 자리를 채웠다 (V87a·V87b).
    //
    // 계기를 셋 더 다는 대신 계기를 지운다 — 이 계산은 워크스페이스의 지금
    // 상태를 읽으므로 셋 모두를 저절로 따라간다.
    const now=this._anyTermToolId();
    if(now){this.app._lastTermTool=now; return now}
    // 일반 창의 활성 탭이 하나도 터미널이 아닐 때만 기억이 마지막 근거다
    // (D-FLW-6). 사라진 도구를 가리키면 서버가 다시 자기 cwd 로 답하므로
    // 살아 있는 것만 쓴다.
    if(this.app._lastTermTool&&this.app.toolIds.has(this.app._lastTermTool)) return this.app._lastTermTool;
    return '';
  }

  // 일반 창의 활성 탭 중 터미널인 것. 여러 개면 마지막으로 쓴 창을 먼저 본다 —
  // 그것이 사용자가 방금 떠나온 자리다.
  _anyTermToolId(){
    // 판정은 `plainWindows` 하나다 — Git 창만 걸러 두면 Editor 창의 탭이
    // 후보가 되는데, 거기에는 터미널 탭이 애초에 없다 (FR-EDT-54).
    const wins=this.plainWindows();
    const order=wins.slice().sort((a,b)=>
      (b.id===this.app._lastPlainWindow?1:0)-(a.id===this.app._lastPlainWindow?1:0));
    for(const w of order){
      const pn=w.focusedPane?findPane(w.layout,w.focusedPane):firstPane(w.layout);
      for(const p of [pn,firstPane(w.layout)]){
        if(!p) continue;
        const tab=p.tabs.find(x=>x.id===this.app.paneTab(p));
        if(tab&&tab.type===TAB_TYPE_TERMINAL&&this.app.toolIds.has(tab.toolId)) return tab.toolId;
      }
    }
    return null;
  }
}

// FR-SVS-47: 전역 진입점은 **포커스 칸의 패널**을 가리킨다. 메뉴·확인창·다이얼로그는
// 화면에 하나만 서고 사용자가 방금 조작한 자리에 속한다 (D-8). 접근자로 두는 덕에
// `app.gitPanel` 을 딛던 자리들이 한 줄도 바뀌지 않는다.
Object.defineProperty(App.prototype,'gitPanel',{
  /**
   * FR-RTU-65: 포커스 칸에서 **지금 보고 있는 git 표면**의 패널이다.
   *
   * 활성 창이 Repo 창이면 그 루트의 것이고, 아니면 옛 Git 창의 자리('')다.
   * 터미널 창에 서 있을 때도 유효한 패널을 주어야 한다 — 상태바 chip 과
   * 사이드바 배지가 창을 보지 않을 때도 이 값을 딛는다 (git-poll 의 signal
   * 주석과 같은 근거).
   */
  get(){ const app=this; return app.git.surfaces.gitPanelAt(app.git.surfaces._gitRootOfActive(),app.slotFocused()) },
  configurable:true,
});
