/**
 * Dongminal — Editor 창의 **칸과 사이드** (FE_MODULE_BOUNDARY_SRS FR-FMB-20).
 *
 * 어느 칸에 무엇이 서는가 — 사이드 폭 · 핀 · 탭의 이동과 닫힘 · git 폴링의 시작.
 * 마지막 IIFE 가 `gitSignal` 을 감싸 저장을 색 갱신의 계기로 잇는다 (FR-EDT-78);
 * `app-git.js` 뒤에 로드되므로 여기서 감쌀 수 있다.
 */
Object.assign(App.prototype, {
  /**
   * FR-EDT-77: 주기는 `GIT_REPOS_POLL_MS` 와 같다. 캐시 TTL 200ms + single-flight
   * 위에 얹히므로 Git 패널과 동시에 떠 있어도 git 실행이 겹치지 않는다 (§2.7).
   *
   * NOTES_LIVE_EXPLORER_SRS FR-FSL-7 / D-7: 겹의 스탬프도 **같은 틱**에 묻는다.
   * 새 타이머를 만들지 않는 이유는 두 관측이 한 화면의 두 면이기 때문이다 —
   * 주기가 갈리면 사용자는 "색은 바뀌었는데 목록은 그대로인" 중간 상태를 본다.
   *
   * FR-FSL-14: 대상도 같다. 화면에 없는 창의 탐색기는 둘 다 묻지 않는다.
   */
  _edStartGitPoll(){
    if(this._edGitPoll) this._edGitPoll.stop();
    // FR-RST-23: 종전에는 숨김만 보고 **복귀 시 갱신이 없었다** — 돌아온 화면이
    // 한 주기 동안 낡은 채였다. 공용 규약이 그것을 함께 준다.
    this._edGitPoll=visiblePoll(()=>gitReposInterval,()=>{
      for(const t of this._edVisibleTrees()){ t.pollGit(); t.pollStamp() }
    });
  },

  /**
   * REPO_TAB_UNIFY_SRS: **Repo 창의 신원은 id 가 아니라 루트다.**
   *
   * 실측한 결함이다 — 목록에 없던 경로를 `openGitWindow` 로 열면 로컬이 창을
   * 만들고 그리로 전환하는데, 곧이어 도착한 `workspace_changed` 가 서버
   * 스냅샷(아직 그 창이 없다)으로 목록을 덮는다. 재조정이 같은 루트의 창을 **새
   * id 로** 다시 만들면 `activeWindow` 는 사라진 옛 id 를 가리키고, 폴백이
   * 엉뚱한 일반 창을 활성으로 고른다. 브라우저가 둘일 때도 같은 순서가 성립한다.
   *
   * 그래서 **id 가 아니라 루트로 다시 찾는다.** 사용자에게 같은 저장소의 창은
   * 같은 창이다.
   */
  _edKeepActive(sv){
    if(!sv||!Array.isArray(sv.windows)) return;
    const cur=this.ws.windows.find(s=>s&&s.id===this.ws.activeWindow);
    if(!this.isEditorWin(cur)) return;
    const root=this.edRootOf(cur);
    if(!root) return;
    const next=sv.windows.find(s=>this.isEditorWin(s)&&this.edRootOf(s)===root);
    if(!next) return;
    sv.activeWindow=next.id;
    /**
     * **sessionStorage 도 함께 옮긴다.** 그 값이 새로고침을 건너는 유일한 근거이고
     * (`activeWindow` 는 PUT 에서 걸러진다, `save`), 여기서 갱신하지 않으면 새
     * 창 id 를 아는 곳이 메모리뿐이다 — 새로고침 뒤 옛 id 를 찾지 못한 폴백이
     * 엉뚱한 일반 창을 고른다. 실측: 새로고침 뒤 Changes 사이드가 사라졌다
     * (V33·FR-GIT-76).
     */
    try{sessionStorage.setItem('activeWindow',next.id)}catch{}
  },

  /**
   * FR-RTU-42(④): 그 파일의 탭을 고정한다.
   *
   * 여는 것과 고정하는 것을 갈라 둔 이유는 **여는 자리가 여럿**이기 때문이다
   * (탐색기·변경 목록·검색·`edit` 명령). 그 전부에 "고정할지" 를 인자로 흘리면
   * 자리마다 판단이 생긴다 — 여기서는 계기를 받은 쪽이 한 줄로 부른다.
   */
  edPinTabFor(filePath){
    const found=filePath&&this._findEditorTab(filePath);
    if(found) this.pinPreviewTab(found.tab);
  },

  // ── 사이드의 활성 탭 (REPO_TAB_UNIFY_SRS FR-RTU-12·13) ──

  // 폭과 같은 규약으로 **워크스페이스**에 산다 — 창마다 따로이고 새로고침을
  // 넘는다. 모르는 값은 기본으로 떨어뜨린다 (옛 워크스페이스에는 이 키가 없다).
  edSideOf(s){
    const v=s&&s.editor&&s.editor.side;
    return REPO_SIDE_TABS.some(d=>d.id===v)?v:REPO_SIDE_DEFAULT;
  },

  edSetSide(s,id){
    if(!s||!REPO_SIDE_TABS.some(d=>d.id===id)) return;
    if(!s.editor) s.editor={};
    if(s.editor.side===id) return;
    s.editor.side=id;
    this.render();
    // FR-DIR-32 와 같은 근거: 사이드를 Explorer 로 돌린 것은 사용자가 방금 한
    // 일이다. 그동안 게이트에 막혀 쉰 트리는 낡았으므로 곧바로 묻는다.
    if(id===REPO_SIDE_EXPLORER){
      const t=this._edTreeFor(s);
      if(t){ t.pollGit({now:true}); t.pollStamp() }
    }
    // FR-RTU-62: 사이드 탭 전환은 **관측 조건의 계기**다. Changes 를 떠나면 그
    // 표면이 화면에서 사라지므로(본문에 git 뷰 탭이 없다면) 폴링도 멎어야 한다 —
    // 조건은 `_applyCadence` 가 불릴 때만 검사되고, 부르는 자리가 여기다.
    this._gitRescheduleAll();
    this.save();
  },

  // ── 사이드 폭 (REPO_SIDE_WIDTH_SRS FR-RSW-1~5) ──

  /**
   * 폭은 **워크스페이스 하나**에 산다 — `sidebarWidth` 가 그렇다 (§2.10).
   *
   *   이전 동작: 창 레코드마다 하나였다 (`window.editor.explorerWidth`, FR-EDT-47)
   *   새  동작: `ws.repoSideWidth` 하나를 모든 Repo 창이 읽는다
   *   이유:     폭은 "이 창을 어떻게 볼까" 가 아니라 목록 자리의 치수다. 창마다
   *             따로면 창을 옮길 때마다 같은 자리가 다른 폭으로 선다 (D-1·D-2)
   */
  edSideWidth(){
    const w=parseInt(this.ws&&this.ws.repoSideWidth,10);
    if(!Number.isFinite(w)) return REPO_SIDE_W_DEFAULT;
    return Math.max(REPO_SIDE_W_MIN,Math.min(REPO_SIDE_W_MAX,w));
  },

  edSetSideWidth(w){
    const v=Math.max(REPO_SIDE_W_MIN,Math.min(REPO_SIDE_W_MAX,Math.round(w)));
    if(this.ws.repoSideWidth===v) return;
    this.ws.repoSideWidth=v;
    this.save();
  },

  /**
   * FR-RSW-5: 창별 폭을 워크스페이스 하나로 옮긴다.
   *
   * `displayMode` 를 지우는 두 자리와 같은 규약이다 — 옮긴 키는 첫 진입과 원격
   * 반영 **둘 다**에서 지운다. 승계는 배열에서 처음 만나는 유효한 값 하나이며
   * (결정론적이다), 이미 새 값이 있으면 승계하지 않는다.
   *
   * 바뀐 것이 있으면 참이다. 저장은 호출자가 한다.
   */
  _edMigrateSideWidth(){
    let changed=false, take=0;
    for(const s of (this.ws.windows||[])){
      if(!s||!s.editor||!('explorerWidth' in s.editor)) continue;
      const w=parseInt(s.editor.explorerWidth,10);
      if(!take&&Number.isFinite(w)) take=w;
      delete s.editor.explorerWidth;
      changed=true;
    }
    if(take&&!this.ws.repoSideWidth){
      this.ws.repoSideWidth=Math.max(REPO_SIDE_W_MIN,Math.min(REPO_SIDE_W_MAX,take));
    }
    return changed;
  },

  // ── 파일 열기 라우팅 (FR-EDT-94~102) ──

  // 경로가 루트 아래인가. 루트 자신도 포함이다. `startsWith(root)` 만으로는
  // `/a/bc` 가 `/a/b` 아래로 잡히므로 구분자까지 함께 본다.
  _edUnder(root,p){ return pathUnder(root,p) },

  /**
   * FR-EDT-95: **연결된 Editor** 는 그 절대경로를 자기 루트 아래에 포함하는 창이다.
   *
   * 둘 이상이면 **루트가 가장 깊은** 것이 이긴다 — 가장 구체적인 것이 이긴다.
   * 중첩된 Editor 둘이 있을 때 얕은 쪽이 이기면, 사용자가 좁혀 두려고 만든 행이
   * 한 번도 쓰이지 않는다.
   */
  _edLinkedWindow(p){
    let best=null,blen=-1;
    for(const s of this.edWindows()){
      const root=this.edRootOf(s);
      if(!this._edUnder(root,p)) continue;
      if(root.length>blen){best=s;blen=root.length}
    }
    return best;
  },

  // FR-EDT-100: 대상 창의 `focusedPane` → `firstPane` → 없으면 새로 만든다.
  // `this.focused` 를 쓰지 않는다 — 대상 창이 비활성일 수 있다 (`_gitPaneOf`).
  edEnsurePane(w){
    if(!w) return null;
    if(w.layout){
      const rid=(w.focusedPane&&findPane(w.layout,w.focusedPane))?w.focusedPane:firstPane(w.layout)?.id;
      if(rid) return rid;
    }
    // FR-EDT-55: pane 이 없는 창이었다. 지금 하나 만든다.
    const rid=newEntityId();
    w.layout={type:'pane',id:rid,tabs:[],activeTab:null};
    w.focusedPane=rid;
    return rid;
  },

  // 경로 아래의 편집기 탭 — 자신과 하위 전부다. 이름 변경·삭제가 폴더면 그
  // 아래의 탭이 전부 대상이므로 판정을 여기 하나에 둔다 (FR-EDT-90·91).
  _edTabsUnder(p){
    const out=[];
    if(!p) return out;
    // 구분자는 그 경로의 것을 쓴다 — `/` 로 굳히면 Windows 에서 어떤 탭도
    // 그 폴더 아래로 잡히지 않아, 폴더를 지우거나 옮겨도 탭이 그대로 남는다.
    const pre=p==='/'?'/':p+pathSep(p);
    for(const s of this.ws.windows){
      if(!s||!s.layout) continue;
      const panes=[];this._collectPanes(s.layout,panes);
      for(const pn of panes){
        for(const t of pn.tabs||[]){
          if(!t||t.type!=='editor'||typeof t.filePath!=='string') continue;
          if(t.filePath===p||t.filePath.startsWith(pre)) out.push({win:s,pane:pn,tab:t});
        }
      }
    }
    return out;
  },

  // FR-EDT-84: 확인창이 밝혀야 할 사실. 이름만 준다 — 개수만 보이면 사용자가
  // 무엇을 잃는지 모른다 (GitConfirm 의 영향 범위와 같은 근거).
  edDirtyUnder(p){
    return this._edTabsUnder(p)
      .filter(x=>{const e=this.fileEditors.get(x.tab.id);return !!(e&&e._dirty)})
      .map(x=>x.tab.name);
  },

  /**
   * FR-EDT-90: 이름 변경·이동을 열린 탭이 따라간다. **탭은 닫히지 않는다.**
   *
   * 폴더가 옮겨지면 그 아래 모든 탭의 경로가 접두사만 바뀐다. `FileEditor` 가
   * 자기 경로를 따로 쥐고 있으므로(저장이 그것을 쓴다) 그쪽도 함께 고친다 —
   * 빠뜨리면 다음 저장이 사라진 경로에 쓴다.
   */
  edRetargetTabs(from,to){
    const list=this._edTabsUnder(from);
    if(!list.length) return 0;
    for(const {tab} of list){
      const np=tab.filePath===from?to:to+tab.filePath.slice(from.length);
      tab.filePath=np;
      tab.name=pathBase(np)||tab.name;
      const ed=this.fileEditors.get(tab.id);
      if(ed){ed.filePath=np;ed.name=tab.name}
    }
    this.render();
    this.save();
    return list.length;
  },

  /**
   * FR-EDT-91: 삭제되면 그 탭을 닫는다. 폴더면 그 아래 전부.
   *
   * `force` 로 dirty 확인을 건너뛴다 — 그 사실은 삭제 확인창이 이미 밝혔다
   * (FR-EDT-84). 여기서 다시 물으면 사용자가 이미 승낙한 것을 두 번 묻는 것이고,
   * 취소해도 파일은 이미 없다.
   */
  async edCloseTabsUnder(p){
    const list=this._edTabsUnder(p);
    for(const x of list) await this.closeTab(x.pane.id,x.tab.id,x.win.id,{force:true});
    return list.length;
  },
});


/**
 * FR-EDT-78: 파일 저장은 색의 즉시 갱신 계기다.
 *
 * 그 신호의 진입점은 이미 하나 있고(`gitSignal`, FR-GIT-18) `FileEditor.save` 가
 * 그것을 부른다. 두 번째 진입점을 만들면 저장 경로마다 어느 쪽을 불러야 하는지가
 * 갈리므로, 있는 자리에 **이어 붙인다** — Git 패널의 동작은 그대로다.
 *
 * app-git.js 뒤에 로드되므로(index.html) 여기서 감쌀 수 있다.
 */
(function(){
  const base=App.prototype.gitSignal;
  App.prototype.gitSignal=function(kind){
    base.call(this,kind);
    const t=this.edActiveTree();
    // FR-DIR-32: 저장·커밋 같은 즉시 신호도 백오프를 넘긴다.
    if(t) t.pollGit({now:true});
    // EDITOR_DIRTY_DIFF_SRS FR-EDD-50·51: 편집기의 기준도 이 신호로 따라온다.
    // 편집기는 자기 주기의 폴링을 갖지 않으므로(D-5) 이 자리가 그 유일한 계기다.
    if(this._edDocs) for(const d of this._edDocs.values()) if(d.dd) d.dd.refresh();
  };
})();
