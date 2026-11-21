/**
 * SidebarPanel — 왼쪽 메인 패널의 접기(레일)·펼침 (REFACTOR3_FE_BASE_SRS FR-FEB-24 · SIDEBAR_COLLAPSE_SRS 묶음 SBC).
 *
 * 열림은 펼침이다. 표식은 `documentElement` 의 `sb-collapsed` 하나다 (D-1·D-2) — index.html 의 인라인 스크립트가
 * 같은 자리에 먼저 붙이고(FR-SBC-5), 그 시점에 `body` 는 아직 없다. 그래서 이 패널만 표식 자리와 뜻이 뒤집혀 있다.
 * 저장은 이 탭의 것이다(PANEL_LAYOUT_SRS FR-PLY-1) — 접힘이면 `'1'`, 펼침이면 키를 지운다.
 * App 의 `sidebarCollapsed`·`setSidebarCollapsed` 는 이 인스턴스에 맡기는 위임자다 (INV-F2).
 */
class SidebarPanel extends Panel {
  constructor(app){
    super({rootId:'sidebar'});
    this.app=app;
    this.tabs=new SidebarTabBar(app);
  }

  stateEl(){ return document.documentElement }
  isOpen(){ return !document.documentElement.classList.contains(SIDEBAR_COLLAPSED_CLASS) }
  mark(e,v){ e.classList.toggle(SIDEBAR_COLLAPSED_CLASS,!v) }

  persist(v){
    if(v) PrefStore.session.remove(SIDEBAR_COLLAPSED_KEY);
    else PrefStore.session.set(SIDEBAR_COLLAPSED_KEY,'1');
  }

  onOpen(){ this.refit() }
  onClose(){ this.refit() }

  /**
   * FR-SBC-19: 폭이 바뀌면 터미널의 열 수가 바뀐다. 재적합은 드래그 리사이즈가 끝날 때와 **같은 코드**다.
   * UX_AUDIT_FIX_SRS FR-UXF-30: 끝 단추(접기)의 아이콘도 다시 그린다.
   */
  refit(){
    const a=this.app;
    if(a.sbCollapsePaint) a.sbCollapsePaint();
    for(const p of a.tools.values()) if(p.el.classList.contains('vis')) p.doFit();
  }
}
