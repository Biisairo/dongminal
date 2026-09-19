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
  // FR-ARE-3: 저장된 적 없으면 기본값(켬). 서버도 같은 기본값을 쓴다
  // (`agentRenderEnv`) — 두 자리가 어긋나면 화면과 실제가 갈린다.
  claudeFullscreen:{get:()=>claudeFullscreen,set(v){
    claudeFullscreen=v;
    const cb=document.getElementById('ds-claudefs');
    if(cb) cb.checked=claudeFullscreen;
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
  // FR-MMT-4: 줄바꿈과 같은 근거로 열려 있는 편집기에도 얹는다.
  editorMinimap:{get:()=>editorMinimap,set(v){
    editorMinimap=v;
    const mm=document.getElementById('ds-minimap');
    if(mm) mm.checked=editorMinimap;
    if(this._edApplyMinimap) this._edApplyMinimap();
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
  // FONT_SIZE_SETTING_SRS FR-FSS-3·9: 배율 하나가 CSS 토큰과 편집기 둘 다에 간다.
  // 터미널은 여기 없다 — 그것이 이 스펙의 요점이다 (FR-FSS-17).
  uiFontScale:{get:()=>uiFontScale,set(v){
    uiFontScale=clampSetting('uiFontScale',v);
    const el=document.getElementById('ds-uifs');
    if(el) el.value=String(uiFontScale);
    applyUiFontScale();
    if(this._edApplyFontSize) this._edApplyFontSize();
  }},
  // FR-FSS-12·15: 터미널만 움직인다.
  termFontSize:{get:()=>termFontSize,set(v){
    termFontSize=clampSetting('termFontSize',v);
    const el=document.getElementById('ds-termfs');
    if(el) el.value=String(termFontSize);
    if(this._termApplyFontSize) this._termApplyFontSize();
  }},
  // AGENT_RENDER_ENV_SRS FR-ARE-8: 얹을 화면이 없다 — 값은 서버가 쓴다.
  claudeScrollSpeed:{get:()=>claudeScrollSpeed,set(v){
    claudeScrollSpeed=clampSetting('claudeScrollSpeed',v);
    const el=document.getElementById('ds-scrollspeed');
    if(el) el.value=String(claudeScrollSpeed);
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
  // SYSTEM_THEME_FOLLOW_SRS FR-STF-1: 얹는 것은 값뿐이다 — 어느 테마를 적용할지는
  // `_settingsApply` 의 테마 갈래가 셋을 함께 보고 정한다 (`_applyThemeChoice`).
  themeFollowSystem:{get:()=>themeFollowSystem,set(v){themeFollowSystem=!!v}},
  themeNameDark:{get:()=>themeNameDark,set(v){if(THEMES[v]) themeNameDark=v}},
  themeNameLight:{get:()=>themeNameLight,set(v){if(THEMES[v]) themeNameLight=v}},
  // FR-B-4 / D-B-1: 서버의 값이 활성 로케일과 다르면 거울(`localStorage`)을 고치고
  // 페이지를 다시 연다 — 상수 1,100여 개가 로드 시점에 읽었으므로 살아 있는
  // 재렌더는 없다. 거울을 쓰지 못하는 브라우저에서는 다시 열지 않는다(무한 재로드).
  locale:{get:()=>uiLocale,set(v){
    uiLocale=I18N.resolve(v);
    const sel=document.getElementById('ds-locale');
    if(sel) sel.value=uiLocale;
    if(uiLocale!==I18N.locale&&this._localeMirror(uiLocale)) location.reload();
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
    if(saved.customTheme){customTheme=saved.customTheme}
    else if(saved.themeName&&THEMES[saved.themeName]){customTheme=null;currentThemeName=saved.themeName}
    // FR-STF-2·7: 추종이 켜져 있으면 슬롯이 이기고, 사용자 정의는 남되 적용되지 않는다.
    this._applyThemeChoice();
    // FR-B-7: 단축키를 품은 툴팁은 설정이 선 뒤에 채운다 — 기본값이어도 한 번은 채워야 한다.
    I18N.applyShortcuts(document);
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

  /**
   * ACCESSIBILITY_BASELINE_SRS FR-A11Y-13 (`G7-1` 첫 판): 설정 컨트롤의 **이름을
   * 구조에서 파생**한다.
   *
   * 첫 판이 올린 것: `<input>` 18개 중 17개·`<select>` 6개에 이름이 없고
   * `label[for]` 는 0개였다 — 이름이 없는 게 아니라 **연결 기제가 없었다.** 관용구는
   * 한결같다: `.ds-row`/`.sbs-row` 의 첫 자식 `<span>` 이 이름이고 그 뒤에 컨트롤
   * 하나가 선다. 그러므로 손으로 스물셋을 적지 않고 그 구조에서 `aria-labelledby`
   * 를 세운다 — 행을 더하는 사람이 아무것도 기억하지 않아도 된다 (`.mtab` 의
   * tablist 와 같은 규약). 컨트롤이 둘 이상인 행은 건드리지 않는다 — 어느 것의
   * 이름인지 구조가 말하지 않는다.
   *
   * 열 때마다 돈다 — 상태바·주기 행은 다시 그려질 수 있다. 멱등이다.
   */
  _labelSettingsRows(){
    const modal=document.getElementById('modal'); if(!modal) return;
    let n=0;
    for(const row of modal.querySelectorAll('.ds-row,.sbs-row')){
      const lab=row.firstElementChild;
      if(!lab||lab.tagName!=='SPAN'||lab.className||!(lab.textContent||'').trim()) continue;
      const ctls=row.querySelectorAll('input:not([type=hidden]),select,textarea,[role=switch]');
      if(ctls.length!==1) continue;
      const c=ctls[0];
      if(c.hasAttribute('aria-label')||c.hasAttribute('aria-labelledby')) continue;
      if(!lab.id) lab.id='ds-lbl-'+(c.id||String(++n));
      c.setAttribute('aria-labelledby',lab.id);
    }
  },

  initModal(){
    this._initThemeFollow();   // FR-STF-2
    const overlay=document.getElementById('modal-overlay');
    const modal=document.getElementById('modal');
    /**
     * ACCESSIBILITY_BASELINE_SRS FR-A11Y-18 (`UX-3`): 탭 줄이 **tablist** 다.
     *
     * 속성을 `index.html` 에 손으로 적지 않는다 — 탭이 열하나이고 하나를 빠뜨리면
     * 그 탭만 조용히 접근성 트리 밖으로 나간다. `data-tab` 에서 파생하면 탭을
     * 더하는 사람이 아무것도 기억하지 않아도 된다 (FR-A11Y-13 과 같은 규약).
     */
    const tabs=[...modal.querySelectorAll('.mtab')];
    modal.querySelector('.modal-tabs').setAttribute('role','tablist');
    for(const t of tabs){
      const id='panel-'+t.dataset.tab;
      t.setAttribute('role','tab');
      t.setAttribute('aria-controls',id);
      t.setAttribute('aria-selected',String(t.classList.contains('active')));
      const pn=document.getElementById(id);
      if(pn){
        pn.setAttribute('role','tabpanel');
        if(!t.id)t.id='mtab-'+t.dataset.tab;
        pn.setAttribute('aria-labelledby',t.id);
      }
    }
    /**
     * 닫는 길이 셋(닫기 버튼·바깥 클릭·Esc)이므로 **닫는 일도 한 자리**여야 한다.
     * 종전에는 세 자리가 각자 `classList.remove('open')` 을 불렀고, 그래서
     * 포커스 복귀를 더하면 세 곳에 같은 줄을 적어야 했다 — 그중 하나를 빠뜨리는
     * 것이 `UX-3` 가 보고한 부류의 결함이다.
     */
    let releaseDlg=null;
    const closeSettings=()=>{
      if(!overlay.classList.contains('open'))return;
      overlay.classList.remove('open');
      if(releaseDlg){releaseDlg();releaseDlg=null}
    };
    document.getElementById('settings-btn').addEventListener('click',()=>{
      overlay.classList.add('open');
      // 연 컨트롤을 **명시로** 든다. `document.activeElement` 에 맡기면 키보드로
      // 연 경우와 클릭으로 연 경우가 갈린다 (클릭 뒤 포커스가 버튼에 남지 않는
      // 브라우저가 있다).
      releaseDlg=UIKit.dialogOpen(modal,{
        labelledBy:'.modal-title',
        returnTo:document.getElementById('settings-btn'),
      });
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
      const dsCfs=document.getElementById('ds-claudefs');
      if(dsCfs) dsCfs.checked=claudeFullscreen;
      this._labelSettingsRows();
      // FONT_SIZE_SETTING_SRS FR-FSS-21 · AGENT_RENDER_ENV_SRS FR-ARE-10: 숫자
      // 입력 셋도 열 때마다 다시 칠한다 (아래 FR-LVC-3 과 같은 근거).
      this._paintNumSettings();
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
      // FR-MMT-6: 미니맵도 같은 자리에서 다시 칠한다.
      const dsMini=document.getElementById('ds-minimap');
      if(dsMini) dsMini.checked=editorMinimap;
      // Auto-close drawer when opening settings on mobile
      if(this.isMobile && this.drawerOpen){this._toggleDrawer(false);this.renderer._rTopbar()}
    });
    document.getElementById('modal-close').addEventListener('click',closeSettings);
    overlay.addEventListener('click',e=>{if(e.target===overlay)closeSettings()});
    document.addEventListener('keydown',e=>{if(e.key==='Escape'&&overlay.classList.contains('open')){e.preventDefault();closeSettings()}});
    modal.querySelectorAll('.mtab').forEach(tab=>{
      tab.addEventListener('click',()=>{
        modal.querySelectorAll('.mtab').forEach(t=>{
          t.classList.remove('active');
          // `aria-selected` 와 `.active` 가 **같은 것을 말해야** 한다 — 갈라지면
          // 화면과 접근성 트리가 다른 탭을 가리킨다 (`TC-A11Y-8b` 가 짝을 본다).
          t.setAttribute('aria-selected','false');
        });
        tab.classList.add('active');
        tab.setAttribute('aria-selected','true');
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
    this._initUiFontScale();
    this._initFgNames();
    this._initBlockKeys();
    this._initClaudeFullscreen();
    this._initTermFontSize();
    this._initClaudeScrollSpeed();
    this._initConfirmLeave();
    this._initFocusEdge();
    this._initAttnEdge();
    this._initWordWrap();
    this._initMinimap();
    this._initLocale();
    this._initLSP();
    this._initBackup();
    this._initSandboxPanel();
    this._initAccessPanel();
  },
});
