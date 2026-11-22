/**
 * 새 판 배지 (UPDATE_NOTICE_SRS 묶음 안내).
 *
 * **이 파일은 GitHub 을 모른다.** 브라우저가 `api.github.com` 으로 못 나가는
 * 것은 CSP(`connect-src 'self' ws: wss:`) 때문이고, 그것이 확인 주체를 서버로
 * 정했다 (D-UPD-1). 여기 있는 것은 서버 캐시를 **읽어 그리는 일**뿐이다.
 *
 * 폴링이 없다 (D-UPD-4). 하루에 한 번 바뀌는 값이라 `_pollStats` 의 3초 주기에
 * 얹으면 28,800배의 낭비다. 대신 읽는 계기가 셋이다 — 구독이 열릴 때
 * (`STATE_REGISTRY` 의 `revalidateOn`), 값이 바뀌어 `update_changed` 가 올 때,
 * 그리고 사용자가 토글을 바꿀 때.
 *
 * App 은 `UpdateController` 를 `update` 로 든다(REFACTOR3_FE_APPCTL_SRS 9a). 읽은 값 `_update` 는 App 에 남는다 —
 * 설정의 판 확인 토글(`settings-notify.js`)이 쓴다(FR-FEA-2).
 */
class UpdateController extends Controller {
  /**
   * `STATE_REGISTRY` 의 `update` 가 부른다. **캐시를 읽을 뿐 확인을 걸지
   * 않는다** — 확인을 거는 것은 서버의 SSE 연결 훅이다 (FR-UPD-2 ②).
   *
   * 503 은 판 확인이 없는 서버다. 그때는 배지도 토글도 없다 — 종전의 서버다.
   */
  _updateRestore(src){
    const flight=this.app._restoreBegin('update');
    return stateFetch(src,'/api/update').then(r=>{
      if(!this.app._restoreLive('update',flight)) return;
      this.app._update=r.ok?r.data:null;
      this._updateRender();
      this.app._restoreEnd('update',flight);
    });
  }

  /**
   * FR-UPD-9: **새 판이 있을 때만** 보인다. 최신이거나, 확인에 실패했거나,
   * 꺼져 있거나, 견줄 기준이 없는 개발 빌드면 아무것도 보이지 않는다
   * (FR-UPD-9b) — 서버가 `newer` 하나로 그 판정을 이미 끝내 놓는다.
   */
  _updateRender(){
    const u=this.app._update;
    // 판 확인이 없는 서버(503)에서는 설정 행 자체를 감춘다. 누를 수 없는 것을
    // 보여 주는 것은 고장으로 읽힌다.
    const cb=document.getElementById('ds-update-check');
    if(cb){
      const row=cb.closest('.ds-row');
      if(row) row.hidden=!u;
      cb.checked=!!(u&&u.enabled);
    }
    const show=!!(u&&u.enabled&&u.newer&&u.latest);
    // UX_AUDIT_FIX_SRS FR-UXF-92 (D-30): 모바일은 상태바가 없다 — ☰ 의 점과 서랍 바닥의 링크가 배지를 대신한다.
    // 링크는 배지와 같은 글자·주소다. 데스크톱에서는 `.mobile-only` 와 감춘 ☰ 가 둘을 가린다.
    const dot=document.querySelector('#m-drawer-toggle .m-update-dot');
    if(dot) dot.hidden=!show;
    for(const el of [document.getElementById('update-badge'),document.getElementById('m-update-link')]){
      if(!el) continue;
      el.hidden=!show;
      if(!show){ el.removeAttribute('href'); el.textContent=''; continue }
      el.textContent=t('update.badge',{version:u.latest});
      el.title=t('update.badge_title',{version:u.latest});
      if(u.link) el.href=u.link; else el.removeAttribute('href');
    }
  }
  // FR-UPD-15: 설정 페이지의 체크박스는 `NotifySection` 이 배선한다 (REFACTOR3_FE_SETTINGS_SRS 8b).
}
