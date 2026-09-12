/**
 * Dongminal — Editor 목록의 **서버 동기와 창 재조정** (FE_MODULE_BOUNDARY_SRS FR-FMB-20).
 *
 * 서버가 준 편집기 목록을 로컬 사본에 반영하고(`_edApplyServer`), 그 결과로 창을
 * 세우거나 지운다(`_edReconcile`). dirty 판정이 함께 있는 이유는 **지우기 전에
 * 물어야** 하기 때문이다 — 재조정이 그 답을 딛는다.
 */
Object.assign(App.prototype, {
  /**
   * FR-EDT-29·120: 목록을 받는다. 실패하면 `_edOff` 로 보고 탭 자체를 숨긴다.
   *
   * **워크스페이스를 처리하기 전에** 끝나야 한다 (app.js init) — 재조정과
   * 편집기 탭 마이그레이션이 둘 다 `home` 을 알아야 돌 수 있고, 모르면 둘 다
   * 돌지 않는 것이 옳다.
   */
  async _edLoad(){
    const res=await apiGet(EDITORS_API);
    const d=res.ok?res.data:null;
    if(!d||typeof d.home!=='string'||!d.home){
      this._edOff=true;this.editors=null;return false;
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
    this.editors={
      home:d.home,
      // FR-NOT-11: 없으면 빈 문자열이다 — 그때 사라지는 것은 메모장 행 하나이고
      // 나머지 표면은 그대로 선다.
      notes:(typeof d.notes==='string'&&d.notes)?d.notes:'',
      list:(Array.isArray(d.list)?d.list:[]).filter(p=>typeof p==='string'&&p),
    };
    this.edMirror();
  },

  /**
   * NOTES_LIVE_EXPLORER_SRS FR-NOT-13: **목록만** 갈아끼운다.
   *
   * `_edApplyServer` 는 서버가 준 것 전부를 반영하므로 `home`·`notes` 를 함께 받아야
   * 한다. 그런데 그것을 부르는 자리 셋(`_edApplyLinked`·`edMutate`·
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
    if(!this.editors) return;
    this._edApplyServer({home:this.editors.home,notes:this.editors.notes,list});
  },

  // 목록은 workspace.json 최상위 `editors.list` 에 산다 (FR-EDT-19). 서버가
  // 확정한 값을 로컬 사본에도 반영해 둔다 — 다음 `save()` 의 PUT 이 방금 만든
  // 행을 지우지 않게 (`_gitPinsApply` 와 같은 규약).
  edMirror(){
    if(!this.editors) return;
    if(!this.ws.editors) this.ws.editors={};
    this.ws.editors.list=this.editors.list.slice();
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
    if(!this.editors||!d||!Array.isArray(d.editors)) return;
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
    return {id:newEntityId(),name:this.edName(root),type:WINDOW_TYPE_EDITOR,
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
    if(!this.edOn()) return 0;
    this.edMirror();
    const ws=list||this.ws.windows;
    if(!Array.isArray(ws)) return 0;
    const want=this.edRoots();
    const wantSet=new Set(want);
    const keep=new Map(),drop=new Set();
    for(const s of ws){
      if(!this.isEditorWin(s)) continue;
      const root=this.edRootOf(s);
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
    //             `edDocDrop` 이 모델까지 dispose 한다 — 편집이 **묻지도
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
    for(const[root,s] of keep){const nm=this.edName(root);if(s.name!==nm){s.name=nm;n++}}
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
    if(!s||!s.layout) return false;
    // FR-RTU-103: Diff 의 편집도 이 창이 잃을 수 있는 것이다 — 탭 닫기와 같은
    // 근거다. 편집기가 하나도 없는 창이어도 Diff 가 dirty 일 수 있으므로,
    // fileEditors 를 보기 **전에** 묻는다.
    if(this._edWinGitDirty(s)) return true;
    if(!this.fileEditors) return false;
    const ids=new Set();
    for(const pn of this.flattenPanes(s.layout))
      for(const t of (pn.tabs||[])) if(t&&t.type==='editor') ids.add(t.id);
    if(!ids.size) return false;
    for(const[k,v] of this.fileEditors)
      if(v&&v._dirty&&ids.has(this.slotBase(k))) return true;
    return false;
  },

  // 이 창의 git 뷰 탭 중 저장하지 않은 편집을 든 것이 있는가 (FR-RTU-103).
  _edWinGitDirty(s){
    const root=this.edRootOf(s);
    for(const pn of this.flattenPanes(s.layout))
      for(const t of (pn.tabs||[]))
        if(t&&t.type===TAB_TYPE_GIT&&this._gitViewDirty(root,t.gitView)) return true;
    return false;
  },

  /**
   * UX_BATCH8_SRS FR-CLG-5: **이 앱 어딘가에 저장하지 않은 편집이 있는가.**
   *
   * 떠남 확인의 사유가 종전에는 도구 하나뿐이었다 (`main.js`). 도구가 없는
   * Editor 창만 열어 두고 새로고침하면 편집이 묻지도 알리지도 않고 사라진다 —
   * `_edWinDirty` 가 창 하나를 두고 답하는 물음을, 이것은 앱 전체를 두고 답한다.
   *
   * 문서가 공유되므로 같은 파일의 뷰가 여럿이면 여러 번 세어지는데, 재는 것이
   * "하나라도 있는가" 이므로 그것은 답을 바꾸지 않는다.
   */
  edAnyDirty(){
    if(!this.fileEditors) return false;
    for(const v of this.fileEditors.values()) if(v&&v._dirty) return true;
    return false;
  },

  /**
   * FR-CLG-2: 이 창의 dirty 편집기를 **모두** 저장한다.
   *
   * 같은 파일이 두 칸에 열려 있으면 뷰가 둘이고 문서는 하나다 (FR-SVS-50) — 뒤
   * 뷰의 `save()` 는 이미 저장된 문서를 두 번 쓴다. 탭 id 로 한 번만 부른다.
   *
   * 한 파일이 실패해도 나머지를 시도한다. 그 실패는 `save()` 가 이미 알리며,
   * 여기서 멈추면 저장할 수 있었던 것까지 잃는다.
   */
  /**
   * 이 창의 저장하지 않은 편집을 전부 저장한다. **하나라도 실패하면 거짓이다**
   * (EDITOR_EXTERNAL_CHANGE_SRS FR-EXC-13a).
   *
   *   이전 동작: 반환 없음 — 창 닫기가 결과를 모른 채 닫았다
   *   새  동작: 참/거짓
   *   이유:     경합으로 막힌 저장이 있는데 창이 닫히면 그 편집을 잃는다
   *
   * 실패해도 **나머지를 마저 시도한다** — 첫 실패에서 멈추면 저장할 수 있었던
   * 것까지 저장되지 않은 채 남는다.
   */
  async _edWinSaveDirty(s){
    if(!s||!s.layout) return true;
    // FR-RTU-103: Diff 의 편집도 함께 저장한다 — `_edWinDirty` 가 그것을 세었으므로
    // 여기서 빠뜨리면 "저장하고 닫기" 가 일부만 저장한다.
    const root=this.edRootOf(s);
    let ok=true;
    for(const pn of this.flattenPanes(s.layout))
      for(const t of (pn.tabs||[]))
        if(t&&t.type===TAB_TYPE_GIT&&!await this._gitViewSave(root,t.gitView)) ok=false;
    if(!this.fileEditors) return ok;
    const ids=new Set();
    for(const pn of this.flattenPanes(s.layout))
      for(const t of (pn.tabs||[])) if(t&&t.type==='editor') ids.add(t.id);
    const done=new Set();
    for(const[k,v] of this.fileEditors){
      const base=this.slotBase(k);
      if(!v||!v._dirty||!ids.has(base)||done.has(base)) continue;
      done.add(base);
      if(!await v.save()) ok=false;
    }
    return ok;
  },

  /**
   * `12-func-ui.md FUI-07`: **이 창의 저장하지 않은 편집을 전부 저장한다.**
   *
   * 동작 자체는 새로 만들지 않는다 — `_edWinSaveDirty` 가 이미 그것이고, 창 닫기
   * 확인창이 그 함수를 쓴다. 없던 것은 **진입점**뿐이었다.
   *
   * 결과를 말한다: 저장할 것이 없었는지, 전부 됐는지, 일부가 막혔는지.
   * `save()` 가 개별 실패를 이미 알리므로 여기서는 **묶음의 결말**만 적는다 —
   * 그것이 없으면 여러 파일 중 하나가 막혔을 때 사용자가 그 사실을 모른다.
   */
  async _edSaveAll(){
    const s=this.aw();
    if(!this.isEditorWin(s)) return;
    if(!this._edWinDirty(s)){ Toast.show(ED_SAVE_ALL_NONE,'ok'); return }
    const ok=await this._edWinSaveDirty(s);
    Toast.show(ok?ED_SAVE_ALL_OK:ED_SAVE_ALL_PARTIAL,ok?'ok':'err');
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
   * **회수의 자리는 재조정이다.** 예전에는 `edTree(s)` 안에서만 거뒀는데, 그
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
      const id=this.slotBase(key);
      // FR-SVS-23: 창이 사라졌거나 그 칸 자체가 사라졌으면 시선을 거둔다.
      if(alive.has(id)&&this._slotOf(key)<n) continue;
      t.destroy();
      this._edTrees.delete(key);
      if(this._edLastActive===id&&!this._edTrees.has(id)) this._edLastActive=null;
    }
  },

  // ── 편집기 탭 마이그레이션 (FR-EDT-103~106 / D-19) ──
});
