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

  setPanelDock(s){
    const n=dockNormalize(s);
    if(dockEqual(n,this.panelDock())) return;                  // FR-PDK-36
    PrefStore.local.setJson(STORE_KEYS.panelDock,n);
    this.applyPanelDock();
    for(const p of this.tools.values()) if(p.el.classList.contains('vis')) p.doFit();  // FR-PDK-14
  },

  applyPanelDock(){
    const s=this.panelDock(), o=dockOrders(s), de=document.documentElement, st=de.style;
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
    if(n===this.repoSideDock()) return;                         // FR-PDK-36
    PrefStore.local.set(STORE_KEYS.repoSideDock,n);
    this.applyPanelDock();
    for(const p of this.tools.values()) if(p.el.classList.contains('vis')) p.doFit();
  },
});
