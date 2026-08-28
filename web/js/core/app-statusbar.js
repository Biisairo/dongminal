/**
 * Remote Terminal — App 상태바 (PACKAGE_RESTRUCTURE_SRS FR-APP-2)
 *
 * class App 본문에서 옮겨온 메서드 11개. 본문은 수정하지 않았다 (FR-APP-3).
 * app.js 이후 main.js 이전에 로드된다 (FR-APP-5).
 */
Object.assign(App.prototype, {
  // ── Status Bar ──
  _initStatusBar(){
    this._stats={};this._latency=null;
    // FR-GIT-112: 진행 중인 원격 작업. Git 창을 보지 않아도 알 수 있어야 하므로
    // Git 창의 폴링이 아니라 상태바 폴링에 얹는다.
    this._gitJobs=[];
    // FR-BGU-4: 진입점은 정적 요소다. 리스너를 여기서 한 번만 부착한다 —
    // 지표 재생성(_updateStatusBar) 주기에 종속되면 안 된다.
    const bgBtn=document.getElementById('sb-bg-btn');
    if(bgBtn) bgBtn.addEventListener('click',e=>{e.stopPropagation();this._bgModalToggle()});
    // FR-BGK-3/4/10: 인라인 확인·진행·오류는 **데이터**로 산다. 모달은 _bgRefresh
    // 마다 통째로 다시 그려지므로, 요소에 붙인 상태는 다시 그리기가 버린다
    // (GIT_REMAINING §1.3 이 전수 조사한 그 부류의 결함이다).
    this._bgConfirm=null; this._bgPending=null; this._bgError=null;
    this._startStatsPoll();
    this._renderStatusBarSettings();
  },
  _startStatsPoll(){
    if(this._statsInterval)clearInterval(this._statsInterval);
    // Skip polling while the tab is hidden — the status bar isn't visible, so
    // the request buys nothing (SYSTEM_STATS_SRS FR-STAT-17). Registered once;
    // _startStatsPoll also runs on interval changes.
    if(!this._statsVisHook){
      this._statsVisHook=true;
      document.addEventListener('visibilitychange',()=>{
        if(!document.hidden)this._pollStats();
      });
    }
    this._statsInterval=setInterval(()=>{
      if(document.hidden)return;
      this._pollStats();
    },statsInterval);
    this._pollStats();
  },
  async _pollStats(){
    // Measure real network latency with lightweight ping
    try{
      const t0=performance.now();
      await fetch('/api/ping');
      this._latency=Math.round(performance.now()-t0);
    }catch{this._latency=null}
    // Fetch stats separately (kept separate so ping stays a clean latency probe)
    try{
      const r=await fetch('/api/stats');
      this._stats=await r.json();
    }catch{}
    await this._pollGitJobs();
    this._updateStatusBar();
  },
  /**
   * FR-RPT-3: 지표를 통째로 다시 만들지 않는다.
   *
   * 이 함수는 stats 폴링과 git status 폴링에서 **1초마다** 불린다. 지표에 제스처는
   * 없지만 `title` 툴팁이 있고, 요소를 다시 만들면 브라우저가 표시 중인 툴팁을
   * 닫는다 — chip 을 hover 해서 리포 경로를 읽는 일이 되지 않는다.
   *
   * **컨테이너 단위 가드로는 부족하다.** 지연·CPU·업타임은 매 회차 값이 달라
   * "전체가 같으면 그리지 않는다" 가 거의 발동하지 않는다. 그래서 지표를 **항목으로**
   * 다루고, 값이 바뀐 항목만 다시 만든다.
   */
  _updateStatusBar(){
    const bar=document.getElementById('sb-items');if(!bar)return;
    const items=[];
    const push=(k,html)=>items.push({k,html});
    if(statusBar.connection){
      const ok=this._latency!==null;
      push('connection',`<span class="sb-item"><span class="sb-dot ${ok?'ok':'err'}"></span>${ok?'연결됨':'끊김'}</span>`);
    }
    if(statusBar.latency&&this._latency!==null){
      push('latency',`<span class="sb-item">${this._latency}ms</span>`);
    }
    if(statusBar.location){
      const loc=this._locationLabel();
      if(loc)push('location',`<span class="sb-item" title="dmctl 대상: ${loc}">📍 ${loc}</span>`);
    }
    if(statusBar.cwd){
      const cwd=this._cwd||'~';
      // Show ~/.../last3dirs
      let short=cwd.replace(/^\/Users\/[^/]+/,'~');
      const parts=short.split('/');
      if(parts.length>4)short='~/.../'+parts.slice(-3).join('/');
      push('cwd',`<span class="sb-item">📁 ${short}</span>`);
    }
    if(statusBar.hostname&&this._stats.hostname){
      push('hostname',`<span class="sb-item">💻 ${this._stats.hostname}</span>`);
    }
    if(statusBar.cpu&&this._stats.cpu!==undefined){
      push('cpu',`<span class="sb-item">CPU ${this._stats.cpu}%</span>`);
    }
    if(statusBar.memory&&this._stats.memTotal){
      const used=this._fmtBytes(this._stats.memUsed);
      const total=this._fmtBytes(this._stats.memTotal);
      push('memory',`<span class="sb-item">MEM ${used}/${total}</span>`);
    }
    if(statusBar.disk&&this._stats.diskPct){
      push('disk',`<span class="sb-item">DISK ${this._stats.diskPct}%</span>`);
    }
    if(statusBar.termsize){
      const p=this._focusedTerminal();
      if(p&&p.term){
        push('termsize',`<span class="sb-item">${p.term.cols}×${p.term.rows}</span>`);
      }
    }
    if(statusBar.uptime){
      const parts=[];
      if(this._stats.sysUptime)parts.push('시스템 '+this._stats.sysUptime);
      if(this._stats.srvUptime)parts.push('서버 '+this._stats.srvUptime);
      if(parts.length)push('uptime',`<span class="sb-item">↑ ${parts.join(' │ ')}</span>`);
    }
    // FR-GIT-112: 진행 중 원격 작업. **브랜치 chip 은 없다** (FR-FLW-12) —
    // 활성 리포는 사용자가 고른 것이고 터미널을 따라가지 않으므로, 하단바에
    // 상주하는 브랜치 표시는 "지금 있는 곳" 으로 오해되기만 했다.
    if(statusBar.git){
      const j=this._gitJobChip(); if(j) items.push({k:'gitjob',el:j});
    }
    // 근거는 그려질 마크업 전부다 (FR-RPT-2). 문자열 지표는 그 문자열이고, chip 은
    // DOM 이므로 `outerHTML` 이다.
    reconcileList(bar,items,{
      key:i=>i.k,
      sig:i=>i.html!==undefined?i.html:i.el.outerHTML,
      build:i=>{
        if(i.el) return i.el;
        const t=document.createElement('template');
        t.innerHTML=i.html;
        return t.content.firstElementChild;
      },
    });
    this._updateBgBtn();
  },

  // FR-BGU-2..5: 진입점은 상태바 우측 끝의 정적 버튼이다. 지표 재생성과
  // 수명을 공유하지 않으므로 여기서는 표시 여부와 개수만 갱신한다.
  _updateBgBtn(){
    const btn=document.getElementById('sb-bg-btn');if(!btn)return;
    const n=(this._bg&&this._bg.length)||0;
    // FR-BGU-5 (구 FR-BG-8): 0개면 UI 에 아무 흔적이 없어야 한다.
    btn.style.display=n?'':'none';
    if(!n) return;
    btn.textContent=`⏻ ${n}`;
    btn.title=`백그라운드 도구 ${n}개`;
  },

  // FR-BGU-6/7: 진입점 클릭 → 중앙 모달. 항목 클릭 시 현재 분할 칸의 새 탭으로
  // 복귀한다 (detach --restore 와 같은 경로).
  _bgModalToggle(open){
    this._bgModalOpen = (open===undefined) ? !this._bgModalOpen : !!open;
    if(this._bgModalOpen){ this._bgRefresh(); this._bgModalRender(); return }
    // FR-BGK-5: 모달 밖 클릭·Escape 는 모달을 닫으므로 확인도 함께 취소된다.
    // 진행 중인 종료는 남는다 — 요청은 이미 떠났고, 응답이 목록을 정리한다.
    this._bgConfirm=null; this._bgError=null;
    const el=document.getElementById('bg-modal'); if(el) el.remove();
    if(this._bgModalKey){document.removeEventListener('keydown',this._bgModalKey);this._bgModalKey=null}
  },

  _bgModalRender(){
    let ov=document.getElementById('bg-modal');
    if(!ov){
      ov=document.createElement('div'); ov.id='bg-modal'; ov.className='bg-modal';
      document.body.appendChild(ov);
      // FR-BGU-7: 배경 클릭 — 오버레이 자신이 대상일 때만 닫는다.
      ov.addEventListener('click',e=>{if(e.target===ov)this._bgModalToggle(false)});
      this._bgModalKey=e=>{if(e.key==='Escape'){e.preventDefault();this._bgModalToggle(false)}};
      document.addEventListener('keydown',this._bgModalKey);
    }
    ov.innerHTML='';
    const box=document.createElement('div'); box.className='bg-box';
    const head=document.createElement('div'); head.className='bg-head';
    head.textContent=`백그라운드 도구 ${this._bg.length}개`;
    box.appendChild(head);
    if(!this._bg.length){
      const empty=document.createElement('div'); empty.className='bg-empty';
      empty.textContent='없음'; box.appendChild(empty);
    }
    for(const b of this._bg) box.appendChild(this._bgRow(b));
    ov.appendChild(box);
  },

  // FR-BGK-1: 행 하나. 종료는 행 클릭(복귀)과 **다른 목표**다 — 겹치면 복귀하려다
  // 죽인다. 확인·진행·오류는 this._bg* 에서 파생하므로 다시 그려도 살아남는다.
  _bgRow(b){
    const confirming=this._bgConfirm===b.toolId;
    const pending=this._bgPending===b.toolId;
    const row=document.createElement('div'); row.className='bg-row';
    if(!confirming&&!pending) row.title='클릭하면 현재 분할 칸의 새 탭으로 복귀';
    // .pn-tab[data-toolid] 과 같은 관행 — 어느 도구의 행인지 DOM 으로 식별한다.
    row.dataset.toolid=b.toolId;
    // FR-NAM-5: 백그라운드 도구에는 탭이 없다 — 파생 이름이 그 도구를 부르는
    // 유일한 이름이다. 서버가 준 name 은 fallback 으로만 쓴다.
    const name=document.createElement('span'); name.className='bg-name';
    name.textContent=this._toolName(b.toolId,b.name);
    const cwd=document.createElement('span'); cwd.className='bg-cwd'; cwd.textContent=b.cwd||'';
    row.appendChild(name); row.appendChild(cwd);
    // FR-BGK-12: Run 소속. 묶음 H 가 오기 전에는 필드가 없고, 그때는 아무것도 붙지 않는다.
    const run=this._bgRun(b);
    if(run){
      const el=document.createElement('span'); el.className='bg-run';
      el.textContent=run.role?`Run ${run.short} · ${run.role}`:`Run ${run.short}`;
      row.appendChild(el);
    }
    // FR-BGK-10: 오류는 행 안에 남는다. 종료 목표보다 앞에 두어 오른쪽 끝이 흔들리지 않는다.
    if(this._bgError&&this._bgError.toolId===b.toolId){
      const err=document.createElement('span'); err.className='bg-err';
      err.textContent=this._bgError.msg; row.appendChild(err);
    }
    if(pending){
      // 서버가 SIGTERM 유예(3초)를 기다리므로 응답은 즉답이 아니다. 아무 표시가
      // 없으면 사용자는 눌리지 않았다고 보고 행을 다시 누른다 — 그것이 복귀다.
      const p=document.createElement('span'); p.className='bg-killing'; p.textContent='종료 중…';
      row.appendChild(p);
    }else if(confirming){
      row.appendChild(this._bgConfirmEl(b));
    }else{
      row.appendChild(this._bgKillBtn(b));
    }
    row.addEventListener('click',()=>{
      if(this._bgPending) return;
      // FR-BGK-5: 확인이 열려 있으면 행을 건드리는 것은 **취소일 뿐**이다.
      // 취소와 복귀를 한 클릭에 겹치면 확인의 의미가 사라진다.
      if(this._bgConfirm){this._bgConfirmSet(null);return}
      this._bgModalToggle(false);this._restoreTool(b.toolId);
    });
    return row;
  },

  // FR-BGK-2: 항상 보인다. hover 게이팅하지 않는다 — 터치 기기에 hover 가 없다.
  _bgKillBtn(b){
    const btn=document.createElement('button');
    btn.className='tbtn bg-kill'; btn.textContent='종료';
    btn.title=`${this._toolName(b.toolId,b.name)} 종료`;
    btn.dataset.toolid=b.toolId;
    btn.addEventListener('click',e=>{e.stopPropagation();this._bgConfirmSet(b.toolId)});
    return btn;
  },

  // FR-BGK-4: 확인은 행 안에서 한다. 모달 위의 모달은 Escape 처리와 포커스
  // 관리를 복잡하게 만든다.
  _bgConfirmEl(b){
    const wrap=document.createElement('span'); wrap.className='bg-confirm';
    const q=document.createElement('span'); q.className='bg-q'; q.textContent=this._bgKillQuestion(b);
    const yes=document.createElement('button'); yes.className='tbtn bg-yes'; yes.textContent='예';
    const no=document.createElement('button'); no.className='tbtn bg-no'; no.textContent='아니오';
    yes.addEventListener('click',e=>{e.stopPropagation();this._bgKill(b.toolId)});
    no.addEventListener('click',e=>{e.stopPropagation();this._bgConfirmSet(null)});
    wrap.appendChild(q); wrap.appendChild(yes); wrap.appendChild(no);
    return wrap;
  },

  // FR-BGK-12 / FR-HLM-9: 헤드리스 멤버는 소속을 알리고 죽인다.
  //
  // runId·role 은 /api/tools/background 가 **열린 Run 의 멤버에만** 싣는다
  // (omitempty — 모르면 키가 없다). 그러니 없는 것이 정상이고, 그때는 "떼어 둔
  // 내 도구" 다. short 는 uuid 앞 8자 (run/store.go 의 shortID 와 같은 규약).
  _bgRun(b){
    if(!b.runId) return null;
    return {short:String(b.runId).slice(0,8),role:b.role||''};
  },

  _bgKillQuestion(b){
    const run=this._bgRun(b);
    if(!run) return '종료?';
    return run.role
      ? `종료? 이 도구는 Run ${run.short} 의 멤버 ${run.role} 이다.`
      : `종료? 이 도구는 Run ${run.short} 의 멤버다.`;
  },

  // FR-BGK-5: 확인은 한 번에 하나다. 다른 행의 종료를 누르면 앞의 확인은 취소된다.
  _bgConfirmSet(toolId){
    this._bgConfirm=toolId||null;
    this._bgError=null;
    this._bgModalRender();
  },

  // FR-BGK-6~10: 종료는 POST /api/tools/kill 이다. 성공하면 목록만 다시 받는다 —
  // 모달은 열린 채로 남고(FR-BGK-8), "없음" 과 배지 소멸은 그 갱신이 따라온다
  // (FR-BGK-9). 실패하면 행이 남고 오류만 인라인으로 붙는다(FR-BGK-10).
  async _bgKill(toolId){
    this._bgConfirm=null; this._bgError=null; this._bgPending=toolId;
    this._bgModalRender();
    let ok=false, msg='';
    try{
      const r=await fetch('/api/tools/kill',{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({toolId})});
      ok=r.ok;
      if(!ok) msg=(await r.text()).trim()||`종료 실패 (${r.status})`;
    }catch{msg='종료 실패 — 서버에 닿지 못했다'}
    this._bgPending=null;
    if(!ok) this._bgError={toolId,msg};
    else await this._bgRefresh();
    // 응답을 기다리는 사이에 모달이 닫혔을 수 있다 — 그때 그리면 되살아난다.
    // 목록 갱신이 실패한 회차에도 '종료 중…' 이 남지 않게 여기서 한 번 더 그린다.
    if(this._bgModalOpen) this._bgModalRender();
  },
  _fmtBytes(b){
    if(b<1073741824)return(b/1048576).toFixed(1)+'MB';
    return(b/1073741824).toFixed(1)+'GB';
  },
  _locationLabel(){
    const s=this._aw();if(!s||!s.layout||!this.focused)return null;
    const sidx=this.ws.windows.findIndex(x=>x.id===this.ws.activeWindow);
    if(sidx<0)return null;
    const panes=[];
    const walk=n=>{
      if(!n)return;
      if(n.type==='pane')panes.push(n);
      else if(n.type==='split')for(const c of(n.children||[]))walk(c);
    };
    walk(s.layout);
    const pidx=panes.findIndex(r=>r.id===this.focused);
    if(pidx<0)return null;
    const pn=panes[pidx];
    const tidx=pn.tabs.findIndex(t=>t.id===pn.activeTab);
    if(tidx<0)return null;
    return `W${sidx+1}.P${pidx+1}.T${tidx+1}`;
  },
  _updateCwd(){
    const p=this._focusedTerminal();if(!p)return;
    fetch('/api/cwd?tool='+p.id).then(r=>r.json()).then(({cwd})=>{this._cwd=cwd;this._updateStatusBar()}).catch(()=>{});
  },
  _renderStatusBarSettings(){
    const el=document.getElementById('sb-settings');if(!el)return;
    el.innerHTML='';
    // Interval selector
    const iRow=document.createElement('div');iRow.className='sbs-row';
    const iLabel=document.createElement('span');iLabel.textContent='갱신 주기';
    const iSel=document.createElement('select');iSel.className='sbs-select';
    [{v:1000,t:'1초'},{v:2000,t:'2초'},{v:3000,t:'3초'},{v:5000,t:'5초'},{v:10000,t:'10초'},{v:30000,t:'30초'}].forEach(o=>{
      const opt=document.createElement('option');opt.value=o.v;opt.textContent=o.t;
      if(String(statsInterval)===String(o.v))opt.selected=true;
      iSel.appendChild(opt);
    });
    iSel.addEventListener('change',()=>{statsInterval=parseInt(iSel.value);this._saveSettings();this._startStatsPoll()});
    iRow.appendChild(iLabel);iRow.appendChild(iSel);
    el.appendChild(iRow);
    // Item toggles
    for(const[k,v]of Object.entries(STATUS_ITEMS)){
      const row=document.createElement('div');row.className='sbs-row';row.dataset.item=k;
      const label=document.createElement('span');label.textContent=v.label;
      const toggle=document.createElement('label');
      const inp=document.createElement('input');inp.type='checkbox';inp.checked=!!statusBar[k];
      const slider=document.createElement('span');slider.className='slider';
      inp.addEventListener('change',()=>{statusBar[k]=inp.checked;this._saveSettings();this._updateStatusBar()});
      toggle.appendChild(inp);toggle.appendChild(slider);
      row.appendChild(label);row.appendChild(toggle);
      el.appendChild(row);
    }
  },
});
