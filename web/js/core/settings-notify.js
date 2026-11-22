/**
 * NotifySection — Settings ▸ Notify (REFACTOR3_FE_SETTINGS_SRS 8b).
 *
 * 데스크톱 알림·소리 두 스위치는 기기별 값이고(`attnDesktop`·`attnSound`), 판 확인은 **이 행만 `/api/update` 로
 * 간다**(UPDATE_NOTICE_SRS D-UPD-2). 저장 경로가 다른 세 행이라 `FormRow` 로 맞추지 않는다(FR-FES-4). 알림 센터의
 * 배지·해제 입구는 설정이 아니므로 `initAttn` 에 남는다.
 */
class NotifySection extends SettingsSection {
  constructor(app){ super(app,'notify') }

  init(){
    const app=this.app;
    const dt=document.getElementById('attn-desktop');
    if(dt){
      dt.checked=app.attnDesktop;
      this.listen(dt,'change',()=>{
        if(dt.checked&&typeof Notification!=='undefined'&&Notification.permission==='default'){
          Notification.requestPermission().then(p=>{if(p!=='granted'){dt.checked=false;app.attnDesktop=false}});
        }
        app.attnDesktop=dt.checked;
      });
    }
    // TLS-1: 동작할 수 없는 환경이면 **끄고 사유를 말한다.**
    app.attn._attnSecurityNotice();
    const sd=document.getElementById('attn-sound');
    if(sd){
      sd.checked=app.attnSound;
      this.listen(sd,'change',()=>{app.attnSound=sd.checked});
    }
    this._initUpdateCheck();
  }

  /**
   * FR-UPD-15: 판 확인 체크박스. **이 값만 `/api/settings` 가 아니라 `/api/update` 로 간다** (D-UPD-2) — 서버가
   * 읽어야 하는 값이고, 설정 블롭은 서버가 해석하지 않는다 (D-CFG-1).
   *
   * 판 확인이 없는 서버(503)에서는 행을 감춘다 — 감추고 칠하는 것은 `_updateRender` 다. 누를 수 없는 것을
   * 보여 주는 것은 고장으로 읽힌다.
   */
  _initUpdateCheck(){
    const cb=document.getElementById('ds-update-check');
    if(!cb) return;
    const app=this.app;
    this.listen(cb,'change',()=>{
      const on=cb.checked;
      apiPut('/api/update',{enabled:on}).then(r=>{
        if(r.ok&&r.data){ app._update=r.data; app.update._updateRender(); return }
        // 서버가 받지 못했다. 화면만 바뀐 채로 두면 껐다고 믿게 된다 —
        // 그것이 §1.2 가 막으려는 거짓말이다.
        cb.checked=!on;
      });
    });
  }
}
