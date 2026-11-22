/**
 * GitViewReload — 새로고침과 뷰 다시 받기 (REFACTOR3_FE_REST5_SRS FR-FR5-21). 옛 자리는 `git-poll.js` 다.
 *
 * 새로고침 버튼(`refresh`)과 관측의 변화가 같은 길(`_reloadViews`)로 뷰를 다시 받는다. 보이지 않는 뷰는 표식만 남기고
 * 활성화할 때(`_staleTake`) 받는다. refs 회차(`_refsRound`)를 소유한다 — 한 회차 안의 `/api/git/refs` 는 리포당 하나다.
 */
class GitViewReload extends GitPart {
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
    if(this.p._refreshing||!this.p.repo) return;
    this.p._refreshing=true;
    for(const p of this.p.obs.panels) p.blameStale();
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
      try{ for(const p of this.p.obs.panels) jobs.push(...p._reloadViews(true)) }
      catch(e){ console.error('[git] reloadViews',e) }
      await Promise.allSettled([this.p.collect(),...jobs]);
    }finally{
      this.p._refreshing=false;
    }
  }

  /**
   * FR-GVR-8·9: Changes 밖의 뷰를 다시 받는다. **새로고침 버튼과 폴링이 같은
   * 것을 돌린다** — 자동 경로가 수동 경로보다 적게 하면 "새로고침을 눌러야
   * 보인다" 가 남는다 (D-8: 새로고침은 백업이다).
   *
   * 열지 않은 뷰는 각자의 `_el`·`_repo` 판정이 조기 반환하므로 요청이 나가지
   * 않는다 (FR-GVR-4).
   *
   * OPTIMIZE_REFACTOR_SRS FR-OPT-4-9 (FEU-6·7 · FR-GVR-4 개정):
   *   이전 동작: 열어 두고 보지 않는 탭도 매 변화마다 log·refs·stash·worktree·submodule 을
   *             받았고, History 와 Branches 가 같은 회차에 refs 를 각자 받았다
   *   새  동작: 자동 회차에서 보이지 않는 뷰는 표식(`_staleViews`)만 남기고 활성화할 때
   *             (`elFor`) 받는다. 새로고침은 종전대로 전부다. refs 는 회차당 한 번 받아
   *             두 뷰가 나눠 쓴다(`_refsRound`)
   *   이유:     보이지 않는 목록을 받는 것은 그릴 곳이 없는 요청이다
   */
  _reloadViews(withConsole){
    const jobs=[];
    this._inRefsRound(()=>{
      // FR-GVR-12: 자동은 자리 유지다 — `full` 은 사용자가 누른 새로고침이다.
      // FR-GVR-6: Stash 도 대상이다. FR-GDT-12: 원격 목록은 Branches 와 함께 받는다.
      // 사용자가 누른 새로고침은 보이지 않는 뷰까지 전부 받는다 (FR-GIT-238 · D-8).
      for(const key of GIT_STALE_VIEWS){
        if(!this.p[GIT_VIEW_FIELD_BY_KEY[key]]) continue;
        if(withConsole||this._viewShown(key)) jobs.push(...this._reloadView(key,!!withConsole));
        else this._staleMark(key);
      }
      // Console 은 **기본으로 받지 않는다.** 그 목록은 dongminal 자신의 쓰기로만
      // 늘어나고(`post()` 와 잡의 `RecordWrite`), 터미널에서 친 git 은 기록에
      // 남지 않는다 — 폴링이 받아 봐야 늘 같은 값이다. 받는 자리는 쓰기가 끝난
      // 곳(FR-GVR-3)과 사용자가 명시적으로 누른 새로고침(FR-GVR-6)뿐이다.
      // FR-GLV-1 / D-8: 새로고침이 자동 경로보다 **적게** 하지 않는다. 오히려
      // 하나 더 한다 — `withConsole` 은 "사용자가 눌렀다" 의 표식이고, 그때는
      // 거부 표식(FR-GLV-6)도 넘어 다시 시도한다.
      if(this.p._diffView) jobs.push(this.p.reloadDiff(!!withConsole));
      if(withConsole&&this.p._consoleView) jobs.push(this.p._consoleView.reload());
    });
    return jobs;
  }

  // FR-OPT-4-9: 뷰가 지금 화면에 있는가. 탭을 떠난 본문은 문서에서 떼이되 `vis` 가
  // 남으므로 둘 다 본다 (Console 의 폴링 가드와 같은 판정, FR-RST-23).
  _viewShown(key){
    const el=this.p._els.get(key);
    return !!el&&el.isConnected&&el.classList.contains('vis');
  }

  _staleMark(key){ (this.p._staleViews||(this.p._staleViews=new Set())).add(key) }

  // 받으면 표식은 풀린다 — 활성화 때 한 번 더 받지 않는다.
  _reloadView(key,full){
    if(this.p._staleViews) this.p._staleViews.delete(key);
    if(key==='history') return [this.p._historyView.reload(!full)];
    if(key==='branches') return [this.p._branchesView.reload(),this.p._branchesView.reloadRemotesIfOpen()];
    return [this.p[GIT_VIEW_FIELD_BY_KEY[key]].reload()];
  }

  /**
   * FR-OPT-4-9 (FEU-7): 활성화된 뷰가 표식을 들고 있으면 자리 유지로 받는다. `elFor` 가
   * `_render` **뒤에** 부른다 — 그 `paint()` 가 리포를 새로 채택했으면(`_adopt`) 이미
   * 받았으므로 다시 받지 않는다(`before` 가 그 판정이다).
   */
  _staleTake(key,before){
    const m=this.p._staleViews;
    if(!m||!m.delete(key)) return;
    const v=this.p[GIT_VIEW_FIELD_BY_KEY[key]];
    if(!v||before!==this.p.repo||v._repo!==this.p.repo) return;
    this._reloadView(key,false);
  }

  /**
   * FR-OPT-4-9 (FEU-6): 이 안에서 나가는 `/api/git/refs` 는 리포당 하나다. 회차는 동기
   * 구간이다 — 뷰의 조회 함수는 첫 `await` 앞에서 요청을 내므로 그 안에 든다.
   */
  _inRefsRound(fn){
    const prev=this._refsRound;
    if(!prev) this._refsRound=new Map();
    try{ return fn() }
    finally{ if(!prev) this._refsRound=null }
  }

  // 회차 안이면 그 회차의 표, 아니면 null 이다 (git-views `fetchRefs`).
  refsRound(){ return this._refsRound||null }

  // FR-GVR-8a: 관측보다 낡은 뷰만 다시 받는다. 지금은 History 만 자기 목록의
  // signature 를 안다 — 나머지 뷰는 종전대로 변화 비교(FR-GVR-8)만 딛는다.
  _reloadStaleViews(sig){
    if(!this.p._historyView||!this.p._historyView.staleFor(sig)) return;
    // FR-OPT-4-9: 보이지 않으면 표식만 남긴다 — `_reloadViews` 와 같은 규약.
    if(this._viewShown('history')) this.p._historyView.reload(true);
    else this._staleMark('history');
  }
}
