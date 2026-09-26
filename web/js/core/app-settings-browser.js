/**
 * Dongminal — 설정창의 **브라우저 패널** (BROWSER_TAB_SRS FR-BRT-12·14·32·68·90).
 *
 * 프로필 목록은 **서버의 폴더가 진실**이다 (FR-BRT-10) — 설정 blob 에 목록을 두지
 * 않는다. 추가·삭제는 `/api/browser/profiles` 가 한다.
 *
 * 로드 순서: `app-settings.js` 뒤.
 */
Object.assign(App.prototype, {
  _initBrowserPanel(){
    const bind=(id,ev,fn)=>{const el=document.getElementById(id);if(el)el.addEventListener(ev,()=>fn(el))};
    bind('brv-set-placement','change',el=>{browserOpenPlacement=el.value==='tab'?'tab':'split';this.saveSettings()});
    bind('brv-set-link','change',el=>{browserLinkTarget=el.value==='viewer'?'viewer':'internal';this.saveSettings()});
    bind('brv-set-profile','change',el=>{browserDefaultProfile=el.value||'default';this.saveSettings()});
    bind('brv-set-audio','change',el=>{browserServerAudio=el.checked;this.saveSettings()});
    bind('brv-set-dldir','change',el=>{browserDownloadDir=el.value.trim();this.saveSettings()});
    const add=document.getElementById('brv-profile-add');
    const name=document.getElementById('brv-profile-name');
    if(add&&name){
      const go=async()=>{
        const n=name.value.trim();
        if(!n) return;
        const r=await apiPost(BROWSER_API.profiles,{name:n});
        if(!r.ok){this._brvProfileStatus(apiErrText(r,t('brv.set_profiles_fail')));return}
        name.value='';
        this._loadBrowserPanel();
      };
      add.addEventListener('click',go);
      name.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();go()}});
    }
  },

  _brvProfileStatus(msg){
    const st=document.getElementById('brv-profile-status');
    if(st) st.textContent=msg||'';
  },

  async _loadBrowserPanel(){
    const list=document.getElementById('brv-profiles');
    const sel=document.getElementById('brv-set-profile');
    if(!list||!sel) return;
    this._brvProfileStatus('');
    const r=await apiGet(BROWSER_API.profiles);
    if(!r.ok){this._brvProfileStatus(apiErrText(r,t('brv.set_profiles_fail')));return}
    const profiles=(r.data&&r.data.profiles)||[];
    list.textContent='';sel.textContent='';
    for(const p of profiles){
      const o=document.createElement('option');o.value=p.name;o.textContent=p.name;sel.appendChild(o);
      const row=document.createElement('div');row.className='brv-profile-row';
      const nm=document.createElement('span');nm.className='brv-profile-name';nm.textContent=p.name;
      row.appendChild(nm);
      if(p.running){const b=document.createElement('span');b.className='brv-profile-run';b.textContent=t('brv.set_profile_running');row.appendChild(b)}
      if(p.name!=='default'){
        const del=UIKit.button({label:t('brv.set_profile_delete'),kind:'ghost',size:'sm'});
        del.addEventListener('click',async()=>{
          // FR-BRT-13: 확인 한 번 (CONFIRM_ONE_STAGE_SRS).
          const ok=await this._confirmClose(t('brv.set_profile_delete_confirm'),{okLabel:t('brv.set_profile_delete')});
          if(ok!==true) return;
          const d=await apiPost(BROWSER_API.profileDelete,{name:p.name});
          if(!d.ok) this._brvProfileStatus(apiErrText(d,t('brv.set_profiles_fail')));
          this._loadBrowserPanel();
        });
        row.appendChild(del);
      }
      list.appendChild(row);
    }
    sel.value=browserDefaultProfile;
    if(sel.value!==browserDefaultProfile) sel.value='default';
  },
});
