/**
 * Remote Terminal — Repo 목록·핀·변화 관측·작업 (FR-GIT-9~17)
 *
 * `GitSync` 는 `GitController` 의 부품이다(`git.sync`, REFACTOR3_FE_APPCTL_SRS 9d). 목록 갱신의 본체는
 * `git-repos-list.js` 의 `GitReposList` 이고 여기서 지연 생성한다.
 */
class GitSync extends Controller {
  // Repo 목록 갱신의 본체는 `git-repos-list.js` 의 `GitReposList` 다 (FR-ASE-8).
  // 여기 남은 넷은 바깥이 부르는 이름이다 — 지연 생성은 `_runsPanel` 과 같은 규약이다.
  _gitReposList(){
    if(!this._reposList) this._reposList=new GitReposList(this.app);
    return this._reposList;
  }
  _startGitReposPoll(){ return this._gitReposList()._startGitReposPoll() }
  gitReposKick(){ return this._gitReposList().gitReposKick() }
  _gitReposOnChanged(repo){ return this._gitReposList()._gitReposOnChanged(repo) }

  /**
   * FR-GOB-8: 핀 전부를 관측할 조건. 셋이 전부 참일 때만이다.
   *
   * 배지의 근거를 만드는 일은 git 실행이므로 공짜가 아니다. 그래서 **보고 있을
   * 때**로 묶는다 — Git 탭이 활성이 아니면 그 목록은 화면에 없고, 없는 것을
   * 위해 git 을 돌릴 이유가 없다 (D-1).
   */
  _gitObserveOk(){
    if(this.app._gitOff) return false;
    if(typeof document!=='undefined'&&document.hidden) return false;
    // REPO_TAB_UNIFY_SRS FR-RTU-1·6: 탭 id 는 `repo` 다. 옛 `'git'` 문자열이
    // 그대로 남아 있어 **배지가 영영 서지 않았다** — 관측을 부르는 조건이 늘
    // 거짓이었다 (실측: V-GOB-1).
    return this.app.sbTab===REPO_TAB_ID;
  }

  /**
   * 서버가 알린 저장소 변화 (GIT_PUSH_OBSERVE_SRS FR-GPO-21·22).
   *
   * **자기가 보는 저장소가 아니면 무시한다.** 방송은 모든 브라우저에 가고,
   * 저마다 다른 저장소를 볼 수 있다.
   *
   * `mark` 가 마지막으로 본 값과 같으면 수집하지 않는다 (FR-GPO-22) — 재연결
   * 직후 서버가 현재 값을 다시 알릴 수 있고, 그때 이미 받은 화면을 다시 받을
   * 이유가 없다.
   *
   * **signature 로 거르지 않는다.** 그 값은 `.git` 만 보므로 작업 트리 변화에서는
   * 그대로이고, 그것으로 거르면 파일이 생겨도 알림이 삼켜진다 — 실측한 결함이다
   * (GIT_PUSH_OBSERVE_SRS §2.9). 거르는 근거는 서버가 **방송을 내보내게 만든 그
   * 판단**과 같아야 한다.
   */
  _onGitChanged(a){
    const repo=a&&a.repo;
    if(!repo) return;
    /**
     * GIT_REFRESH_LIFECYCLE_SRS FR-GRF-28 (`GP-12`): **숨어 있으면 받지 않는다.**
     *
     *   이전 동작: 방송은 모든 클라이언트에 가고, 숨은 탭의 관측기도 그대로
     *             `collect()` 했다. 부수효과로 **숨은 탭이 낸 status 가 서버의
     *             임대를 계속 살려** 그 저장소의 1초 감시가 멎지 않았다
     *   새  동작: `document.hidden` 이면 아무것도 하지 않는다
     *   이유:     `GIT_LIVE_TRIGGERS_SRS` FR-GLW-3 이 "숨으면 전 패널이 조건을
     *             다시 보고 폴링을 걷는다" 를 이미 정했고 `_gitLifecycle` 이
     *             그것을 한다 — 방송 경로만 그 가드 **밖**에 있었다
     *
     * 놓친 변화는 복귀에서 갚는다 (D-GRF-7): 가시성 복귀가 `signal()` 을 내고
     * 그것이 수집으로 간다. 버리는 것이 아니라 미루는 것이다.
     */
    // OPTIMIZE_REFACTOR_SRS FR-OPT-4-1: 탐색기도 같은 방송을 듣는다 (IPC-8). 숨은 동안의
    // 것은 복귀 틱(`_edTick`)이 갚는다 — 탐색기의 주기 status 는 안전망뿐이다.
    if(typeof document!=='undefined'&&document.hidden){
      this.app._edGitHold(repo,a.mark||'');
      return;
    }
    this.app._edOnGitChanged(repo,a.mark||'');
    this._gitReposOnChanged(repo);
    if(!this.app._gitObservers) return;
    // 관측기는 **저장소마다** 하나다 (FR-GIT-26·29). 방송이 가리키는 저장소를
    // 보고 있는 관측기만 움직인다 — 남의 저장소 이벤트로 이 창이 요청을 내면
    // 종전에 없던 요청이 생긴다.
    for(const o of this.app._gitObservers.values()){
      const p=o.any();
      if(!p) continue;
      /**
       * 방송이 싣는 경로는 **git 이 푼 루트**다 (`apiGitStatus` 의 `root`).
       * 패널의 `repo` 는 사용자가 연 그대로이고, 그 둘은 심볼릭 링크에서
       * 갈린다 — macOS 에서 `/tmp/x` 로 연 저장소의 방송은 `/private/tmp/x` 로
       * 온다. 문자열 하나로만 견주면 그 저장소는 방송을 **한 건도** 받지 못하고,
       * 남는 갱신 경로가 30초 안전망과 손으로 누르는 새로고침뿐이 된다.
       *
       * 관측 응답이 그 루트를 함께 실어 주므로(`status.repo`) 둘 다 본다 —
       * FR-DIR-5 의 "비교는 정규화를 아는 쪽이 한다" 를 방송 경로까지 넓힌 것이다.
       */
      const root=(o._status&&o._status.repo)||'';
      if(p.repo!==repo&&root!==repo) continue;
      // 이미 본 값이면 받지 않는다 (FR-GPO-22). 재연결 직후 서버가 현재 값을
      // 다시 알릴 수 있고, 그때 방금 받은 화면을 또 받을 이유가 없다.
      if(a.mark&&o._gitMark===a.mark) continue;
      // FR-GRF-29: 보고 있는 표면이 있는 관측기만 움직인다. 없으면 이 방송이
      // 만드는 요청은 아무도 읽지 않는 값을 위한 것이다 (NFR-RTU-1 과 같은 근거).
      if(!o.pollOkAny()) continue;
      o._gitMark=a.mark||'';
      // REPO_FIX 05 F-5.2: 작업 트리가 바뀌었다 — 작업 트리 Blame 도 다시 받는다.
      for(const q of o.panels) q.blameStale();
      p.collect();
    }
  }

  /**
   * 구독이 열렸다 (FR-GPO-23). 끊겨 있던 동안의 변화는 방송으로 오지 않았으므로
   * 한 번 받아 온다. `_reschedule` 이 아니라 `collect` 인 이유는 주기를 다시
   * 걸 일이 없기 때문이다 — 주기는 `_applyCadence` 의 것이고 그것은 이미 서 있다.
   */
  _gitObserveRestore(){
    // FR-OPT-4-3: 저장소 목록도 같다 — 끊긴 동안의 배지 변화를 갚고, 끊김이 푼 핀 임대를
    // 새 구독에 다시 세운다. 안전망이 꺼져 있으면 그 밖의 계기가 없다.
    if(this._gitObserveOk()) this.gitReposKick();
    if(!this.app._gitObservers) return;
    for(const o of this.app._gitObservers.values()){
      const p=o.any();
      if(p) p.collect();
    }
  }

  gitReposRefresh(){ return this._gitReposList().gitReposRefresh() }

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
    // 경로는 서버가 판정한다 (SERVER_DRIVEN_ACTIONS_SRS GV-c) — 저장소가 아닌 자리에서 묻는다.
    const answer=new GitInputAnswer({repo:'',id:GIT_ACTION.repoAdd,
      params:v=>({path:(v.path||'').trim()}),fail:()=>GIT_ADD_REPO_FAIL});
    return GitDialog.open({
      id:'git-add-repo-dlg',ns:'gar',action:'repo_pin',
      title:GIT_ADD_REPO_TITLE,runLabel:GIT_ADD_REPO_RUN,focus:'path',
      body:here?GIT_ADD_REPO_HERE.replace('%s',here):why,
      fields:[
        {key:'path',type:GIT_DIALOG_TEXT,cls:'gar-path',value:here,
         placeholder:GIT_ADD_REPO_PROMPT},
      ],
      validate:(v,d)=>answer.why(v,d),
      run:v=>this._gitAddRepoRun((v.path||'').trim()),
    });
  }

  // FR-FLW-6: 화면에 상주시키지 않는다 — 여는 순간 한 번 묻는 것이 전부다.
  //
  // FR-ETR-36: 도구 id 가 비면 **묻지 않는다.** 보내도 서버의 cwd 가 돌아올
  // 뿐이고, 그 왕복은 값을 만들지 않는다.
  async _gitRepoAt(){
    const tool=this.app._gitTermToolId();
    if(!tool) return null;
    // gitFetch 는 던지지 않는다 — 망 실패도 {ok:false} 로 돌아온다.
    const res=await gitFetch(GIT_API.repoAt,{tool});
    return res.ok?res.data:null;
  }

  /**
   * FR-FLW-7·8: 실패는 사유를 보이고 **닫지 않는다.** 이미 핀된 것은 실패가
   * 아니므로 성공으로 답하되, 목록이 늘지 않은 이유를 알린다.
   */
  async _gitAddRepoRun(path){
    const before=((this.app.gitRepos||{}).pinned||[]).length;
    const d=await this.app.gitPin(path);
    if(!d||!d.ok) return {ok:false,reason:(d&&d.reason)||GIT_ADD_REPO_FAIL};
    if(d.pinned&&d.pinned.length===before) return {ok:false,reason:GIT_ADD_REPO_DUP};
    return {ok:true};
  }

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
    const res=await gitPost(GIT_API.reposReorder,
      {src:path(dr.src),target:path(dr.target),before:!!dr.before});
    const d=res.data;
    if(!res.ok){
      // FR-BLP-12: 서버가 아는 순서를 다시 받아 화면을 맞춘다.
      await this.app.gitReposRefresh();
      return;
    }
    this._gitPinsApply(d.pinned);
    // 서버가 확정한 순서로 목록을 정렬한다. 보통 방금 그린 것과 같지만, 그 사이
    // 폴링이 옛 순서를 실어 왔다면 여기서 바로잡힌다.
    this._gitPinsSort(d.pinned);
    this.app.renderer._rGitSection();
  }

  // 서버가 준 경로 순서로 목록을 맞춘다. 목록에만 있는 항목(방금 도착한 핀)은
  // 뒤에 남긴다 — 서버가 모르는 것을 버리지 않는다.
  _gitPinsSort(order){
    const arr=(this.app.gitRepos||{}).pinned;
    if(!Array.isArray(arr)||!Array.isArray(order)) return;
    const at=new Map(order.map((p,i)=>[p,i]));
    arr.sort((a,b)=>{
      const ia=at.has(a&&a.path)?at.get(a.path):Number.MAX_SAFE_INTEGER;
      const ib=at.has(b&&b.path)?at.get(b.path):Number.MAX_SAFE_INTEGER;
      return ia-ib;
    });
  }

  // gitPin 은 경로를 검증해 핀한다. 저장소가 아니면 사유를 보인다 (FR-GIT-12) —
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
  async gitPin(path){
    if(!path) return {ok:false,reason:GIT_PIN_FAIL_LABEL};
    // WORKSPACE_SAVE_CONFLICT_SRS FR-WSC-18: 핀은 서버의 워크스페이스를 고친다 — 이 화면의
    // 저장을 먼저 끝낸다. 그러지 않으면 방금 한 조작(탭 전환)을 실은 저장이 핀의 rev 에
    // 409 를 받고 원격 채택으로 그 조작이 사라진다.
    await this.app.save();
    const res=await gitPost(GIT_API.reposPin,{path});
    const d=res.data;
    if(!res.ok) return {ok:false,reason:(d&&d.message)||GIT_PIN_FAIL_LABEL};
    this._gitPinsApply(d.pinned);
    this.app._edApplyLinked(d);
    await this.app.gitReposRefresh();
    return {ok:true,pinned:d.pinned||[]};
  }

  async gitUnpin(path){
    if(!path) return false;
    // FR-WSC-18: 핀과 같다.
    await this.app.save();
    const res=await gitPost(GIT_API.reposUnpin,{path});
    const d=res.data;
    if(!res.ok) return false;
    this._gitPinsApply(d.pinned);
    this.app._edApplyLinked(d);
    this.app.git._gitLeaveIfRemoved(path);
    await this.app.gitReposRefresh();
    return true;
  }

  // 핀은 workspace.json 최상위 git.pinned 에 산다 (O1). 서버가 고친 값을 로컬
  // 사본에도 반영해 둔다 — 다음 save() 의 PUT 이 방금 만든 핀을 지우지 않게.
  _gitPinsApply(pinned){
    if(!Array.isArray(pinned)) return;
    if(!this.app.ws.git) this.app.ws.git={};
    this.app.ws.git.pinned=pinned;
  }

  /**
   * FR-GIT-101a (개정 — OPTIMIZE_REFACTOR_SRS FR-OPT-4-4): 진행 중 원격 작업 목록.
   *
   * Git 창의 폴링(FR-GIT-22)은 창이 활성일 때만 돌므로 그것에 얹으면 다른 창이
   * 띄운 작업을 놓친다. 이 호출은 git 을 실행하지 않는다 — 서버가 들고 있는
   * 목록이다.
   *
   * 목록의 임자는 Git 패널이다: 다른 브라우저 창이 띄운 작업도 같은 리포의 원격
   * 버튼을 막아야 한다 (FR-GIT-101).
   *
   *   이전 동작: 상태바 틱마다 `/api/git/jobs` 를 따로 물었다 — 패널이 없어도
   *   새  동작: 서버가 작업의 시작·끝을 `git_jobs_changed` 로 밀고 여기가 받는다.
   *             틱은 `/api/stats?jobs=1` 로 같은 목록을 안전망으로 싣는다.
   *             **Git 패널이 하나도 없으면 묻지 않는다**
   *   이유:     시작·끝은 서버가 안다. 목록을 쓰는 곳은 패널뿐이다 (FEC-15 · IPC-9)
   *
   * `state-registry` 의 `git.jobs` — `merge:'latest'`. 방송은 목록을 나르지 않는다.
   */
  async _pollGitJobs(){
    if(!this._gitJobsWanted()) return;
    const flight=this.app._restoreBegin('gitJobs');
    // 전역 조회다 — 리포에 매이지 않으므로 echo 가 없다 (FR-DPN-33).
    const res=await gitFetch(GIT_API.jobs,null);
    const d=res.data;
    if(!this.app._restoreLive('gitJobs',flight)) return;
    this.app._restoreEnd('gitJobs',flight);
    // 받지 못했으면 이전 목록을 유지한다 — 한 번의 실패로 목록이 사라지면
    // "작업이 끝났다" 와 "모른다" 가 같아진다.
    if(!res.ok||!Array.isArray(d.jobs)) return;
    this._gitJobsAdopt(d.jobs);
  }

  // 목록을 쓸 곳이 있는가 — 저장소를 가진 Git 패널이 있을 때뿐이다 (`gitPanelAt`).
  // 부팅이 세우는 옛 Git 창 자리의 패널(root '')은 저장소가 없으면 원격 버튼도 없다.
  _gitJobsWanted(){
    if(!this.app.gitPanels) return false;
    for(const p of this.app.gitPanels.values()) if(p&&p.repo) return true;
    return false;
  }

  /**
   * 상태바 틱이 싣는 목록도 `_pollGitJobs` 와 같은 `gitJobs` 비행에 선다 (Ofix2) — 틱이
   * 떠난 뒤 떠난 조회의 새 목록을 늦게 온 틱의 응답이 덮지 않는다 (`merge:'latest'`).
   * 목록을 쓸 곳이 없으면 비행을 열지 않는다 — 그때 틱은 목록을 묻지 않는다.
   *
   * 비행 중인 조회를 밀어낸 틱이 목록을 받지 못하면 다시 조회한다 (Ofix3) — 밀려난
   * 조회의 답은 이미 버려졌으므로, 그대로 두면 그 목록이 다음 방송·틱까지 사라진다.
   */
  _gitJobsBegin(){
    if(!this._gitJobsWanted()) return null;
    const displaced=this.app.bus.inFlight('gitJobs');
    const flight=this.app._restoreBegin('gitJobs');
    this._gitJobsDisplacer=displaced?flight:null;
    return flight;
  }

  _gitJobsSettle(flight,jobs){
    if(!this.app._restoreLive('gitJobs',flight)) return;
    this.app._restoreEnd('gitJobs',flight);
    const requery=this._gitJobsDisplacer===flight;
    this._gitJobsDisplacer=null;
    if(Array.isArray(jobs)) this._gitJobsAdopt(jobs);
    else if(requery) this._pollGitJobs();
  }

  _gitJobsAdopt(jobs){
    this.app._gitJobs=jobs;
    if(this.app.gitPanel) this.app.gitPanel.adoptJobs(jobs);
  }

  // U-19 ①: `_gitJobSeen`·`_gitJobEnded`·`_gitJobChip` 은 **제거됐다.** 셋 다
  // 상태바 chip 을 즉시 갱신하기 위한 것이었고(FR-GIT-112), 그 chip 이 철회되며
  // 쓰임이 사라졌다. 작업의 진행·종료는 그것을 띄운 패널이 스트림으로 알고
  // (FR-GIT-103), 남의 작업은 `_pollGitJobs` → `adoptJobs` 가 받는다.
}

// 바깥과 계약·시험이 App 에서 부르는 이름 (FR-FEA-4).
Controller.delegate(App,'git.sync',['gitReposKick','_gitObserveOk','_onGitChanged','_gitObserveRestore','gitReposRefresh','gitPin','gitUnpin',
  '_gitPinsApply','_pollGitJobs','_gitJobsBegin','_gitJobsSettle']);
