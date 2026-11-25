/**
 * SettingsController — 설정 탭들의 조정자 (REFACTOR3_FE_SETTINGS_SRS FR-FES-6·7, 8e).
 *
 * 탭 하나는 `SettingsSection` 하위 하나다. 이 컨트롤러가 섹션을 들고(`section(tab)`·`all()`), 부팅 때 세우고,
 * 설정을 열 때·탭을 고를 때 섹션의 `onOpen`·`onTab` 을 부른다. App 은 이것 하나를 `settings` 로 든다(FR-FES-7).
 *
 * REFACTOR3_FE_APPCTL_SRS 9a: App 생성자가 만든다 — 값의 길(`SettingsApply`)은 설정창보다 먼저 돈다. 부품 셋을
 * 든다: `apply`(저장·적용·복원과 즉시 반영) · `live`(패널의 실시간 갱신) · `saveState`(저장 단추). 열기·검색·라벨도 여기다.
 *
 * PERF D-41: 이 컨트롤러는 부팅 껍데기다. 부팅의 `init` 은 표 `SETTINGS_BOOT` 와 섹션이 하던 부팅 효과만 돌린다. 설정 창
 * (모달·섹션)은 `settings` 화면 묶음이고, 처음 열 때 `ready` 가 싣고 그 묶음의 표 `SETTINGS_INIT`(`settings-open.js`)대로
 * 세운다. 그 전에는 섹션이 없다 — `section(tab)` 은 null 이고 `paint` 는 아무것도 하지 않는다. 열 때의 순서는 `onOpen` 의
 * 본문이 말한다(INV-S3).
 * 모바일 두 화면과 검색은 섹션이 모른다 — 이 컨트롤러가 App 의 것을 부른다(§1.3).
 */

/**
 * 부팅 몫 (PERF D-41). 설정 창과 무관한 주제의 init 이다 — 옛 `SETTINGS_INIT` 에서 섹션 사이에 돌던 자리의 상대 순서 그대로다.
 * 설정 창(모달·섹션)을 세우는 열기 몫은 `settings` 화면 묶음의 `SETTINGS_INIT`(`settings-open.js`)이다. 이름은 앱에서
 * 주인까지의 점 경로다 (REFACTOR3_FE_DELEG_SRS FR-DLG-3).
 */
const SETTINGS_BOOT=['statusbar.initStatusBar','mobile.initMobile','mobile.initMobileKeybar','attn.initAttn'];

/**
 * REFACTOR3_FE_FIX_SRS FR-FFX-9: 서버에서 값을 읽어 그리는 패널. 설정을 열 때 고른 탭이 이 가운데 하나면 다시 읽고,
 * 읽기는 섹션마다 하나만 난다(`_reread`). profile·claude 도 열 때 다시 읽지만 자기 `onOpen` 이 한다(순서 계약 INV-S3).
 */
const SETTINGS_REREAD=['access','sandbox','edges','telegram','server'];

class SettingsController extends Controller {
  constructor(app){
    super(app);
    this._sections=new Map();
    this._reading=new Map();
    this.modal=null;
    this.apply=new SettingsApply(app);
    this.live=new SettingsLive(app);
    this.saveState=new SettingsSaveState(app);
  }

  /**
   * 부팅 때 한 번 (PERF D-41). 섹션이 부팅에 하던 일 — 탭 폭·글꼴 배율 적용(옛 `DisplaySection.init`)과 시스템 모드
   * 추종(옛 `ThemeSection.init`) — 을 여기서 하고, 부팅 몫의 init 을 돌린 뒤 설정 단추를 건다. 설정 창은 처음 열 때 선다.
   */
  init(){
    applyTabWidth();
    applyUiFontScale();
    this._initThemeFollow();
    for(const step of SETTINGS_BOOT) this._step(step);
    document.getElementById('settings-btn').addEventListener('click',()=>this._openSettings().catch(e=>ErrorLog.push('settings',(e&&e.message)||e)));
    return this;
  }

  /** 점 경로의 init 하나를 부른다. */
  _step(path){
    const keys=path.split('.'), last=keys.pop();
    keys.reduce((o,k)=>o[k],this.app)[last]();
  }

  /**
   * 설정 창 본체를 세운다 — `settings` 묶음을 싣고, 처음이면 열기 몫(`settingsBuild`)을 돈다. 여러 번 불러도 한 번 선다.
   * 실패하면 거절한다. 묶음 로더는 실패를 기억하지 않으므로 다음 부름이 다시 싣는다(D-30).
   */
  async ready(){
    await Screens.load('settings');
    if(!this.modal) settingsBuild(this);
    return this;
  }

  /** SYSTEM_THEME_FOLLOW_SRS FR-STF-2: 시스템 모드가 바뀌면 그 자리에서 다시 고른다 — 새로고침이 없다. 설정 창이 서 있으면 목록도 다시 그린다. */
  _initThemeFollow(){
    if(typeof matchMedia!=='function') return;
    const mq=matchMedia('(prefers-color-scheme: dark)');
    const on=()=>{if(themeFollowSystem){this.apply._applyThemeChoice();this.section('theme')?._renderThemePanel()}};
    if(mq.addEventListener) this.listen(mq,'change',on); else if(mq.addListener) mq.addListener(on);
  }

  /**
   * HOT_REBIND_SRS FR-HRB-26: 채널 `cmd` 의 `server_moving` — 이 화면도 새 주소로 간다. 적용 응답(`ServerSection._srvApply`)과 겹쳐
   * 와도 한 번만 간다. 설정 창을 연 적이 없어도 가야 하므로 부팅 껍데기에 있다 (PERF D-41).
   */
  _onServerMoving(a){
    if(this._srvMoving||!a||!a.port) return;
    this._srvMoving=true;
    this._serverMoveTo(String(a.port));
  }

  _serverMoveTo(port){ return serverMoveNow(port) }

  /** 섹션을 들고 `init()` 을 부른다. */
  start(section){
    this._sections.set(section.tab,section);
    section.init();
    return section;
  }

  section(tab){ return this._sections.get(tab)||null }

  /** 세운 순서다. */
  all(){ return [...this._sections.values()] }

  /**
   * 칠하기 한 자리 — 섹션마다 `paint()`. App 의 `_paintSettingControls` 가 이것이다.
   *
   * OPTIMIZE_REFACTOR_SRS FR-OPT-1-12 (FEC-26): 설정창의 행을 **지금 값으로** 칠한다.
   * 계기는 셋이다 — 부팅(`init`) · 값을 얹은 뒤(`_settingsApply`) · 설정창을 열 때
   * (FR-LVC-3). 행은 섹션이 `FormRow` 로 선언한다(REFACTOR3_FE_SETTINGS_SRS FR-FES-2) —
   * 포커스를 쥔 입력란을 건너뛰는지도 행마다 정해져 있다(`guard`).
   */
  paint(){
    for(const s of this._sections.values()) s.paint();
  }

  /**
   * 설정창을 열 때 (`SettingsModal` 의 `onOpen`). 열 때마다 현재 값을 다시 칠한다 — FR-LVC-3 · FR-WBR-10 ·
   * FR-MMT-6 · FR-UXB-43 · FR-FSS-21: 다른 화면에서 바뀐 값이 이 모달에 옛 상태로 남아 있으면 사용자가 그것을
   * 켜진 줄로 읽는다. 숫자 입력란도 확정하지 않은 글자(`999` 를 치고 `Esc`)를 여기서 맞춘다. 포커스는 다음
   * 프레임에 오므로 여기서는 전부 칠해진다.
   *
   * 순서가 계약이다(INV-S3) — 모든 섹션을 돌지 않는다. profile 은 검색 비우기 뒤다(REFACTOR3_FE_ESC_SRS FR-FEE-9:
   * 종전 `#settings-btn` 클릭 리스너 셋의 실행 순서 — 검색 비우기 → 프로필 읽기 → 모바일 머리와 목록 화면).
   * 목록 화면은 열기·패널 칠하기 뒤여야 한다.
   */
  onOpen(modal){
    const app=this.app;
    this._hook('theme','onOpen');
    this._hook('shortcuts','onOpen');
    this._hook('presets','onOpen');
    this._hook('display','onOpen');
    this.paint();
    this._labelSettingsRows();
    this._hook('claude','onOpen');
    if(app.isMobile&&app.drawerOpen) app.mobile._toggleDrawer(false);
    if(this._settingsSearchReset) this._settingsSearchReset();
    this._hook('profile','onOpen');
    this._rereadOnOpen();
    app.mobile.sheets._settingsMobileOnOpen(modal);
  }

  /**
   * REFACTOR3_FE_FIX_SRS FR-FFX-9·10: 고른 탭이 서버 패널이면 다시 읽는다 — 닫은 사이 다른 창·기기에서 바뀐 값이 옛 상태로
   * 남지 않게. 고르지 않은 패널은 탭을 누를 때 읽으므로 묻지 않는다(D-FFX-7). 저장하지 않은 수정이 있으면 지우지 않는다.
   *   이전: 다섯 패널은 탭을 누를 때만 읽었다 — 고른 채 닫았다 다시 열면 닫기 전에 읽은 값이 남았다
   *   새:   열 때 고른 패널을 다시 읽는다
   */
  _rereadOnOpen(){
    const tab=this.modal&&this.modal.current();
    if(!SETTINGS_REREAD.includes(tab)) return;
    const s=this.section(tab);
    if(!s||(s.dirty?s.dirty():settingsPanelDirty(this.app,'panel-'+tab))) return;
    this._reread(tab);
  }

  /**
   * FR-FFX-11 (D-FFX-8): 서버 패널의 읽기는 섹션마다 하나만 난다. 읽는 중에 다시 부르면(열고 닫기 되풀이·탭 누르기) 새 요청을
   * 내지 않고 그 약속을 돌려준다 — 겹친 요청이 없으니 늦게 온 옛 응답이 새 값을 덮을 일도 없다.
   */
  _reread(tab){
    let p=this._reading.get(tab);
    if(!p){
      p=Promise.resolve(this.section(tab).onTab()).finally(()=>this._reading.delete(tab));
      this._reading.set(tab,p);
    }
    return p;
  }

  /**
   * 탭을 골랐을 때 (`SettingsModal` 의 `onTab`). 고른 탭의 DOM 은 이미 바뀌었다. 탭별 재조회(sandbox·access·
   * profile·edges·telegram·server·claude)·code 탭의 관측·프리셋 목록은 그 섹션의 `onTab` 이다. 서버 패널 다섯은
   * 열 때의 다시 읽기와 같은 비행 하나를 지난다(FR-FFX-11).
   */
  onTab(tab){
    if(SETTINGS_REREAD.includes(tab)&&this.section(tab)) return this._reread(tab);
    this._hook(tab,'onTab');
  }

  _hook(tab,name){
    const s=this.section(tab);
    if(s) s[name]();
  }

  /**
   * SANDBOX_PICK_COPY_SRS FR-SPK-7: 설정 화면을 특정 탭으로 연다.
   *
   * 여는 절차는 `SettingsModal.open()` 한 자리다(REFACTOR3_FE_ESC_SRS FR-FEE-9). 탭은 탭 요소를 **실제로
   * 누른다** — 탭별 재조회와 모바일 상세 화면이 그 리스너 안에 있다.
   */
  async _openSettings(tab){
    await this.ready();
    this.modal.open();
    if(!tab) return;
    const tabEl=document.querySelector('#modal .mtab[data-tab="'+tab+'"]');
    if(tabEl) tabEl.click();
  }

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
  }

  /**
   * UI_POLISH_SRS FR-UIP-23: 설정 검색. 탭 이름(영어 툴팁도, FR-UXF-40)이나 그 탭 안의 글(항목 라벨·설명)에
   * 입력이 들어 있는 탭만 목록에 남긴다. 선택지(`<option>`)의 글은 보지 않는다 —
   * 언어·테마 이름 같은 값이 거의 모든 낱말에 걸린다.
   * 고른 탭이 걸러지면 남은 첫 탭으로 옮긴다. 모달을 열 때마다 비운다.
   */
  _bindSettingsSearch(modal){
    const input=document.getElementById('modal-search'); if(!input) return;
    const textOf=root=>{
      const w=document.createTreeWalker(root,NodeFilter.SHOW_TEXT,{acceptNode:n=>
        n.parentElement&&n.parentElement.closest('option,select,script,style')
          ?NodeFilter.FILTER_REJECT:NodeFilter.FILTER_ACCEPT});
      let out='';
      for(let n=w.nextNode();n;n=w.nextNode()) out+=' '+n.nodeValue;
      return out.toLowerCase();
    };
    const apply=()=>{
      const q=input.value.trim().toLowerCase();
      const tabs=[...modal.querySelectorAll('.mtab')];
      for(const tab of tabs){
        const pn=document.getElementById('panel-'+tab.dataset.tab);
        tab.hidden=!!q&&!((tab.textContent+' '+tab.title).toLowerCase().includes(q)||(pn&&textOf(pn).includes(q)));
      }
      for(const g of modal.querySelectorAll('.mtab-grp')) g.hidden=!!q; // FR-STO-4: 거른 목록에 묶음 이름은 없다
      const cur=modal.querySelector('.mtab.active');
      if(cur&&cur.hidden&&!(this.app.isMobile&&modal.dataset.mview==='list')){   // MOBILE_UX_OVERHAUL_SRS FR-MUX-21: 모바일 목록에서는 상세로 넘기지 않는다
        const first=tabs.find(x=>!x.hidden);
        if(first) first.click();
      }
    };
    input.addEventListener('input',apply);
    this._settingsSearchReset=()=>{input.value='';apply()};   // 열 때 비운다(`SettingsController.onOpen`)
  }

  /**
   * 섹션의 이름을 부르는 길 — 그 탭의 섹션이 없으면(`init` 전) 아무것도 하지 않는다. 설정 적용 길(`SettingsApply`)은
   * 이것을 부르지 않는다 — 칠하기는 `paint()` 한 자리다(QUALITY_FIX_SRS FR-QFX-9). 남은 쓰임은 저장 단추 판정
   * (`SETTINGS_SAVE_LIVE`)이다. 다른 자리는 `section(tab)?.X()` 로 부른다 (REFACTOR3_FE_DELEG_SRS D-DLG-4).
   */
  _sectionCall(tab,name,args){
    const s=this.section(tab);
    return s?s[name](...args):undefined;
  }
}


// PERF D-41: 설정 창 본체는 `settings` 묶음이다. 탭이 아니라 모달이라 `tab` 이 없다 — `ready` 가 싣는다.
// 설정 ▸ Edges 의 망 그림이 `chat` 묶음의 `edges-mesh.js` 를 쓰므로 그것을 먼저 싣는다 (PERF 3.4.12.10, D-47).
Screens.register('settings',{needs:['chat']});
