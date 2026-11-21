/**
 * SettingsModal — 설정 모달 (REFACTOR3_FE_DIALOG_SRS FR-FED-9). `index.html` 의 `#modal-overlay`·`#modal` 을 받아 쓴다.
 *
 * 이 클래스가 지는 것은 **열림과 탭 고르기의 DOM** 이다 — 열기·닫기 길 셋(닫기 버튼·바깥 클릭·Esc), 접근성 계약,
 * 탭 줄의 tablist 속성, 고른 탭의 `active`·`aria-selected`·패널 `hidden`. 열 때·탭을 고를 때 무엇을 다시 칠하고
 * 읽을지는 모른다 — App 이 훅 `onOpen()`·`onTab(name)` 으로 준다(D-FED-4).
 *
 * Esc 는 **버블**이다(D-FED-5). 모바일 상세 화면의 Esc(FR-MUX-23)는 문서 캡처에서 먼저 목록으로 물러서고
 * 전파를 끊는다 — 캡처로 옮기면 등록 순서상 이 닫기가 먼저 돈다.
 */
class SettingsModal extends Dialog {
  constructor(hooks){
    super();
    this.hooks=hooks||{};
    this._escCapture=false;
  }

  init(){
    this.adopt(document.getElementById('modal-overlay'));
    this.ov=this.el;
    this.box=document.getElementById('modal');
    this._tabsAria();
    document.getElementById('settings-btn').addEventListener('click',()=>this.open());
    document.getElementById('modal-close').addEventListener('click',()=>this.close());
    this.ov.addEventListener('click',e=>{ if(e.target===this.ov) this.close() });
    for(const tab of this.tabs()) tab.addEventListener('click',()=>this.select(tab));
    return this;
  }

  tabs(){ return [...this.box.querySelectorAll('.mtab')] }

  /**
   * ACCESSIBILITY_BASELINE_SRS FR-A11Y-18 (`UX-3`): 탭 줄이 **tablist** 다. 속성을 `index.html` 에 손으로 적지
   * 않는다 — 탭이 열하나이고 하나를 빠뜨리면 그 탭만 조용히 접근성 트리 밖으로 나간다. `data-tab` 에서 파생한다.
   */
  _tabsAria(){
    this.box.querySelector('.modal-tabs').setAttribute('role','tablist');
    for(const tab of this.tabs()){
      const id='panel-'+tab.dataset.tab;
      tab.setAttribute('role','tab');
      tab.setAttribute('aria-controls',id);
      tab.setAttribute('aria-selected',String(tab.classList.contains('active')));
      const pn=document.getElementById(id);
      if(pn){
        pn.setAttribute('role','tabpanel');
        if(!tab.id) tab.id='mtab-'+tab.dataset.tab;
        pn.setAttribute('aria-labelledby',tab.id);
      }
    }
  }

  isOpen(){ return this.ov.classList.contains('open') }

  open(){
    if(this.isOpen()) return;
    this.ov.classList.add('open');
    // 연 컨트롤을 **명시로** 든다. `document.activeElement` 에 맡기면 키보드로 연 경우와 클릭으로 연 경우가
    // 갈린다(클릭 뒤 포커스가 버튼에 남지 않는 브라우저가 있다).
    this._attach({labelledBy:'.modal-title',returnTo:document.getElementById('settings-btn')});
    // FR-CMP-84: 넘친 탭만 흐려 **잘린 것이 있음**을 알린다. 닫을 때 끊는다 — 안 끊으면 열 때마다 하나씩 는다.
    this._openOff.push(UIKit.fadeWatch(this.box.querySelector('.modal-body')));
    if(this.hooks.onOpen) this.hooks.onOpen();
  }

  /** 닫는 길이 셋이므로 닫는 일은 이 한 자리다 — 포커스 복귀를 한 곳에만 적는다(`UX-3`). */
  close(){
    if(!this.isOpen()) return;
    this.ov.classList.remove('open');
    this._detach();
  }

  // 전파는 끊지 않는다 — 종전 설정 모달의 Esc 와 같다.
  _onKey(e){
    if(e.key!=='Escape') return;
    e.preventDefault();
    this.close();
  }

  /** `.active` 와 `aria-selected` 가 **같은 것을 말해야** 한다 — 갈라지면 화면과 접근성 트리가 다른 탭을 가리킨다(`TC-A11Y-8b`). */
  select(tab){
    for(const x of this.tabs()){
      x.classList.toggle('active',x===tab);
      x.setAttribute('aria-selected',String(x===tab));
    }
    for(const p of this.box.querySelectorAll('.mpanel')) p.hidden=p.id!=='panel-'+tab.dataset.tab;
    if(this.hooks.onTab) this.hooks.onTab(tab.dataset.tab);
  }
}
