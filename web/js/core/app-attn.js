/**
 * Remote Terminal — App 주의 알림 (PACKAGE_RESTRUCTURE_SRS FR-APP-2)
 *
 * class App 본문에서 옮겨온 메서드 20개. 본문은 수정하지 않았다 (FR-APP-3).
 * app.js 이후 main.js 이전에 로드된다 (FR-APP-5).
 */
Object.assign(App.prototype, {
  _attnHas(toolId){return this._attn.has(toolId)},

  // 활성 창의 포커스 pane 의 activeTab toolId === toolId 인지 (FR-PAN-9)
  _isToolFocusedActive(toolId){
    if(!toolId) return false;
    const s=this._aw(); if(!s||!s.layout) return false;
    const pn=findPane(s.layout,this.focused); if(!pn) return false;
    const at=(pn.tabs||[]).find(t=>t.id===pn.activeTab);
    return !!at&&at.toolId===toolId;
  },

  _onToolAttention({toolId,reason}={}){
    if(!toolId) return;
    // 억제(즉시 해제)는 "정말로 보고 있을 때"만 — 브라우저 창이 OS 포커스를 가졌고(다른 앱이
    // 위에 있지 않음) 그 pane 에 포커스가 있을 때. 다른 프로그램을 보고 있으면(document.hasFocus()
    // false) 포커스여도 알람을 살린다 (FR-PAN-9/13/요구2).
    const browserFocused=(typeof document!=='undefined'&&typeof document.hasFocus==='function')?document.hasFocus():true;
    if(browserFocused&&this._isToolFocusedActive(toolId)){this._attnClear(toolId);return}
    this._attn.set(toolId,{reason});
    this._attnRefresh();
    this._attnDesktopNotify(reason,toolId); // FR-PAN-13a
    this._attnBeep(); // FR-PAN-13c
  },

  _onToolAttentionClear({toolId}={}){
    if(!toolId) return;
    this._attnCloseNotif(toolId);
    if(!this._attn.delete(toolId)) return;
    this._attnRefresh();
  },

  // FR-PAN-12: 합류/재연결 시 현재 주의 집합 복원(기존 것 병합)
  _attnRestore(){
    fetch('/api/tools/attention').then(r=>r.ok?r.json():null).then(j=>{
      if(!j||!Array.isArray(j.toolIds)) return;
      for(const pid of j.toolIds){if(!this._attn.has(pid))this._attn.set(pid,{reason:'signaled'})}
      this._attnRefresh();
    }).catch(()=>{});
  },

  // FR-PAN-11: 로컬 즉시 제거 + 백엔드 해제(다른 브라우저로 전파)
  _attnClear(toolId){
    if(!toolId) return;
    this._attnCloseNotif(toolId);
    this._attn.delete(toolId);
    fetch('/api/tools/attention/clear',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({toolId})}).catch(()=>{});
    this._attnRefresh();
  },

  // FR-PAN-17: 모든 알람 일괄 해제
  _attnClearAll(){
    fetch('/api/tools/attention/clear-all',{method:'POST'}).catch(()=>{});
    Object.keys(this._attnNotifs||{}).forEach(k=>this._attnCloseNotif(k));
    this._attn.clear();
    this._attnCenterClose();
    this._attnRefresh();
  },

  // FR-PAN-16: 창 layout 안에 주의 상태 pane 이 있는지
  _windowHasAttn(s){
    if(!s||!s.layout||!this._attn.size) return false;
    const walk=(node)=>{
      if(!node) return false;
      if(node.type==='pane') return (node.tabs||[]).some(t=>t.toolId&&this._attn.has(t.toolId));
      if(node.children) return node.children.some(walk);
      return false;
    };
    return walk(s.layout);
  },

  // 포커스된 활성 탭이 주의 상태면 해제. 그 탭은 어차피 강조 안 되므로 full render 불필요
  _attnClearFocused(){
    if(!this._attn.size) return;
    const s=this._aw(); if(!s||!s.layout) return;
    const pn=findPane(s.layout,this.focused); if(!pn) return;
    const at=(pn.tabs||[]).find(t=>t.id===pn.activeTab);
    if(at&&at.toolId&&this._attn.has(at.toolId)) this._attnClear(at.toolId);
  },

  // 모든 창 layout 트리를 walk 해 toolId 를 가진 tab 위치 반환 (FR-PAN-16)
  /**
   * FR-NAM-1: 도구 이름을 묻는 자리는 전부 여기를 지난다. 탭이 있으면 그
   * 탭의 규칙(FR-TAN-15)이 적용되고, 없으면 파생 이름이 답한다.
   */
  _toolName(toolId,fallback){
    const loc=this._findToolLocation(toolId);
    return toolDisplayName(toolId,this._fgNames,loc&&loc.tab,fallback);
  },

  _findToolLocation(toolId){
    if(!toolId) return null;
    const walk=(node,win)=>{
      if(!node) return null;
      if(node.type==='pane'){
        const tab=(node.tabs||[]).find(t=>t.toolId===toolId);
        return tab?{win,pane:node,tab}:null;
      }
      if(node.children) for(const c of node.children){const f=walk(c,win);if(f)return f}
      return null;
    };
    for(const s of this.ws.windows){const f=walk(s.layout,s);if(f)return f}
    return null;
  },

  // FR-PAN-16: 해당 pane 으로 포커스 이동(_setFocus 가 _attnClearFocused 로 해제)
  _jumpToTool(toolId){
    const loc=this._findToolLocation(toolId);
    if(!loc) return;
    this.ws.activeWindow=loc.win.id;
    try{sessionStorage.setItem('activeWindow', loc.win.id)}catch{}
    loc.pane.activeTab=loc.tab.id;
    this._setFocus(loc.pane.id, loc.win);
    this._focusWindow(loc.win.id);
    this.render();
  },

  // FR-PAN-16: 제목 배지 + notification center 배지/팝오버 갱신
  _attnRefresh(){
    const n=this._attn.size;
    document.title=(n?'('+n+') ':'')+'Dongminal'; // FR-PAN-13b
    // 사이드바 창 알람 표시 갱신 (전체 재렌더 없이)
    document.querySelectorAll('#windows .si').forEach(el=>{
      const s=this.ws.windows.find(x=>x.id===el.dataset.sid);
      el.classList.toggle('attn', !!(s&&this._windowHasAttn(s)));
    });
    // GIT_SIDEBAR_TABS_SRS FR-SBT-13: 같은 사실을 사이드바 탭 배지도 보인다 —
    // Windows 탭이 비활성이면 목록의 `.si.attn` 이 보이지 않기 때문이다.
    this._sbUpdateBadges();
    // 탭/리전 강조도 타깃 토글 — 전체 render() 를 피해 포커스 플리커(xterm blur/refocus)를 막는다.
    document.querySelectorAll('#area .pn-tab[data-toolid]').forEach(t=>{
      const pn=t.closest('.pn');
      const focusedPane=!!(pn&&pn.classList.contains('focused'));
      const active=t.classList.contains('active');
      t.classList.toggle('attn', this._attnHas(t.dataset.toolid)&&!(focusedPane&&active));
    });
    document.querySelectorAll('#area .pn[data-paneid]').forEach(pn=>{
      const at=pn.querySelector('.pn-tab.active[data-toolid]');
      const pid=at?at.dataset.toolid:null;
      pn.classList.toggle('attn', !!(pid&&this._attnHas(pid)&&!pn.classList.contains('focused')));
    });
    const badge=document.getElementById('attn-badge');
    if(badge){
      const cnt=badge.querySelector('.attn-count');
      if(cnt) cnt.textContent=String(n);
      badge.style.display=n?'':'none';
      if(!n) this._attnCenterClose();
    }
    const center=document.getElementById('attn-center');
    if(center&&center.classList.contains('open')) this._attnCenterRender();
    this._agentsRender(); // FR-AAP-18: 활동 카드의 alarm 표시도 함께 갱신
  },

  _positionAttnCenter(){
    const badge=document.getElementById('attn-badge');
    const center=document.getElementById('attn-center');
    if(!badge||!center) return;
    const r=badge.getBoundingClientRect();
    center.style.top=(r.bottom+4)+'px';
    center.style.left='';
    center.style.right=(window.innerWidth-r.right)+'px';
  },

  _attnCenterToggle(){
    const center=document.getElementById('attn-center');
    if(!center) return;
    if(center.classList.contains('open')) this._attnCenterClose();
    else{this._positionAttnCenter();center.classList.add('open');this._attnCenterRender()}
  },

  _attnCenterClose(){
    const center=document.getElementById('attn-center');
    if(center) center.classList.remove('open');
  },

  _attnCenterRender(){
    const center=document.getElementById('attn-center');
    if(!center) return;
    center.innerHTML='';
    if(!this._attn.size){this._attnCenterClose();return}
    const head=document.createElement('div');
    head.className='attn-head';
    head.innerHTML=`<span class="attn-title">주의 알림 ${this._attn.size}</span><button class="attn-clear-all">모두 제거</button>`;
    head.querySelector('.attn-clear-all').addEventListener('click',e=>{e.stopPropagation();this._attnClearAll()});
    center.appendChild(head);
    for(const [toolId,info] of this._attn){
      // FR-NAM-6: 알림도 파생 이름을 쓴다 — 화면의 탭과 다른 이름을 부르면
      // 사용자가 어느 도구인지 못 찾는다.
      const name=this._toolName(toolId,toolId);
      const reason=info&&info.reason==='idle'?'작업 멈춤':'알림 신호';
      const item=document.createElement('div');
      item.className='attn-item';
      const nameSpan=document.createElement('span');nameSpan.className='attn-name';nameSpan.textContent=name;
      const reasonSpan=document.createElement('span');reasonSpan.className='attn-reason';reasonSpan.textContent=reason;
      item.appendChild(nameSpan);
      item.appendChild(reasonSpan);
      item.addEventListener('click',()=>{this._jumpToTool(toolId);this._attnCenterClose()});
      center.appendChild(item);
    }
  },

  // FR-PAN-13a: 데스크톱 알림(권한 granted + 설정 on). pane 별 직전 알림을 닫고 새로 띄운다.
  _attnDesktopNotify(reason,toolId){
    if(!this.attnDesktop) return;
    if(typeof Notification==='undefined'||Notification.permission!=='granted') return;
    const loc=this._findToolLocation(toolId);
    const where=loc?[loc.win&&loc.win.name,tabName(loc.tab,this._fgNames)].filter(Boolean).join(' · '):('pane '+toolId);
    const head=reason==='done'?'✅ 작업 완료':reason==='waiting'?'⌨️ 입력 대기 중':reason==='idle'?'⏸️ 작업이 멈췄습니다':'🔔 주의가 필요합니다';
    // 같은 pane 의 이전 알림을 닫고 새로 띄운다 — tag+renotify 는 (특히 macOS 에서)
    // 조용히 갱신만 되어 재팝업이 안 되므로, close→재생성으로 매번 확실히 다시 띄운다.
    this._attnNotifs=this._attnNotifs||{};
    this._attnCloseNotif(toolId);
    try{this._attnNotifs[toolId]=new Notification(head,{body:where||('pane '+toolId)})}catch{}
  },

  // 저장해 둔 데스크톱 알림 객체를 닫는다(있으면).
  _attnCloseNotif(toolId){
    if(this._attnNotifs&&this._attnNotifs[toolId]){
      try{this._attnNotifs[toolId].close()}catch{}
      delete this._attnNotifs[toolId];
    }
  },

  // FR-PAN-13c: WebAudio 짧은 비프(외부 파일 없음). 설정 on 일 때만
  _attnBeep(){
    if(!this.attnSound) return;
    const Ctx=window.AudioContext||window['webkitAudioContext'];
    if(!Ctx) return;
    if(!this._audioCtx) this._audioCtx=new Ctx();
    const ctx=this._audioCtx;
    const osc=ctx.createOscillator();
    const gain=ctx.createGain();
    osc.type='sine';
    osc.frequency.value=880;
    gain.gain.value=.05;
    osc.connect(gain);gain.connect(ctx.destination);
    const t=ctx.currentTime;
    osc.start(t);
    gain.gain.setValueAtTime(.05,t);
    gain.gain.exponentialRampToValueAtTime(.0001,t+.18);
    osc.stop(t+.2);
  },

  // notification center 배지/팝오버 이벤트 바인딩 + 설정 토글 (FR-PAN-14/16)
  _initAttn(){
    const badge=document.getElementById('attn-badge');
    if(badge&&!badge._bound){
      badge._bound=true;
      badge.addEventListener('click',e=>{e.stopPropagation();this._attnCenterToggle()});
    }
    document.addEventListener('click',e=>{
      const center=document.getElementById('attn-center');
      if(!center||!center.classList.contains('open')) return;
      if(center.contains(e.target)||(badge&&badge.contains(e.target))) return;
      this._attnCenterClose();
    });
    const dt=document.getElementById('attn-desktop');
    if(dt){
      dt.checked=this.attnDesktop;
      dt.addEventListener('change',()=>{
        if(dt.checked&&typeof Notification!=='undefined'&&Notification.permission==='default'){
          Notification.requestPermission().then(p=>{if(p!=='granted'){dt.checked=false;this.attnDesktop=false}});
        }
        this.attnDesktop=dt.checked;
      });
    }
    const sd=document.getElementById('attn-sound');
    if(sd){
      sd.checked=this.attnSound;
      sd.addEventListener('change',()=>{this.attnSound=sd.checked});
    }
    const ap=document.getElementById('agents-poll');
    if(ap){
      ap.value=String(this.agentsPollMs);
      ap.addEventListener('change',()=>{
        this.agentsPollMs=parseInt(ap.value);
        if(this._agentsTimer) this._agentsStartPoll(); // 폴링 중이면 새 주기로 재시작
      });
    }
    // 데스크톱 알림 권한은 사용자 제스처가 필요하므로, 켜져 있고 아직 미결정이면
    // 첫 상호작용에서 한 번 요청한다 (브라우저 정책 충족) — FR-PAN-13a.
    // capture 단계로 들어야 xterm 이 pointer/key 이벤트를 먼저 소비해도 누락되지 않는다.
    if(typeof Notification!=='undefined'&&Notification.permission==='default'&&this.attnDesktop&&!this._attnPermAsked){
      this._attnPermAsked=true;
      let asked=false;
      const ask=()=>{if(asked)return;asked=true;try{const r=Notification.requestPermission();if(r&&r.then)r.then(()=>this._initAttn&&this._attnRefresh())}catch{}};
      document.addEventListener('pointerdown',ask,{once:true,capture:true});
      document.addEventListener('keydown',ask,{once:true,capture:true});
    }
    // 브라우저로 돌아오면(다른 앱→복귀) 지금 보고 있는 pane 의 알람은 해제 (요구2 보완).
    if(!this._attnFocusBound){
      this._attnFocusBound=true;
      window.addEventListener('focus',()=>this._attnClearFocused());
    }
    this._attnRefresh();
  },
});
