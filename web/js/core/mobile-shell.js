/**
 * 모바일의 부팅 쪽 껍데기 (PERF 3.4.12.8, perf/M3_BOOT_SCOPE.md §3 `mobile`).
 *
 * 본체 — `MobileController` 와 부품(`MobileNav`·`MobileSheets`)·서랍(`DrawerSheet`) — 는 `mobile` 묶음이고, 키바의 순수
 * 함수(keybar.js)는 라이브러리 묶음 `keybar` 다(설정 ▸ Terminal 도 쓴다). App 은 처음에 이 껍데기를 `mobile` 로 든다.
 * 껍데기는 렌더러·상태 바·main 이 부르는 이름에 **데스크톱의 답**을 낸다.
 *
 * 모바일이어야 하면(`app.wantsMobile`) 묶음을 싣고 `app.mobile` 을 본체로 바꾼다. 계기는 셋이다 — 부팅(`app.init` 이 첫 렌더
 * 앞에서 기다린다), resize, 렌더(설정의 표시 모드 바꿈). 본체가 서기 전에는 `app.isMobile` 이 거짓이다 — 화면 전체가 한 판으로
 * 데스크톱에 남았다가 본체가 서면 함께 모바일이 된다.
 *
 * 본체는 이 클래스를 잇는다. 모드와 무관한 `_scheduleFit`·`mobilePaneCount`·`mobileOnSide` 는 여기 한 벌이다.
 */
class MobileShell extends Controller {
  constructor(app){
    super(app);
    this.nav={actSheetLeave(){}, mobileActSync(){}, mobileRepoSegSync(){}};
    const shell=this;
    this.sheets={
      mobileChromeSync(){},
      _initSettingsMobile(){ shell._settingsBuilt=true },
      _settingsMobileOnOpen(modal){ modal.dataset.mview='list' },
    };
    if(!this.loaded) window.addEventListener('resize',()=>{ if(this.app.mobile===this) this.loadIfWanted() });
  }

  /** 본체가 섰는가. */
  get loaded(){ return false }

  /** 모바일이어야 하면 본체를 싣는다. 실패는 기록만 하고 데스크톱에 남는다 — 등록부가 실패를 기억하지 않으므로 다음 계기가 다시 시도한다. */
  loadIfWanted(){
    if(this.loaded||!this.app.wantsMobile) return Promise.resolve();
    return this._load().catch(e=>ErrorLog.push('mobile',(e&&e.message)||e));
  }

  async _load(){
    await Screens.load('mobile');
    if(this.app.mobile!==this) return;   // 먼저 끝난 계기가 이미 바꿨다
    const body=new MobileController(this.app);
    this.app.mobile=body;
    if(this._settingsBuilt) body.sheets._initSettingsMobile();
    if(!this._booted) return;   // 부팅 중이다 — 부팅 몫의 init 과 첫 렌더는 부팅이 본체로 돈다
    body._mobileBind();   // 돋보기는 껍데기의 initMobile 이 이미 걸었다
    body.initMobileKeybar();
    this.app.render();
    body._kbSuppressAll();   // FR-MKB-13: 모드가 뒤집히면 inputmode 도 따라간다
  }

  applyMobileMode(){
    this.loadIfWanted();
    this.app.layout.tabOps.sbPanel().railSync(); this.app.agents.list.actPanel().railSync();
  }

  /** 부팅 몫(`SETTINGS_BOOT`). 데스크톱이 쓰는 돋보기만 건다 — 나머지 단추는 모바일 전용이라 본체가 건다. */
  initMobile(){
    this._booted=true;
    // MOBILE_UX_OVERHAUL_SRS FR-MUX-46: 돋보기는 지금 칸의 찾기를 연다 — 터미널이면 터미널 검색, 편집기·diff 면 그 파일의
    // 찾기 패널이다. 두 모드에 다 선다(UX_AUDIT_FIX_SRS FR-UXF-79).
    const srch=document.getElementById('m-search-btn');
    if(srch) srch.addEventListener('click',()=>{
      const a=this.app;
      if(!a.tool.search.focusedTerminal()&&(a.editor.search._edActiveEditor()||a.editor.search._edActiveDiff())){a.editor.search._edFindInFile();return}
      a.tool.search.toggleSearch();
    });
  }

  initMobileKeybar(){ this.app.modKbd={ctrl:false,alt:false} }

  _toggleDrawer(){}
  mobileSideSlots(){ return 0 }
  mobileShowPane(){ return false }
  mTopPaint(){}
  _mkbRender(){}
  mkbRefresh(){}
  _kbSuppressAll(){}
  _mobileVvApply(){}

  // 지금 사이드 자리에 서 있는가. 그 자리에서는 본문의 pane 을 그리지 않는다.
  mobileOnSide(){
    return this.mobileSideSlots()>0&&this.app.mPaneIdx===0;
  }

  // REPO_TAB_UNIFY_SRS FR-RTU-82: 계수는 **사이드를 포함한다** — pane 이 둘이면 `1/3` 이다.
  mobilePaneCount(){
    const s=this.app.tool.life.aw(); if(!s) return 0;
    const off=this.mobileSideSlots();
    if(!s.layout) return off;
    return this.app.flattenPanes(s.layout).length+off;
  }

  // FR-MTI-12/20: 뷰포트 변화마다 fit 하면 PTY SIGWINCH 가 이벤트 수만큼 나가고
  // TUI 는 매번 프레임 전체를 다시 그린다 — 입력이 씹히는 원인이다. 프레임당
  // 1회로 묶는다.
  //
  // 두 계기가 이 함수를 공유한다. WebKit 은 키보드를 visualViewport 로만 알리고
  // (FR-MKV-3), Android Chrome 은 interactive-widget=resizes-content 를 지원해
  // layout viewport 가 함께 줄어 window resize 로 알린다. 후자에서는 kbH 가 0 에
  // 수렴해 vv 경로가 스스로 비활성되므로, window resize 쪽도 반드시 묶여야 한다.
  _scheduleFit(){
    TIMERS.frame(()=>{
      for(const p of this.app.tools.values()){if(p.el.classList.contains('vis'))p.sizer.doFit()}
    },{owner:'app', coalesce:'fit'});
  }

  // 이전 이름. 모바일 전용이 아니게 되었으므로 _scheduleFit 을 쓴다.
  _scheduleMobileFit(){ this._scheduleFit() }
}

Screens.register('keybar');
Screens.register('mobile',{needs:['keybar']});
