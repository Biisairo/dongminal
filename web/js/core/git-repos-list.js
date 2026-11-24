/**
 * Repo 목록(`/api/git/repos`)의 갱신 — 합치기·세대·칠하기 가드·핀 감시(토픽)
 * (APP_STATE_EXTRACT_SRS FR-ASE-8 · §2.3a).
 *
 * 이 가족의 상태 여섯은 `App` 이 아니라 여기 있다. 본문은 옛 `app-git.js`(지금 `git-sync.js`)에서 구간
 * 이동했고 편집은 앱으로 나가는 자리(`this.app.`)뿐이다. 목록 그 자체(`gitRepos`)와
 * git 부재(`_gitOff`)는 렌더러·e2e 가 읽는 공유 상태라 `App` 에 남는다.
 *
 * **`gitReposKick` 은 `this.app.gitReposRefresh` 를 부른다** (§2.3a A-6) — e2e
 * (`git-sidebar`)와 단위 검사(`app-git-lists`)가 앱의 그 이름을 갈아 끼워 갱신을 끊는다.
 */
class GitReposList {
  constructor(app){ this.app=app }
}

Object.assign(GitReposList.prototype, {
  /**
   * PERF_OPTIMIZATION_SRS M1 C4 (D-9): **목록에 주기가 없다.**
   *
   *   이전 동작: `gitStatusInterval` 마다 목록을 받았다(안전망). Repo 탭이 보이면 그 요청이
   *             핀 전부의 감시를 임대했다(`observe=1&clientId`)
   *   새  동작: Repo 탭이 보이는 동안 핀마다 채널의 `git:<root>` 토픽을 구독한다 — 구독이 감시의
   *             임대이고, 바뀐 mark 가 `_gitReposOnChanged` 로 와서 목록을 받는다. 탭에 들고
   *             날 때·브라우저 탭이 돌아올 때·핀 목록이 바뀔 때 받는다
   *   이유:     상태용 주기 GET 을 없앤다. 배지의 변화는 서버 감시자가 안다
   */
  _gitPinsWatchSync(){
    const want=new Set();
    if(this.app.git.sync._gitObserveOk()){
      for(const e of ((this.app.gitRepos||{}).pinned)||[]) if(e&&e.isRepo&&e.root) want.add(e.root);
    }
    const m=this._gitPinWatch||(this._gitPinWatch=new Map());
    for(const [root,w] of m) if(!want.has(root)){ w.stop(); m.delete(root) }
    for(const root of want) if(!m.has(root)) m.set(root,this.app.git.topics.watch(root));
  },

  /**
   * 목록 갱신을 합친다 — 비행 중이면 끝난 뒤 한 번 더 받는다. `git_changed`·핀 목록
   * 변화·패널 관측이 부른다 (FR-OPT-4-3). 같은 방송에 여럿이 반응해도 요청이 겹치지 않는다.
   */
  gitReposKick(){
    if(this._gitReposKicking){ this._gitReposKickAgain=true; return }
    this._gitReposKicking=true;
    this.app.git.sync.gitReposRefresh().finally(()=>{
      this._gitReposKicking=false;
      if(!this._gitReposKickAgain) return;
      this._gitReposKickAgain=false;
      this.gitReposKick();
    });
  },

  /**
   * `git_changed` 가 핀 저장소의 것이면 목록을 받는다 (FR-OPT-4-3). 방송은 git 이 푼 루트를
   * 싣는다 — 핀의 `root` 와도 견준다 (FR-DIR-5). 겹친 알림은 `gitReposKick` 이 합친다.
   *
   *   이전 동작: Repo 탭이 보일 때만 받았다 — 숨은 동안의 배지는 안전망 주기(30초)를 기다렸다
   *   새  동작: 탭이 숨어 있어도 받는다. 브라우저 탭이 숨은 동안은 호출 쪽이 미룬다
   *   이유:     UX_BATCH12 FR-LIV-8 (사용자 결정)
   */
  _gitReposOnChanged(repo){
    if(this.app._gitOff) return;
    const pinned=((this.app.gitRepos||{}).pinned)||[];
    if(pinned.some(e=>e&&(e.path===repo||e.root===repo))) this.gitReposKick();
  },

  // gitReposRefresh 는 GIT 섹션의 목록을 갱신한다. 실패하면 이전 목록을 유지한다 —
  // 네트워크가 한 번 튀었다고 섹션이 비면 안 된다.
  async gitReposRefresh(){
    // UX_REVISION_SRS FR-GRR-1: **낡은 응답이 새 목록을 덮지 않는다.**
    //
    // 이 함수는 변화 알림과 핀/해제 직후 양쪽에서 불린다. 핀이 쌓여 응답이 느려지면
    // 먼저 떠난 폴링이 나중에 도착해 방금 추가한 핀이 없는 목록으로 되돌린다 —
    // 그러면 소실 화면의 `핀 제거` 처럼 **핀 여부로 갈리는 UI** 가 사라진다.
    // 실측으로 밟았다: 단독 실행은 통과하고 스펙 여럿을 이어 돌리면 M5 가 실패했다.
    // `gitPanel.collect` 의 `_seq` 와 같은 규약이다.
    const seq=(this._gitReposSeq=(this._gitReposSeq||0)+1);
    const stale=()=>seq!==this._gitReposSeq;
    // FR-FLW-2: 목록은 핀만 답한다 — 도구 인자를 싣지 않는다.
    // FR-GOB-7·8: 관측 여부는 인자로 받지 않는다. 조건이 두 자리에 흩어지면
    // 한쪽이 낡는다.
    // 핀의 감시 임대는 채널의 `git:<root>` 토픽 구독이 쥔다(`_gitPinsWatchSync`).
    /** @type {Record<string,string>} */
    const q={};
    if(this.app.git.sync._gitObserveOk()) q.observe='1';
    const res=await gitFetch(GIT_API.repos,q,{stale});
    if(res.stale) return;
    if(res.status===503){
      // git 이 없거나 서비스가 구성되지 않은 환경이다. 섹션 전체를 숨긴다.
      this.app._gitOff=true;this._gitReposSig=null;this.app.renderer._rGitSection();this.app.renderer._rSbTabs();return;
    }
    if(!res.ok) return;
    const wasOff=this.app._gitOff;
    this.app._gitOff=false;this.app.gitRepos=res.data;
    this._gitPinsWatchSync();
    /**
     * FR-OPT-4-3 (FEC-13): **화면이 읽는 값이 같으면 칠하지 않는다.**
     *
     * 근거에서 관측 시각은 빼고 그것이 낡았는지만 넣는다 — 시각은 관측마다 달라
     * 가드가 죽고, 낡음은 배지의 모양을 바꾼다(`gitBadgeStale`). 근거는 그린 뒤에
     * 기록한다 (FR-GIT-227 과 같은 순서).
     */
    const sig=this._gitReposSigOf(res.data);
    if(!wasOff&&sig===this._gitReposSig) return;
    // 전체 render() 를 부르지 않는다 — 터미널 재부착 비용이 크다.
    this.app.renderer._rGitSection();
    // FR-SBT-8·12: 탭의 표시 여부(`_gitOff`)와 배지(변경 있는 핀 수)가 이 값에서
    // 나온다 — 목록이 도착하는 자리에서 함께 고친다.
    this.app.renderer._rSbTabs();
    // FR-GIT-249 (FR-RPT-8): 핀 목록이 **도착하는 자리**다. Worktrees 행의 핀 버튼이
    // 이 값을 읽으므로 여기서 알린다 — 상태 폴링의 다시 그리기에 업으면 관측이 같은
    // 회차에 버튼이 낡은 채로 남는다 (FR-GIT-227).
    //
    // **모든 패널에 알린다** (DRIFT_RECLAIM_SRS FR-DRC-16). 종전에는
    // `this.gitPanel` 하나였다 — 그 getter 는 **활성 창의 루트와 포커스 칸**의
    // 패널을 준다(`_gitRootOfActive`). 핀을 찍은 화면이 그 자리가 아니면
    // (다른 창에 서 있거나 다른 칸이 포커스면) 그 화면은 통지를 받지 못하고
    // 버튼이 낡은 채로 남는다.
    //
    // 바로 위 `_gitRescheduleAll` 이 **같은 이유로 이미 고쳐진 자리**다:
    // "종전에는 활성 칸의 패널 하나만 `_reschedule()` 했다 — 패널이 하나뿐이었기
    // 때문이다." 폴링은 옮겨졌고 이 통지만 옛 모양으로 남아 있었다.
    this.app.git.surfaces._gitNotifyPinsAll();
    this._gitReposSig=sig;
  },

  /**
   * `/api/git/repos` 응답의 **화면이 읽는 값** (FR-OPT-4-3 · FEC-13). 관측 시각 대신 그것이
   * 낡았는지를 넣는다 — 시각은 관측마다 다르고, 낡음은 배지의 모양을 바꾼다.
   */
  _gitReposSigOf(d){
    const pinned=((d&&d.pinned)||[]).map(e=>(e&&e.badge)
      ?Object.assign({},e,{badge:Object.assign({},e.badge,{observedAtUnixMs:gitBadgeStale(e.badge)})})
      :e);
    return JSON.stringify(pinned);
  },
});
