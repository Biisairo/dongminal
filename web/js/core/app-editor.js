/**
 * Dongminal — Editor 행과 Editor 창 (EDITOR_TAB_SRS 묶음 T·E·W·M)
 *
 * Git 창이 특수 창의 선례다 (§2.2) — 이 파일은 `app-git.js` 의 구조를 그대로
 * 복제한다: 창을 찾는 자리 하나, 창을 만드는 자리 하나, 마이그레이션 하나,
 * 목록을 서버에서 받아 로컬 사본에 반영하는 자리 하나.
 *
 * app.js 이후 main.js 이전에 로드된다 (FR-APP-5).
 */
Object.assign(App.prototype, {
  // ── 창 판정 (FR-EDT-40) ──

  // `_isGitWin` 과 같은 자리·같은 모양이다. 조건이 흩어지면 한 곳이 빠져도
  // 조용히 지나간다 (§2.2).
  _isEditorWin(s){return !!(s&&s.type===WINDOW_TYPE_EDITOR)},
  _edWindows(){return this.ws.windows.filter(s=>this._isEditorWin(s))},
  _edRootOf(s){return (s&&s.editor&&s.editor.root)||''},
  _edWindowFor(root){return this._edWindows().find(s=>this._edRootOf(s)===root)||null},

  // ── 목록 (FR-EDT-19·20·29·120) ──

  // FR-EDT-120: `home` 을 모르면 root 행도 root 창도 만들 수 없다. 그때는 표면
  // 전체가 없는 것으로 본다 — Git 이 `_gitOff` 로 하는 것과 같다.
  _edOn(){return !this._edOff&&!!(this._editors&&this._editors.home)},
  _edHome(){return this._edOn()?this._editors.home:''},

  /**
   * NOTES_LIVE_EXPLORER_SRS FR-NOT-11: 메모 루트. 서버가 주지 못하면 빈 문자열이며
   * 그때 없는 것은 **메모장 행 하나뿐**이다 — 홈과 다르다. 홈은 root 창의
   * 근거라서 모르면 표면 전체가 서지 않지만(FR-EDT-120), 메모 루트는 자기 행
   * 하나의 근거일 뿐이다.
   */
  _edNotes(){return this._edOn()?((this._editors||{}).notes||''):''},

  // 경로의 마지막 조각. 행 이름과 창 이름이 같은 규칙을 쓴다 (FR-EDT-10·44).
  _edBase(p){
    const s=String(p||'').replace(/\/+$/,'');
    return s.split('/').pop()||s||p||'';
  },
  // FR-NOT-9: 고정 행 둘은 경로에서 이름을 뽑지 않는다 — 파생시키면 `~` 가
  // 홈 디렉터리 이름이 되고 메모장이 `notes` 가 된다.
  _edName(root){
    if(root===this._edHome()) return EDITOR_ROOT_NAME;
    if(root&&root===this._edNotes()) return EDITOR_NOTES_NAME;
    return this._edBase(root);
  },

  // FR-EDT-16·37 / FR-NOT-7: 홈과 메모 루트는 고정 행이 대표한다 — 일반 행
  // 목록에 같은 경로가 있어도 두 번 그리지 않는다.
  _edEntries(){
    const fixed=new Set(this._edFixed().map(e=>e.path));
    return ((this._editors||{}).list||[])
      .filter(p=>typeof p==='string'&&p&&!fixed.has(p))
      .map(p=>({path:p,root:false}));
  },
  /**
   * FR-EDT-13·14 / FR-NOT-8: 최하단 고정 행들. 서술자의 `fixed(app)` 이
   * 돌려주는 것이 이것이다.
   *
   * **배열의 순서가 화면의 순서이자 순회의 순서다** (`SidebarList.entries`).
   * 메모장이 앞에 오므로 `~` **위**에 그려진다 — 접수한 말이 요구한 자리다.
   */
  _edFixed(){
    const out=[];
    const notes=this._edNotes();
    if(notes) out.push({path:notes,notes:true});
    const home=this._edHome();
    if(home) out.push({path:home,root:true});
    return out;
  },
  /**
   * FR-EDT-42(1) / FR-NOT-6: 있어야 할 루트 집합. 메모 루트가 여기 드는 것이
   * 곧 메모장 창이 서는 근거다 — 재조정이 이 집합만 보고 창을 세운다.
   *
   * 순서는 서버의 `Roots()` 와 같은 `[home, notes, ...list]` 다. 고정 행의
   * 표시 순서(`_edFixed`)와 **일부러 다르다**: 저쪽은 화면에서 무엇이 위에
   * 오는가이고, 이쪽은 창이 만들어지는 차례다. root 창이 먼저 서야 새
   * 워크스페이스의 첫 창이 지금까지와 같다.
   */
  _edRoots(){
    const home=this._edHome();
    if(!home) return [];
    const notes=this._edNotes();
    return [home,...(notes?[notes]:[]),...this._edEntries().map(e=>e.path)];
  },

  /**
   * FR-EDT-29·120: 목록을 받는다. 실패하면 `_edOff` 로 보고 탭 자체를 숨긴다.
   *
   * **워크스페이스를 처리하기 전에** 끝나야 한다 (app.js init) — 재조정과
   * 편집기 탭 마이그레이션이 둘 다 `home` 을 알아야 돌 수 있고, 모르면 둘 다
   * 돌지 않는 것이 옳다.
   */
  async _edLoad(){
    let r=null,d=null;
    try{r=await fetch(EDITORS_API)}catch{r=null}
    if(r&&r.ok){try{d=await r.json()}catch{d=null}}
    if(!d||typeof d.home!=='string'||!d.home){
      this._edOff=true;this._editors=null;return false;
    }
    this._edApplyServer(d);
    return true;
  },

  /**
   * FR-EDT-20·30: 서버가 준 값만 반영한다. 배열이 아니거나 문자열이 아닌 항목은
   * 조용히 버린다 — 손상된 워크스페이스가 목록 전체를 죽이지 않는다.
   *
   * WORKBENCH_REVIEW_SRS FR-WBR-31: **이름이 계약이다.** 이 함수는 `/api/editors`
   * 의 응답 — `home`·`notes`·`list` 를 **전부** 아는 값 — 전용이며, 부르는 자리는
   * `_edLoad` 하나다. 그 셋 중 일부만 아는 자리는 `_edPatchList` 로 간다.
   *
   *   이전 이름: `_edApply`
   *   새  이름: `_edApplyServer`
   *   이유:     "일부만 아는 값" 을 들고 이 함수를 부르면 나머지가 **조용히
   *             지워진다.** 실제로 두 번 일어났다 — `app-cmd.js` 한 자리(당시
   *             고침)와 `app.js` 의 워크스페이스 충돌 재시도(FR-WBR-30). 이름이
   *             출처를 말하면 그것을 들고 오지 않은 자리가 부르지 않는다
   */
  _edApplyServer(d){
    if(!d||typeof d.home!=='string'||!d.home) return;
    this._edOff=false;
    this._editors={
      home:d.home,
      // FR-NOT-11: 없으면 빈 문자열이다 — 그때 사라지는 것은 메모장 행 하나이고
      // 나머지 표면은 그대로 선다.
      notes:(typeof d.notes==='string'&&d.notes)?d.notes:'',
      list:(Array.isArray(d.list)?d.list:[]).filter(p=>typeof p==='string'&&p),
    };
    this._edMirror();
  },

  /**
   * NOTES_LIVE_EXPLORER_SRS FR-NOT-13: **목록만** 갈아끼운다.
   *
   * `_edApplyServer` 는 서버가 준 것 전부를 반영하므로 `home`·`notes` 를 함께 받아야
   * 한다. 그런데 그것을 부르는 자리 셋(`_edApplyLinked`·`_edMutate`·
   * `_applyRemoteWorkspace`)은 하나같이 **목록만** 새로 알고 나머지는 이미 아는
   * 값을 도로 실어 보낸다. 그 리터럴이 셋으로 흩어져 있으면 필드가 늘 때마다
   * 세 자리를 함께 고쳐야 하고, 한 자리를 빠뜨리면 그 필드가 조용히 지워진다 —
   * 실제로 `notes` 를 더할 때 `app-cmd.js` 의 한 자리가 빠져 메모장 창이
   * 워크스페이스 동기화 한 번에 사라졌다.
   *
   * 그래서 "아는 값은 그대로, 목록만" 을 **함수 하나**로 만든다. 넷째 호출처가
   * 생겨도 같은 실수를 할 자리가 없다.
   *
   * **넷째 호출처가 실제로 있었다** (WORKBENCH_REVIEW_SRS FR-WBR-30). `app.js` 의
   * 워크스페이스 충돌 재시도가 `_edApplyServer` 를 직접 불렀고, 그 리터럴에
   * `notes` 가 없어 충돌 한 번에 메모장이 사라졌다. 지금은 그 자리도 여기로 온다.
   */
  _edPatchList(list){
    if(!this._editors) return;
    this._edApplyServer({home:this._editors.home,notes:this._editors.notes,list});
  },

  // 목록은 workspace.json 최상위 `editors.list` 에 산다 (FR-EDT-19). 서버가
  // 확정한 값을 로컬 사본에도 반영해 둔다 — 다음 `_save()` 의 PUT 이 방금 만든
  // 행을 지우지 않게 (`_gitPinsApply` 와 같은 규약).
  _edMirror(){
    if(!this._editors) return;
    if(!this.ws.editors) this.ws.editors={};
    this.ws.editors.list=this._editors.list.slice();
  },

  /**
   * FR-EDT-39: 연동으로 두 목록이 **함께** 바뀌었을 때, 응답에 실려 온 쪽을
   * 반영하고 창까지 맞춘다.
   *
   * `/api/git/repos/{pin,unpin}` 은 Editor 목록을 바꿀 수 있다 (FR-EDT-31·32).
   * 그 절반을 버리면 리포를 핀해도 새로고침 전까지 Editor 행이 나타나지 않고,
   * 언핀하면 유령 행과 유령 창이 남는다.
   */
  _edApplyLinked(d){
    if(!this._editors||!d||!Array.isArray(d.editors)) return;
    this._edPatchList(d.editors);
    // 목록이 바뀌는 모든 경로는 `_edAfterChange` 하나를 지난다 — 재조정·저장·
    // 사라진 창에서의 이탈이 거기 모여 있다. 여기서 따로 부르면 그 셋 중
    // 하나가 빠진다.
    this._edAfterChange();
  },

  // ── 창의 재조정 (FR-EDT-42·43 / D-14) ──

  _edMkWindow(root){
    // FR-EDT-42(2)·55: `layout:null` 로 태어난다. pane 이 **없는** 것이지 빈
    // pane 이 있는 것이 아니다. 이 창이 살아남는 근거는 FR-EDT-49 의 필터다.
    return {id:newEntityId(),name:this._edName(root),type:WINDOW_TYPE_EDITOR,
      editor:{root},layout:null};
  },

  /**
   * FR-EDT-42: 창의 생성·소멸은 **멱등한 재조정**이다.
   *
   * 창을 만드는 주체는 브라우저인데(§2.3) 목록 변경은 SSE 로 모든 브라우저에
   * 도달한다. 게이팅이 없으면 브라우저 수만큼 같은 루트의 창이 생기고, 단일
   * 실행자 지명은 `POST /api/commands` 경로에만 있어 여기 쓸 수 없다. 그래서
   * **결정론적 중복 제거**가 그 자리를 대신한다 — 어느 브라우저가 먼저 쓰든
   * 수렴하는 값이 같다 (D-14).
   *
   * 바뀐 창 수를 돌려준다. 저장은 호출자가 한다 (`_migrateGitWindow` 와 같은 규약).
   */
  _edReconcile(list){
    if(!this._edOn()) return 0;
    this._edMirror();
    const ws=list||this.ws.windows;
    if(!Array.isArray(ws)) return 0;
    const want=this._edRoots();
    const wantSet=new Set(want);
    const keep=new Map(),drop=new Set();
    for(const s of ws){
      if(!this._isEditorWin(s)) continue;
      const root=this._edRootOf(s);
      // ③ 집합에 없는 루트의 창은 지운다.
      if(!root||!wantSet.has(root)){drop.add(s);continue}
      const cur=keep.get(root);
      if(!cur){keep.set(root,s);continue}
      // ④ 같은 루트가 둘이면 id 사전순으로 앞선 하나만 남긴다.
      if(s.id<cur.id){keep.set(root,s);drop.add(cur)} else drop.add(s);
    }
    let n=0;
    // WORKBENCH_REVIEW_SRS FR-WBR-40: **저장하지 않은 편집이 있는 창은 지우지
    // 않는다.**
    //
    //   이전 동작: 루트가 목록에서 빠지면 창을 통째로 splice 했다. 그 순간 탭
    //             id 가 사라져 렌더러의 회수기가 편집기를 파괴하고
    //             `_edDocDrop` 이 모델까지 dispose 한다 — 편집이 **묻지도
    //             알리지도 않고** 사라졌다
    //   새  동작: dirty 인 편집기가 있으면 그 창을 남긴다
    //   이유:     탭을 닫을 때는 이미 묻고 있다 (`app-layout` 의 dirty 가드).
    //             같은 손실을 다른 길에서 조용히 낼 이유가 없다
    //
    // **묻지 않는 이유는 NFR-WBR-3 이다** — 재조정은 SSE 로 아무 때나 불리는
    // 비동기 반영이라 사용자의 답을 기다리는 동안 화면과 워크스페이스가 어긋난 채
    // 멈춘다. **조용히 저장하지 않는 이유는 NFR-WBR-4** — 버리려던 내용이 디스크에
    // 남는다. 그래서 미룬다: 저장하거나 되돌리면 다음 재조정이 거둔다 (FR-WBR-42).
    const held=[];
    for(const s of drop) if(this._edWinDirty(s)) held.push(s);
    for(const s of held) drop.delete(s);
    for(let i=ws.length-1;i>=0;i--) if(drop.has(ws[i])){ws.splice(i,1);n++}
    // FR-WBR-41: 목록과 창이 어긋난 채 남으므로 그 이유가 화면에 없으면 "지웠는데
    // 안 지워진다" 가 된다. 같은 창을 두고 되풀이해 알리지는 않는다.
    if(held.length) this._edNotifyHeld(held);
    // 미룰 것이 없어지면 다음에 다시 알릴 수 있어야 한다.
    else this._edHeldKey='';
    // ② 집합에 있는데 창이 없으면 만든다.
    for(const root of want){
      if(keep.has(root)) continue;
      ws.push(this._edMkWindow(root));
      n++;
    }
    // 이름은 루트에서 파생된다 — 홈이 바뀌면 root 창의 이름도 따라간다 (FR-EDT-17).
    for(const[root,s] of keep){const nm=this._edName(root);if(s.name!==nm){s.name=nm;n++}}
    this._edReapTrees(ws);
    // REPO_TAB_UNIFY_SRS FR-RTU-63: Git 패널도 창의 것이다 — 탐색기와 같은
    // 자리에서 거둔다. 재조정은 창이 사라지는 것을 아는 유일한 자리이므로,
    // 여기서 빠지면 볼 사람이 없는 패널이 Monaco 를 든 채 남는다.
    this._gitPanelReap();
    return n;
  },

  /**
   * FR-WBR-40: 이 Editor 창 안에 **저장하지 않은 편집**이 있는가.
   *
   * 편집기 Map 의 키는 복합키이므로(FR-WSL-75) 탭 id 로 판정한다 — 같은 탭이 두
   * 칸에 보이면 인스턴스가 둘이고, 그중 하나만 dirty 여도 잃을 것이 있다.
   * `_dirty` 는 뷰가 아니라 **문서**의 것이다 (`file-editor.js` 의 접근자).
   */
  _edWinDirty(s){
    if(!s||!s.layout||!this.fileEditors) return false;
    const ids=new Set();
    for(const pn of this._flattenPanes(s.layout))
      for(const t of (pn.tabs||[])) if(t&&t.type==='editor') ids.add(t.id);
    if(!ids.size) return false;
    for(const[k,v] of this.fileEditors)
      if(v&&v._dirty&&ids.has(this._slotBase(k))) return true;
    return false;
  },

  // FR-WBR-41: 미룬 사실을 알린다. 창 이름을 밝힌다 — 개수만 말하면 어느 것을
  // 정리해야 하는지 알 수 없다 (FR-EDT-84 와 같은 근거).
  _edNotifyHeld(held){
    const names=held.map(s=>s&&s.name).filter(Boolean);
    if(!names.length||!this._notify) return;
    const key=names.slice().sort().join('\u0001');
    // 재조정은 되풀이해 불린다 — 같은 창을 두고 매번 알리면 그것이 소음이다.
    if(this._edHeldKey===key) return;
    this._edHeldKey=key;
    this._notify(EDITOR_HELD_DIRTY.replace('%s',names.join(', ')));
  },

  /**
   * 사라진 창의 탐색기를 거둔다.
   *
   * **회수의 자리는 재조정이다.** 예전에는 `_edTree(s)` 안에서만 거뒀는데, 그
   * 함수는 **활성 Editor 창을 그릴 때만** 불린다 — 일반 창에 있는 동안 Editor
   * 행을 지우면 그 창의 트리와 분리된 DOM 이 다음에 아무 Editor 창이나
   * 활성화될 때까지 `_edTrees` 에 남았다. 재조정은 창이 사라지는 것을 아는
   * 유일한 자리이므로 여기가 맞다.
   */
  _edReapTrees(ws){
    if(!this._edTrees||!this._edTrees.size) return;
    const alive=new Set((ws||this.ws.windows||[]).map(s=>s&&s.id).filter(Boolean));
    const n=this.slotCount();
    for(const[key,t] of this._edTrees){
      // FR-SVS-24: 키는 복합키다 — 창 id 와 칸을 갈라 본다.
      const id=this._slotBase(key);
      // FR-SVS-23: 창이 사라졌거나 그 칸 자체가 사라졌으면 시선을 거둔다.
      if(alive.has(id)&&this._slotOf(key)<n) continue;
      t.destroy();
      this._edTrees.delete(key);
      if(this._edLastActive===id&&!this._edTrees.has(id)) this._edLastActive=null;
    }
  },

  // ── 편집기 탭 마이그레이션 (FR-EDT-103~106 / D-19) ──

  /**
   * FR-EDT-103·104: 일반 창에 남은 `type==='editor'` 탭을 제거한다.
   *
   * **`clean()` 에 넣지 않는다** — `clean` 은 편집기 탭을 보존하도록 만들어져
   * 있고(§2.9) 시그니처가 창 타입을 알지 못한다. 창을 순회하는 자리인
   * `_migrateGitWindow` 옆이 그 자리다 (D-19).
   *
   * 확인창은 띄우지 않는다 (D-9) — 로드 시점이라 확인이 걸릴 자리가 아니고,
   * 파일 자체는 디스크에 그대로 있다.
   */
  _migrateEditorTabs(list){
    if(!this._edOn()) return 0;
    const ws=list||this.ws.windows;
    if(!Array.isArray(ws)) return 0;
    let n=0;
    for(const s of ws){
      if(!s||!s.layout) continue;
      if(this._isEditorWin(s)||this._isGitWin(s)) continue;
      const panes=[];this._collectPanes(s.layout,panes);
      for(const p of panes){
        const before=(p.tabs||[]).length;
        p.tabs=(p.tabs||[]).filter(t=>!t||t.type!=='editor');
        n+=before-p.tabs.length;
        if(!p.tabs.find(t=>t.id===p.activeTab)) p.activeTab=p.tabs.length?p.tabs[0].id:null;
      }
      // FR-EDT-105: 탭이 0이 된 pane 은 붕괴 규약대로 사라지고, layout 이 빈
      // 일반 창도 사라진다 (호출처의 필터가 거둔다).
      for(const p of panes) if(!p.tabs.length) s.layout=doRemove(s.layout,p.id);
    }
    return n;
  },

  // ── 탭 ↔ 창 (FR-EDT-7·9) ──

  // FR-EDT-7: Editor 탭을 고르면 마지막으로 활성이었던 Editor 창으로 간다.
  // 그런 창이 없으면 root 에디터 창이다 (`_gitBackTarget` 과 같은 모양).
  _edActivateTarget(){
    const wins=this._edWindows();
    return wins.find(s=>s.id===this._lastEditorWindow)
      ||this._edWindowFor(this._edHome())||wins[0]||null;
  },
  _edOpenWindow(root){
    const w=this._edWindowFor(root);
    if(w) this.switchWindow(w.id);
  },

  // ── 탐색기 (FR-EDT-57~68) ──

  /**
   * 창별 탐색기 인스턴스. 렌더러의 마운트 자리가 이것을 부른다.
   *
   * **렌더러가 소유하지 않는다.** `_rLayout` 은 매 render 마다 `.ed-win` 을 지우고
   * 다시 만드는데, 트리를 거기서 만들면 SSE 한 번에 펼침·선택·스크롤이 사라진다
   * (FR-EDT-66). `fileEditors` 와 같은 규약이다 — 인스턴스는 app 이 쥐고 요소만
   * 옮겨 붙는다.
   */
  // ── 문서 (SLOT_VIEW_STATE_SRS 묶음 E / FR-SVS-50~55) ──

  /**
   * FR-SVS-50: 편집 중인 파일의 **문서는 하나**다. 내용(Monaco 모델)과 dirty 는
   * 문서의 것이며 칸의 것이 아니다.
   *
   * 단위는 **파일 경로**다 (D-7) — 탭이 아니다. 같은 파일이 두 탭에 열릴 수 있는
   * 한, 탭 단위 문서는 한쪽 저장이 다른 쪽을 덮는 같은 손실을 다시 만든다.
   *
   * 슬롯이 생긴 뒤로 `FileEditor` 는 이미 칸마다 섰다 (`_slotKey`). 그런데 내용과
   * dirty 를 그 뷰가 소유했으므로, 같은 파일을 두 칸에 열면 독립 편집기 둘이 같은
   * 파일을 각자 편집하고 한쪽 저장이 다른 쪽 저장에 덮였다.
   */
  _edDoc(filePath){
    if(!this._edDocs) this._edDocs=new Map();
    let d=this._edDocs.get(filePath);
    if(!d){
      // `model` 은 첫 뷰가 내용을 받아 온 뒤에 채운다 — 문서의 자리를 먼저 잡아야
      // 두 번째 뷰가 "이미 누가 열어 두었다" 를 알 수 있다.
      d={model:null,dirty:false,saving:false,views:new Set()};
      this._edDocs.set(filePath,d);
    }
    return d;
  },

  // FR-SVS-55: 그 파일을 보는 칸이 하나도 남지 않으면 문서를 거둔다. 칸이 줄어도
  // 다른 칸이 보고 있으면 내용은 남는다 — 편집 중이던 것이 칸 정리로 사라지면
  // 그것이 결함이다.
  _edDocDrop(filePath,view){
    const d=this._edDocs&&this._edDocs.get(filePath);
    if(!d) return;
    d.views.delete(view);
    if(d.views.size) return;
    if(d.model){try{d.model.dispose()}catch{}}
    this._edDocs.delete(filePath);
  },

  /**
   * FR-SVS-20: 탐색기의 **관측**은 루트마다 하나다. 창이 아니라 루트가 단위인
   * 이유는 두 Editor 창이 같은 루트를 볼 때 요청이 두 벌이 될 이유가 없기
   * 때문이다 (D-5). 마지막 뷰가 떠날 때 store 가 스스로 이 맵에서 빠진다.
   */
  _edStore(root){
    if(!this._edStores) this._edStores=new Map();
    let st=this._edStores.get(root);
    if(!st){st=new FileTreeStore(this,root);this._edStores.set(root,st)}
    return st;
  },

  /**
   * FR-SVS-21·24: 탐색기의 **시선**은 칸마다 하나다. 키가 `_slotKey` 를 지나므로
   * 칸 0 의 키는 창 id **그대로**다 (FR-WSL-75 와 같은 이유).
   *
   * 두 칸이 같은 Editor 창을 볼 때 예전에는 `mount()` 가 같은 요소를 돌려주어
   * 뒤에 그린 칸이 앞 칸에서 탐색기를 **떼어 갔다** — 앞 칸의 탐색기 자리가 비는
   * 것이 접수된 결함의 절반이었다.
   */
  _edTree(s,slot){
    if(!this._edTrees) this._edTrees=new Map();
    // 회수의 주 자리는 `_edReapTrees`(재조정)다. 여기서 한 번 더 부르는 것은
    // 재조정을 지나지 않는 경로로 창이 사라졌을 때의 그물이다.
    this._edReapTrees();
    const key=this._slotKey(s.id,slot||0);
    let t=this._edTrees.get(key);
    if(t&&t.root!==this._edRootOf(s)){t.destroy();t=null}
    if(!t){t=new FileTree(this,s);this._edTrees.set(key,t)}
    // FR-EDT-78: 창 활성화가 즉시 갱신의 계기 하나다. 여기가 그 사실을 아는
    // 유일한 자리다 — 마운트는 활성 창에만 일어난다. 관측이 공유되므로 어느
    // 칸에서 부르든 요청은 한 벌이고, 결과는 모든 칸에 칠해진다 (FR-SVS-22).
    // FR-FSL-7 과 같은 짝: 활성화는 색과 목록 **둘 다**의 계기다. 색만 새로
    // 받으면 사용자는 창을 바꾸자마자 "색은 맞는데 목록은 옛것" 을 본다.
    // FR-DIR-32: 활성화는 사용자가 방금 한 일이다 — 백오프를 넘겨 곧바로 묻는다.
    if(this._edLastActive!==s.id){this._edLastActive=s.id;t.pollGit({now:true});t.pollStamp()}
    return t;
  },

  // FR-EDT-76: 폴링의 대상은 **활성 Editor 창 하나**다. 비활성 창의 트리는 살아
  // 있어도 git 을 부르지 않는다 (FR-GIT-24 와 같은 근거).
  /**
   * FR-SVS-21: 그 창의 탐색기 중 **포커스 칸의 것**. 펼침·드러내기는 시선이므로
   * 사용자가 있는 칸에만 일어난다 — 다른 칸의 펼침을 앱이 임의로 바꾸지 않는다.
   */
  _edTreeFor(w){
    if(!w||!this._edTrees) return null;
    return this._edTrees.get(this._slotKey(w.id,this._slotFocused()))
      ||this._edTrees.get(w.id)||null;
  },

  // 관측이 루트마다 하나이므로 **어느 칸의 뷰를 통해 불러도** 요청은 한 벌이고
  // 결과는 모든 칸에 칠해진다 (FR-SVS-20·22). 포커스 칸의 것을 고르고, 없으면
  // 그 창을 보는 아무 칸의 것을 쓴다.
  _edActiveTree(){
    const s=this._aw();
    if(!this._isEditorWin(s)||!this._edTrees) return null;
    // FR-RTU-12·14: 사이드가 `Changes` 면 탐색기는 화면에 없다 — `_edVisibleTrees`
    // 와 같은 게이트다. 이 자리가 빠지면 즉시 신호(`_gitSignal`)마다 보이지도
    // 않는 트리의 status 가 한 건 더 나가 디바운스가 무의미해진다 (V5 실측).
    if(this._edSideOf(s)!==REPO_SIDE_EXPLORER) return null;
    const mine=this._edTrees.get(this._slotKey(s.id,this._slotFocused()));
    if(mine) return mine;
    for(const[key,t] of this._edTrees) if(this._slotBase(key)===s.id) return t;
    return null;
  },

  /**
   * SLOT_VIEW_STATE_SRS FR-SVS-39b: **화면에 있는 탐색기 전부.**
   *
   * `_edActiveTree` 는 활성 창의 것 하나를 준다. 그것으로 폴링하면 칸 둘에 Editor
   * 창을 놓았을 때 서 있지 않은 쪽이 멎는다 — Git 쪽과 같은 결함이며 같은 근거로
   * 고친다 (FR-SVS-36).
   *
   * 요청이 늘지 않는 이유는 관측이 **루트마다** 하나이고 캐시 TTL·single-flight 가
   * 그 위에 있기 때문이다 (FR-EDT-77) — 두 칸이 같은 루트를 보아도 git 실행은
   * 한 번이다.
   */
  _edVisibleTrees(){
    if(!this._edTrees) return [];
    const out=[];
    for(const [key,t] of this._edTrees){
      if(!t) continue;
      const id=this._slotBase(key);
      if(!this._windowVisible(id)) continue;
      /**
       * REPO_TAB_UNIFY_SRS FR-RTU-12·14: **사이드가 Explorer 일 때만** 묻는다.
       *
       * 창이 보이는 것과 탐색기가 보이는 것이 이제 다르다 — 사이드는 탭 교체이고
       * `Changes` 쪽에 있으면 트리는 화면에 없다. 트리 객체는 그때도 살아 있으므로
       * (돌아왔을 때 펼침·스크롤이 남아야 한다, FR-EDT-66) 목록에서만 뺀다.
       *
       * 실측: 이 게이트가 없으면 `Changes` 사이드에서도 3초마다 status·stamp 가
       * 나가 "폴링을 껐는데 status 가 온다" 가 됐다 (V18).
       */
      const w=this.ws.windows.find(x=>x&&x.id===id);
      if(this._isEditorWin(w)&&this._edSideOf(w)!==REPO_SIDE_EXPLORER) continue;
      out.push(t);
    }
    return out;
  },

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
    if(this._edGitInterval) clearInterval(this._edGitInterval);
    this._edGitInterval=setInterval(()=>{
      if(document.hidden) return;
      for(const t of this._edVisibleTrees()){ t.pollGit(); t.pollStamp() }
    },EDITOR_GIT_POLL_MS);
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
    if(!this._isEditorWin(cur)) return;
    const root=this._edRootOf(cur);
    if(!root) return;
    const next=sv.windows.find(s=>this._isEditorWin(s)&&this._edRootOf(s)===root);
    if(!next) return;
    sv.activeWindow=next.id;
    /**
     * **sessionStorage 도 함께 옮긴다.** 그 값이 새로고침을 건너는 유일한 근거이고
     * (`activeWindow` 는 PUT 에서 걸러진다, `_save`), 여기서 갱신하지 않으면 새
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
  _edPinTabFor(filePath){
    const found=filePath&&this._findEditorTab(filePath);
    if(found) this._pinPreviewTab(found.tab);
  },

  // ── 사이드의 활성 탭 (REPO_TAB_UNIFY_SRS FR-RTU-12·13) ──

  // 폭과 같은 규약으로 **워크스페이스**에 산다 — 창마다 따로이고 새로고침을
  // 넘는다. 모르는 값은 기본으로 떨어뜨린다 (옛 워크스페이스에는 이 키가 없다).
  _edSideOf(s){
    const v=s&&s.editor&&s.editor.side;
    return REPO_SIDE_TABS.some(d=>d.id===v)?v:REPO_SIDE_DEFAULT;
  },

  _edSetSide(s,id){
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
    this._save();
  },

  // ── 탐색기 폭 (FR-EDT-47 / D-18) ──

  _edExplorerWidth(s){
    const w=parseInt((s&&s.editor&&s.editor.explorerWidth),10);
    if(!Number.isFinite(w)) return EDITOR_EXPLORER_W_DEFAULT;
    return Math.max(EDITOR_EXPLORER_W_MIN,Math.min(EDITOR_EXPLORER_W_MAX,w));
  },
  // 폭은 **워크스페이스**에 산다 — `sidebarWidth` 가 그렇다 (§2.10). 창마다
  // 따로 기억되므로 창 레코드에 붙인다.
  _edSetExplorerWidth(s,w){
    if(!s) return;
    const v=Math.max(EDITOR_EXPLORER_W_MIN,Math.min(EDITOR_EXPLORER_W_MAX,Math.round(w)));
    if(!s.editor) s.editor={};
    if(s.editor.explorerWidth===v) return;
    s.editor.explorerWidth=v;
    this._save();
  },

  // ── 파일 열기 라우팅 (FR-EDT-94~102) ──

  // 경로가 루트 아래인가. 루트 자신도 포함이다. `startsWith(root)` 만으로는
  // `/a/bc` 가 `/a/b` 아래로 잡히므로 구분자까지 함께 본다.
  _edUnder(root,p){
    if(!root||!p) return false;
    if(p===root) return true;
    return p.startsWith(root==='/'?'/':root+'/');
  },

  /**
   * FR-EDT-95: **연결된 Editor** 는 그 절대경로를 자기 루트 아래에 포함하는 창이다.
   *
   * 둘 이상이면 **루트가 가장 깊은** 것이 이긴다 — 가장 구체적인 것이 이긴다.
   * 중첩된 Editor 둘이 있을 때 얕은 쪽이 이기면, 사용자가 좁혀 두려고 만든 행이
   * 한 번도 쓰이지 않는다.
   */
  _edLinkedWindow(p){
    let best=null,blen=-1;
    for(const s of this._edWindows()){
      const root=this._edRootOf(s);
      if(!this._edUnder(root,p)) continue;
      if(root.length>blen){best=s;blen=root.length}
    }
    return best;
  },

  // FR-EDT-100: 대상 창의 `focusedPane` → `firstPane` → 없으면 새로 만든다.
  // `this.focused` 를 쓰지 않는다 — 대상 창이 비활성일 수 있다 (`_gitPaneOf`).
  _edEnsurePane(w){
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

  /**
   * FR-EDT-94·96: 편집기 탭은 Editor 창에서만 열린다.
   *
   * 대상 창을 고르는 기준은 **`opts.anchor`** 이고 없으면 파일 경로 자신이다
   * (FR-EDT-96). Git 의 Open File 만 그것을 달리 준다 — 파일이 아니라 **활성 리포
   * 경로**로 골라야 하기 때문이다 (FR-EDT-97·98). 연결된 Editor 가 없으면 root
   * 에디터로 간다. 그 창의 탐색기가 파일을 가리키지 못하는 것은 정상이다
   * (FR-EDT-99) — 탐색기는 루트의 트리이지 열린 탭의 목록이 아니다.
   */
  async _edOpenFile(filePath,opts){
    if(!filePath||!this._edOn()) return null;
    // FR-EDT-101: 이미 열려 있으면 **그 탭이 있는 창**이 대상이다. 폴백 창의
    // pane 을 먼저 만들면 탭은 원래 창으로 가고 빈 pane 만 남는다 (FR-EDT-52).
    const open=this._findEditorTab(filePath);
    const anchor=(opts||{}).anchor||filePath;
    const w=(open&&this._isEditorWin(open.win))?open.win
      :(this._edLinkedWindow(anchor)||this._edWindowFor(this._edHome()));
    if(!w) return null;
    const rid=(open&&open.win===w)?open.pane.id:this._edEnsurePane(w);
    if(!rid) return null;
    // addTab 의 editor 분기가 중복 방지와 refresh 를 이미 한다.
    // FR-RTU-40: `preview` 는 그대로 넘긴다 — 미리보기 탭을 만들지 대체할지는
    // addTab 한 자리가 정한다.
    await this.addTab(rid,'editor',
      {filePath,name:(opts||{}).name,windowId:w.id,preview:!!(opts||{}).preview});
    // FR-EDT-102: 열면 그 창으로 전환된다. 열었는데 보이지 않으면 사용자는
    // 실패로 읽는다. 사이드바 탭은 FR-EDT-8 로 따라온다.
    this.switchWindow(w.id);
    // FR-EGS-10: 검색 결과로 열렸으면 그 줄로 간다. 이미 열려 있던 탭이어도
    // 옮긴다 — 사용자가 고른 것은 파일이 아니라 그 줄이다.
    const ln=(opts||{}).line;
    if(ln){
      const t=this._findEditorTab(filePath);
      const v=t&&this.fileEditors.get(t.tab.id);
      if(v&&v.revealLine) v.revealLine(ln,(opts||{}).col);
    }
    // 연 파일이 **탐색기에서도** 보이게 한다. 파일 검색·전체 검색으로 열면 그
    // 파일이 트리 어디에 있는지가 답의 일부인데, 탐색기를 그대로 두면 사용자가
    // 경로를 눈으로 따라가며 폴더를 하나씩 펼쳐야 한다. 여는 경로가 여럿이므로
    // (검색 둘·git 변경파일·dmctl open) 각 부름터가 아니라 이 자리에 둔다.
    const tree=this._edTreeFor(w);
    if(tree&&tree.revealPath) tree.revealPath(filePath);
    return w.id;
  },

  // ── 파일 조작의 뒷단 (FR-EDT-79~93) ──

  /**
   * 조작 종단 셋의 단일 호출 자리. 실패는 **코드와 사람의 말**로 돌려준다
   * (FR-EDT-92·117).
   *
   * 던지지 않는다 — 호출자는 실패에서 낙관적 반영을 되돌려야 하므로 흐름이
   * 갈리는 것이 아니라 값이 갈려야 한다.
   */
  async _edFs(url,body){
    let r=null,d=null;
    try{
      r=await fetch(url,{method:'POST',
        headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    }catch{r=null}
    if(!r) return {ok:false,code:'',msg:EDITOR_FS_ERR_UNKNOWN};
    try{d=await r.json()}catch{d=null}
    if(r.ok&&d&&d.ok) return {ok:true,code:'',msg:''};
    const code=(d&&d.code)||'';
    return {ok:false,code,msg:EDITOR_FS_ERR_MSG[code]||(d&&d.message)||EDITOR_FS_ERR_UNKNOWN};
  },

  /**
   * FR-EDT-83 의 "그 안의 항목 수". 근거는 `list` 뿐이다 — 서버에 세는 종단이
   * 없다 (FR-EDT-108 은 크기도 수도 주지 않는다).
   *
   * 링크는 따라가지 않는다 (`dir` 은 Lstat 기준이라 링크는 언제나 false 다) —
   * 따라가면 링크 밖의 항목을 지운다고 말하는 것이 된다. 세지 못한 가지나 상한
   * 초과는 `more` 로 알린다: 정확한 수보다 **모른다는 사실**이 중요하다.
   */
  async _edCountTree(root,dir){
    const q=[dir]; let n=0,more=false;
    while(q.length){
      const d=q.shift();
      let r=null,j=null;
      const u=FS_LIST_API+'?root='+encodeURIComponent(root)+'&path='+encodeURIComponent(d);
      try{r=await fetch(u)}catch{r=null}
      if(r&&r.ok){try{j=await r.json()}catch{j=null}}
      if(!j||!Array.isArray(j.entries)){more=true;continue}
      n+=j.entries.length;
      if(j.truncated) more=true;
      for(const e of j.entries){
        if(e&&e.dir&&!e.link) q.push(d==='/'?'/'+e.name:d+'/'+e.name);
      }
      if(n>=EDITOR_DEL_COUNT_MAX){more=true;break}
    }
    return {n,more};
  },

  // 경로 아래의 편집기 탭 — 자신과 하위 전부다. 이름 변경·삭제가 폴더면 그
  // 아래의 탭이 전부 대상이므로 판정을 여기 하나에 둔다 (FR-EDT-90·91).
  _edTabsUnder(p){
    const out=[];
    if(!p) return out;
    const pre=p==='/'?'/':p+'/';
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
  _edDirtyUnder(p){
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
  _edRetargetTabs(from,to){
    const list=this._edTabsUnder(from);
    if(!list.length) return 0;
    for(const {tab} of list){
      const np=tab.filePath===from?to:to+tab.filePath.slice(from.length);
      tab.filePath=np;
      tab.name=np.split('/').pop()||tab.name;
      const ed=this.fileEditors.get(tab.id);
      if(ed){ed.filePath=np;ed.name=tab.name}
    }
    this.render();
    this._save();
    return list.length;
  },

  /**
   * FR-EDT-91: 삭제되면 그 탭을 닫는다. 폴더면 그 아래 전부.
   *
   * `force` 로 dirty 확인을 건너뛴다 — 그 사실은 삭제 확인창이 이미 밝혔다
   * (FR-EDT-84). 여기서 다시 물으면 사용자가 이미 승낙한 것을 두 번 묻는 것이고,
   * 취소해도 파일은 이미 없다.
   */
  async _edCloseTabsUnder(p){
    const list=this._edTabsUnder(p);
    for(const x of list) await this.closeTab(x.pane.id,x.tab.id,x.win.id,{force:true});
    return list.length;
  },

  /**
   * FR-EDT-83: 파괴적 확인. `_confirmClose` 와 같은 껍데기를 쓰되 **문자열이 아니라
   * 줄의 배열**을 받는다 — 파일 이름이 그대로 들어가는 자리라 innerHTML 로 조립할
   * 수 없다.
   *
   * 기본 선택지는 안전한 쪽이다 (FR-GIT-97 과 같은 규약) — 초기 포커스가 취소이고
   * `Enter`·`Esc`·바깥 클릭이 모두 취소다.
   */
  _edConfirm(lines,okLabel){
    return new Promise(resolve=>{
      const ov=document.createElement('div');
      ov.className='confirm-overlay ed-confirm';
      const box=document.createElement('div'); box.className='confirm-box';
      const msg=document.createElement('div'); msg.className='confirm-msg';
      for(const t of lines){
        const l=document.createElement('div'); l.className='ed-confirm-line';
        l.textContent=t; msg.appendChild(l);
      }
      const btns=document.createElement('div'); btns.className='confirm-btns';
      const ok=document.createElement('button'); ok.className='confirm-ok'; ok.textContent=okLabel;
      const no=document.createElement('button'); no.className='confirm-cancel'; no.textContent=EDITOR_DEL_CANCEL;
      btns.appendChild(ok); btns.appendChild(no);
      box.appendChild(msg); box.appendChild(btns); ov.appendChild(box);
      document.body.appendChild(ov);
      const done=v=>{ov.remove();document.removeEventListener('keydown',onKey,true);resolve(v)};
      const onKey=e=>{
        if(e.key==='Escape'){e.preventDefault();e.stopPropagation();done(false)}
      };
      document.addEventListener('keydown',onKey,true);
      ok.addEventListener('click',()=>done(true));
      no.addEventListener('click',()=>done(false));
      ov.addEventListener('click',e=>{if(e.target===ov)done(false)});
      no.focus();
    });
  },

  // FR-EDT-83·84 의 문장을 조립하는 한 자리. 폴더면 재귀와 항목 수를, dirty 탭이
  // 있으면 그 사실을 밝힌다.
  _edConfirmDelete(path,isDir,count,dirty){
    const name=path.split('/').pop()||path;
    const lines=[];
    if(isDir){
      const n=count&&count.more
        ?EDITOR_DEL_COUNT_MORE.replace('%n',(count&&count.n)||0)
        :String((count&&count.n)||0);
      lines.push(EDITOR_DEL_DIR.replace('%s',name).replace('%n',n));
    }else{
      lines.push(EDITOR_DEL_FILE.replace('%s',name));
    }
    lines.push(EDITOR_DEL_PERMANENT);
    if(dirty&&dirty.length){
      lines.push(EDITOR_DEL_DIRTY.replace('%n',dirty.length).replace('%s',dirty.join(', ')));
    }
    return this._edConfirm(lines,EDITOR_DEL_OK);
  },

  // ── 목록 조작 (FR-EDT-12·25·26·27·28) ──

  // 진입점은 정적 요소이므로 리스너는 여기서 한 번만 붙인다 (`_initGitSection`
  // 과 같은 모양). **목록**에는 폴링이 없다 — 변경 계기가 SSE 와 자기 조작뿐이다.
  // 여기서 거는 폴링은 탐색기의 git 색이며 대상이 다르다 (FR-EDT-77).
  _initEditorSection(){
    // FR-RTU-5: 진입점은 하나다 — 이 한 번이 목록과 핀을 함께 만든다 (연동).
    const add=document.getElementById(REPO_ADD_ID);
    if(add) add.addEventListener('click',()=>this._edAdd());
    this._edStartGitPoll();
  },

  // FR-EDT-28: `+ Add` 는 지금 터미널의 cwd 를 미리 채운다. 얻지 못하면 빈 칸으로
  // 연다 (`_gitRepoAt` 와 같은 규약).
  async _edTermCwd(){
    const tool=this._gitTermToolId();
    if(!tool) return '';
    let r=null,d=null;
    try{r=await fetch('/api/cwd?tool='+encodeURIComponent(tool))}catch{return ''}
    if(!r||!r.ok) return '';
    try{d=await r.json()}catch{return ''}
    // FR-ETR-33: `source` 를 읽는다. 이 필드는 FR-FTR-7 이 **정확히 이 문제
    // 때문에** 넣은 것인데, 여기가 그것을 읽지 않아 서버 프로세스의 cwd 가
    // 사용자의 경로로 채워지고 있었다 (§2.4).
    if(!d||d.source!==GIT_CWD_SOURCE_TOOL) return '';
    return d.cwd||'';
  },

  async _edAdd(){
    const here=await this._edTermCwd();
    return GitDialog.open({
      id:'editor-add-dlg',ns:'eda',action:'editor_add',
      title:EDITOR_ADD_TITLE,runLabel:EDITOR_ADD_RUN,focus:'path',
      body:here?EDITOR_ADD_HERE.replace('%s',here):EDITOR_ADD_NO_TERM,
      fields:[
        {key:'path',type:GIT_DIALOG_TEXT,cls:'eda-path',value:here,
         placeholder:EDITOR_ADD_PROMPT},
      ],
      validate:v=>(v.path||'').trim()?'':EDITOR_ADD_NEED_PATH,
      run:async v=>{
        const ok=await this._edMutate('/add',{path:(v.path||'').trim()});
        return ok?{ok:true}:{ok:false,reason:EDITOR_ADD_FAIL};
      },
    });
  },

  // FR-EDT-26: 제거는 문자열 완전 일치다 — 경로를 다시 정규화하지 않는다.
  // 사라진 디렉터리의 행도 지울 수 있어야 한다.
  async _edRemove(path){
    if(!path) return false;
    return this._edMutate('/remove',{path});
  },

  // FR-EDT-27: 재정렬은 전체 배열이 아니라 (src, target, before) 델타다 — 그
  // 사이에 다른 창이 행을 더했을 때 전체를 보내면 그것을 조용히 지운다.
  async _edReorder(dr){
    if(!dr||!dr.src||!dr.target||dr.src===dr.target) return false;
    const path=k=>String(k||'').replace(/^ed:/,'');
    const ok=await this._edMutate('/reorder',
      {src:path(dr.src),target:path(dr.target),before:!!dr.before});
    // FR-BLP-12 와 같은 규약: 확정하지 못했으면 서버가 아는 순서로 되돌린다.
    if(!ok) await this._edRefresh();
    return ok;
  },

  /**
   * FR-EDT-20·39·43: 목록을 바꾸는 종단은 하나같이 새 목록을 돌려준다. 응답을
   * 로컬 사본에 반영하고 **그 직후 재조정을 돈다** — 행과 창은 한 상태의 두
   * 표현이므로 목록만 바뀌고 창이 그대로면 화면이 거짓을 말한다.
   */
  async _edMutate(sub,body){
    if(!this._edOn()) return false;
    let r=null,d=null;
    try{
      r=await fetch(EDITORS_API+sub,{method:'POST',
        headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    }catch{return false}
    if(!r.ok) return false;
    try{d=await r.json()}catch{d=null}
    if(!d) return false;
    // 응답에는 `home` 이 없다 (FR-EDT-110) — 알고 있는 값을 그대로 쓴다.
    this._edPatchList(d.list);
    // FR-EDT-39: 연동으로 핀이 함께 바뀐다. 응답이 실어 준 값을 로컬 사본에도
    // 반영해 둔다 — 다음 PUT 이 서버가 방금 만든 핀을 지우지 않게.
    if(Array.isArray(d.pinned)) this._gitPinsApply(d.pinned);
    this._edAfterChange();
    if(Array.isArray(d.pinned)&&this._gitReposRefresh) this._gitReposRefresh();
    return true;
  },

  async _edRefresh(){
    if(!await this._edLoad()){this.renderer._rSbTabs();return}
    this._edAfterChange();
  },

  // 재조정 → 활성 창 보정 → 저장 → 그리기. 목록이 바뀌는 모든 경로가 여기 하나를
  // 지난다 — 두 벌로 두면 한쪽만 고쳐진다.
  _edAfterChange(){
    this._edReconcile();
    this._save();
    // 보고 있던 Editor 창이 사라졌으면 남는 자리로 옮긴다. 옮기지 않으면
    // activeWindow 가 없는 창을 가리켜 콘텐츠 영역이 빈다.
    if(!this.ws.windows.some(s=>s.id===this.ws.activeWindow)){
      const back=this._edActivateTarget()||this._gitBackTarget();
      if(back){this.switchWindow(back.id);return}
    }
    this.render();
  },
});

/**
 * FR-EDT-78: 파일 저장은 색의 즉시 갱신 계기다.
 *
 * 그 신호의 진입점은 이미 하나 있고(`_gitSignal`, FR-GIT-18) `FileEditor.save` 가
 * 그것을 부른다. 두 번째 진입점을 만들면 저장 경로마다 어느 쪽을 불러야 하는지가
 * 갈리므로, 있는 자리에 **이어 붙인다** — Git 패널의 동작은 그대로다.
 *
 * app-git.js 뒤에 로드되므로(index.html) 여기서 감쌀 수 있다.
 */
(function(){
  const base=App.prototype._gitSignal;
  App.prototype._gitSignal=function(kind){
    base.call(this,kind);
    const t=this._edActiveTree();
    // FR-DIR-32: 저장·커밋 같은 즉시 신호도 백오프를 넘긴다.
    if(t) t.pollGit({now:true});
  };
})();
