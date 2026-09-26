/**
 * 설정 저장 파이프라인 — 비행 하나·디바운스·자기 에코 무시
 * (OPTIMIZE_REFACTOR_SRS FR-OPT-5-2 · APP_STATE_EXTRACT_SRS FR-ASE-9 · §2.3a).
 *
 * 이 가족의 상태 다섯은 `App` 이 아니라 여기 있다. 본문은 `app-settings.js`·
 * `app-settings-init.js` 에서 구간 이동했고 편집은 앱으로 나가는 자리(`this.app.`)뿐이다.
 * `_settingsAcceptRemote` 는 `_settingsRestore` 안에 있던 에코 판정 두 줄이다.
 *
 * **`_settingsApply`·`_settingsRestore` 는 `this.app.` 으로 부른다** (§2.3a A-6) — e2e
 * (`save-pipeline`)가 앱의 `_settingsApply` 를 갈아 끼워 재적용 수를 센다.
 */
class SettingsSync {
  constructor(app){ this.app=app }
}

Object.assign(SettingsSync.prototype, {
  /**
   * 설정 blob 전체를 서버에 쓴다.
   *
   * 블롭 전체를 갈아치우므로 읽어 쓰는 값은 전부 실어야 한다 — 여기서 빠지면
   * 다른 설정을 건드릴 때 조용히 사라진다.
   *
   * **그래서 나열하지 않는다** (CONFIG_MANAGEMENT_SRS FR-CFG-4). 본문은
   * 서술자 표에서 파생되므로, 키를 더하고 여기를 잊는 실패 모드가 없어진다.
   * `gitSignatureInterval` 이 표에 없는 것이 곧 싣지 않는다는 뜻이다 (FR-PIS-2).
   *
   * `FE-7`(PRODUCTION_ROADMAP §M3): **응답을 검사한다.** 종전에는 결과를
   * 버렸고, 그래서 디스크가 차거나 경계에 걸려 거절된 저장이 **성공처럼**
   * 보였다 — 사용자는 설정이 바뀐 줄 알고 다음 기동에서 옛 값을 만난다.
   *
   * OPTIMIZE_REFACTOR_SRS FR-OPT-5-2 (FEC-7): **비행은 하나다.** 비행 중에 부르면
   * 표시만 하고 그 비행의 약속을 돌려받는다 — 비행이 끝나면 최신 본문으로 한 번
   * 더 나간다. 전체 blob 두 개가 순서가 바뀌어 도착하면 옛 값이 남기 때문이다.
   * 약속은 마지막 PUT 의 성패로 풀린다. 던지면 거부되되 비행은 풀린다 (finally).
   * FEC-M3: `?clientId=` 가 방송의 `origin` 으로 돌아온다 (`_onSettingsChanged`).
   */
  saveSettings(){
    this._settingsDirty=true;
    if(this._settingsChain) return this._settingsChain;
    const run=async()=>{
      let ok=true;
      try{
        while(this._settingsDirty){
          this._settingsDirty=false;
          const body=JSON.stringify(this.app._settingsBody());
          // D-OPT-7: 보낸 본문을 **보내기 전에** 적는다 — 방송이 응답보다 먼저 온다.
          this._settingsLastSent=body;
          const res=await apiPut('/api/settings?clientId='+encodeURIComponent(this.app.clientId),body);
          ok=res.ok;
          if(!ok&&this.app._notify) this.app._notify(SETTINGS_SAVE_FAIL);
        }
      }finally{
        this._settingsChain=null; this._settingsDirty=false;
        // 비행 중에 받은 방송은 미뤄 두었다 — 남의 저장일 수 있으므로 이제 다시 본다.
        if(this._settingsEchoMissed){
          this._settingsEchoMissed=false;
          this.app._settingsRestore();
        }
      }
      return ok;
    };
    return (this._settingsChain=run());
  },

  // D-OPT-7: 로컬 저장이 대기 중인가 — 미룬 입력 · 비행 · 비행 뒤 한 번 더.
  _settingsLocalPending(){
    return !!(this._settingsChain||this._settingsDirty||
      (this._settingsSaveTimers&&this._settingsSaveTimers.size));
  },

  /**
   * FR-OPT-5-2 (FEC-6): 입력 중인 설정의 저장을 미룬다. `key` 는 입력란 하나이고,
   * 같은 키의 다음 입력이 타이머를 다시 건다 — 글자·드래그마다 PUT 을 보내지 않는다.
   */
  _saveSettingsSoon(key){
    const timers=this._settingsSaveTimers||(this._settingsSaveTimers=new Map());
    TIMERS.cancel(timers.get(key));
    timers.set(key,this.app.timers.after(SETTINGS_SAVE_DEBOUNCE_MS,()=>{
      timers.delete(key);
      this.saveSettings();
    },{owner:'app',label:'save-'+key}));
  },

  /**
   * 확정(`blur`·`change`)은 미루지 않는다. 디바운스는 입력 **중**의 요청 수를
   * 줄이는 장치이지 정해진 값을 늦추는 장치가 아니다 (실측 W7: 값을 바꾸고 바로
   * 새로고침하면 입력이 통째로 날아갔다).
   */
  _saveSettingsNow(key){
    const timers=this._settingsSaveTimers;
    if(timers&&timers.has(key)){ TIMERS.cancel(timers.get(key)); timers.delete(key) }
    return this.saveSettings();
  },

  /**
   * OPTIMIZE_REFACTOR_SRS D-OPT-7 (FEC-4 · FEC-M3): **자기 에코는 얹지 않는다.**
   *
   * 방송은 보낸 쪽에도 온다. 받은 blob 이 마지막으로 보낸 본문과 같으면 이미
   * 화면의 값이고, 얹으면 테마·단축키를 통째로 다시 적용하며 `customTheme` 을
   * 새 객체로 갈아 끼운다. 로컬 저장이 대기 중이면 받은 blob 은 곧 우리 것에
   * 덮이므로 얹지 않고, 그 저장이 끝난 뒤 한 번 더 본다 (`saveSettings`).
   * 부르는 자리는 `_settingsRestore` 다.
   */
  _settingsAcceptRemote(r){
    if(this._settingsLocalPending()) this._settingsEchoMissed=true;
    else if(!(r.ok&&r.text===this._settingsLastSent)) this.app._settingsApply(r.ok?r.data:null);
  },
});
