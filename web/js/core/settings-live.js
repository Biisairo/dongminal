/**
 * Dongminal — 설정 패널의 실시간 갱신 (UX_BATCH12_SRS FR-LIV-4~6).
 *
 * 접속 허용 목록·샌드박스·노드 설정 패널이 함께 쓴다. 읽을 때 받은 지문(`ETag`)과 그때의
 * 폼 값을 기준으로 남긴다. 저장은 그 지문을 `If-Match` 로 싣는다. 방송이 오면 지문이 바뀐
 * 경우에만 움직인다 — 수정이 없으면 다시 그리고, 있으면 덮지 않고 그 패널에 알린다.
 *
 * `SettingsLive` 는 `SettingsController` 의 부품이다(`settings.live`, REFACTOR3_FE_APPCTL_SRS 9a). 기준(`_live`)을 든다.
 *
 * 로드 순서 계약: `app.js` 뒤, 설정 섹션 앞.
 */
const SETTINGS_LIVE_PANEL={access:'panel-access',sandbox:'panel-sandbox',edges:'panel-edges',profile:'panel-profile'};

class SettingsLive extends Controller {
  _liveOf(k){
    if(!this._live) this._live={};
    return this._live[k]||(this._live[k]={etag:'',base:''});
  }

  _liveTag(r){ return (r&&r.headers&&typeof r.headers.get==='function'&&r.headers.get('ETag'))||'' }

  /** 읽거나 저장한 뒤 부른다 — 지문과 지금 폼 값이 새 기준이다. 알림은 거둔다. */
  _liveMark(k,r,form){
    const l=this._liveOf(k);
    l.etag=this._liveTag(r);
    l.base=JSON.stringify(form);
    this.app._liveNotice(k,null);
    if(this.app._saveBtnsPaint) this.app._saveBtnsPaint(); // UX_AUDIT_FIX_SRS FR-UXF-72: 기준이 바뀌었다
  }

  /** FR-LIV-6: 저장하지 않은 수정은 지금 폼 값이 마지막으로 읽은 값과 다른 것이다. */
  _liveDirty(k,form){ return JSON.stringify(form)!==this._liveOf(k).base }

  /** FR-LIV-5: 저장 요청의 머리. 지문을 모르면 싣지 않는다. */
  _liveOpts(k){
    const e=this._liveOf(k).etag;
    return e?{headers:{'If-Match':e}}:undefined;
  }

  _liveOpen(k){
    const p=document.getElementById(SETTINGS_LIVE_PANEL[k]);
    const o=document.getElementById('modal-overlay');
    return !!(p&&!p.hidden&&o&&o.classList.contains('open'));
  }

  /** FR-LIV-4: 방송을 받았을 때. 지문이 같으면 이 패널과 무관한 변화다. */
  _liveChanged(k,r,form,reload){
    if(!this.app._liveOpen(k)) return;
    const tag=this._liveTag(r);
    if(tag&&tag===this._liveOf(k).etag) return;
    if(this._liveDirty(k,form)){ this.app._liveNotice(k,reload); return }
    reload();
  }

  /** FR-LIV-5: 409 를 받았으면 알린다. 참이면 낡은 저장이었다. */
  _liveStale(k,r,reload){
    if(!r||r.status!==409) return false;
    this.app._liveNotice(k,reload);
    return true;
  }

  /** 알림을 세우거나(reload 가 있을 때) 거둔다. 다시 불러오기 단추가 reload 를 부른다. */
  _liveNotice(k,reload){
    const p=document.getElementById(SETTINGS_LIVE_PANEL[k]);
    if(!p) return;
    const old=p.querySelector('.settings-stale');
    if(!reload){ if(old) old.remove(); return }
    if(old) return;
    const box=document.createElement('div');
    box.className='settings-stale';
    box.setAttribute('role','status');
    const msg=document.createElement('span');
    msg.textContent=t('settings.stale_notice');
    const btn=UIKit.button({label:t('settings.stale_reload'),size:'sm'});
    btn.addEventListener('click',()=>reload());
    box.append(msg,btn);
    p.prepend(box);
  }
  // 방송을 받는 `_onAccessChanged`·`_onSandboxChanged` 는 그 섹션에 있다 (REFACTOR3_FE_SETTINGS_SRS 8c).
}

// 설정 섹션·`EdgesController` 가 App 에서 부르는 이름 (FR-FEA-4). `_liveOpen`·`_liveNotice` 는 시험이 갈아 끼운다.
Controller.delegate(App,'settings.live',['_liveMark','_liveOpts','_liveOpen','_liveChanged','_liveStale','_liveNotice']);
