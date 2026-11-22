/**
 * Remote Terminal — git 패널과 관측기의 등록부 (SLOT_VIEW_STATE_SRS 묶음 O·V)
 *
 * `GitSurfaces` 는 `GitController` 의 부품이다(`git.surfaces`, REFACTOR3_FE_APPCTL_SRS 9d). 패널은 (루트, 칸)마다,
 * 관측기는 저장소마다 하나다. 맵은 App 의 `gitPanels`·`_gitObservers` 에 남는다.
 */
class GitSurfaces extends Controller {
  // ── 관측과 시선의 레지스트리 (SLOT_VIEW_STATE_SRS 묶음 O·V) ──

  /**
   * 관측은 **저장소마다** 하나다.
   *
   * **FR-SVS-30 을 개정한다** (REPO_TAB_UNIFY_SRS FR-RTU-64). 그 규칙이 "앱에
   * 하나" 였던 근거는 Git 창이 워크스페이스에 하나여서 **활성 저장소도 하나**
   * 였다는 것이다 (FR-GIT-26·29). 관측기는 status·signature·소실·실패 누적을
   * 통째로 들고 있으므로, 저장소마다 창이 서는 지금 그것을 하나로 두면 마지막에
   * 수집한 저장소의 상태를 모든 창이 함께 본다 — 실측한 결함이다: 다른 창에서
   * 파일을 만들어도 이 창의 목록이 갱신되지 않았다.
   *
   * 요청 수는 늘지 않는다. 관측이 도는 조건은 **그 표면이 화면에 있을 때**이고
   * (FR-RTU-62), 화면에 있는 저장소만큼만 폴링이 돈다 — 종전에도 활성 저장소
   * 하나가 폴링의 대상이었다.
   */
  gitObs(root){
    if(!this.app._gitObservers) this.app._gitObservers=new Map();
    const key=root||'';
    let o=this.app._gitObservers.get(key);
    if(!o){o=new GitObserver(this.app);this.app._gitObservers.set(key,o)}
    return o;
  }

  /**
   * REPO_TAB_UNIFY_SRS FR-RTU-62: 창이 바뀌면 **모든 패널**이 폴링 조건을 다시
   * 본다.
   *
   * 종전에는 활성 칸의 패널 하나만 `_reschedule()` 했다 — 패널이 하나뿐이었기
   * 때문이다. 저장소마다 패널이 서는 지금 그렇게 하면 **떠난 창의 패널이 타이머를
   * 든 채 남는다**: `_pollOk` 는 `_applyCadence` 가 불릴 때만 검사되므로, 아무도
   * 보지 않는 저장소를 계속 폴링한다 (실측).
   *
   * **여기서 패널을 만들지 않는다.** 종전에는 `gitPanel` getter 를 불러
   * "활성 창의 패널이 아직 없으면 만들며 첫 관측을 시작" 했는데, 그것이 **git
   * 저장소가 아닌 루트의 Repo 창에도 패널을 세워** status 를 3초마다 묻게 했다
   * (실측: V-EDT-47 이 status 1회를 기대하는데 4회). 판정의 근거가 없는 것이
   * 아니라 **볼 사람이 없는 것**이 문제다 — 사이드가 Explorer 이고 본문에 git
   * 뷰 탭도 없으면 그 저장소의 관측을 쓰는 화면이 하나도 없다.
   *
   * 첫 관측은 **패널을 만드는 자리**(`gitPanelAt`)가 맡는다. 그 자리는 사이드가
   * Changes 로 돌아갔거나 git 뷰 탭이 마운트될 때 렌더가 지나므로, 관측은 그
   * 표면이 실제로 화면에 설 때 시작된다 (FR-RTU-62).
   */
  _gitRescheduleAll(){
    if(this.app.gitPanels) for(const p of this.app.gitPanels.values()) p.poll._reschedule();
  }

  /**
   * UX_BATCH9_SRS FR-GLR-1: 멈춘 관측을 되살리는 **상시 계기**.
   *
   * 위의 `_gitRescheduleAll` 은 "표면이 바뀌었다" 를 아는 자리들이 부른다. 그
   * 목록이 완전하다는 보장이 없고, 하나가 새면 그 패널은 영구히 멎는다 (SRS
   * §2.4). 이 함수는 그 목록에 기대지 않는다 — **관측이 낡았는지**만 보고,
   * 낡았을 때만 움직인다.
   *
   * 렌더마다 불려도 좋도록 두 겹으로 싸 둔다: 여기의 시간 문턱과, 패널 쪽의
   * 나이 판정(`_watchdog`)이다. 정상 상태에서 이 경로가 내는 요청은 0 이다.
   */
  gitWatchdogAll(){
    if(!this.app.gitPanels||!this.app.gitPanels.size) return;
    const now=Date.now();
    if(this.app._gitWdAt&&now-this.app._gitWdAt<GIT_WATCHDOG_CHECK_MS) return;
    this.app._gitWdAt=now;
    for(const p of this.app.gitPanels.values()) p.watchdog.run();
  }

  /**
   * FR-GIT-249 (FR-DRC-16): 핀 목록이 바뀌었음을 **모든 패널**에 알린다.
   *
   * `_gitRescheduleAll` 과 같은 골격이고 같은 근거다 — 패널이 저장소마다,
   * 칸마다 서므로 활성인 하나만 알리면 나머지는 낡은 값을 그린 채 남는다.
   */
  _gitNotifyPinsAll(){
    if(!this.app.gitPanels) return;
    for(const p of this.app.gitPanels.values()) if(p.notifyPins) p.notifyPins();
  }

  // 패널이 하나도 남지 않은 관측기는 거둔다 — 타이머를 든 채 남으면 사라진 창의
  // 저장소를 영영 폴링한다.
  _gitObsReap(){
    if(!this.app._gitObservers) return;
    for(const [k,o] of this.app._gitObservers){
      if(o.panels.size) continue;
      o.stopPolling();
      this.app._gitObservers.delete(k);
    }
  }

  /**
   * FR-SVS-40·42 + REPO_TAB_UNIFY_SRS FR-RTU-60: Git 의 **시선**은 (루트, 칸)마다
   * 하나다. 키가 `slotKey` 를 지나므로 칸 0 의 키는 접미사가 없다 (FR-WSL-75).
   *
   * 종전 키는 칸 번호뿐이었고 근거가 "Git 창은 워크스페이스에 하나" 였다
   * (FR-GIT-26). 창이 경로마다 생기면 그 전제가 깨진다 — 두 Repo 창이 같은
   * 패널을 다투면 한쪽에서 고른 파일이 다른 쪽 diff 에 뜬다.
   *
   * `root` 가 빈 문자열이면 **옛 Git 창**의 패널이다. 마이그레이션(FR-RTU-70)
   * 전까지 두 표면이 공존하므로 그 자리를 남겨 둔다.
   */
  gitPanelAt(root,slot){
    if(!this.app.gitPanels) this.app.gitPanels=new Map();
    const key=this._gitPanelKey(root,slot);
    let p=this.app.gitPanels.get(key);
    if(!p){
      // FR-RTU-24: Repo 창의 패널이 볼 저장소는 **그 창의 루트에서 나온다** —
      // `repo` getter 가 그것을 주므로 여기서 따로 정하지 않는다. 옛 Git
      // 창(root='')은 사용자가 사이드바에서 고른 리포를 따른다.
      p=new GitPanel(this.app,root||'');
      this.app.gitPanels.set(key,p);
      // FR-GIT-22: 새 패널의 **첫 관측**이다. 맵에 먼저 넣는 이유는 `collect` 가
      // 다시 이 함수를 지날 수 있기 때문이다.
      //
      // **여기서만 부른다.** 매 부름마다 부르면 렌더마다 조건을 다시 보게 되고,
      // 사이 어딘가에서 `_stop` 이 한 번 걸린 뒤의 첫 렌더가 즉시 수집을 한 번
      // 더 일으킨다 — 주기 0(폴링 끔)에서 그 한 건이 그대로 드러났다 (V18 실측).
      // 표면이 바뀌는 계기는 `_gitRescheduleAll` 을 부르는 자리들이 든다.
      p.poll._reschedule();
    }
    return p;
  }

  /**
   * NFR-RTU-3 + FR-RTU-34: 그 루트의 패널들에서 뷰 하나의 DOM 을 놓는다.
   *
   * 칸마다 패널이 따로이므로(FR-RTU-60) 루트가 같은 것 **전부**를 돈다 — 탭은
   * 레이아웃의 것이고 레이아웃은 칸이 공유한다. 상태(스크롤·선택·diff 대상)는
   * 패널의 필드에 남으므로 다시 열면 그대로다 (FR-RTU-34).
   */
  // UX_BATCH12_SRS FR-RTB-7: Diff 탭은 탭마다 전용 패널이다 — `tabId` 가 오면 그 탭의 패널만 거둔다.
  _gitDropView(root,view,tabId){
    if(!view||!this.app.gitPanels) return;
    if(tabId&&view==='diff'){this.app._gitDiffPanelsDrop(tabId);return}
    for(const [key,p] of this.app.gitPanels){
      if(this.app._gitPanelRoot(key)!==(root||'')) continue;
      if(p.viewRoots.dropView) p.viewRoots.dropView(view);
    }
  }

  /**
   * 그 루트의 Diff 뷰 중 저장하지 않은 편집을 든 것이 있는가 (FR-RTU-103).
   *
   * Diff 는 unstaged·conflict 축에서 **편집할 수 있다**(`GIT_AXIS_EDITABLE`) —
   * `GitDiffView` 가 자기 `_dirty` 와 `save()`·`Cmd+S` 를 든다. 그러므로 탭을
   * 닫을 때 "잃는 편집이 없다" 는 전제는 더는 참이 아니다.
   *
   * `tab.dirty` 를 읽지 않고 뷰에게 묻는 이유는 그것이 **편집을 실제로 들고 있는
   * 쪽**이기 때문이다. 탭의 표식은 그 사실의 사본이고, 사본을 근거로 삼으면
   * 동기화가 어긋난 순간 확인이 조용히 빠진다.
   */
  // `closing` 은 닫기 확인의 물음이다 — 그 뷰가 떠나면 편집을 잃는가 (REPO_FIX 05 §3A-3).
  // `tabId` 가 오면 그 Diff 탭의 패널만 본다 (FR-RTB-7 — Diff 탭이 여럿이다).
  _gitViewDirty(root,view,closing,tabId){
    if(!view||!this.app.gitPanels) return false;
    for(const [key,p] of this.app.gitPanels){
      if(this.app._gitPanelRoot(key)!==(root||'')) continue;
      if(!this._gitPanelOfTab(p,view,tabId)) continue;
      if(p.viewRoots.viewDirty&&p.viewRoots.viewDirty(view,!!closing)) return true;
    }
    return false;
  }

  // 그 루트의 Diff 뷰들이 보고 있는 편집기 문서의 경로 (REPO_FIX 05 §3A-3).
  _gitDiffDocPaths(root){
    const out=[];
    if(!this.app.gitPanels) return out;
    for(const [key,p] of this.app.gitPanels){
      if(this.app._gitPanelRoot(key)!==(root||'')) continue;
      const dp=p&&p._diffView&&p._diffView.docPath();
      if(dp) out.push(dp);
    }
    return out;
  }

  /**
   * 그 루트의 Diff 뷰가 든 편집을 저장한다. 하나라도 실패하면 false 다 —
   * 호출자는 그때 닫기를 멈춘다. 저장한 줄 알고 닫으면 그것이 곧 손실이다.
   */
  async _gitViewSave(root,view,tabId){
    if(!view||!this.app.gitPanels) return true;
    let ok=true;
    for(const [key,p] of this.app.gitPanels){
      if(this.app._gitPanelRoot(key)!==(root||'')) continue;
      if(!this._gitPanelOfTab(p,view,tabId)) continue;
      if(p.viewRoots.viewSave&&!await p.viewRoots.viewSave(view)) ok=false;
    }
    return ok;
  }

  /**
   * FR-RTU-62: **이 창에 git 표면이 서 있는가.**
   *
   * 창이 보이는 것만으로는 부족하다 — Repo 창은 사이드가 `Explorer` 이고 본문에
   * git 뷰 탭도 없을 수 있고, 그때 그 저장소의 관측을 쓰는 화면은 하나도 없다.
   * 그것을 세지 않으면 **저장소가 아닌 루트에도** status 가 3초마다 나간다
   * (실측: V-EDT-47 이 1회를 기대하는데 4회였다).
   *
   * 탭은 **있는지**만 본다. 활성인지까지 따지면 사용자가 Diff 와 History 를
   * 오갈 때마다 관측이 멎었다 살아나고, 돌아온 탭이 낡은 내용을 먼저 보인다.
   */
  gitSurfaceOn(w){
    if(!w) return false;
    if(this.app.edSideOf(w)===REPO_SIDE_CHANGES) return true;
    if(!w.layout) return false;
    for(const pn of this.app.flattenPanes(w.layout))
      if((pn.tabs||[]).some(tab=>tab&&tab.type===TAB_TYPE_GIT)) return true;
    return false;
  }

  // 키의 조립은 여기 하나다 — 회수(`_gitPanelReap`)가 같은 규칙으로 되풀어야
  // 하고, 두 벌이 되면 한쪽만 고쳐진다.
  _gitPanelKey(root,slot){ return this.app.slotKey('git:'+(root||''),slot||0) }
  _gitPanelRoot(key){
    const base=this.app.slotBase(key);
    if(!base.startsWith('git:')) return '';
    // FR-RTB-7: Diff 탭 패널의 키는 루트 뒤에 탭 id 를 단다 (`gitDiffPanelFor`).
    const at=base.indexOf(GIT_DIFF_TAB_SEP);
    return at<0?base.slice(4):base.slice(4,at);
  }
  // Diff 탭 하나를 묻는 자리(`tabId`)면 그 탭의 패널만 대상이다.
  _gitPanelOfTab(p,view,tabId){
    return !(tabId&&view==='diff')||p.diffTabId===tabId;
  }

  /**
   * FR-SVS-46 + FR-RTU-63: 사라진 **칸**과 사라진 **루트**의 패널을 거둔다.
   * 편집기가 패널마다 서므로 이 회수가 새면 인스턴스가 누적된다 (§7 R-1).
   *
   * 루트가 목록에서 사라지는 것은 재조정이 창을 지우는 것과 같은 사건이다
   * (FR-EDT-42) — 창이 없는 패널은 볼 사람이 없다.
   */
  _gitPanelReap(){
    if(!this.app.gitPanels||!this.app.gitPanels.size) return;
    const n=this.app.slotCount();
    // 살아 있는 루트: Repo 창들의 루트 + 옛 Git 창의 자리('').
    const live=new Set(['']);
    for(const s of this.app.ws.windows) if(this.app.isEditorWin(s)) live.add(this.app.edRootOf(s));
    // FR-RTB-7: Diff 탭 패널은 그 탭이 레이아웃에 남아 있을 때만 산다.
    const tabs=this.app._gitDiffTabIds();
    for(const [key,p] of this.app.gitPanels){
      if(this.app._slotOf(key)<n&&live.has(this.app._gitPanelRoot(key))&&(!p.diffTabId||tabs.has(p.diffTabId))) continue;
      p.destroy();
      this.app.gitPanels.delete(key);
    }
    // 패널이 사라지면 그 관측기도 볼 사람이 없다.
    this._gitObsReap();
  }

  /**
   * FR-RTU-65: 지금 활성인 창이 어느 git 표면인가.
   *
   * Repo 창이면 그 루트, 아니면 옛 Git 창의 자리('')다. **활성 창이 Repo 창이
   * 아닐 때 빈 문자열을 주는 것이 요점이다** — 터미널 창에 서 있는 동안에도
   * 상태바와 사이드바가 딛을 패널이 있어야 하고, 그 자리는 종전과 같다.
   */
  _gitRootOfActive(){
    const w=this.app.aw();
    return this.app.isEditorWin(w)?this.app.edRootOf(w):'';
  }
}

// 바깥과 계약·시험이 App 에서 부르는 이름 (FR-FEA-4).
Controller.delegate(App,'git.surfaces',['gitObs','_gitRescheduleAll','gitWatchdogAll','_gitNotifyPinsAll','gitPanelAt','_gitDropView',
  '_gitViewDirty','_gitDiffDocPaths','_gitViewSave','gitSurfaceOn','_gitPanelKey','_gitPanelRoot','_gitPanelReap','_gitRootOfActive']);
