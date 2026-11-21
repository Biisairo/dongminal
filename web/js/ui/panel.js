/**
 * Panel — 열고 닫는 패널 (REFACTOR3_FE_BASE_SRS FR-FEB-23 · FE_OBJECT_MODEL 계열 1).
 *
 * 열림의 기준은 **DOM 하나**다 — `stateEl()` 의 클래스(`openClass`)다. 필드나 다른 클래스에 따로 적지 않는다.
 * 상태를 다른 자리에도 비춰야 하는 하위는 `mark` 를 덮어 한 자리에서 함께 바꾼다(`DrawerSheet`).
 *
 *   setOpen(v)  바뀌었을 때만 표식 → 영속(`persist`) → EscapeStack → `onOpen`/`onClose` → 탭 줄 다시 재기. 바뀌었으면 참
 *   persist     `persistKey` 가 있으면 `PrefStore.session` 에 `'1'`/`'0'` 으로 적는다. 다른 꼴은 하위가 덮는다
 *   escapable   참이면 열 때 `EscapeStack` 에 넣고 닫을 때 뺀다. 등록 여부는 하위가 정한다. 항목은 패널 자신이다 —
 *               층은 `phase`(기본 캡처), 살아 있는지는 하위가 `active()` 로 말한다(REFACTOR3_FE_ESC_SRS FR-FEE-5)
 *   tabs        하위가 드는 `TabBar`. 열고 닫으면 라벨 자리가 바뀌므로 같은 길(`fit`)로 다시 잰다 (FR-FEB-26)
 *   rail        참이면 데스크톱에서 닫힘이 레일이다. 레일 표식 `data-rail` 은 `railSync` 한 자리가 세운다
 *               (REFACTOR3_FE_REST4_SRS FR-FR4-3)
 *
 * 루트는 `rootId` 의 요소를 처음 쓸 때 받는다(`adopt`, D-FEB-3).
 */
class Panel extends View {
  constructor(opts){
    super(opts);
    const o=opts||{};
    this.rootId=o.rootId||null;
    this.openClass=o.openClass||'open';
    this.persistKey=o.persistKey||null;
    this.escapable=!!o.escapable;
    this.phase=o.phase||'capture';
    this.rail=!!o.rail;
    this.tabs=null;
  }

  root(){
    if(!this.el&&this.rootId){
      const e=document.getElementById(this.rootId);
      if(e) this.adopt(e);
    }
    return this.el;
  }

  /** 열림 표식이 붙는 요소. 하위가 바꿀 수 있다. */
  stateEl(){ return this.root() }

  isOpen(){
    const e=this.stateEl();
    return !!e&&e.classList.contains(this.openClass);
  }

  setOpen(v){
    v=!!v;
    const e=this.stateEl();
    if(!e||this.isOpen()===v) return false;
    this.mark(e,v);
    this.railSync();
    this.persist(v);
    if(this.escapable){ if(v) EscapeStack.push(this); else EscapeStack.remove(this) }
    if(v) this.onOpen(); else this.onClose();
    if(this.tabs) this.tabs.fit();
    return true;
  }

  open(){ return this.setOpen(true) }
  close(){ return this.setOpen(false) }
  toggle(){ return this.setOpen(!this.isOpen()) }

  mark(e,v){ e.classList.toggle(this.openClass,v) }

  /**
   * REFACTOR3_FE_REST4_SRS FR-FR4-3·4: 레일 표식을 세우는 유일한 자리. 레일 = 레일을 갖는 패널이 닫혀 있고 데스크톱이다.
   * 데스크톱 판정은 `body.mobile` 클래스다 — CSS 가 보던 `body:not(.mobile)` 과 같은 것을 본다(D-FR4-5).
   * 부르는 곳: 열림이 바뀐 뒤(`setOpen`), `body.mobile` 을 바꾼 뒤(`applyMobileMode`), 부팅 때 저장 값으로 연 뒤.
   */
  railSync(){
    const e=this.root();
    if(!e||!this.rail) return;
    e.toggleAttribute('data-rail',!this.isOpen()&&!document.body.classList.contains('mobile'));
  }

  persist(v){ if(this.persistKey) PrefStore.session.setBool(this.persistKey,v) }

  onOpen(){}
  onClose(){}
}
