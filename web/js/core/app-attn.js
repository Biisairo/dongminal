/**
 * Remote Terminal — App 주의 알림 (PACKAGE_RESTRUCTURE_SRS FR-APP-2)
 *
 * class App 본문에서 옮겨온 메서드 20개. 본문은 수정하지 않았다 (FR-APP-3).
 * app.js 이후 main.js 이전에 로드된다 (FR-APP-5).
 */
Object.assign(App.prototype, {
  _attnHas(toolId){return this._attn.has(toolId)},

  // 활성 창의 포커스 pane 에서 그 도구의 탭이 보이는지 (FR-PAN-9).
  //
  // FR-SVS-13: 칸이 여럿이면 **어느 칸에서든 보이면 보이는 것**이다. 두 칸 중
  // 하나에 떠 있는데 알람이 울리면 그것이 결함이다. 판정하는 pane 은 포커스
  // pane 이지만, 그 pane 을 그리는 칸은 여럿일 수 있다.
  _isToolFocusedActive(toolId){
    if(!toolId) return false;
    const s=this._aw(); if(!s||!s.layout) return false;
    const pn=findPane(s.layout,this.focused); if(!pn) return false;
    const tabs=pn.tabs||[];
    const n=this.slotCount();
    for(let i=0;i<n;i++){
      // 그 칸이 이 창을 보고 있지 않으면 그 칸의 시선은 이 판정과 무관하다.
      if(this._slots&&this._slotWindow(i)!==s) continue;
      const at=tabs.find(t=>t.id===this.paneTab(pn,i));
      if(at&&at.toolId===toolId) return true;
    }
    return false;
  },

  /**
   * ATTENTION_FIRING_SRS FR-ATA-2·7·8: 알람은 **언제나** 선다. 포커스가 있다는
   * 사실이 알람을 지우던 것이 "울려야 할 때 울리지 않는다" 의 절반이었다 —
   * 브라우저가 뒤에 있는 동안 뜬 알람은 화면에 흔적을 남기지 않았고, 사용자가
   * 돌아오는 순간 지워졌다 (B4·B6).
   *
   * 억제되는 것은 **소리와 데스크톱 알림뿐**이다. 조건은 개정 전 억제 조건과
   * 글자 그대로 같다 — 눈앞에 있는 것을 소리로 다시 부르는 것은 방해다 (AS-2).
   */
  _onToolAttention({toolId,reason}={}){
    if(!toolId) return;
    this._restoreNote('attn',toolId);   // FR-RSF-4
    this._attn.set(toolId,{reason});
    this._attnRefresh();
    if(this._attnUserIsWatching(toolId)) return;
    this._attnDesktopNotify(reason,toolId); // FR-PAN-13a
    this._attnBeep(); // FR-PAN-13c
  },

  // 브라우저 창이 OS 포커스를 가졌고(다른 앱이 위에 있지 않음) 그 도구가 포커스
  // 된 칸의 활성 탭인가 — 즉 사용자가 지금 그것을 보고 있는가 (FR-ATA-7).
  _attnUserIsWatching(toolId){
    const browserFocused=(typeof document!=='undefined'&&typeof document.hasFocus==='function')?document.hasFocus():true;
    return browserFocused&&this._isToolFocusedActive(toolId);
  },

  _onToolAttentionClear({toolId}={}){
    if(!toolId) return;
    this._attnCloseNotif(toolId);
    // 서버발 해제도 서버에서는 주목이다 — 잠금이 섰다고 기록해 둔다. 그러지
    // 않으면 다른 브라우저가 해제한 도구를 여기서 만져도 잠금이 풀리지 않는다.
    this._attnNoteLock(toolId,false);
    this._restoreNote('attn',toolId);   // FR-RSF-4
    if(!this._attn.delete(toolId)) return;
    this._attnRefresh();
  },

  /**
   * FR-PAN-12 · FR-ATL-8: 합류/재연결 시 현재 주의 집합을 복원한다.
   *
   * 서버 집합이 **권위**다. 지금까지 이 함수는 병합만 했고, 그래서 죽은 도구의
   * 알람이 새로고침으로도 사라지지 않았다 — `_fgApply` 가 "목록에 없는 도구의
   * 이름은 지운다"고 하는 것과 같은 규약이 여기만 빠져 있었다.
   *
   * FR-ATL-9: 지운 id 에 clear 를 보내지 않는다. 서버가 이미 모르는 것을 다시
   * 지우라고 말할 이유가 없다.
   *
   * FR-RSF-2·3: **비행 중에 만진 id 는 스냅숏이 건드리지 않는다.** 응답은 요청
   * 시점의 서버 상태이고, 그 사이 SSE 로 새 알람이 올라오거나(`es.onopen` 이
   * 바로 그 순간이다) 사용자가 알람을 거둘 수 있다 — 둘 다 스냅숏보다 새롭다.
   * 개정 전의 `before`(요청 전 키 집합)는 새 알람이 지워지는 쪽만 막았고,
   * 사용자가 거둔 알람이 되살아나는 쪽은 그대로였다 (RESTORE_FLIGHT_SRS §1.1).
   */
  _attnRestore(){
    const t=this._restoreBegin('attn');
    fetch('/api/tools/attention').then(r=>r.ok?r.json():null).then(j=>{
      if(!this._restoreLive('attn',t)) return;
      if(!j||!Array.isArray(j.toolIds)) return;
      const live=new Set(j.toolIds);
      for(const pid of live){if(!t.has(pid)&&!this._attn.has(pid))this._attn.set(pid,{reason:'signaled'})}
      for(const pid of Array.from(this._attn.keys())){if(!live.has(pid)&&!t.has(pid))this._attnDrop(pid)}
      this._restoreEnd('attn',t);
      this._attnRefresh();
      // FR-ATA-1: 복원도 포커스를 이유로 지우지 않는다. 개정 전에는 FR-ATL-10
      // 이 여기서 "보고 있으면 해제" 를 했으나, 그 규약 자체가 사라졌다 —
      // 해제는 실제 상호작용에서만 온다 (D-1).
    }).catch(()=>{});
  },

  /**
   * FR-ATL-7·8: 알람을 **로컬에서만** 뗀다. 서버에 알리지 않는다 — 대상이 이미
   * 없는(죽었거나 곧 죽일) 도구이기 때문이다. 서버에도 알려야 하는 해제는
   * `_attnClear` 다.
   */
  _attnDrop(toolId){
    if(!toolId) return false;
    this._attnCloseNotif(toolId);
    this._restoreNote('attn',toolId);   // FR-RSF-4
    return this._attn.delete(toolId);
  },

  /**
   * FR-PAN-11: 로컬 즉시 제거 + 백엔드 해제(다른 브라우저로 전파).
   *
   * FR-ATA-9: `typed` 는 사용자가 그 도구에 **키를 눌렀는가** 다. 보기만 한
   * 해제는 서버의 재무장을 잠그고, 키를 누른 해제는 잠금을 푼다 — 일을
   * 시켰으면 그 결과를 다시 기다리게 되기 때문이다 (FR-ATF-5·6).
   */
  _attnClear(toolId,typed){
    if(!toolId) return;
    this._restoreNote('attn',toolId);   // FR-RSF-4 — 사용자 조작도 비행보다 새롭다
    this._attnCloseNotif(toolId);
    this._attn.delete(toolId);
    this._attnNoteLock(toolId,!!typed);
    fetch('/api/tools/attention/clear',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({toolId,typed:!!typed})}).catch(()=>{});
    this._attnRefresh();
  },

  /**
   * FR-ATF-8: 서버의 재무장 잠금이 **지금 서 있는지**를 기억한다. 이 한 칸이
   * `_attnRearm` 의 왕복을 눌러 준다 (NFR-2).
   *
   * `false` 는 "잠겼다"(보기만 한 해제), `true` 는 "풀었다"(키를 누른 해제),
   * 없음은 "잠근 적이 없다" 다. 셋을 구분해야 잠근 적 없는 도구에 신호를
   * 보내지 않는다.
   */
  _attnNoteLock(toolId,unlocked){
    this._attnTyped=this._attnTyped||{};
    this._attnTyped[toolId]=!!unlocked;
  },

  /**
   * FR-ATF-6: 알람이 없는 칸에서 키를 눌렀을 때 잠금만 푼다. 잠긴 적이 없거나
   * 이미 푼 도구에는 아무것도 보내지 않는다 — 그러면 매 키 입력이 서버를 친다.
   */
  _attnRearm(toolId){
    if(!toolId||!this._attnTyped||this._attnTyped[toolId]!==false) return;
    this._attnTyped[toolId]=true;
    fetch('/api/tools/attention/clear',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({toolId,typed:true})}).catch(()=>{});
  },

  // FR-PAN-17: 모든 알람 일괄 해제
  _attnClearAll(){
    fetch('/api/tools/attention/clear-all',{method:'POST'}).catch(()=>{});
    Object.keys(this._attnNotifs||{}).forEach(k=>this._attnCloseNotif(k));
    // FR-ATF-13: 서버는 이 한 번으로 전부를 잠근다 — 로컬 기록도 함께 세운다.
    for(const id of this._attn.keys()) this._attnNoteLock(id,false);
    this._restoreVoid('attn');   // FR-RSF-5: 전체 초기화는 id 로 표현되지 않는다
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

  /**
   * FR-ATA-3·4·5: **해제의 유일한 판정**이다. 분할 칸 안에서 일어난 사용자
   * 제스처가 그 칸의 활성 탭 도구를 주목한 것으로 읽는다.
   *
   * 포커스는 더 이상 해제가 아니다 (FR-ATA-1) — 포커스를 얻는 경로가 넷이나
   * 되는데 그중 어느 것도 "사용자가 그것을 보았다" 를 증명하지 못했다.
   *
   * `keydown` 은 일을 시킨 것이고 `pointerdown` 은 본 것이다. 그 차이가 서버의
   * 재무장 잠금을 가른다 (FR-ATF-5·6).
   */
  _attnNoteInteraction(e){
    const el=e&&e.target&&e.target.closest?e.target.closest('#area .pn[data-paneid]'):null;
    if(!el) return;
    const at=el.querySelector('.pn-tab.active[data-toolid]');
    const toolId=at?at.dataset.toolid:null;
    if(!toolId) return;
    const typed=e.type==='keydown';
    if(this._attn.has(toolId)) this._attnClear(toolId,typed);
    else if(typed) this._attnRearm(toolId);
  },

  /**
   * FR-PAN-16: 해당 pane 으로 포커스 이동.
   *
   * FR-ATA-6: 해제는 **여기서** 한다. 포커스가 더 이상 해제가 아니므로
   * (FR-ATA-1), 알림 센터·활동 카드의 클릭 — 사용자가 "이것을 보겠다" 고 말한
   * 명시적 제스처 — 만은 이 자리가 직접 거둔다.
   *
   * 탭이 없는 도구도 온다 — 백그라운드로 보냈거나 Run 이 만든 헤드리스 멤버다.
   * 그때 조용히 return 하면 클릭이 아무 일도 하지 않고, 그 알람은 `모두 제거`
   * 말고는 없앨 방법이 없다. FR-ATJ-1·2 로 두 갈래를 준다: 백그라운드면 복귀,
   * 어디에도 없으면 해제. **클릭이 아무 일도 하지 않는 경우는 없다.**
   */
  _jumpToTool(toolId){
    const loc=this._findToolLocation(toolId);
    if(!loc){this._attnLand(toolId);return}
    this._attnClear(toolId);
    this.ws.activeWindow=loc.win.id;
    try{sessionStorage.setItem('activeWindow', loc.win.id)}catch{}
    // FR-SVS-12: 알람은 사용자를 부르는 것이고 사용자는 포커스 칸에 있다.
    this.paneTabSet(loc.pane,loc.tab.id);
    this._setFocus(loc.pane.id, loc.win);
    this._focusWindow(loc.win.id);
    this.render();
  },

  /**
   * FR-ATJ-1·2·3: 탭이 없는 도구의 알람이 착지하는 자리. 판정은 여기 하나다 —
   * 알림 센터와 활동 카드가 둘 다 `_jumpToTool` 을 지나므로 두 벌로 만들지 않는다.
   */
  _attnLand(toolId){
    const bg=(this._bg||[]).some(b=>b&&b.toolId===toolId);
    // 백그라운드 도구는 되돌릴 자리가 있다 — ⏻ 모달의 복귀와 같은 경로다.
    if(bg){this._restoreTool(toolId);return}
    // 어디에도 없으면 알람만 거둔다. 서버에도 알린다 — 다른 브라우저의 배지도
    // 같이 내려가야 한다.
    this._attnClear(toolId);
  },

  // FR-PAN-16: 제목 배지 + notification center 배지/팝오버 갱신
  _attnRefresh(){
    const n=this._attn.size;
    this._applyPageTitle(); // FR-PAN-13b · PAGE_TITLE_SRS FR-PGT-8
    // 사이드바 창 알람 표시 갱신 (전체 재렌더 없이)
    document.querySelectorAll('#windows .si').forEach(el=>{
      const s=this.ws.windows.find(x=>x.id===el.dataset.sid);
      el.classList.toggle('attn', !!(s&&this._windowHasAttn(s)));
    });
    // GIT_SIDEBAR_TABS_SRS FR-SBT-13: 같은 사실을 사이드바 탭 배지도 보인다 —
    // Windows 탭이 비활성이면 목록의 `.si.attn` 이 보이지 않기 때문이다.
    this._sbUpdateBadges();
    // 탭/리전 강조도 타깃 토글 — 전체 render() 를 피해 포커스 플리커(xterm blur/refocus)를 막는다.
    // FR-ATV-1: 포커스 예외가 없다. 표식이 맥박을 얻은 뒤로 둘은 시간축에서
    // 갈라지므로, 같은 자리에 겹쳐도 서로를 가리지 않는다 (§2.4).
    document.querySelectorAll('#area .pn-tab[data-toolid]').forEach(t=>{
      t.classList.toggle('attn', this._attnHas(t.dataset.toolid));
    });
    document.querySelectorAll('#area .pn[data-paneid]').forEach(pn=>{
      const at=pn.querySelector('.pn-tab.active[data-toolid]');
      const pid=at?at.dataset.toolid:null;
      pn.classList.toggle('attn', !!(pid&&this._attnHas(pid)));
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
    // FR-ATA-3·4: 해제의 유일한 입구. capture 로 들어야 xterm 이 pointer/key
    // 이벤트를 먼저 소비해도 누락되지 않는다.
    //
    // 개정 전 여기 있던 `window.focus → 해제` 는 사라졌다 — 다른 앱에서 돌아온
    // 사용자가 알람을 보기도 전에 지우던 자리다 (B6).
    if(!this._attnInteractBound){
      this._attnInteractBound=true;
      document.addEventListener('pointerdown',e=>this._attnNoteInteraction(e),{capture:true});
      document.addEventListener('keydown',e=>this._attnNoteInteraction(e),{capture:true});
    }
    this._attnRefresh();
  },
});
