/**
 * Dongminal — 설정 행 저장 단추의 활성 (UX_AUDIT_FIX_SRS FR-UXF-70~72, 사용자 결정 D-24).
 *
 * 저장 단추는 저장할 변경이 있을 때만 활성이고, 활성이면 주동작 모양이다. 자리는 행 그대로다.
 *
 *   이전 동작: 저장 단추가 늘 활성이었다 — 바꾼 것이 있는지, 저장했는지를 단추가 말하지 않았다
 *   새  동작: 아래 표의 판정이 참일 때만 활성
 *   이유:     진단 D6·M13
 *
 * `SettingsSaveState` 는 `SettingsController` 의 부품이다(`settings.saveState`, REFACTOR3_FE_APPCTL_SRS 9a). 판정 함수는
 * 종전대로 App 을 받는다.
 *
 * 로드 순서 계약: `settings-live.js` 뒤.
 */

/** FR-UXF-70: 토큰은 저장 뒤 입력을 비우므로 읽은 값이 없다 — 무엇이든 적혀 있으면 변경이다. */
function tgTokenDirty(v){ return String(v||'').trim()!=='' }

/** FR-UXF-70: 조용한 시간은 서버 값과 다를 때 변경이다. 서버 값을 모르면 변경이 없다. */
function tgSilenceDirty(tg,v){ return !!tg&&(parseInt(v,10)||0)!==(tg.silenceMin||0) }

const SETTINGS_SAVE_LIVE=(k,collect)=>app=>app.settings.live._liveOf(k).base!==''&&app.settings.live._liveDirty(k,app[collect]());
const SETTINGS_SAVE_VAL=id=>{const e=document.getElementById(id);return e?e.value:''};

/** FR-UXF-70: 단추 · 그 패널 · 변경 판정. `#ds-layout-save` 는 폼 값이 없는 동작이라 대상이 아니다. */
const SETTINGS_SAVE_BTNS=[
  {btn:'pf-save',         panel:'panel-profile',  dirty:SETTINGS_SAVE_LIVE('profile','_pfCollect')},
  {btn:'acl-save',        panel:'panel-access',   dirty:SETTINGS_SAVE_LIVE('access','_aclCollect')},
  {btn:'eg-save',         panel:'panel-edges',    dirty:SETTINGS_SAVE_LIVE('edges','_egNodeCollect')},
  {btn:'sbx-save',        panel:'panel-sandbox',  dirty:SETTINGS_SAVE_LIVE('sandbox','_sbxCollect')},
  {btn:'tg-token-save',   panel:'panel-telegram', dirty:()=>tgTokenDirty(SETTINGS_SAVE_VAL('tg-token'))},
  {btn:'tg-silence-save', panel:'panel-telegram', dirty:app=>tgSilenceDirty(app._tg,SETTINGS_SAVE_VAL('tg-silence'))},
];

/**
 * REFACTOR3_FE_FIX_SRS FR-FFX-10: 패널에 저장하지 않은 수정이 있는가 — 그 패널의 저장 단추 판정 하나라도 참이면 그렇다.
 * 설정을 열 때 다시 읽을지 가른다(`SettingsController._rereadOnOpen`): 수정이 있으면 지우지 않는다.
 */
function settingsPanelDirty(app,panel){
  return SETTINGS_SAVE_BTNS.some(d=>d.panel===panel&&!!d.dirty(app));
}

class SettingsSaveState extends Controller {
  /** FR-UXF-71·72: 모든 저장 단추를 다시 판정한다. */
  _saveBtnsPaint(){
    for(const d of SETTINGS_SAVE_BTNS){
      const b=document.getElementById(d.btn);
      if(!b) continue;
      const on=!!d.dirty(this.app);
      b.disabled=!on;
      b.classList.toggle('ui-btn-primary',on);
    }
  }

  /** FR-UXF-72: 패널 안의 입력·바꿈·클릭 뒤에 다시 판정한다. */
  initSaveButtons(){
    const seen=new Set();
    for(const d of SETTINGS_SAVE_BTNS){
      const p=document.getElementById(d.panel);
      if(!p||seen.has(p)) continue;
      seen.add(p);
      for(const ev of ['input','change','click']) p.addEventListener(ev,()=>this.app._saveBtnsPaint());
    }
    this.app._saveBtnsPaint();
  }
}

// `settings-telegram.js`·`SettingsLive` 와 부팅 표 `SETTINGS_INIT` 이 App 에서 부르는 이름 (FR-FEA-4).
Controller.delegate(App,'settings.saveState',['_saveBtnsPaint','initSaveButtons']);
