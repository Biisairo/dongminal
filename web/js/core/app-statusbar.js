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
    // FR-GIT-58: chip 은 _updateStatusBar 가 매번 다시 만든다 — 리스너를 거기서
    // 붙이면 갱신마다 누적된다. 정적 컨테이너에 위임해 여기서 한 번만 붙인다.
    const sbItems=document.getElementById('sb-items');
    if(sbItems) sbItems.addEventListener('click',e=>{
      if(e.target.closest&&e.target.closest('.sb-git')) this.openGitWindow();
    });
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
    // chip 은 문자열이 아니라 DOM 으로 붙인다 — 브랜치 이름에는 < 와 & 가 올 수 있다.
    // FR-GIT-112: 진행 중 원격 작업은 chip 옆에 별도로 붙는다 — 브랜치 표시와
    // 섞으면 어느 것이 관측이고 어느 것이 진행인지 구분되지 않는다.
    if(statusBar.git){
      const c=this._gitChip(); if(c) items.push({k:'git',el:c});
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
    for(const b of this._bg){
      const row=document.createElement('div'); row.className='bg-row'; row.title='클릭하면 현재 분할 칸의 새 탭으로 복귀';
      // .pn-tab[data-toolid] 과 같은 관행 — 어느 도구의 행인지 DOM 으로 식별한다.
      row.dataset.toolid=b.toolId;
      const name=document.createElement('span'); name.className='bg-name'; name.textContent=b.name||DEFAULT_TOOL_NAME;
      const cwd=document.createElement('span'); cwd.className='bg-cwd'; cwd.textContent=b.cwd||'';
      row.appendChild(name); row.appendChild(cwd);
      row.addEventListener('click',()=>{this._bgModalToggle(false);this._restoreTool(b.toolId)});
      box.appendChild(row);
    }
    ov.appendChild(box);
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
