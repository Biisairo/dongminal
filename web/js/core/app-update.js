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
 */
Object.assign(App.prototype, {
  /**
   * `STATE_REGISTRY` 의 `update` 가 부른다. **캐시를 읽을 뿐 확인을 걸지
   * 않는다** — 확인을 거는 것은 서버의 SSE 연결 훅이다 (FR-UPD-2 ②).
   *
   * 503 은 판 확인이 없는 서버다. 그때는 배지도 토글도 없다 — 종전의 서버다.
   */
  _updateRestore(){
    const t=this._restoreBegin('update');
    return apiGet('/api/update').then(r=>{
      if(!this._restoreLive('update',t)) return;
      this._update=r.ok?r.data:null;
      this._updateRender();
      this._restoreEnd('update',t);
    });
  },

  /**
   * FR-UPD-9: **새 판이 있을 때만** 보인다. 최신이거나, 확인에 실패했거나,
   * 꺼져 있거나, 견줄 기준이 없는 개발 빌드면 아무것도 보이지 않는다
   * (FR-UPD-9b) — 서버가 `newer` 하나로 그 판정을 이미 끝내 놓는다.
   */
  _updateRender(){
    const u=this._update;
    // 판 확인이 없는 서버(503)에서는 설정 행 자체를 감춘다. 누를 수 없는 것을
    // 보여 주는 것은 고장으로 읽힌다.
    const cb=document.getElementById('ds-update-check');
    if(cb){
      const row=cb.closest('.ds-row');
      if(row) row.hidden=!u;
      cb.checked=!!(u&&u.enabled);
    }
    const el=document.getElementById('update-badge');
    if(!el) return;
    const show=!!(u&&u.enabled&&u.newer&&u.latest);
    el.hidden=!show;
    if(!show){ el.removeAttribute('href'); el.textContent=''; return }
    el.textContent=t('update.badge',{version:u.latest});
    el.title=t('update.badge_title',{version:u.latest});
    if(u.link) el.href=u.link; else el.removeAttribute('href');
  },

  /**
   * FR-UPD-15: 설정 페이지의 체크박스. **이 값만 `/api/settings` 가 아니라
   * `/api/update` 로 간다** (D-UPD-2) — 서버가 읽어야 하는 값이고, 설정 블롭은
   * 서버가 해석하지 않는다 (D-CFG-1).
   *
   * 판 확인이 없는 서버(503)에서는 행을 감춘다. 누를 수 없는 것을 보여 주는
   * 것은 고장으로 읽힌다.
   */
  initUpdateSettings(){
    const cb=document.getElementById('ds-update-check');
    if(!cb) return;
    cb.addEventListener('change',()=>{
      const on=cb.checked;
      apiPut('/api/update',{enabled:on}).then(r=>{
        if(r.ok&&r.data){ this._update=r.data; this._updateRender(); return }
        // 서버가 받지 못했다. 화면만 바뀐 채로 두면 껐다고 믿게 된다 —
        // 그것이 §1.2 가 막으려는 거짓말이다.
        cb.checked=!on;
      });
    });
  },
});
