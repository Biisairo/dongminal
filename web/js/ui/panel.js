/**
 * Panel — 열고 닫는 패널 (REFACTOR3_FE_BASE_SRS FR-FEB-23 · FE_OBJECT_MODEL 계열 1).
 *
 * 열림의 기준은 **DOM 하나**다 — `stateEl()` 의 클래스(`openClass`)다. 필드나 다른 클래스에 따로 적지 않는다.
 * 상태를 다른 자리에도 비춰야 하는 하위는 `mark` 를 덮어 한 자리에서 함께 바꾼다(`DrawerSheet`).
 *
 *   setOpen(v)  바뀌었을 때만 표식 → 영속(`persist`) → EscapeStack → `onOpen`/`onClose` → 탭 줄 다시 재기. 바뀌었으면 참
 *   persist     `persistKey` 가 있으면 `PrefStore.session` 에 `'1'`/`'0'` 으로 적는다. 다른 꼴은 하위가 덮는다
 *   escapable   참이면 열 때 `EscapeStack` 에 넣고 닫을 때 뺀다. 등록 여부는 하위가 정한다
 *   tabs        하위가 드는 `TabBar`. 열고 닫으면 라벨 자리가 바뀌므로 같은 길(`fit`)로 다시 잰다 (FR-FEB-26)
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

  persist(v){ if(this.persistKey) PrefStore.session.setBool(this.persistKey,v) }

  onOpen(){}
  onClose(){}
}
