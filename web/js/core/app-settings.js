/**
 * Dongminal — 설정의 **단일 경로** (FE_MODULE_BOUNDARY_SRS FR-FMB-10).
 *
 * 설정 하나를 **읽고 얹는 방법**의 서술자 표와, 그 표를 도는 셋 — 저장(PUT) ·
 * 적용 · 복원. 설정창의 골격도 여기 있다.
 *
 * **패널은 갈라져 나갔다.** 고칠 자리를 파일 이름이 말한다:
 *
 *   app-settings-init.js      개별 설정의 초기화와 즉시 반영 (설정창 없이도 돈다)
 *   app-settings-theme.js     테마 목록 · 미리보기 · 사용자 정의 편집
 *   app-settings-keys.js      단축키 목록 · 녹화
 *   app-settings-sandbox.js   샌드박스 패널
 *   app-settings-access.js    접속 허용 목록(ACL) 패널
 */
/**
 * 설정 하나를 **읽고 얹는 방법** (CONFIG_MANAGEMENT_SRS FR-CFG-5).
 *
 * 키·타입·범위·기본값은 여기 없다 — `settings-schema.js` 의 `SETTINGS_SCHEMA` 가
 * 그 단일 원천이고 Go 도 같은 바이트를 읽는다 (FR-CFG-1·10). 이 표가 지는 것은
 * **전역 변수에 닿는 길과 얹은 뒤의 뒷일**뿐이다. JSON 에 담을 수 없어 갈라 둔
 * 것이며, 두 표의 키 집합이 같은지는 검사가 강제한다 (TC-CFG-1).
 *
 * 종전에는 이 목록이 **세 벌**이었다 — PUT 본문의 인라인 나열 · `_settingsApply`
 * 의 `if` 스무 갈래 · 이식 표. 아무 게이트도 없었고, 빠뜨린 실패는 다른 브라우저
 * 창을 열어 보기 전까지 아무도 모른다.
 *
 *   get()   블롭에 실을 값. 없으면 그 키는 PUT 본문에서 빠진다 (FR-CFG-6)
 *   set(v)  값을 얹고 화면까지 따라가게 한다
 */
const SETTINGS_ACCESS={
  // 테마는 두 키가 한 쌍이라 얹는 자리가 `_settingsApply` 에 따로 있다 —
  // 사용자 정의가 있으면 그것이 이름을 이긴다. 여기서는 싣기만 한다.
  themeName:{get:()=>customTheme?null:currentThemeName},
  customTheme:{get:()=>customTheme},
  shortcuts:{get:()=>shortcuts,set:v=>{Object.assign(shortcuts,v)}},
  statusBar:{get:()=>statusBar,set:v=>{Object.assign(statusBar,v)}},
  // 주기 다섯은 `POLL_SETTINGS` 가 이미 쥔 길을 그대로 쓴다 (FR-PIS-7).
  agentsPollInterval:{get:()=>agentsPollInterval,set:v=>POLL_BY_KEY.agentsPollInterval.set(v)},
  statsInterval:{get:()=>statsInterval,set:v=>POLL_BY_KEY.statsInterval.set(v)},
  gitStatusInterval:{get:()=>gitStatusInterval,set:v=>POLL_BY_KEY.gitStatusInterval.set(v)},
  gitReposInterval:{get:()=>gitReposInterval,set:v=>POLL_BY_KEY.gitReposInterval.set(v)},
  gitConsoleInterval:{get:()=>gitConsoleInterval,set:v=>POLL_BY_KEY.gitConsoleInterval.set(v)},
  layoutPresets:{get:()=>layoutPresets,set:v=>{layoutPresets=v}},
  defaultPreset:{get:()=>defaultPreset,set:v=>{defaultPreset=v}},
  // FR-TAN-19
  fgTabNames:{get:()=>fgTabNames,set(v){
    fgTabNames=v;
    if(this._fgRepaint) this._fgRepaint();
    const cb=document.getElementById('ds-fgnames');
    if(cb) cb.checked=fgTabNames;
  }},
  // FR-KEY-6: 저장된 적 없으면 기본값(켬).
  blockBrowserKeys:{get:()=>blockBrowserKeys,set(v){
    blockBrowserKeys=v;
    const bk=document.getElementById('sc-blockbrowser');
    if(bk) bk.checked=blockBrowserKeys;
  }},
  // PAGE_TITLE_SRS FR-PGT-10
  pageTitle:{get:()=>pageTitle,set(v){pageTitle=v;this._applyPageTitle()}},
  // FR-LVC-6: 저장된 적 없으면 기본값(끔).
  confirmLeave:{get:()=>confirmLeave,set(v){
    confirmLeave=v;
    const cl=document.getElementById('ds-confirmleave');
    if(cl) cl.checked=confirmLeave;
  }},
  // FR-WBR-10·11: 값만 바꾸면 사용자는 설정이 듣지 않는 것으로 읽는다 —
  // 이미 열려 있는 편집기에도 얹는다.
  editorWordWrap:{get:()=>editorWordWrap,set(v){
    editorWordWrap=v;
    const ww=document.getElementById('ds-wordwrap');
    if(ww) ww.checked=editorWordWrap;
    if(this._edApplyWordWrap) this._edApplyWordWrap();
  }},
  // FR-TBW-8: 같은 근거로 곧바로 얹는다. 클래스와 변수 하나뿐이라 다시 그리지 않는다.
  tabFixedWidth:{get:()=>tabFixedWidth,set(v){
    tabFixedWidth=v;
    const tf=document.getElementById('ds-tabfix');
    if(tf) tf.checked=tabFixedWidth;
    applyTabWidth();
  }},
  tabWidthPx:{get:()=>tabWidthPx,set(v){
    tabWidthPx=clampTabWidth(v);
    const tw=document.getElementById('ds-tabw');
    if(tw) tw.value=String(tabWidthPx);
    applyTabWidth();
  }},
  // FR-UFE-12·13 / FR-AED-9: 범위 판정은 표가 한다 (`settingValue`) — 종전에는
  // 같은 모양의 `if` 가 두 줄 걸러 두 번 적혀 있었다.
  focusEdgeLevel:{get:()=>focusEdgeLevel,set(v){
    focusEdgeLevel=v;
    this._focusEdgePaintRow();
    this._paintFocusEdge();
  }},
  attnEdgeLevel:{get:()=>attnEdgeLevel,set(v){
    attnEdgeLevel=v;
    this._attnEdgePaintRow();
    this._paintAttnEdge();
    this._attnRefresh();
  }},
};


Object.assign(App.prototype, {
  async saveSettings(){
    // 블롭 전체를 갈아치우므로 읽어 쓰는 값은 전부 실어야 한다 — 여기서 빠지면
    // 다른 설정을 건드릴 때 조용히 사라진다.
    //
    // **그래서 나열하지 않는다** (CONFIG_MANAGEMENT_SRS FR-CFG-4). 본문은
    // 서술자 표에서 파생되므로, 키를 더하고 여기를 잊는 실패 모드가 없어진다.
    // `gitSignatureInterval` 이 표에 없는 것이 곧 싣지 않는다는 뜻이다 (FR-PIS-2).
    //
    // `FE-7`(PRODUCTION_ROADMAP §M3): **응답을 검사한다.** 종전에는 결과를
    // 버렸고, 그래서 디스크가 차거나 경계에 걸려 거절된 저장이 **성공처럼**
    // 보였다 — 사용자는 설정이 바뀐 줄 알고 다음 기동에서 옛 값을 만난다.
    const body={};
    for(const spec of SETTINGS_SCHEMA){
      const acc=SETTINGS_ACCESS[spec.key];
      // FR-CFG-6: 읽을 길이 없는 키는 빠진다 — UI 가 아직 없는 값을 표에 적어
      // 두는 길을 남긴다.
      if(!acc||!acc.get) continue;
      body[spec.key]=acc.get.call(this);
    }
    const res=await apiPut('/api/settings',body);
    if(!res.ok&&this._notify) this._notify(SETTINGS_SAVE_FAIL);
    return res.ok;
  },

  /**
   * SANDBOX_PICK_COPY_SRS FR-SPK-7: 설정 화면을 특정 탭으로 연다.
   *
   * **버튼과 탭을 실제로 누른다.** 여는 절차(패널 다시 칠하기·모바일 드로어
   * 닫기·탭별 재조회)가 그 리스너 안에 있으므로, 여기서 클래스만 바꾸면 그
   * 절차가 통째로 빠진 반쯤 열린 화면이 된다.
   */
  _openSettings(tab){
    const btn=document.getElementById('settings-btn');
    if(btn) btn.click();
    if(!tab) return;
    const t=document.querySelector('#modal .mtab[data-tab="'+tab+'"]');
    if(t) t.click();
  },

  /**
   * 서버 설정 blob 하나를 **화면에 얹는다** (SETTINGS_LIVE: 2026-09-08 접수).
   *
   * 종전에는 이 일이 두 곳에 흩어져 있었다 — `main.js` 의 부팅 로더(테마·단축키·
   * 상태바·주기·프리셋·제목)와 이 파일 끝의 IIFE(브라우저 키·떠날 때 확인·
   * 가장자리·줄바꿈·탭 너비·프로세스 이름). 둘 다 키를 손으로 나열했고, 그래서
   * **다른 창에서 바뀐 값을 받아 얹을 자리가 아예 없었다**: 접수한 말이
   * "설정값이 바뀌었을 때 다른 브라우저창은 바로 갱신이 안된다" 다.
   *
   * 얹는 규약을 한 함수로 내리면 세 계기가 같은 길을 지난다 — 부팅 · SSE 방송 ·
   * 소프트 리로드. 새 설정을 더할 때 고칠 자리도 하나다.
   *
   * `boot` 는 **부팅에서만 해야 하는 일**을 가른다. 지금은 그런 것이 없지만,
   * 값을 지우는 쪽(예: `saved.x===undefined` 일 때 기본으로 되돌리기)은 부팅과
   * 갱신에서 뜻이 다를 수 있어 자리를 비워 둔다.
   */
  _settingsApply(saved,opts){
    if(!saved||typeof saved!=='object') return;
    /**
     * **서술자 표 하나를 돈다** (CONFIG_MANAGEMENT_SRS FR-CFG-3·5).
     *
     * 종전에는 키마다 `if` 가 하나씩 있었고 범위 검사가 같은 모양으로 두 번 세
     * 번 적혀 있었다 (`focusEdgeLevel`·`attnEdgeLevel`·주기 다섯). 값 판정은
     * 이제 `settingValue` 한 자리이고, 이 표가 지는 것은 얹은 뒤의 뒷일뿐이다.
     *
     * `!==undefined` 가드는 **그대로다** (FR-PIS-8): 서버가 말하지 않은 키에
     * 대해 화면이 판단하지 않는다. 부팅에서는 변수가 이미 기본값이라 결과가
     * 같고, 갱신에서는 이것이 유일하게 안전한 답이다 — 되돌려 버리면 이 자리에
     * 값을 직접 넣어 둔 쪽(검사·진단)의 값을 방송 하나가 지운다.
     */
    for(const spec of SETTINGS_SCHEMA){
      if(saved[spec.key]===undefined) continue;
      const acc=SETTINGS_ACCESS[spec.key];
      if(!acc||!acc.set) continue;
      const v=settingValue(saved[spec.key],spec);
      if(v===undefined) continue;
      acc.set.call(this,v);
    }
    // 테마는 두 키가 한 쌍이라 표 밖에 남는다 — **사용자 정의가 이름을 이긴다.**
    // 표를 돌며 각자 얹으면 순서에 따라 답이 갈린다.
    if(saved.customTheme){customTheme=saved.customTheme;applyThemeObj(customTheme)}
    else if(saved.themeName&&THEMES[saved.themeName]){customTheme=null;currentThemeName=saved.themeName;applyThemeObj(THEMES[currentThemeName])}
    // 설정 변경은 감지 계층의 재평가 시점이다 (FR-GIT-23). 이 계층만 따로인
    // 이유는 백오프·소실 판정·활성 저장소 판정을 함께 쥐고 있어 주기만 떼어 올
    // 수 없기 때문이다 (FR-PIS-15).
    if(this.gitPanel&&this.gitPanel._reschedule) this.gitPanel._reschedule();
    /**
     * FR-PIS-14 / D-8a: 나머지 주기는 **도는 타이머에 닿아야** 한다.
     *
     * 진입점이 하나인 이유는 핸들에 닿는 길이 저마다 다르기 때문이다 — git
     * 콘솔의 타이머는 `observer → panels → panel._consoleView` 세 단 아래에 있고,
     * 그 길을 설정이 알아야 할 이유가 없다. 바뀐 job 만 다시 걸리고, **발화하지
     * 않는다**: 주기를 바꾼 것은 수집의 계기가 아니다.
     */
    TIMERS.refreshChanged();
    // 화면의 드롭다운도 같은 값을 보여야 한다 — 다른 창에서 바뀐 값이 SSE 로
    // 왔을 때 열려 있는 설정창이 옛 값을 든 채 남지 않는다 (FR-SYN).
    if(this._pollPaintRows) this._pollPaintRows();
    /**
     * FR-PIS-17 / D-9: `agentsPollMs` 의 이사는 **부팅에서만** 한다.
     *
     * `boot` 가 가르는 자리가 바로 이런 것이라고 위 주석이 적어 두었다 — SSE
     * 방송마다 로컬을 다시 보면, 그 사이 다른 창에서 바꾼 값을 옛 로컬 값이
     * 덮는다. 이사는 한 번이고 조용하다.
     */
    if(opts&&opts.boot) this._pollMigrateAgents(saved);
  },

  /**
   * 서버의 설정을 다시 받아 얹는다. `STATE_REGISTRY` 의 `settings` 가 부른다 —
   * 계기는 셋이다: SSE `settings_changed` · 구독이 열린 순간 · 소프트 리로드.
   *
   * `merge:'latest'` 인 이유는 이 상태에 **증분이 없기** 때문이다 (FR-HUB 의
   * `background` 와 같은 근거) — 방송은 "다시 받으라" 는 신호이고, 막아야 하는
   * 것은 스냅샷끼리의 추월뿐이다.
   */
  _settingsRestore(){
    const t=this._restoreBegin('settings');
    return apiGet('/api/settings').then(r=>{
      if(!this._restoreLive('settings',t)) return;
      this._settingsApply(r.ok?r.data:null);
      this._restoreEnd('settings',t);
    });
  },

  initModal(){
    const overlay=document.getElementById('modal-overlay');
    const modal=document.getElementById('modal');
    document.getElementById('settings-btn').addEventListener('click',()=>{
      overlay.classList.add('open');
      this._renderThemePanel();this._renderShortcutList();this._renderPresets();
      const dsMode=document.getElementById('ds-mode');
      const dsBp=document.getElementById('ds-bp');
      if(dsMode) dsMode.value=this.displayMode;
      if(dsBp) dsBp.value=this.mobileBreakpoint;
      const dsTitle=document.getElementById('ds-title');
      if(dsTitle) dsTitle.value=pageTitle;
      const dsFg=document.getElementById('ds-fgnames');
      if(dsFg) dsFg.checked=fgTabNames;
      // FR-WSL-81: 슬롯 방향 세그먼트. 열 때마다 현재 값을 다시 칠한다.
      this._slotDirPaint();
      const scBlock=document.getElementById('sc-blockbrowser');
      if(scBlock) scBlock.checked=blockBrowserKeys;
      // FR-LVC-3: 열 때마다 현재 값을 다시 칠한다 — 다른 화면에서 바뀐 값이
      // 이 모달에 옛 상태로 남아 있으면 사용자가 그것을 켜진 줄로 읽는다.
      const dsLeave=document.getElementById('ds-confirmleave');
      if(dsLeave) dsLeave.checked=confirmLeave;
      // FR-UFE-14: 같은 근거로 이 행도 열 때마다 다시 칠한다 — 체크박스와 세기가
      // 함께 움직이므로 한 함수가 둘을 맡는다.
      this._focusEdgePaintRow();
      // FR-WBR-10: 열 때마다 현재 값을 다시 칠한다 (FR-LVC-3 과 같은 근거).
      const dsWrap=document.getElementById('ds-wordwrap');
      if(dsWrap) dsWrap.checked=editorWordWrap;
      // Auto-close drawer when opening settings on mobile
      if(this.isMobile && this.drawerOpen){this._toggleDrawer(false);this.renderer._rTopbar()}
    });
    document.getElementById('modal-close').addEventListener('click',()=>overlay.classList.remove('open'));
    overlay.addEventListener('click',e=>{if(e.target===overlay)overlay.classList.remove('open')});
    document.addEventListener('keydown',e=>{if(e.key==='Escape'&&overlay.classList.contains('open')){e.preventDefault();overlay.classList.remove('open')}});
    modal.querySelectorAll('.mtab').forEach(tab=>{
      tab.addEventListener('click',()=>{
        modal.querySelectorAll('.mtab').forEach(t=>t.classList.remove('active'));
        tab.classList.add('active');
        modal.querySelectorAll('.mpanel').forEach(p=>p.style.display='none');
        document.getElementById('panel-'+tab.dataset.tab).style.display='';
        if(tab.dataset.tab==='presets')this._renderPresets();
        // 샌드박스 정의는 파일이 진실이다. 열 때마다 다시 읽어야 바깥에서
        // 고친 것과 어긋나지 않는다.
        if(tab.dataset.tab==='sandbox')this._loadSandboxPanel();
        // 허용 목록도 파일이 진실이다. 게다가 해석 상태는 관측값이라 캐시할
        // 수 없다 — 열 때마다 서버에 묻는다.
        if(tab.dataset.tab==='access')this._loadAccessPanel();
        // FR-LSP-47: 언어 서버의 상태는 캐시가 아니라 관측이다 — 샌드박스와
        // 같은 근거로 열 때마다 다시 읽는다.
        if(tab.dataset.tab==='code'){
          this._lspRefresh();
          // 토글은 기기별 값이라 다른 탭에서 바뀔 일이 없지만, 열 때마다 다시
          // 칠하는 것이 이 모달의 규약이다 (FR-LVC-3 와 같은 근거).
          const dcb=document.getElementById('lsp-diag');
          if(dcb) dcb.checked=lspDiagOn;
        }
      });
    });
    this._initPageTitle();
    this._initTabWidth();
    this._initFgNames();
    this._initBlockKeys();
    this._initConfirmLeave();
    this._initFocusEdge();
    this._initAttnEdge();
    this._initWordWrap();
    this._initLSP();
    this._initBackup();
    this._initSandboxPanel();
    this._initAccessPanel();
  },
});
