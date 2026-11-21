/**
 * Remote Terminal — App 모바일 시트 (MOBILE_UX_OVERHAUL_SRS)
 *
 * 모바일의 전체 높이 시트(서랍·Activity·설정)가 하단 크롬과 맞물리는 규칙, 설정의
 * 목록 → 상세, 길게 누르기 → 컨텍스트 메뉴. `MobileController` 의 `initMobile` 이
 * `_initMobileSheets` 를 부른다 — 그 시점에는 설정 모달(`initModal`)이 이미 서 있다.
 * `MobileSheets` 는 `MobileController` 의 부품이다(`mobile.sheets`, REFACTOR3_FE_APPCTL_SRS 9c).
 * mobile-controller.js 뒤, main.js 앞에 로드된다.
 */
class MobileSheets extends Controller {
  /**
   * MOBILE_UX_OVERHAUL_SRS FR-MUX-2·3·13: 하단 크롬(키바·상태바)이 설 자리를 정한다.
   *
   *   `m-sheet` — 시트(서랍·Activity·설정)가 열려 있다. 키바·상태바를 감춘다
   *   `m-no-kb` — 키바를 감춘다. 시트가 열렸거나 포커스 칸이 터미널이 아니다
   *
   * 판정은 DOM 의 열림 표식을 읽는다 — 셋은 각자 자기 열림을 DOM 에 적고, 여기서
   * 따로 기억하면 그 둘이 어긋난다. 키바가 서거나 빠지면 본문 높이가 바뀌므로
   * 보이는 터미널을 다시 맞춘다.
   */
  mobileChromeSync(){
    const b=document.body;
    const mob=this.app.isMobile;
    const ov=document.getElementById('modal-overlay');
    const ag=document.getElementById('agents-panel');
    const sheet=mob&&(!!this.app.drawerOpen||!!(ag&&ag.classList.contains('open'))||!!(ov&&ov.classList.contains('open')));
    const noKb=mob&&(sheet||!this.app.focusedTerminal());
    const changed=b.classList.contains('m-no-kb')!==noKb;
    b.classList.toggle('m-sheet',sheet);
    b.classList.toggle('m-no-kb',noKb);
    if(!changed) return;
    // 키보드가 올라와 있으면 그 보정(padding-bottom)이 키바 높이를 품고 있다 — 다시 잰다.
    this.app._mKbH=null;
    if(window.visualViewport) this.app._mobileVvApply(); else this.app._scheduleFit();
  }

  _initMobileSheets(){
    this._initLongPress();
    this._initSettingsMobile();
  }

  /**
   * FR-MUX-20~24: 모바일 설정의 두 화면 — `list`(섹션 목록)와 `detail`(고른 섹션의 패널).
   * `#modal[data-mview]` 에 적고 CSS 가 그린다. 데스크톱에서는 값이 있어도 걸리는 규칙이 없다.
   *
   * 패널을 고르는 진실은 `SettingsModal.select` 한 자리다 — 여기서는 그 뒤에 **화면만**
   * 바꾼다. 탭 누르기 리스너가 그것보다 늦게 붙으므로 늘 그 뒤에 돈다. 열 때의 목록 화면은
   * `SettingsController.onOpen` 이 `_settingsMobileOnOpen` 으로 부른다(REFACTOR3_FE_ESC_SRS FR-FEE-9).
   *
   * FR-MUX-23: 상세의 Escape 는 목록으로 물러선다. 상세로 갈 때 EscapeStack 캡처 층에 넣으므로 그보다
   * 먼저 연 설정 닫기보다 먼저 돈다(FR-FEE-6). 서랍·Activity 의 Esc(FR-MUX-14)는 두 패널이 진다(FR-FEE-5).
   */
  _initSettingsMobile(){
    const overlay=document.getElementById('modal-overlay');
    const modal=document.getElementById('modal');
    if(!overlay||!modal) return;
    modal.querySelectorAll('.mtab').forEach(tab=>tab.addEventListener('click',()=>this._settingsView(modal,'detail')));
    this._settingsDetailEsc={
      active:()=>this.app.isMobile&&overlay.classList.contains('open')&&modal.dataset.mview==='detail',
      close:()=>this._settingsView(modal,'list'),
    };
    // FR-MUX-13: 닫는 길이 셋이다(닫기·바깥·Escape) — 열림 표식 하나를 지켜본다.
    if(this._settingsOverlayMo) this._settingsOverlayMo.disconnect();
    this._settingsOverlayMo=new MutationObserver(()=>{
      this.app.mobileChromeSync();
      if(!overlay.classList.contains('open')) EscapeStack.remove(this._settingsDetailEsc);   // FR-FEE-6
    });
    this._settingsOverlayMo.observe(overlay,{attributes:true,attributeFilter:['class']});
  }

  /** 설정을 열 때 — 모바일 머리를 세우고 목록 화면으로 간다. 열기·패널 칠하기 뒤에 부른다(FR-FEE-9). */
  _settingsMobileOnOpen(modal){
    if(this.app.isMobile) this._settingsMobileHead(modal);
    this._settingsView(modal,'list');
  }

  /**
   * FR-MUX-22: 상세의 머리 — 뒤로 단추와 섹션 이름. **모바일에서 처음 열 때** 만든다 — 데스크톱
   * DOM 은 종전과 같아야 계산값 기준선(V-LAY-1)이 재는 대상이 바뀌지 않는다. 한 번 서면 남고,
   * 데스크톱에서는 CSS 가 감춘다.
   */
  _settingsMobileHead(modal){
    if(modal.querySelector('.modal-back')) return;
    const back=document.createElement('button');
    back.type='button';back.id='modal-back';
    back.className='ui-btn ui-btn-icon ui-btn-ghost modal-back';
    back.title=TIP_SETTINGS_BACK;back.setAttribute('aria-label',TIP_SETTINGS_BACK);
    back.appendChild(UIKit.icon('chevron-left'));
    back.addEventListener('click',()=>this._settingsView(modal,'list'));
    const sec=document.createElement('span');
    sec.className='modal-section';
    modal.querySelector('.modal-header').prepend(back,sec);
  }

  _settingsView(modal,view){
    modal.dataset.mview=view;
    const sec=modal.querySelector('.modal-section');
    const cur=modal.querySelector('.mtab.active');
    if(sec) sec.textContent=cur?cur.textContent.trim():'';
    const body=modal.querySelector('.modal-body');
    if(view==='detail'&&this.app.isMobile&&body) body.scrollTop=0;
    const esc=this._settingsDetailEsc;
    if(esc){ if(view==='detail'&&this.app.isMobile) EscapeStack.push(esc); else EscapeStack.remove(esc) }   // FR-FEE-6
  }

  /**
   * MOBILE_UX_OVERHAUL_SRS FR-MUX-50~52: 길게 누르면 그 자리에 `contextmenu` 를 보낸다.
   *
   * 메뉴를 여는 길은 이미 자리마다 `contextmenu` 리스너다 — 그 길을 하나 더 만들지
   * 않고 같은 이벤트를 합성한다. Android Chrome 은 스스로도 보내므로 한 번의 누름에
   * 메뉴가 두 번 열리지 않게 한다: 브라우저의 것이 먼저 오면 우리 타이머를 거두고,
   * 우리 것이 먼저 나갔으면 뒤따르는 브라우저의 것을 삼킨다. 메뉴를 연 누름은
   * 뒤따르는 click(행 열기 등)을 내지 않는다.
   */
  _initLongPress(){
    let timer=null,start=null,fired=false;
    const cancel=()=>{if(timer){TIMERS.cancel(timer);timer=null}};
    document.addEventListener('touchstart',e=>{
      cancel();fired=false;start=null;
      if(!this.app.isMobile||e.touches.length!==1) return;
      const tg=e.target;
      if(!(tg instanceof Element)||tg.closest(MOBILE_LONG_PRESS_SKIP)) return;
      const p=e.touches[0];
      start={x:p.clientX,y:p.clientY};
      timer=TIMERS.after(MOBILE_LONG_PRESS_MS,()=>{
        timer=null;fired=true;
        tg.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:start.x,clientY:start.y}));
      },{owner:'mobile',label:'long-press'});
    },{passive:true,capture:true});
    document.addEventListener('touchmove',e=>{
      if(!timer||!start) return;
      const p=e.touches[0];
      if(p&&(Math.abs(p.clientX-start.x)>MKB_TAP_SLOP_PX||Math.abs(p.clientY-start.y)>MKB_TAP_SLOP_PX)) cancel();
    },{passive:true,capture:true});
    document.addEventListener('touchcancel',cancel,{capture:true});
    document.addEventListener('touchend',e=>{
      cancel();
      if(fired&&e.cancelable) e.preventDefault();
    },{capture:true});
    document.addEventListener('contextmenu',e=>{
      if(!e.isTrusted) return;
      if(fired){e.preventDefault();e.stopPropagation();return}
      cancel();
    },{capture:true});
  }
}

// 활동 패널·설정·`ui/`(서랍·렌더러)와 시험이 App 에서 부르는 이름 (FR-FEA-4).
Controller.delegate(App,'mobile.sheets',['mobileChromeSync','_settingsMobileOnOpen']);
