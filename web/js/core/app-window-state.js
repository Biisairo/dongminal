/**
 * Dongminal — 받은 워크스페이스의 정규화와 활성 창 전환 (OPTIMIZE_REFACTOR_SRS FR-OPT-11-1).
 *
 * **두 로드 경로가 한 벌을 지난다** (FEC-17). 첫 로드(`init`)와 원격 채택
 * (`_applyRemoteWorkspace`)이 같은 단계를 각자 적고 있었다 — clean·normalize,
 * 빈 창 거르기, Git 창·편집기 탭 마이그레이션, 활성 창 폴백, 기기 키 걷기. 두 벌이면
 * 한쪽만 고쳐진다.
 *
 * **활성 창을 바꾸는 자리도 하나다** (FEC-18). `ws.activeWindow` 와 그 탭별 기억
 * (`sessionStorage` 의 창 id · Repo 루트)을 여기서만 적는다. 창을 바꾸며 함께 하는
 * 일(칸 따라가기·포커스·소유권 주장·git 재예약)은 자리마다 다르므로 부르는 쪽에
 * 남는다 — 그 차이를 옵션으로 올리면 호출부마다 옵션 조합이 하나씩 생긴다.
 */
Object.assign(App.prototype, {
  /**
   * 받은 스냅숏의 창 목록을 제자리에서 정규화한다. `live` 는 살아 있는 도구 id 의
   * 판정이다 (FR-TLU-5·6 — 모를 때는 전부 참).
   *
   * 편집기 탭 마이그레이션이 무언가 옮겼으면 참이다 — 저장은 부르는 쪽이 한다
   * (FR-EDT-105: 되쓰지 않으면 다음 동기화가 같은 일을 되풀이한다).
   */
  _normalizeIncomingWorkspace(sv,live){
    for(const s of sv.windows){
      if(!s||!s.id) continue;
      s.layout=clean(s.layout,live);
      if(s.layout) normalizeLayout(s.layout);
    }
    // FR-EDT-49 / D-13: **layout 이 없는 Editor 창은 지워지지 않는다.** 갓 만든
    // Editor 창은 pane 이 없고(FR-EDT-55) 그것이 정상이다 — `git pin` 하나에도
    // `workspace_changed` 가 오므로(§2.4) 예외가 없으면 다음 핀 한 번에 사라진다.
    const keep=()=>{sv.windows=sv.windows.filter(s=>s&&(s.layout||this.isEditorWin(s)))};
    keep();
    // FR-GIT-186: 개정 이전에 Git 창 안에 들어간 탭을 일반 창으로 옮긴다.
    this._migrateGitWindow(sv.windows);
    // FR-EDT-103·104·106 / D-19: 일반 창에 남은 편집기 탭을 걷어낸다 — 다른 브라우저가
    // 만든 것도. `clean()` 이 아니라 여기다: `clean` 은 편집기 탭을 보존하도록
    // 만들어져 있고 창 타입을 알지 못한다 (§2.9).
    if(!this._migrateEditorTabs(sv.windows)) return false;
    // FR-EDT-105: 탭이 0이 된 pane 은 붕괴하고, layout 이 빈 **일반** 창은 사라진다.
    keep();
    return true;
  },

  /**
   * FR-EDT-45 (FR-CLS-1 과 같은 근거): 활성 창의 폴백은 Editor 창이 아니다.
   * `save()` 가 activeWindow 를 싣지 않으므로 다른 브라우저가 만든 워크스페이스를
   * 처음 읽을 때 이 자리가 늘 돈다 — 배열의 첫 자리를 그대로 쓰면 아무 조작도 하지
   * 않은 사용자가 편집기 화면에 떨어진다. 모델만 고친다.
   */
  _fallbackActiveWindow(ws){
    if(ws.windows.find(s=>s.id===ws.activeWindow)) return;
    ws.activeWindow=(ws.windows.find(s=>!this.isEditorWin(s))||ws.windows[0])?.id||null;
  },

  /**
   * 기기·창의 것인 키를 동기화 상태에서 걷어낸다. 옮긴 키는 첫 진입과 원격 반영
   * **둘 다**에서 지운다 — 옛 판의 브라우저가 계속 실어 보낼 수 있다.
   *
   *   displayMode·mobileBreakpoint  탭별(sessionStorage)이다
   *   sidebarWidth                  창의 치수다 (FR-UXB-8, D-UXB-1)
   *   Repo 사이드 폭                창의 치수다 (FR-RSW-5, `_edMigrateSideWidth`)
   *
   * 대상은 `this.ws` 다 — `_edMigrateSideWidth` 도 그것을 본다. 폭을 옮겼으면 참이다
   * (저장은 부르는 쪽이 한다).
   */
  _stripDeviceKeys(){
    delete this.ws.displayMode;
    delete this.ws.mobileBreakpoint;
    let moved=false;
    if('sidebarWidth' in this.ws){ delete this.ws.sidebarWidth; moved=true }
    return this._edMigrateSideWidth()||moved;
  },

  /**
   * FEC-18: 활성 창을 `id` 로 바꾼다. `rememberFocus` 면 **다른 창으로 떠날 때**
   * 떠나는 창의 포커스 pane 을 적는다 — 돌아왔을 때 그 자리로 간다.
   */
  _activateWindow(id,{rememberFocus=false}={}){
    if(rememberFocus&&this.ws.activeWindow!==id){
      const cur=this.aw(); if(cur) cur.focusedPane=this.focused;
    }
    this.ws.activeWindow=id;
    this._persistActiveWindow(id);
  },

  /**
   * 활성 창의 **탭별 기억**. 새로고침을 건너는 유일한 근거다 (`activeWindow` 는
   * PUT 에서 걸러진다, `save`).
   *
   * D-RTU-18: 루트도 함께 적는다 — Repo 창은 재조정이 새 id 로 다시 세울 수 있고
   * 루트는 그대로다. 일반 창이면 지운다: 남겨 두면 새로고침이 옛 Repo 창으로 간다.
   *
   * `win` 은 창이 아직 `this.ws` 에 없을 때(원격 스냅숏의 창) 넘긴다.
   */
  _persistActiveWindow(id,win){
    const w=win||this.ws.windows.find(s=>s&&s.id===id);
    try{
      sessionStorage.setItem('activeWindow',id);
      if(this.isEditorWin(w)) sessionStorage.setItem(ACTIVE_EDITOR_ROOT_KEY,this.edRootOf(w));
      else sessionStorage.removeItem(ACTIVE_EDITOR_ROOT_KEY);
    }catch{}
  },
});
