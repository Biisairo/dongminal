/**
 * Remote Terminal — 패널 좌우 도킹 (PANEL_DOCK_SRS).
 *
 * 앱 패널(사이드바·Activity)과 Repo 사이드의 자리를 읽고, 바꾸고, 화면에 싣는다.
 * 계산은 `panel-dock.js` 의 순수 함수가 하고, 드래그 배선은 `input-binding.js` 가 한다.
 */
Object.assign(App.prototype, {
  /**
   * 노드를 옮기지 않고 flex `order` 로 놓는다 — 옮기면 스크롤·포커스·진행 중인
   * 드래그를 잃는다. 모바일 제외(FR-PDK-15)는 CSS 의 `body:not(.mobile)` 가 맡는다.
   */
  panelDock(){return dockNormalize(PrefStore.local.json(STORE_KEYS.panelDock,null))},

  /**
   * FR-PDK-36: 바뀐 것이 없으면 아무것도 하지 않는다. 비교 대상은 **화면에 실린 값**이다.
   *   이전: 저장소 값과 비교했다 — 다른 탭이 저장소를 먼저 바꾸면 이 탭에서 같은 배치로
   *         다시 바꿔도 화면에 실리지 않았다 (사용자 보고 2026-11-10)
   */
  setPanelDock(s){
    const n=dockNormalize(s);
    if(this._dockShown&&dockEqual(n,this._dockShown)) return;
    PrefStore.local.setJson(STORE_KEYS.panelDock,n);
    this.applyPanelDock();
    this._dockRefit();
  },

  // FR-PDK-14: 자리가 바뀌면 보이는 터미널의 폭이 바뀐다.
  _dockRefit(){
    for(const p of this.tools.values()) if(p.el.classList.contains('vis')) p.doFit();
  },

  /**
   * 같은 브라우저의 다른 탭이 자리를 바꾸면 따라간다. 자리는 `localStorage` 에 살아
   * 탭끼리 함께 쓰므로, 따라가지 않으면 저장소와 화면이 어긋난 채 남는다.
   */
  watchPanelDock(){
    window.addEventListener('storage',e=>{
      if(e.key!==null&&e.key!==STORE_KEYS.panelDock&&e.key!==STORE_KEYS.repoSideDock) return;
      this.applyPanelDock();
      this._dockRefit();
    });
  },

  applyPanelDock(){
    const s=this.panelDock(), o=dockOrders(s), de=document.documentElement, st=de.style;
    this._dockShown=s;
    st.setProperty('--dock-sb-ord',String(o.sidebar.panel));
    st.setProperty('--dock-sb-h-ord',String(o.sidebar.handle));
    st.setProperty('--dock-ag-ord',String(o.activity.panel));
    st.setProperty('--dock-ag-h-ord',String(o.activity.handle));
    de.dataset.sbSide=dockSideOf(s,'sidebar');
    de.dataset.agSide=dockSideOf(s,'activity');
    de.dataset.repoSide=this.repoSideDock();
  },

  repoSideDock(){return repoSideNormalize(PrefStore.local.get(STORE_KEYS.repoSideDock))},

  setRepoSideDock(v){
    const n=repoSideNormalize(v);
    if(n===document.documentElement.dataset.repoSide) return;   // FR-PDK-36 — 화면에 실린 값과 비교한다
    PrefStore.local.set(STORE_KEYS.repoSideDock,n);
    this.applyPanelDock();
    this._dockRefit();
  },
});
