/**
 * Dongminal — 설정 내보내기·가져오기 (SETTINGS_PORTABILITY_SRS)
 *
 * **Settings 창에서 설정 가능한 값 전부를 파일 하나로 옮긴다.**
 *
 * 사용자에게는 한 창의 설정이지만 값은 세 저장소에 흩어져 있다 (§2.1) —
 * 서버 블롭(`/api/settings`) · `localStorage`(기기별) · `sessionStorage`(탭별).
 * 한 계층만 담으면 "설정을 옮겼는데 알림이 꺼져 있다" 가 된다.
 *
 * 서버는 블롭을 해석하지 않으므로(§2.2) 이 기능은 종단을 새로 파지 않는다 (D-1).
 */

// FR-SPT-1 / D-3: 이식 표. **내보내기와 가져오기가 같은 배열을 읽는다** — 두 벌로
// 적으면 설정이 늘 때 한쪽만 고쳐지고, 그 실패는 복원해 보기 전까지 아무도 모른다.
//
// 표 밖의 키(`sidebarWidth`·`gitFileView`·리포별 마지막 ref…)는 담지도 건드리지도
// 않는다 (FR-SPT-3) — 화면 크기에 딸린 치수와 리포별 자리는 옮기면 뜻을 잃는다.
const BACKUP_KEYS=[
  {store:'local',   key:'attnDesktop'},      // Notifications ▸ 데스크톱 알림
  {store:'local',   key:'attnSound'},        // Notifications ▸ 사운드
  // POLL_INTERVAL_SETTINGS_SRS FR-PIS-18: `agentsPollMs` 가 여기서 빠졌다 — 값이
  // 서버 설정으로 옮겼고(D-3), 이 표는 localStorage·sessionStorage 만 담는다.
  {store:'local',   key:'slotDir'},          // Display ▸ 슬롯 방향
  {store:'session', key:'displayMode'},      // Display ▸ Display Mode
  {store:'session', key:'mobileBreakpoint'}, // Display ▸ Mobile Breakpoint
];
const BACKUP_KIND='dongminal-settings';
const BACKUP_VERSION=1;

Object.assign(App.prototype, {
  _bkStore(name){
    return name==='session'?sessionStorage:localStorage;
  },

  // FR-SPT-5 / D-6: **저장된 키만** 담는다. 없는 키를 기본값으로 채우면 나중에
  // 기본값이 바뀌어도 옛 값이 따라온다 — "정한 적 없음" 은 그대로 옮겨져야 한다.
  _bkCollect(){
    const out={local:{},session:{}};
    for(const {store,key} of BACKUP_KEYS){
      let v=null;
      try{v=this._bkStore(store).getItem(key)}catch{}
      if(v!==null) out[store][key]=v;
    }
    return out;
  },

  // FR-SPT-6: 지역 시각을 이름에 박는다 — 여러 번 내보내도 서로 덮지 않는다.
  _bkFileName(d){
    const p=n=>String(n).padStart(2,'0');
    return `dongminal-settings-${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}`
      +`-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.json`;
  },

  _bkMsg(text,kind){
    const el=document.getElementById('bk-msg');
    if(!el) return;
    el.textContent=text||'';
    el.className='bk-msg'+(text?(' '+(kind||'ok')):'');
  },

  /**
   * FR-SPT-4·5. 블롭 계층은 키를 세지 않고 통째로 담는다 (FR-SPT-2) — 서버가
   * 해석하지 않는 값이라 GET 응답이 곧 그 계층의 전부다.
   *
   * FR-SPT-7: 블롭을 못 읽으면 **파일을 만들지 않는다.** 반쪽 백업이 온전한
   * 백업처럼 보이는 것이 가장 나쁘다.
   */
  async _bkExport(){
    let server;
    {
      const r=await apiGet('/api/settings');
      if(!r.ok||!r.data){
        this._bkMsg('설정을 읽지 못해 내보내지 않았습니다 (HTTP '+r.status+')','err');
        return false;
      }
      server=r.data;
    }
    const {local,session}=this._bkCollect();
    const now=new Date();
    const envelope={kind:BACKUP_KIND,version:BACKUP_VERSION,exportedAt:now.toISOString(),server,local,session};
    const url=URL.createObjectURL(new Blob([JSON.stringify(envelope,null,2)],{type:'application/json'}));
    const a=document.createElement('a');
    a.href=url; a.download=this._bkFileName(now);
    document.body.appendChild(a); a.click(); a.remove();
    TIMERS.defer(()=>URL.revokeObjectURL(url),{label:'revoke-url'});
    this._bkMsg('내보냈습니다 — '+a.download,'ok');
    return true;
  },

  /**
   * FR-SPT-9: 하나라도 어긋나면 **아무것도 바꾸지 않고** 거부한다.
   *
   * 아는 판보다 새로운 파일을 받지 않는 이유는 전체 교체이기 때문이다 — 그 판이
   * 무엇을 더 담는지 모르는 채로 지금의 이식 표대로 지우면, 모르는 설정이 조용히
   * 날아간다.
   */
  _bkParse(text){
    let env;
    try{env=JSON.parse(text)}
    catch{return {err:'JSON 파일이 아닙니다'}}
    if(!env||typeof env!=='object'||Array.isArray(env)) return {err:'JSON 파일이 아닙니다'};
    if(env.kind!==BACKUP_KIND) return {err:'dongminal 설정 파일이 아닙니다'};
    const v=Number(env.version);
    if(!(v>=1)) return {err:'dongminal 설정 파일이 아닙니다'};
    if(v>BACKUP_VERSION) return {err:'더 새로운 판의 설정 파일입니다 (v'+env.version+')'};
    if(!env.server||typeof env.server!=='object'||Array.isArray(env.server)) return {err:'설정 내용이 없습니다'};
    return {env};
  },

  // FR-SPT-10: 무엇이 덮이는지 알리고 확인을 받는다. 되돌릴 수 없는 교체다.
  _bkPreview(env){
    const {local,session}=this._bkCollect();
    const willClear=BACKUP_KEYS.filter(({store,key})=>{
      const src=store==='session'?env.session:env.local;
      const cur=store==='session'?session:local;
      return cur[key]!==undefined && (!src||src[key]===undefined);
    }).length;
    const when=env.exportedAt?new Date(env.exportedAt).toLocaleString():'시각 없음';
    const lines=[
      '내보낸 시각: '+when,
      '설정 항목: '+Object.keys(env.server).length+'개(서버) · '
        +Object.keys(env.local||{}).length+'개(기기) · '
        +Object.keys(env.session||{}).length+'개(탭)',
      '지금 설정은 이 파일의 값으로 전부 바뀝니다'
        +(willClear?(' — 파일에 없는 설정 '+willClear+'개는 기본값으로 돌아갑니다'):'')
        +'. 되돌릴 수 없습니다.',
    ];
    const el=document.getElementById('bk-summary');
    if(el) el.textContent=lines.join('\n');
    const box=document.getElementById('bk-confirm');
    if(box) box.hidden=false;
  },

  _bkCancel(){
    const box=document.getElementById('bk-confirm');
    if(box) box.hidden=true;
    this._bkPending=null;
  },

  /**
   * FR-SPT-11: 전체 교체.
   *
   * FR-SPT-12: 서버가 먼저다. PUT 이 실패하면 거기서 멈춘다 — 서버는 옛 설정,
   * 브라우저는 새 설정인 상태를 만들지 않는다.
   *
   * FR-SPT-13 / D-4: 끝나면 페이지를 다시 연다. 설정 전역을 다시 읽는 길이
   * 그것뿐이고(§2.4), 다시 열지 않으면 다음 `saveSettings` 가 메모리에 남은 옛
   * 전역으로 블롭을 덮는다 (§2.3).
   */
  async _bkApply(){
    const env=this._bkPending;
    if(!env) return false;
    {
      const r=await apiPut('/api/settings',env.server);
      if(!r.ok){
        this._bkMsg('서버에 설정을 쓰지 못했습니다 (HTTP '+r.status+'). 아무것도 바뀌지 않았습니다.','err');
        return false;
      }
    }
    for(const {store,key} of BACKUP_KEYS){
      const src=store==='session'?env.session:env.local;
      const v=src?src[key]:undefined;
      try{
        if(v===undefined||v===null) this._bkStore(store).removeItem(key);
        else this._bkStore(store).setItem(key,String(v));
      }catch{}
    }
    this._bkPending=null;
    // §2.5 / FR-RLC-5a: 앱이 스스로 여는 새로고침은 이탈 가드를 지난다.
    window.__dmReloading=true;
    // BOOT_SCREEN_REUSE_SRS FR-BTR-11: 되돌린 설정은 다시 열린 문서에서야
    // 화면에 닿는다. 그 사이의 옛 화면을 덮는다.
    BootScreen.show(BOOT_STEP_BACKUP);
    location.reload();
    return true;
  },

  /**
   * FUI-24: 설정 전부를 기본값으로 되돌린다.
   *
   * 종전에는 길이 없었다 — 한 항목씩 되돌리는 수밖에 없었고, 어느 것을 만졌는지
   * 사용자가 기억해야 했다.
   *
   * 세 자리를 함께 비운다. 서버 블롭은 `{}` 로 갈아치우고(빈 블롭이 곧 "정한 적
   * 없음" 이므로 `_settingsApply` 가 전부 기본값으로 둔다), 이식 표의
   * `localStorage`·`sessionStorage` 키를 지운다. **표 밖의 키는 건드리지 않는다**
   * (FR-SPT-3) — 창 너비 같은 화면 치수는 취향이 아니라 이 기기의 치수다.
   *
   * **창 배치는 건드리지 않는다.** 그것은 `workspace.json` 이고 되돌리는 길이
   * 따로 있다 (`G4-7`).
   */
  async _bkReset(){
    const r=await apiPut('/api/settings',{});
    if(!r.ok){
      this._bkMsg('서버에 설정을 쓰지 못했습니다 (HTTP '+r.status+'). 아무것도 바뀌지 않았습니다.','err');
      return false;
    }
    for(const {store,key} of BACKUP_KEYS){
      try{this._bkStore(store).removeItem(key)}catch{}
    }
    window.__dmReloading=true;
    BootScreen.show(BOOT_STEP_BACKUP);
    location.reload();
    return true;
  },

  /**
   * M5 `G4-7`: 되돌릴 수 있는 창 배치의 판을 보인다.
   *
   * **읽히는지까지는 묻지 않는다** — 서버의 목록 종단과 같은 규약이다. 깨진
   * 판의 거절은 되돌리는 순간에 일어난다.
   */
  async _bkRevList(){
    const box=document.getElementById('bk-revs');
    if(!box) return;
    const r=await apiGet('/api/workspace/revisions');
    if(!r.ok){
      this._bkMsg('되돌릴 수 있는 판을 읽지 못했습니다 (HTTP '+r.status+')','err');
      return;
    }
    const gens=(r.data&&r.data.generations)||[];
    box.textContent='';
    box.hidden=false;
    if(!gens.length){
      const empty=document.createElement('div');
      empty.className='bk-rev';
      empty.textContent='되돌릴 수 있는 판이 없습니다 — 아직 덮어쓴 적이 없습니다.';
      box.appendChild(empty);
      return;
    }
    for(const g of gens){
      const row=document.createElement('div');
      row.className='bk-rev';
      const when=document.createElement('span');
      when.className='bk-rev-when';
      // 값은 전부 textContent 로 넣는다 — 보간이 스크립트가 되지 않는다 (FE-16).
      when.textContent=g.modified||('판 '+g.gen);
      const size=document.createElement('span');
      size.className='bk-rev-size';
      size.textContent=String(g.bytes)+' B';
      const btn=document.createElement('button');
      btn.type='button';
      btn.className='ds-toggle';
      btn.title='Revert the window layout to this generation';
      btn.textContent='이 판으로';
      btn.addEventListener('click',()=>this._bkRevert(g.gen));
      row.append(when,size,btn);
      box.appendChild(row);
    }
  },

  /**
   * 판 하나로 되돌린다.
   *
   * 확인을 따로 묻지 않는 이유는 **이 동작이 되돌릴 수 있기** 때문이다 —
   * 직전 판이 세대 사슬의 맨 앞으로 들어가므로 한 번 더 되돌리면 제자리다.
   * 되돌릴 수 없는 것(`_bkReset`)에만 확인을 붙인다.
   */
  async _bkRevert(gen){
    const r=await apiPost('/api/workspace/revert',{gen});
    if(!r.ok){
      this._bkMsg('되돌리지 못했습니다 (HTTP '+r.status+')','err');
      return;
    }
    window.__dmReloading=true;
    BootScreen.show(BOOT_STEP_BACKUP);
    location.reload();
  },

  _initBackup(){
    const ex=document.getElementById('bk-export');
    if(!ex) return;
    ex.addEventListener('click',()=>this._bkExport());
    const file=document.getElementById('bk-file');
    document.getElementById('bk-import').addEventListener('click',()=>file.click());
    file.addEventListener('change',async()=>{
      const f=file.files&&file.files[0];
      // 같은 파일을 다시 고를 수 있게 비운다 — 값이 같으면 change 가 오지 않는다.
      file.value='';
      if(!f) return;
      this._bkCancel();
      const {env,err}=this._bkParse(await f.text());
      if(err){this._bkMsg(err,'err');return}
      this._bkMsg('');
      this._bkPending=env;
      this._bkPreview(env);
    });
    document.getElementById('bk-apply').addEventListener('click',()=>this._bkApply());
    document.getElementById('bk-cancel').addEventListener('click',()=>{this._bkCancel();this._bkMsg('')});

    // M5 `G4-7` — 창 배치 되돌리기.
    const revBtn=document.getElementById('bk-revlist');
    if(revBtn) revBtn.addEventListener('click',()=>this._bkRevList());

    // FUI-24 — 기본값으로 되돌리기. 되돌릴 수 없으므로 한 단계를 더 둔다.
    const reset=document.getElementById('bk-reset');
    const rc=document.getElementById('bk-reset-confirm');
    if(reset&&rc){
      reset.addEventListener('click',()=>{
        this._bkCancel();
        this._bkMsg('');
        rc.hidden=false;
      });
      document.getElementById('bk-reset-apply').addEventListener('click',()=>{
        rc.hidden=true;
        this._bkReset();
      });
      document.getElementById('bk-reset-cancel').addEventListener('click',()=>{rc.hidden=true});
    }
  },
});
