/**
 * Remote Terminal — App git 연동 (PACKAGE_RESTRUCTURE_SRS FR-APP-2)
 *
 * class App 본문에서 옮겨온 메서드 23개. 본문은 수정하지 않았다 (FR-APP-3).
 * app.js 이후 main.js 이전에 로드된다 (FR-APP-5).
 */
Object.assign(App.prototype, {
  // _gitWindow 는 워크스페이스의 Git 창이다. 없으면 null (FR-GIT-26).
  _gitWindow(){return this.ws.windows.find(s=>s&&s.type===WINDOW_TYPE_GIT)||null},

  // FR-GIT-179·182: Git 창은 닫힌 창이고 창 목록·순환의 대상이 아니다. 판정은
  // 이 두 곳에만 둔다 — 조건이 흩어지면 한 곳이 빠져도 조용히 지나간다.
  _isGitWin(s){return !!(s&&s.type===WINDOW_TYPE_GIT)},
  _plainWindows(){return this.ws.windows.filter(s=>!this._isGitWin(s))},

  // FR-GIT-183: Git 창을 닫는다. 다시 열면 새로 만들어진다 (FR-GIT-26 유지).
  _gitCloseWindow(){
    const w=this._gitWindow(); if(!w) return;
    this.delWindow(w.id);
  },

  // FR-GIT-186: 개정 이전 워크스페이스의 Git 창 안 탭을 일반 창으로 옮긴다.
  // 판정과 이동은 helpers 의 순수 함수가 한다 — 로드 경로가 둘이라 여기서 두 벌로
  // 만들면 한쪽만 고쳐진다.
  _migrateGitWindow(list){
    const ws=list||this.ws.windows;
    const n=migrateGitWindows(ws,()=>{
      // 받을 일반 창이 없으면 껍데기 창을 만든다 (O19). PTY 는 붙이지 않는다 —
      // 옮겨 온 탭이 이미 자기 실체를 들고 온다.
      const w={id:newEntityId(),name:'Window',
        layout:{type:'pane',id:newEntityId(),tabs:[],activeTab:null}};
      ws.push(w);
      return w;
    });
    if(n) this._save();
  },

  // openGitWindow 는 Git 창을 활성화한다. 없으면 만든다 — 두 번 불러도 창은
  // 하나다 (FR-GIT-26). repo 를 주면 활성 리포까지 전환한다 (FR-GIT-15).
  async openGitWindow(repo){
    const win=this._gitWindow()||this._mkGitWindow(repo||null);
    if(repo) this.gitPanel.setRepo(repo);
    this.switchWindow(win.id);
    return win.id;
  },

  // _mkGitWindow 는 GIT_VIEWS 의 고정 탭을 갖춘 Git 창을 만든다. _mkWindow 와 달리
  // _newTool 을 부르지 않는다 — Git 창의 초기 상태에는 PTY 가 필요 없다.
  _mkGitWindow(repo){
    const r=newEntityId();
    const tabs=GIT_VIEWS.map(v=>({id:newEntityId(),name:v.name,type:TAB_TYPE_GIT,gitView:v.key}));
    const s={
      id:newEntityId(),name:GIT_WINDOW_NAME,type:WINDOW_TYPE_GIT,
      // 활성 리포는 창에 붙는다 — 창이 곧 Git 표면이므로 (FR-GIT-29).
      git:{repo:repo||null},
      layout:{type:'pane',id:r,tabs,activeTab:tabs[0].id}
    };
    this.ws.windows.push(s);
    return s;
  },

  // ── 좌측 GIT 섹션 (FR-GIT-9~17) ──

  // GIT 섹션 배선. 진입점은 정적 요소이므로 리스너는 여기서 한 번만 붙인다.
  _initGitSection(){
    const add=document.getElementById('git-add-repo');
    if(add) add.addEventListener('click',()=>this._gitAddRepo());
    this._startGitReposPoll();
    this.gitPanel.init();
  },

  // _gitSignal 은 즉시 신호의 단일 진입점이다 (FR-GIT-18). 어디서 왔는지는 라벨로만
  // 남기고 처리는 GitPanel 이 한다 — 디바운스와 게이팅이 한 곳에 있어야 한다.
  _gitSignal(kind){ if(this.gitPanel) this.gitPanel.signal(kind) },

  /**
   * FR-GIT-41·185 의 Open File. addTab 의 editor 분기를 그대로 쓴다 — 이미 열려
   * 있으면 그 탭으로 이동한다.
   *
   * **Git 창에는 열지 않는다** (FR-GIT-179). 대상은 직전에 활성이었던 일반 창이고,
   * 없으면 만든다 (O15). 연 뒤 그 창을 활성화한다 — 열었는데 보이지 않으면
   * 사용자는 실패로 읽는다.
   */
  async _gitOpenFile(filePath){
    if(!filePath) return;
    const w=await this._gitPlainTarget(); if(!w) return;
    const rid=this._gitPaneOf(w);
    if(rid) await this.addTab(rid,'editor',{filePath,windowId:w.id});
  },

  /**
   * FR-GIT-274: `HEAD:<path>` 의 내용을 연다 (Open File (HEAD)).
   *
   * **Open File 과 같은 규약이다** — Git 창이 아닌 창에 연다 (FR-GIT-179·185).
   * 다른 것은 여는 대상뿐이다: 서버가 HEAD 의 내용을 저장소 밖에 놓아 준 경로이며,
   * 탭 이름에 그것이 HEAD 의 것임을 적는다 — 워킹 트리의 파일과 구분되지 않으면
   * 사용자가 그 자리에서 편집한 것이 저장소에 반영된다고 오해한다.
   */
  async _gitOpenFileHead(openPath,relPath){
    if(!openPath) return;
    const w=await this._gitPlainTarget(); if(!w) return;
    const rid=this._gitPaneOf(w);
    const name=((relPath||openPath).split('/').pop())+GIT_HEAD_TAB_SUFFIX;
    if(rid) await this.addTab(rid,'editor',{filePath:openPath,name,windowId:w.id});
  },

  /**
   * FR-GIT-244: worktree 에서 터미널 탭을 연다. Open File 과 **같은 대상 창**을
   * 쓴다 — Git 창에는 열지 않는다 (FR-GIT-179).
   */
  async _gitOpenTerminal(cwd){
    if(!cwd) return;
    const w=await this._gitPlainTarget(); if(!w) return;
    const rid=this._gitPaneOf(w);
    if(rid) await this.addTab(rid,'terminal',{cwd,windowId:w.id,name:cwd.split('/').pop()});
  },

  /**
   * FR-GIT-185 의 대상 창. 직전에 활성이었던 일반 창이고, 없으면 만든다. 연 뒤
   * 활성화하는 것까지 여기서 한다 — 열었는데 보이지 않으면 사용자는 실패로 읽는다.
   *
   * Open File 과 터미널 열기가 이 한 자리를 쓴다 — 두 벌로 두면 한쪽만 고쳐진다.
   */
  async _gitPlainTarget(){
    const plain=this._plainWindows();
    let w=plain.find(s=>s.id===this._lastPlainWindow)||plain[0];
    if(!w) w=await this._mkWindow();
    if(!w||!w.layout) return null;
    this.switchWindow(w.id);
    return w;
  },

  _gitPaneOf(w){
    return (w.focusedPane&&findPane(w.layout,w.focusedPane))?w.focusedPane:firstPane(w.layout)?.id;
  },

  // 목록은 주기적으로 갱신하되 탭이 숨겨졌으면 건너뛴다 — 보이지 않는 섹션을
  // 위해 요청을 살 이유가 없다 (_startStatsPoll 의 선례, FR-STAT-17).
  _startGitReposPoll(){
    if(this._gitReposInterval)clearInterval(this._gitReposInterval);
    if(!this._gitReposVisHook){
      this._gitReposVisHook=true;
      document.addEventListener('visibilitychange',()=>{
        if(!document.hidden)this._gitReposRefresh();
      });
    }
    this._gitReposInterval=setInterval(()=>{
      if(document.hidden)return;
      this._gitReposRefresh();
    },GIT_REPOS_POLL_MS);
    this._gitReposRefresh();
  },

  /**
   * _gitFocusToolId 는 follow 가 딛는 도구다 (FR-GIT-9).
   *
   * 포커스가 터미널이 아닐 때(Git 창·편집기 탭) **마지막 터미널을 유지한다.**
   * 빈 값을 보내면 서버가 자기 cwd 로 답하는데, 그것은 사용자가 가 본 적 없는
   * 리포다 — Git 창에 들어간 순간 follow 가 dongminal 로 바뀌는 결함이 그것이었다.
   * follow 는 "포커스된 터미널의 cwd" 이고, 터미널을 떠났다고 다른 리포를
   * 가리켜서는 안 된다 (FR-GIT-10 의 "임의로 유지하지 않는다"와 같은 뜻이다).
   */
  _gitFocusToolId(){
    const p=this._focusedTerminal();
    if(p){this._lastTermTool=p.id; return p.id}
    // 사라진 도구를 가리키면 서버가 다시 자기 cwd 로 답한다 — 살아 있는 것만 쓴다.
    if(this._lastTermTool&&this.tools.has(this._lastTermTool)) return this._lastTermTool;
    this._lastTermTool=null;
    return '';
  },

  // _gitReposRefresh 는 GIT 섹션의 목록을 갱신한다. 실패하면 이전 목록을 유지한다 —
  // 네트워크가 한 번 튀었다고 섹션이 비면 안 된다.
  async _gitReposRefresh(){
    let r;
    try{r=await fetch('/api/git/repos?tool='+encodeURIComponent(this._gitFocusToolId()))}catch{return}
    if(r.status===503){
      // git 이 없거나 서비스가 구성되지 않은 환경이다. 섹션 전체를 숨긴다.
      this._gitOff=true;this.renderer._rGitSection();return;
    }
    if(!r.ok) return;
    let d;
    try{d=await r.json()}catch{return}
    this._gitOff=false;this._gitRepos=d;
    // 전체 render() 를 부르지 않는다 — 터미널 재부착 비용이 크다.
    this.renderer._rGitSection();
    // FR-GIT-249 (FR-RPT-8): 핀 목록이 **도착하는 자리**다. Worktrees 행의 핀 버튼이
    // 이 값을 읽으므로 여기서 알린다 — 상태 폴링의 다시 그리기에 업으면 관측이 같은
    // 회차에 버튼이 낡은 채로 남는다 (FR-GIT-227).
    if(this.gitPanel&&this.gitPanel.notifyPins) this.gitPanel.notifyPins();
  },

  // FR-GIT-12: 경로를 물어 핀한다. M1 에는 공통 다이얼로그가 없으므로 prompt 를
  // 쓴다 (다이얼로그 규약은 M5 묶음 P).
  _gitAddRepo(){
    const v=window.prompt(GIT_ADD_REPO_PROMPT,this._cwd||'');
    if(v===null) return;
    const path=v.trim(); if(!path) return;
    this._gitPin(path);
  },

  /**
   * FR-GIT-223: 핀 순서 재배치. 창 순서와 달리 **서버가 권위**이므로(O1) 여기서
   * 배열을 고치지 않고 서버가 준 목록을 받는다.
   *
   * 목록 전체가 아니라 (src, target, before) 를 보낸다 — 그 사이에 다른 창이 핀을
   * 더했을 때 전체를 보내면 그것을 조용히 지운다.
   */
  async _gitReorder(dr){
    if(!dr||dr.done||!dr.src||!dr.target||dr.src===dr.target) return;
    dr.done=true;
    let r=null,d=null;
    try{
      r=await fetch('/api/git/repos/reorder',{method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({src:dr.src,target:dr.target,before:!!dr.before})});
    }catch{r=null}
    if(r){try{d=await r.json()}catch{d=null}}
    if(!r||!r.ok||!d) return;
    this._gitPinsApply(d.pinned);
  },

  // _gitPin 은 경로를 검증해 핀한다. 저장소가 아니면 사유를 보인다 (FR-GIT-12) —
  // 조용히 실패하지 않는다.
  //
  // FR-GIT-249: `quiet` 는 **자기 안내 자리를 가진 호출자**의 것이다 (Worktrees 탭).
  // 그런 자리에서 alert 까지 띄우면 같은 사실을 두 번 알리게 된다. 이 섹션의 저장소
  // 추가는 보일 자리가 alert 뿐이므로 기본은 그대로다.
  async _gitPin(path,o){
    if(!path) return false;
    const quiet=!!(o&&o.quiet);
    let r,d;
    try{
      r=await fetch('/api/git/repos/pin',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path})});
      d=await r.json();
    }catch(err){if(!quiet)window.alert(GIT_PIN_FAIL_LABEL+': '+err);return false}
    if(!r.ok){if(!quiet)window.alert(GIT_PIN_FAIL_LABEL+' ('+(d&&d.error)+'): '+(d&&d.message));return false}
    this._gitPinsApply(d.pinned);
    await this._gitReposRefresh();
    return true;
  },

  async _gitUnpin(path){
    if(!path) return false;
    let r,d;
    try{
      r=await fetch('/api/git/repos/unpin',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path})});
      d=await r.json();
    }catch{return false}
    if(!r.ok) return false;
    this._gitPinsApply(d.pinned);
    await this._gitReposRefresh();
    return true;
  },

  // 핀은 workspace.json 최상위 git.pinned 에 산다 (O1). 서버가 고친 값을 로컬
  // 사본에도 반영해 둔다 — 다음 _save() 의 PUT 이 방금 만든 핀을 지우지 않게.
  _gitPinsApply(pinned){
    if(!Array.isArray(pinned)) return;
    if(!this.ws.git) this.ws.git={};
    this.ws.git.pinned=pinned;
  },

  /**
   * FR-GIT-112: 진행 중 원격 작업을 상태바에 보인다.
   *
   * Git 창의 폴링(FR-GIT-22)은 창이 활성일 때만 돌므로 그것에 얹으면 요구사항이
   * 뜻을 잃는다. 이 호출은 git 을 실행하지 않는다 — 서버가 들고 있는 목록이다.
   *
   * 목록은 Git 창에도 넘긴다: 다른 브라우저 창이 띄운 작업도 같은 리포의 원격
   * 버튼을 막아야 한다 (FR-GIT-101).
   */
  async _pollGitJobs(){
    if(!statusBar.git){this._gitJobs=[];return}
    let r=null,d=null;
    try{r=await fetch('/api/git/jobs')}catch{r=null}
    if(r&&r.ok){try{d=await r.json()}catch{d=null}}
    // 받지 못했으면 이전 목록을 유지한다 — 한 번의 실패로 chip 이 사라지면
    // "작업이 끝났다" 와 "모른다" 가 같아진다.
    if(!d||!Array.isArray(d.jobs)) return;
    this._gitJobs=d.jobs;
    if(this.gitPanel) this.gitPanel.adoptJobs(d.jobs);
  },

  // 방금 띄운 작업은 폴링 주기를 기다리지 않는다 (FR-GIT-112).
  _gitJobSeen(job){
    if(!job||!job.id) return;
    if(!this._gitJobs) this._gitJobs=[];
    if(this._gitJobs.some(j=>j.id===job.id)) return;
    this._gitJobs=this._gitJobs.concat([job]);
    this._updateStatusBar();
  },

  _gitJobEnded(id){
    if(!id||!this._gitJobs) return;
    const n=this._gitJobs.length;
    this._gitJobs=this._gitJobs.filter(j=>j.id!==id);
    if(this._gitJobs.length!==n) this._updateStatusBar();
  },

  // FR-GIT-57·59: 활성 리포의 마지막 관측을 chip 으로 만든다. 리포가 없거나
  // 관측이 없으면 null 이다 — 빈 chip 이나 '-' 를 보이면 "변경 없음" 과
  // "모른다" 가 같아진다.
  _gitChip(){
    const g=this.gitPanel;
    const s=(g&&g.repo&&g._status&&g._status.status)||null;
    if(!s) return null;
    const el=document.createElement('span');
    el.className='sb-item sb-git'+(s.detached?' sb-git-detached':'');
    el.title=(g.repo||'')+' — '+GIT_SB_TITLE;
    const b=document.createElement('span'); b.className='sb-git-branch';
    // detached 면 브랜치 자리에 해시 앞 7자가 온다 (.git-head-branch 와 같은 규약).
    b.textContent=GIT_SB_BRANCH_ICON+' '+(s.detached?(s.oid||'').slice(0,7):(s.branch||''));
    el.appendChild(b);
    // 변경 수가 0 이면 숫자를 붙이지 않는다.
    const n=s.total||0;
    if(n){
      const d=document.createElement('span'); d.className='sb-git-dirty';
      d.textContent=GIT_SB_DIRTY_ICON+n;
      el.appendChild(d);
    }
    return el;
  },

  // FR-GIT-112: 진행 중 원격 작업의 chip. 없으면 null 이다 — 빈 chip 을 보이면
  // "작업 중" 과 "아무 일도 없음" 이 같아진다.
  _gitJobChip(){
    const jobs=this._gitJobs||[];
    if(!jobs.length) return null;
    const el=document.createElement('span');
    el.className='sb-item sb-git-job';
    el.textContent=GIT_SB_JOB_ICON+' '+jobs.map(j=>j.kind||'').join(' ')+GIT_SB_JOB_SUFFIX;
    el.title=GIT_SB_JOB_TITLE+' — '+jobs.map(j=>(j.kind||'')+' @ '+(j.repo||'')).join('\n');
    return el;
  },
});
