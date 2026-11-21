/**
 * ActivityTabBar — 작업 패널 머리의 탭 줄 (REFACTOR3_FE_BASE_SRS FR-FEB-22 · PEER_CHAT_SRS FR-PCH-80~82).
 *
 * 서술자는 `ACTIVITY_SECTIONS`(activity-list.js)이고 영속 키는 `STORE_KEYS.activityTab` 이다. 줄은 이 클래스가 만들고
 * (`build`), `agentsRender` 의 재조정이 그 요소를 `#agents-head` 에 둔다. 구역 목록은 고정이므로 단추는 한 번 만든다(FR-UXF-123).
 *
 * 사이드바 탭 줄과 다른 것:
 *   배지      수(FR-UIP-7) 또는 알람 점(FR-PCH-81). 값은 그리기마다 `_actItems` 가 센 것을 `paintWith` 로 받는다
 *   다시 그리기  탭을 고르면 패널 전체(`agentsRender`)를 다시 그린다 — 몸통의 항목이 탭을 따른다
 *   스크롤    몸통(`#agents-body`)이 하나라 자리를 탭 키별 Map 에 적는다 — 요소에 적는 `ScrollMemo` 는 탭마다 다른 요소를 전제한다
 *   직행 키   `actPanelOpen(key)` — 접기는 패널 닫기다. 열린 패널에서 다른 구역으로 가면 목록을 다시 받는다(FR-ARR-5)
 * App 의 `_actTab`·`_actTabSelect`·`_actTabsEl`·`_actTabsPaint` 는 이 인스턴스에 맡기는 위임자다 (INV-F2).
 */
class ActivityTabBar extends TabBar {
  constructor(app){
    super({persistKey:STORE_KEYS.activityTab});
    this.app=app;
    this._view=new Map();
    this._scroll=new Map();
    this._defs=null;
  }

  defs(){ return this._defs||(this._defs=ACTIVITY_SECTIONS.map(s=>({id:s.key,sec:s}))) }

  /** 고른 탭. 모르는 값이면 저장 값, 그것도 모르면 첫 탭이다. */
  get current(){
    if(!this.def(this._cur)) this._cur=this.restore();
    return this._cur;
  }
  set current(v){ this._cur=v }

  build(){
    const bar=domEl('div','ag-tabs ui-panel-tabs');   // PANEL_TEMPLATE_SRS FR-PNT-2
    bar.setAttribute('role','tablist');
    return bar;
  }

  buildTab(d){
    const s=d.sec;
    const b=UIKit.tab({title:s.tip(),icon:s.icon,label:s.title(),
      cls:'ag-tab ui-panel-tab',iconCls:'ag-tab-icon',labelCls:'ag-tab-name',badgeCls:'ag-tab-n',
      onClick:e=>{e.stopPropagation();this.select(d.id)}});
    b.dataset.sec=d.id;
    return b;
  }

  tabSel(id){ return '.ag-tab[data-sec="'+id+'"]' }

  /** 그리기마다 센 탭 값(`{key, tip, n, dot}`)을 받아 그린다. */
  paintWith(tabs){
    this._view=new Map(tabs.map(tb=>[tb.key,tb]));
    this.paint();
  }

  paintTab(b,d){
    const v=this._view.get(d.id);
    if(v) b.title=v.tip;
  }

  // FR-PCH-81: 수가 없으면 알람 점이다. UI_POLISH_SRS FR-UIP-7: 0 은 말하지 않는다.
  badgeFor(d){
    const v=this._view.get(d.id);
    return badgeOf(v?v.n:0,{dot:!!(v&&v.dot)});
  }

  paintBadge(b,g,bd){
    if(g){ g.hidden=!bd.shown; g.textContent=bd.text }
    const dot=b.querySelector('.ag-tab-dot');
    if(bd.dot){ if(!dot) b.appendChild(domEl('span','ag-tab-dot')) }else if(dot) dot.remove();
  }

  render(){ this.app.agentsRender() }

  /**
   * UX_AUDIT_FIX_SRS FR-UXF-121 (D-41): 탭마다 보던 자리로 돌아온다 — 메인 패널과 같은 규칙이다.
   *   이전: 탭을 바꾸면 맨 위로 갔다
   */
  saveScroll(id){
    const body=document.getElementById('agents-body');
    if(body) this._scroll.set(id,body.scrollTop);
  }
  restoreScroll(id){
    const body=document.getElementById('agents-body');
    if(body) body.scrollTop=this._scroll.get(id)||0;
  }

  canFold(){ return true }
  isFolded(){ return !this.app.agentsPanelOpen() }
  setFolded(v){ this.app.setAgentsPanelOpen(!v) }

  /** FR-ARR-5: 열린 패널에서 다른 구역으로 가면 그 목록을 다시 받는다. 닫혀 있었으면 여는 길이 받는다. */
  jump(n){
    const d=this.defs()[n-1];
    if(d&&!this.isFolded()&&this.current!==d.id) this.app._actRefresh();
    super.jump(n);
  }
}
