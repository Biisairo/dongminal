/**
 * TabBar — 패널 머리의 탭 줄 (REFACTOR3_FE_BASE_SRS FR-FEB-20 · FE_OBJECT_MODEL 계열 2).
 *
 * 사이드바 탭 줄(`SidebarTabBar`)과 작업 패널 탭 줄(`ActivityTabBar`)의 공통 부분이다.
 *   서술자     `defs()` 가 준다. 하위가 쓰는 필드는 `id` 이고 나머지(label·title·icon·badge)는 하위의 `buildTab`·`badgeFor` 가 읽는다
 *   단추       줄이 비었을 때만 서술자 전부로 만든다(C-3) — 이후로는 활성·숨김·배지만 고친다
 *   라벨 맞춤  `fit()` 한 자리에서 `UIKit.tabsFit` 을 부른다. 배지(`paintBadges`)·그리기(`paint`)·폭(자기 줄의 ResizeObserver)·
 *              패널 열고 닫기(`Panel.setOpen`)·모바일 진입이 모두 이 길로 온다 (FR-FEB-26). 판정 규칙은 자기 줄에 라벨이 다 들어가는가다
 *   스크롤     탭별 자리는 `ScrollMemo`(`scrollRoot(id)` 의 요소에 적는다)
 *   고르기     `select(id)` — 자리 적기 → 고르기·영속 → 다시 그리기 → 자리 되돌리기 → `onLeave`·`onEnter`·`onSelect`
 *   직행 키    `jump(n)` — 펼친 채 보는 탭이면 접고, 아니면 고르고 접혀 있었으면 편다 (UX_AUDIT_FIX_SRS FR-UXF-122)
 *
 * 루트는 `rootId` 가 있으면 `index.html` 의 요소를 받고(`adopt`), 없으면 `build()` 로 만든다. 처음 쓸 때 찾는다.
 */
class TabBar extends View {
  constructor(opts){
    super(opts);
    const o=opts||{};
    this.rootId=o.rootId||null;
    this.persistKey=o.persistKey||null;
    this._cur=null;
    this._fitRo=null;
    this.memo=new ScrollMemo(id=>this.scrollRoot(id));
  }

  /** 보관된 값이 없거나 모르는 값이면 첫 서술자다 (FR-SBT-7 · FR-PCH-80). */
  static restoreFrom(key,defs){
    const v=key?PrefStore.local.get(key):null;
    return defs.some(d=>d.id===v)?v:(defs.length?defs[0].id:null);
  }

  // ── 하위가 정하는 것 ──
  defs(){ return [] }
  isVisible(){ return true }
  buildTab(d){ return UIKit.tab({id:d.id,label:d.label,title:d.title,icon:d.icon}) }
  tabSel(id){ return '[data-panel="'+id+'"]' }
  badgeFor(){ return badgeOf(0) }
  paintTab(){}
  paintPane(){}
  scrollRoot(){ return null }
  onLeave(){}
  onEnter(){}
  onSelect(){}
  canFold(){ return false }
  isFolded(){ return false }
  setFolded(){}

  get current(){ return this._cur }
  set current(v){ this._cur=v }

  restore(){ return TabBar.restoreFrom(this.persistKey,this.defs()) }
  visibleDefs(){ return this.defs().filter(d=>this.isVisible(d)) }
  def(id){ return this.visibleDefs().find(d=>d.id===id)||null }

  root(){
    if(this.el) return this.el;
    const e=this.rootId?document.getElementById(this.rootId):this.build();
    if(!e) return null;
    if(this.rootId) this.adopt(e); else this.el=e;
    this.watch();
    return this.el;
  }

  /** 폭이 바뀌면 다시 잰다. 관측은 자기 줄에 한 번 건다 — 두 패널이 같은 대상(탭 줄)을 본다. */
  watch(){
    if(this._fitRo||!this.el||typeof ResizeObserver!=='function') return;
    const ro=new ResizeObserver(()=>this.fit());
    this._fitRo=this.observe(ro,this.el);
  }

  /** 단추를 서술자마다 한 번 만든다. 줄이 비었을 때만 만든다 — 나중에 보이게 된 탭도 순서를 지킨다. */
  ensure(){
    const el=this.root(); if(!el) return null;
    // ACCESSIBILITY_BASELINE_SRS FR-A11Y-12: `tab` 은 `tablist` 안에 있어야 한다.
    el.setAttribute('role','tablist');
    if(!el.childElementCount) for(const d of this.defs()) el.appendChild(this.buildTab(d));
    return el;
  }

  tabEl(id){ return this.el?this.el.querySelector(this.tabSel(id)):null }

  render(){ this.paint() }

  /** 활성·`aria-selected`·숨김을 고치고 배지를 그린다. 보던 탭이 지금 보이지 않으면 첫 탭이다 (FR-SBT-8). */
  paint(){
    if(!this.ensure()) return;
    const vis=this.visibleDefs();
    if(!vis.some(d=>d.id===this.current)) this.current=vis.length?vis[0].id:null;
    for(const d of this.defs()){
      const b=this.tabEl(d.id), on=vis.includes(d), act=on&&this.current===d.id;
      if(b){
        b.hidden=!on;
        b.classList.toggle('active',act);
        b.setAttribute('aria-selected',act?'true':'false');
        this.paintTab(b,d);
      }
      this.paintPane(d,act);
    }
    this.paintBadges();
  }

  /** 배지는 `badgeOf` 한 벌로 판정한다(FR-FEB-15). 배지가 서고 지면 라벨 자리가 바뀌므로 다시 잰다 (FR-UXF-98). */
  paintBadges(){
    if(!this.root()) return;
    for(const d of this.defs()){
      const b=this.tabEl(d.id);
      if(b) this.paintBadge(b,b.querySelector('.ui-tab-badge'),this.badgeFor(d));
    }
    this.fit();
  }

  paintBadge(b,g,bd){
    if(!g) return;
    g.hidden=!bd.shown;
    if(bd.shown) g.textContent=bd.text;
  }

  /** 라벨 판정의 한 자리 (FR-FEB-26). 줄이 아직 없으면 잴 것이 없다. */
  fit(){ if(this.el) UIKit.tabsFit(this.el) }

  saveScroll(id){ this.memo.save(id) }
  restoreScroll(id){ this.memo.restore(id) }

  select(id,opts){
    const next=this.def(id); if(!next||this.current===id) return false;
    const prev=this.def(this.current);
    this.saveScroll(this.current);
    this.current=id;
    if(this.persistKey) PrefStore.local.set(this.persistKey,id);
    this.render();
    this.restoreScroll(id);
    this.onLeave(prev);
    this.onEnter(next);
    this.onSelect(next,opts);
    return true;
  }

  /** n 은 1-based 이며 서술자 배열의 인덱스다 — 숨은 탭이 있어도 번호가 밀리지 않는다 (FR-SBT-26·29). */
  jump(n){
    const d=this.defs()[n-1];
    if(!d||!this.def(d.id)) return;
    const fold=this.canFold(), folded=fold&&this.isFolded();
    if(fold&&!folded&&this.current===d.id){ this.setFolded(true); return }
    if(this.current!==d.id) this.select(d.id);
    if(folded) this.setFolded(false);
  }
}
