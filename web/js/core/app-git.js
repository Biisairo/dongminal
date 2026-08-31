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
  // EDITOR_TAB_SRS FR-EDT-45: Editor 창도 같은 근거로 창 목록·창 순회의 대상이
  // 아니다 — 진입점은 Editor 탭의 행뿐이다. 판정을 여기 하나에 모은다.
  _plainWindows(){return this.ws.windows.filter(s=>!this._isGitWin(s)&&!this._isEditorWin(s))},

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
   * 지금 보고 있던 리포가 목록에서 사라졌으면 그 자리를 떠난다.
   *
   * 핀을 지워도 Git 창은 **그 리포를 계속 보이고 있었다** — 사용자가 없앤 것이
   * 화면에 남는다. 리포를 고르는 자리(사이드바)가 이미 비었으므로 그 창에는 갈
   * 곳이 없다.
   *
   * 연동으로 같은 경로의 Editor 창도 함께 사라지므로(FR-EDT-32), 그쪽에 앉아
   * 있었다면 재조정이 창을 빼는 순간 활성 창이 유령이 된다. 두 경우를 한
   * 자리에서 본다.
   */
  _gitLeaveIfRemoved(path){
    const w=this._aw();
    // 지운 리포를 그대로 보이고 있는 Git 창이면 떠난다. 리포를 고르는 자리가
    // 이미 비었으므로 그 창에는 갈 곳이 없다.
    //
    // 연동으로 사라지는 Editor 창은 여기서 보지 않는다 — `_edAfterChange` 가
    // 목록이 바뀌는 모든 경로에서 그것을 이미 처리한다.
    if(!this._isGitWin(w)||!w.git||w.git.repo!==path) return;
    const t=this._gitBackTarget();
    if(t) this.switchWindow(t.id);
  },

  _gitBackTarget(){
    const plain=this._plainWindows();
    return plain.find(s=>s.id===this._lastPlainWindow)||plain[0]||null;
  },

  /**
   * FR-GIT-183: Git 창을 닫는다. 다시 열면 새로 만들어진다 (FR-GIT-26 유지).
   *
   * **FR-SBT-34 로 이 함수를 부르는 UI 는 사라졌다.** 남겨 두는 이유가 둘이다
   * (FR-SBT-36): ① 복귀 대상 계산(`_gitBackTarget`)이 `Windows` 탭과 같은 것이라
   * 여기가 그 규칙의 집이다 ② Git 창을 파괴해야 하는 경로(마이그레이션·복구)가
   * 나중에 필요해질 때 되살리는 것보다 남겨 두는 편이 싸다.
   *
   * **먼저 옮기고 나서 지운다.** 지운 뒤 옮기면 두 번 그리게 되고, 그 사이 한 번은
   * 엉뚱한 창이 보인다.
   */
  _gitCloseWindow(){
    const w=this._gitWindow(); if(!w) return;
    const back=this._gitBackTarget();
    if(back) this.switchWindow(back.id);
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
    // FR-EDT-94·97: 편집기 탭은 일반 창에 열리지 않는다. 대상 창은 **활성 리포
    // 경로에 연결된 Editor** 다 — 파일 경로로 고르지 않는다. 연동(FR-EDT-31)으로
    // 핀이 걸린 리포에는 그 Editor 가 늘 있다.
    if(this._edOn()){ await this._edOpenFile(filePath,{anchor:this._gitActiveRepo()}); return }
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
    const name=((relPath||openPath).split('/').pop())+GIT_HEAD_TAB_SUFFIX;
    // FR-EDT-94·98: Open File 과 같은 규약이다 — **리포로 고른다.** 서버는 HEAD 의
    // 내용을 저장소 밖에 놓으므로 파일로 고르면 언제나 폴백으로 떨어진다. 그 임시
    // 파일이 탐색기 루트 밖인 것은 정상이다 (FR-EDT-99).
    if(this._edOn()){ await this._edOpenFile(openPath,{name,anchor:this._gitActiveRepo()}); return }
    const w=await this._gitPlainTarget(); if(!w) return;
    const rid=this._gitPaneOf(w);
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

  // FR-EDT-97: 라우팅의 기준이 되는 **활성 리포**. 창에 붙어 있는 값을 패널이
  // 쥐고 있다 (FR-GIT-29) — 판정 자리를 늘리지 않으려고 여기 하나로 읽는다.
  _gitActiveRepo(){ return (this.gitPanel&&this.gitPanel.repo)||'' },

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
   * _gitTermToolId 는 `+ Add` 가 "지금 터미널의 리포" 를 물을 때 딛는 도구다
   * (FR-FLW-6). **목록은 이것을 쓰지 않는다** — 목록은 핀에서만 온다.
   *
   * 포커스가 터미널이 아닐 때(Git 창·편집기 탭) **마지막 터미널을 유지한다.**
   * 빈 값을 보내면 서버가 자기 cwd 로 답하는데, 그것은 사용자가 가 본 적 없는
   * 리포다 — Git 창에 들어간 순간 대상이 dongminal 자신으로 바뀌는 결함이
   * 그것이었다 (D-FLW-6, 옛 FR-GIT-210).
   */
  _gitTermToolId(){
    const p=this._focusedTerminal();
    if(p){this._lastTermTool=p.id; return p.id}
    // 사라진 도구를 가리키면 서버가 다시 자기 cwd 로 답한다 — 살아 있는 것만 쓴다.
    if(this._lastTermTool&&this.tools.has(this._lastTermTool)) return this._lastTermTool;
    // 기억이 없으면 워크스페이스에서 찾는다. 포커스 훅은 **포커스가 바뀔 때만**
    // 돌아서, 처음부터 터미널에 있다가 Git 창으로 넘어간 경우 기억이 빈다.
    this._lastTermTool=this._anyTermToolId();
    return this._lastTermTool||'';
  },

  // 일반 창의 활성 탭 중 터미널인 것. 여러 개면 마지막으로 쓴 창을 먼저 본다 —
  // 그것이 사용자가 방금 떠나온 자리다.
  _anyTermToolId(){
    // 판정은 `_plainWindows` 하나다 — Git 창만 걸러 두면 Editor 창의 탭이
    // 후보가 되는데, 거기에는 터미널 탭이 애초에 없다 (FR-EDT-54).
    const wins=this._plainWindows();
    const order=wins.slice().sort((a,b)=>
      (b.id===this._lastPlainWindow?1:0)-(a.id===this._lastPlainWindow?1:0));
    for(const w of order){
      const pn=w.focusedPane?findPane(w.layout,w.focusedPane):firstPane(w.layout);
      for(const p of [pn,firstPane(w.layout)]){
        if(!p) continue;
        const tab=p.tabs.find(t=>t.id===p.activeTab);
        if(tab&&tab.type==='terminal'&&this.tools.has(tab.toolId)) return tab.toolId;
      }
    }
    return null;
  },

  /**
   * FR-GOB-8: 핀 전부를 관측할 조건. 셋이 전부 참일 때만이다.
   *
   * 배지의 근거를 만드는 일은 git 실행이므로 공짜가 아니다. 그래서 **보고 있을
   * 때**로 묶는다 — Git 탭이 활성이 아니면 그 목록은 화면에 없고, 없는 것을
   * 위해 git 을 돌릴 이유가 없다 (D-1).
   */
  _gitObserveOk(){
    if(this._gitOff) return false;
    if(typeof document!=='undefined'&&document.hidden) return false;
    return this._sbTab==='git';
  },

  // _gitReposRefresh 는 GIT 섹션의 목록을 갱신한다. 실패하면 이전 목록을 유지한다 —
  // 네트워크가 한 번 튀었다고 섹션이 비면 안 된다.
  async _gitReposRefresh(){
    // UX_REVISION_SRS FR-GRR-1: **낡은 응답이 새 목록을 덮지 않는다.**
    //
    // 이 함수는 3초 폴링과 핀/해제 직후 양쪽에서 불린다. 핀이 쌓여 응답이 느려지면
    // 먼저 떠난 폴링이 나중에 도착해 방금 추가한 핀이 없는 목록으로 되돌린다 —
    // 그러면 소실 화면의 `핀 제거` 처럼 **핀 여부로 갈리는 UI** 가 사라진다.
    // 실측으로 밟았다: 단독 실행은 통과하고 스펙 여럿을 이어 돌리면 M5 가 실패했다.
    // `gitPanel.collect` 의 `_seq` 와 같은 규약이다.
    const seq=(this._gitReposSeq=(this._gitReposSeq||0)+1);
    const stale=()=>seq!==this._gitReposSeq;
    // FR-FLW-2: 목록은 핀만 답한다 — 도구 인자를 싣지 않는다.
    // FR-GOB-7·8: 관측 여부는 인자로 받지 않는다. 조건이 두 자리에 흩어지면
    // 한쪽이 낡는다.
    const res=await gitFetch('/api/git/repos',
      this._gitObserveOk()?{observe:'1'}:null,{stale});
    if(res.stale) return;
    if(res.status===503){
      // git 이 없거나 서비스가 구성되지 않은 환경이다. 섹션 전체를 숨긴다.
      this._gitOff=true;this.renderer._rGitSection();this.renderer._rSbTabs();return;
    }
    if(!res.ok) return;
    this._gitOff=false;this._gitRepos=res.data;
    // 전체 render() 를 부르지 않는다 — 터미널 재부착 비용이 크다.
    this.renderer._rGitSection();
    // FR-SBT-8·12: 탭의 표시 여부(`_gitOff`)와 배지(변경 있는 핀 수)가 이 값에서
    // 나온다 — 목록이 도착하는 자리에서 함께 고친다.
    this.renderer._rSbTabs();
    // FR-GIT-249 (FR-RPT-8): 핀 목록이 **도착하는 자리**다. Worktrees 행의 핀 버튼이
    // 이 값을 읽으므로 여기서 알린다 — 상태 폴링의 다시 그리기에 업으면 관측이 같은
    // 회차에 버튼이 낡은 채로 남는다 (FR-GIT-227).
    if(this.gitPanel&&this.gitPanel.notifyPins) this.gitPanel.notifyPins();
  },

  // FR-GIT-12: 경로를 물어 핀한다. M1 에는 공통 다이얼로그가 없으므로 prompt 를
  // 쓴다 (다이얼로그 규약은 M5 묶음 P).
  /**
   * FR-FLW-5~10 — 리포 추가.
   *
   * follow 행이 하던 일(핀하지 않은 리포로 가는 한 번의 클릭)을 여기가 대신한다.
   * 그래서 **여는 순간 지금 터미널의 리포를 물어 채운다** — 경로를 타이핑하게
   * 하면 대신하지 못한다. 브라우저 프롬프트를 쓰지 않는 이유는 거부 사유를 보일
   * 자리가 없기 때문이다 (D-FLW-4).
   */
  async _gitAddRepo(){
    const at=await this._gitRepoAt();
    // FR-ETR-32: **`source` 가 `tool` 일 때만** 채운다. 서버는 도구를 못 찾으면
    // 자기 cwd 로 답하고, 그것이 마침 저장소면 `isRepo:true` 로 나간다 — 사용자가
    // 보는 것은 빈 칸이 아니라 **그럴듯한 남의 경로**이고, 그래서 "잘 안 된다"로
    // 읽힌다 (§2.4). 비어 있으면 사용자가 직접 넣지만, 채워져 있으면 맞는 줄 안다.
    const mine=!!(at&&at.source===GIT_CWD_SOURCE_TOOL);
    const here=(mine&&at.isRepo&&at.path)?at.path:'';
    // FR-ETR-34: 채우지 못한 두 경우는 사용자가 할 일이 다르다 — 터미널이 없는
    // 것과, 터미널은 있으나 그 자리가 저장소가 아닌 것.
    const why=here?''
      :(mine?GIT_ADD_REPO_NO_TERM.replace('%s',(at&&(at.reason||at.cwd))||'')
            :GIT_ADD_REPO_NO_TOOL);
    return GitDialog.open({
      id:'git-add-repo-dlg',ns:'gar',action:'repo_pin',
      title:GIT_ADD_REPO_TITLE,runLabel:GIT_ADD_REPO_RUN,focus:'path',
      body:here?GIT_ADD_REPO_HERE.replace('%s',here):why,
      fields:[
        {key:'path',type:GIT_DIALOG_TEXT,cls:'gar-path',value:here,
         placeholder:GIT_ADD_REPO_PROMPT},
      ],
      validate:v=>(v.path||'').trim()?'':GIT_ADD_REPO_NEED_PATH,
      run:v=>this._gitAddRepoRun((v.path||'').trim()),
    });
  },

  // FR-FLW-6: 화면에 상주시키지 않는다 — 여는 순간 한 번 묻는 것이 전부다.
  //
  // FR-ETR-36: 도구 id 가 비면 **묻지 않는다.** 보내도 서버의 cwd 가 돌아올
  // 뿐이고, 그 왕복은 값을 만들지 않는다.
  async _gitRepoAt(){
    const tool=this._gitTermToolId();
    if(!tool) return null;
    // gitFetch 는 던지지 않는다 — 망 실패도 {ok:false} 로 돌아온다.
    const res=await gitFetch('/api/git/repo-at',{tool});
    return res.ok?res.data:null;
  },

  /**
   * FR-FLW-7·8: 실패는 사유를 보이고 **닫지 않는다.** 이미 핀된 것은 실패가
   * 아니므로 성공으로 답하되, 목록이 늘지 않은 이유를 알린다.
   */
  async _gitAddRepoRun(path){
    const before=((this._gitRepos||{}).pinned||[]).length;
    const d=await this._gitPin(path);
    if(!d||!d.ok) return {ok:false,reason:(d&&d.reason)||GIT_ADD_REPO_FAIL};
    if(d.pinned&&d.pinned.length===before) return {ok:false,reason:GIT_ADD_REPO_DUP};
    return {ok:true};
  },

  /**
   * FR-GIT-223: 핀 순서 재배치. 창 순서와 달리 **서버가 권위**이므로(O1) 여기서
   * 배열을 고치지 않고 서버가 준 목록을 받는다.
   *
   * 목록 전체가 아니라 (src, target, before) 를 보낸다 — 그 사이에 다른 창이 핀을
   * 더했을 때 전체를 보내면 그것을 조용히 지운다.
   */
  /**
   * FR-GIT-223 · UX_REVISION_SRS FR-BLP-11·12: 핀 순서의 **서버 확정**.
   *
   * 화면과 로컬 사본은 블루프린트가 이미 바꿔 놓았다 (낙관적 적용). 여기가 하는
   * 일은 그것을 서버에 확정하는 것과, 확정하지 못했을 때 **되돌리는 것**이다 —
   * 화면이 서버가 모르는 순서로 남으면 다음 폴링에 조용히 뒤집힌다.
   *
   * 인자는 블루프린트의 드래그 상태이며 키가 `pin:<path>` 다. 서버 종단은 경로를
   * 받으므로 여기서 벗긴다 — 키 형식은 목록의 것이고 API 의 것이 아니다.
   */
  async _gitReorder(dr){
    if(!dr||!dr.src||!dr.target||dr.src===dr.target) return;
    const path=k=>String(k||'').replace(/^pin:/,'');
    const res=await gitPost('/api/git/repos/reorder',
      {src:path(dr.src),target:path(dr.target),before:!!dr.before});
    const d=res.data;
    if(!res.ok){
      // FR-BLP-12: 서버가 아는 순서를 다시 받아 화면을 맞춘다.
      await this._gitReposRefresh();
      return;
    }
    this._gitPinsApply(d.pinned);
    // 서버가 확정한 순서로 목록을 정렬한다. 보통 방금 그린 것과 같지만, 그 사이
    // 폴링이 옛 순서를 실어 왔다면 여기서 바로잡힌다.
    this._gitPinsSort(d.pinned);
    this.renderer._rGitSection();
  },

  // 서버가 준 경로 순서로 목록을 맞춘다. 목록에만 있는 항목(방금 도착한 핀)은
  // 뒤에 남긴다 — 서버가 모르는 것을 버리지 않는다.
  _gitPinsSort(order){
    const arr=(this._gitRepos||{}).pinned;
    if(!Array.isArray(arr)||!Array.isArray(order)) return;
    const at=new Map(order.map((p,i)=>[p,i]));
    arr.sort((a,b)=>{
      const ia=at.has(a&&a.path)?at.get(a.path):Number.MAX_SAFE_INTEGER;
      const ib=at.has(b&&b.path)?at.get(b.path):Number.MAX_SAFE_INTEGER;
      return ia-ib;
    });
  },

  // _gitPin 은 경로를 검증해 핀한다. 저장소가 아니면 사유를 보인다 (FR-GIT-12) —
  // 조용히 실패하지 않는다.
  //
  // FR-GIT-249: `quiet` 는 **자기 안내 자리를 가진 호출자**의 것이다 (Worktrees 탭).
  // 그런 자리에서 alert 까지 띄우면 같은 사실을 두 번 알리게 된다. 이 섹션의 저장소
  // 추가는 보일 자리가 alert 뿐이므로 기본은 그대로다.
  /**
   * 핀 하나를 추가한다. **결과를 돌려주고 스스로 알리지 않는다** — 사유를 보일
   * 자리는 호출자마다 다르다 (`+ Add` 는 다이얼로그, Worktrees 는 그 탭의 안내 줄).
   * 같은 사실을 두 번 알리면 사용자는 두 가지 일이 일어난 줄로 읽는다.
   */
  async _gitPin(path){
    if(!path) return {ok:false,reason:GIT_PIN_FAIL_LABEL};
    const res=await gitPost('/api/git/repos/pin',{path});
    const d=res.data;
    if(!res.ok) return {ok:false,reason:(d&&d.message)||GIT_PIN_FAIL_LABEL};
    this._gitPinsApply(d.pinned);
    this._edApplyLinked(d);
    await this._gitReposRefresh();
    return {ok:true,pinned:d.pinned||[]};
  },

  async _gitUnpin(path){
    if(!path) return false;
    const res=await gitPost('/api/git/repos/unpin',{path});
    const d=res.data;
    if(!res.ok) return false;
    this._gitPinsApply(d.pinned);
    this._edApplyLinked(d);
    this._gitLeaveIfRemoved(path);
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
    // 전역 조회다 — 리포에 매이지 않으므로 echo 가 없다 (FR-DPN-33).
    const res=await gitFetch('/api/git/jobs',null);
    const d=res.data;
    // 받지 못했으면 이전 목록을 유지한다 — 한 번의 실패로 chip 이 사라지면
    // "작업이 끝났다" 와 "모른다" 가 같아진다.
    if(!res.ok||!Array.isArray(d.jobs)) return;
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
