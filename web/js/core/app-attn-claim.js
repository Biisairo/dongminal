/**
 * Remote Terminal — 한 컴퓨터에서 한 번 (ATTENTION_FIRING_SRS 묶음 D)
 *
 *   이전 동작: 알람을 받은 모든 창이 배너와 소리를 냈다 — 창이 둘이면 두 번 울었다
 *   새  동작: 화면 표식은 모든 창에, 배너·소리는 컴퓨터마다 낼 수 있는 창 하나에서
 *   이유:     같은 알람이 창 수만큼 반복되어 "연달아 운다" 로 접수됐다 (§1.13)
 *
 * 창끼리 브라우저 안에서 묻지 않는다 — Web Locks 는 secure context 에만 있고
 * BroadcastChannel 은 같은 출처끼리만 닿는다 (B18). 서버가 컴퓨터마다 처음 든 손
 * 하나를 승낙한다 (FR-ATD-4·5).
 *
 * **제 파일에 사는 이유.** `app-attn.js` 가 500줄 기준에 닿아 있다 (FR-STR-40).
 * 이 파일은 "낼지" 만 알고, 내는 일(`_attnDesktopNotify`·`_attnBeep`)과 알람의
 * 수명은 `app-attn.js` 의 것이다.
 *
 * 로드 순서 계약: `app.js` 뒤, `app-attn.js` 뒤.
 */

Object.assign(App.prototype, {

  // FR-ATD-3: 배너를 낼 수 있는가 — 켜져 있고, 막힌 환경이 아니며, 권한이 있다.
  _attnCanBanner(){
    return !!this.attnDesktop&&!this.attnDesktopBlocked&&
      typeof Notification!=='undefined'&&Notification.permission==='granted';
  },

  // FR-ATD-3: 소리를 낼 수 있는가 — 켜져 있고, 이 창에서 사용자 조작이 있었다.
  // 브라우저는 조작이 없던 창의 소리를 막는다. 그 사실을 알 수 없으면 있었다고 본다.
  _attnCanSound(){
    if(!this.attnSound) return false;
    const ua=typeof navigator!=='undefined'?navigator.userActivation:null;
    return ua?!!ua.hasBeenActive:true;
  },

  /**
   * 알람 하나의 배너·소리를 낼지 정하고 낸다.
   *
   * FR-ATD-7: 청구가 실패하면 낸다 — 망 오류·비 2xx·읽을 수 없는 응답 모두. 중복은
   * 침묵보다 낫다 (D-10). FR-ATD-8: 번호가 없으면(옛 서버) 청구 없이 낸다.
   */
  async _attnAnnounce(reason,toolId,seq){
    const kinds=[];
    if(this._attnCanBanner()) kinds.push('banner');
    if(this._attnCanSound()) kinds.push('sound');
    if(!kinds.length) return;
    let granted=kinds;
    if(seq){
      const res=await apiPost('/api/tools/attention/claim',{seq,kinds});
      if(res&&res.ok&&res.data&&Array.isArray(res.data.granted)) granted=res.data.granted;
    }
    if(granted.includes('banner')) this._attnDesktopNotify(reason,toolId); // FR-PAN-13a
    if(granted.includes('sound')) this._attnBeep(); // FR-PAN-13c
  },
});
