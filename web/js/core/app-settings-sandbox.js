/**
 * Dongminal — 설정창의 **샌드박스 패널** (FE_MODULE_BOUNDARY_SRS FR-FMB-10).
 *
 * 샌드박스 설정 (SANDBOX_WINDOW_SRS FR-SBX-43).
 *
 * 기본 마운트는 손으로 적기에 실수하기 쉬운 값이다 — 경로 두 개와 두 개의
 * 표식이 한 항목을 이룬다. 그래서 파일을 직접 고치게 두지 않고 여기서 다룬다.
 */
Object.assign(App.prototype, {
  _sbxMountRow(m={}){
    const row=document.createElement('div');row.className='sbx-mount';
    const mk=(cls,ph,val)=>{
      const i=document.createElement('input');
      i.type='text';i.className=cls;i.placeholder=ph;i.value=val||'';
      return i;
    };
    const host=mk('sbx-host','~/.ssh',m.host);
    const cont=mk('sbx-cont','/root/.ssh',m.container);
    const flag=(label,title,on)=>{
      const l=document.createElement('label');l.className='sbx-flag';l.title=title;
      const c=document.createElement('input');c.type='checkbox';c.checked=!!on;
      const s=document.createElement('span');s.textContent=label;
      l.appendChild(c);l.appendChild(s);return l;
    };
    const ro=flag('ro','읽기 전용으로 붙입니다',m.readonly);
    // 이 표식이 켜지면 그 창은 더 이상 격리 경계가 아니다 (FR-SBX-39b).
    const sc=flag('scratch','격리 창에도 붙입니다 — 켜면 그 창은 격리 경계가 아니게 됩니다',m.scratch);
    const del=UIKit.button({icon:'x',title:'Remove this mount',kind:'ghost',size:'sm',cls:'sbx-del'});
    del.addEventListener('click',()=>row.remove());
    row.append(host,cont,ro,sc,del);
    return row;
  },

  _sbxCollect(){
    const mounts=[];
    for(const row of document.querySelectorAll('#sbx-mounts .sbx-mount')){
      const host=row.querySelector('.sbx-host').value.trim();
      const container=row.querySelector('.sbx-cont').value.trim();
      // 양쪽이 다 빈 줄은 사용자가 추가만 하고 두고 간 것이다 — 조용히 버린다.
      if(!host&&!container) continue;
      const [ro,sc]=row.querySelectorAll('.sbx-flag input');
      mounts.push({host,container,readonly:ro.checked,scratch:sc.checked});
    }
    const image=document.getElementById('sbx-image').value.trim();
    const portsRaw=document.getElementById('sbx-ports').value.trim();
    const cfg={};
    if(mounts.length) cfg.mounts=mounts;
    if(image){
      const ports=portsRaw?portsRaw.split(',').map(s=>s.trim()).filter(Boolean):[];
      cfg.dev=ports.length?{image,ports}:{image};
    }
    return cfg;
  },

  async _loadSandboxPanel(){
    const box=document.getElementById('sbx-mounts');
    const status=document.getElementById('sbx-status');
    if(!box) return;
    box.innerHTML='';status.textContent='';status.classList.remove('err');
    try{
      const r=await apiGet('/api/sandbox/config');
      if(!r.ok){
        // 런타임이 없으면 설정할 대상 자체가 없다. 빈 화면보다 이유가 낫다.
        status.textContent=r.text.trim()||'샌드박스 설정을 읽지 못했습니다';
        status.classList.add('err');
        return;
      }
      const cfg=r.data||{};
      document.getElementById('sbx-image').value=(cfg.dev&&cfg.dev.image)||'';
      document.getElementById('sbx-ports').value=(cfg.dev&&cfg.dev.ports||[]).join(', ');
      for(const m of cfg.mounts||[]) box.appendChild(this._sbxMountRow(m));
    }catch(e){
      status.textContent='샌드박스 설정을 읽지 못했습니다 — '+((e&&e.message)||e);
      status.classList.add('err');
    }
  },

  _initSandboxPanel(){
    const add=document.getElementById('sbx-mount-add');
    const save=document.getElementById('sbx-save');
    if(!add||!save) return;
    add.addEventListener('click',()=>
      document.getElementById('sbx-mounts').appendChild(this._sbxMountRow()));
    save.addEventListener('click',async()=>{
      const status=document.getElementById('sbx-status');
      status.classList.remove('err');status.textContent='저장 중…';
      try{
        const r=await apiPut('/api/sandbox/config',this._sbxCollect());
        if(!r.ok){
          // 거부 사유가 그대로 온다 — 무엇이 잘못됐는지 모르면 고칠 수 없다.
          status.textContent=r.text.trim()||'저장하지 못했습니다';
          status.classList.add('err');
          return;
        }
        status.textContent='저장했습니다';
      }catch(e){
        status.textContent='저장하지 못했습니다 — '+((e&&e.message)||e);
        status.classList.add('err');
      }
    });
  },
});
