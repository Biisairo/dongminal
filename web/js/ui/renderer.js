/**
 * Remote Terminal — layout → DOM renderer
 * App 의 render / _rSidebar / _rTopbar / _rLayout / _buildNode / _buildPane
 * / _buildSp / _handle 책임을 분리. Renderer 내부 메서드 호출은 this.X 로,
 * App 상태·메서드는 this.app.X 로 접근한다. 동작은 1:1 보존.
 */
class Renderer {
  constructor(app){ this.app = app; }

  render(){
    const oldFocus=this.app._prevFocus;
    this.app._prevFocus=this.app.focused;
    if(oldFocus!==undefined&&oldFocus!==this.app.focused){
      this.app._clearAllSearchDecorations();
      this.app._researchIfOpen();
    }
    this.app._applyMobileMode();
    this._rSbTabs();this._rSidebar();this._rGitSection();this._rTopbar();this._rLayout();
    this.app._updateCwd();
    this.app._updateStatusBar();
    // Apply window focus overlay after every render so the DOM is
    // guaranteed to exist (BroadcastChannel may trigger _applyFocusOverlay
    // before the first render completes).
    this.app._applyFocusOverlay();
  }

  /**
   * GIT_SIDEBAR_TABS_SRS FR-SBT-1·14: 사이드바 탭 바.
   *
   * 그리기 전에 **활성 창 → 탭**을 맞춘다 (FR-SBT-14). 반대 방향(탭 → 창)은
   * `SidebarTabs.setTab` 이 하며, 재진입 가드가 둘이 서로를 부르는 순환을 끊는다
   * (§3.9.2, V-SBT-10).
   */
  _rSbTabs(){
    this.app._sbSyncTabToWindow();
    SidebarTabs.paint(this.app);
  }

  /**
   * FR-RPT-3: 목록을 비우고 다시 만들지 않는다.
   *
   * `render()` 는 사용자 행동뿐 아니라 **SSE `workspace_changed`** 로도 불린다 —
   * 다른 브라우저나 다른 에이전트의 `dmctl` 이 워크스페이스를 고치면 사용자가
   * 아무것도 하지 않았는데 이 목록이 다시 만들어진다. 그러면 hover 로만 보이는
   * `×` 가 사라지고, 이름변경 더블클릭의 두 번째 클릭이 새 요소에 떨어지고,
   * 끌고 있던 창이 DOM 에서 빠져 재배치가 조용히 실패한다.
   */
  _rSidebar(){
    const el=document.getElementById('windows');
    const wins=this.app.ws.windows.filter(s=>!this.app._isGitWin(s));
    reconcileList(el,wins,{
      key:s=>s.id,
      // `_siEl` 이 읽는 값 전부다 (FR-RPT-2).
      sig:s=>[s.name||'',s.type||WINDOW_TYPE_TERMINAL,
              s.id===this.app.ws.activeWindow?1:0,
              this.app._windowHasAttn(s)?1:0].join('\u0001'),
      build:s=>this._siEl(el,s),
    });
  }

  // FR-GIT-182: Git 창은 WINDOWS 목록에 없다 — 진입점은 GIT 섹션의 리포 항목뿐이다.
  // 진입점이 둘이면 창 목록의 `Git` 은 "어느 리포인지 모르는 창"이 된다. 걸러내는
  // 것은 `_rSidebar` 이고 여기는 만들기만 한다.
  _siEl(el,s){
    const d=document.createElement('div');
    // FR-PAN-16: 알람이 있는 창을 사이드바에서 구분 표시
    d.className='si'+(s.id===this.app.ws.activeWindow?' active':'')+(this.app._windowHasAttn(s)?' attn':'');
    d.dataset.sid=s.id;
    d.dataset.windowType=s.type||WINDOW_TYPE_TERMINAL;
    d.innerHTML='<span class="si-dot"></span><span class="si-name"></span><span class="si-x">×</span>';
    d.querySelector('.si-name').textContent=s.name;
    d.addEventListener('click',e=>{if(!e.target.classList.contains('si-x'))this.app.switchWindow(s.id)});
    d.querySelector('.si-x').addEventListener('click',e=>{e.stopPropagation();this.app.delWindow(s.id)});
    d.querySelector('.si-name').addEventListener('dblclick',e=>{e.stopPropagation();this.app._rename(s,e.target)});
    d.draggable=true;
    // 재배치는 drop(즉시·깜빡임 없음) 1순위, 패널 밖 release 는 dragend 폴백. 식별자 기반 splice.
    d.addEventListener('dragstart',e=>{this.app._drag={type:'window',srcId:s.id,targetId:null,before:false,done:false};e.dataTransfer.effectAllowed='move';setTimeout(()=>d.classList.add('dragging'),0)});
    d.addEventListener('dragover',e=>{const dr=this.app._drag;if(!dr||dr.type!=='window')return;e.preventDefault();el.querySelectorAll('.si').forEach(si=>si.classList.remove('drag-above','drag-below'));const rect=d.getBoundingClientRect();const before=e.clientY<rect.top+rect.height/2;d.classList.add(before?'drag-above':'drag-below');dr.targetId=s.id;dr.before=before});
    d.addEventListener('drop',e=>{const dr=this.app._drag;if(!dr||dr.type!=='window')return;e.preventDefault();e.stopPropagation();this.app._reorderWindows(dr)});
    // dragend 는 시각 정리만 — 패널 밖 release 는 취소(순서 불변, snap-back 깜빡임 방지).
    d.addEventListener('dragend',()=>{this.app._drag=null;d.classList.remove('dragging');el.querySelectorAll('.si').forEach(si=>si.classList.remove('drag-above','drag-below'))});
    return d;
  }

  // FR-GIT-13: 좌측 GIT 섹션. 데이터는 app._gitRepos 다 — 없으면 본문만 비운다.
  //
  // FR-SBT-8: git 이 없는 환경(`_gitOff`)에서 요소를 하나씩 감추던 일은 사라졌다 —
  // 감추는 단위가 **탭**이 되었고, 그 판정은 서술자의 `visible()` 한 곳에 있다.
  _rGitSection(){
    const el=document.getElementById('git-repos'); if(!el) return;
    const d=this.app._gitRepos;
    if(!d){el.innerHTML=''; return}
    /**
     * FR-RPT-3: 목록을 비우고 다시 만들지 않는다.
     *
     * 이 함수는 `_gitReposRefresh` 가 **3초마다** 부른다. 요소를 새로 만들면 hover
     * 로만 보이는 `×` 가 3초마다 깜빡이고, 더 나쁜 것은 **끌고 있던 핀이 DOM 에서
     * 빠져 재배치가 조용히 실패하는 것**이다 (FR-GIT-223).
     */
    // FR-FLW-1: 핀만 그린다. follow 행은 없다 — 활성 리포는 사용자가 고른 것이다.
    //
    // FR-FLW-11: 비었을 때 자리를 비워 두지 않는다. follow 행이 늘 한 줄을
    // 채우고 있었으므로 이 섹션은 빈 적이 없었다 — 이제는 있다.
    const items=(d.pinned||[]).map(e=>({e}));
    el.classList.toggle('empty',!items.length);
    if(!items.length){
      el.innerHTML='<div class="git-repos-none"></div>';
      el.firstElementChild.textContent=GIT_REPOS_NONE;
      return;
    }
    reconcileList(el,items,{
      key:it=>'pin:'+(it.e.path||''),
      sig:it=>this._gitRepoSig(it),
      build:it=>this._rGitRepo(it.e),
    });
  }

  // 행의 **보이는 값 전부**다 (FR-RPT-2) — `_rGitRepo` 가 읽는 것과 1:1 로 맞춘다.
  _gitRepoSig(it){
    const e=it.e,b=e.badge||{};
    return [
      e.path||'',e.isRepo?1:0,e.name||'',e.reason||'',e.cwd||'',
      b.total>0?b.total:0,b.total>0?(b.observedAtUnixMs||0):0,
      (!!e.path&&this.app.gitPanel.repo===e.path)?1:0,
    ].join('\u0001');
  }

  /**
   * 핀 재배치의 native DnD. WINDOWS 목록(`_rSidebar`)과 같은 규약이다 —
   * drop(즉시) 1순위 + dragend 는 시각 정리만, `done` 으로 중복 커밋을 막는다.
   *
   * 다른 점은 커밋 지점 하나다: 창 순서는 클라이언트가 `workspace.json` 에 쓰지만
   * **핀 순서는 서버가 권위로 쓴다** (O1) — `_gitReorder` 가 서버를 지난다.
   */
  _bindPinDrag(d,path){
    const list=document.getElementById('git-repos');
    const clear=()=>list&&list.querySelectorAll('.git-repo').forEach(x=>
      x.classList.remove('drag-above','drag-below'));
    d.draggable=true;
    d.addEventListener('dragstart',e=>{
      this.app._drag={type:'gitpin',src:path,target:null,before:false,done:false};
      if(e.dataTransfer) e.dataTransfer.effectAllowed='move';
      setTimeout(()=>d.classList.add('dragging'),0);
    });
    d.addEventListener('dragover',e=>{
      const dr=this.app._drag; if(!dr||dr.type!=='gitpin') return;
      e.preventDefault(); clear();
      const r=d.getBoundingClientRect();
      const before=(e.clientY-r.top)<r.height/2;
      dr.target=path; dr.before=before;
      d.classList.add(before?'drag-above':'drag-below');
    });
    d.addEventListener('drop',e=>{
      const dr=this.app._drag; if(!dr||dr.type!=='gitpin') return;
      e.preventDefault(); e.stopPropagation(); clear();
      this.app._gitReorder(dr);
    });
    d.addEventListener('dragend',()=>{
      this.app._drag=null; d.classList.remove('dragging'); clear();
    });
  }

  // FR-GIT-11·14·15: 핀 항목. 저장소가 아니면 흐리게 보이고 클릭 리스너를 달지
  // 않는다 — 핀은 × 로 지울 수 있어야 하므로 목록에는 남겨 둔다.
  _rGitRepo(e){
    const path=e.path||'';
    const active=!!path&&this.app.gitPanel.repo===path;
    const d=document.createElement('div');
    d.className='git-repo pinned'+(e.isRepo?'':' norepo')+(active?' active':'');
    if(path) d.dataset.gitRepo=path;
    // FR-GIT-192: 이모지를 쓰지 않는다. 표식은 WINDOWS 목록의 점(`.si-dot`)과 같은
    // 어휘이며 **활성 리포 여부만** 나타낸다 (O18).
    d.innerHTML='<span class="git-repo-dot"></span><span class="git-repo-name"></span>';
    if(!e.isRepo) d.querySelector('.git-repo-dot').classList.add('none');
    d.querySelector('.git-repo-name').textContent=e.name;
    // FR-RMS-17: 사유는 사람이 읽는 문구로 옮긴다 — `repo_missing` 을 날것으로
    // 보이면 사용자는 그것이 무엇인지 모르고, 그러면 알린 것이 아니다.
    const why=e.reason?(GIT_WRITE_ERR[e.reason]||e.reason):'';
    d.title=e.isRepo?path:why+' — '+(e.cwd||path);
    // 배지는 서버의 마지막 관측값이다. 0 을 보일 이유는 없다 (FR-GIT-14).
    const b=e.badge;
    if(b&&b.total>0){
      const s=document.createElement('span');
      // O4: 활성 리포가 아니면 흐리게 하고 관측 시각을 알린다.
      s.className='git-badge'+(active?'':' stale');
      s.textContent=b.total;
      if(!active) s.title='최신 아님 (마지막 관측: '+new Date(b.observedAtUnixMs).toLocaleTimeString()+')';
      d.appendChild(s);
    }
    const x=document.createElement('span'); x.className='git-repo-x'; x.textContent='×';
    x.addEventListener('click',ev=>{ev.stopPropagation();this.app._gitUnpin(e.path)});
    d.appendChild(x);
    if(e.isRepo&&path) d.addEventListener('click',()=>this.app.openGitWindow(path));
    // FR-GIT-223: 핀은 WINDOWS 목록과 **같은 제스처**로 순서를 바꾼다.
    if(path) this._bindPinDrag(d,path);
    return d;
  }

  _rTopbar(){
    const a=this.app._aw();
    document.getElementById('window-name').textContent=a?a.name:'';
    // FR-GIT-180: Git 창에서는 분할 진입점을 감춘다. (FR-GIT-183 의 `Close Git`
    // 은 폐기됐다 — 떠나는 길이 사이드바 탭으로 상시 존재한다, FR-SBT-34.)
    const isGit=this.app._isGitWin(a);
    for(const id of ['split-h','split-v']){
      const b=document.getElementById(id);
      if(b) b.classList.toggle('git-hidden',isGit);
    }
    const mAdd=document.getElementById('m-add-tab');
    if(mAdd) mAdd.classList.toggle('git-hidden',isGit);
    const ind=document.getElementById('m-pane-indicator');
    if(ind){
      const n=this.app._mobilePaneCount();
      if(n<=0){ind.textContent='0/0'}
      else{
        if(this.app._mPaneIdx>=n) this.app._mPaneIdx=n-1;
        if(this.app._mPaneIdx<0) this.app._mPaneIdx=0;
        ind.textContent=`${this.app._mPaneIdx+1}/${n}`;
      }
    }
    const dt=document.getElementById('m-drawer-toggle');
    if(dt) dt.textContent = this.app._drawerOpen ? '✕' : '☰';
  }

  _rLayout(){
    const area=document.getElementById('area');
    const s=this.app._aw();
    for(const p of this.app.tools.values()){
      if(p.el.classList.contains('vis')){
        const vp=p.el.querySelector('.xterm-viewport');
        if(vp) p._scrollTop=vp.scrollTop;
        if(p.term){try{p._viewportY=p.term.buffer.active.viewportY}catch{}}
      }
      p.el.classList.remove('vis');area.appendChild(p.el);
    }
    for(const v of this.app.fileEditors.values()){
      v.el.classList.remove('vis');area.appendChild(v.el);
    }
    for(const c of [...area.children]){if(c.classList.contains('sp')||c.classList.contains('pn'))c.remove()}
    if(!s?.layout) return;
    if(!findPane(s.layout,this.app.focused)){this.app._setFocus(firstPane(s.layout)?.id||null, s)}
    let dom;
    if(this.app.isMobile){
      const regs=this.app._flattenPanes(s.layout);
      if(regs.length){
        const fIdx=regs.findIndex(r=>r.id===this.app.focused);
        if(fIdx>=0) this.app._mPaneIdx=fIdx;
        else if(this.app._mPaneIdx>=regs.length) this.app._mPaneIdx=regs.length-1;
        const target=regs[this.app._mPaneIdx];
        if(target){this.app._setFocus(target.id, s);dom=this._buildPane(target)}
      }
    }else{
      dom=this._buildNode(s.layout);
    }
    if(dom) area.appendChild(dom);
    const allTabIds=new Set();
    const walk=n=>{if(!n)return;if(n.type==='pane'&&n.tabs)n.tabs.forEach(t=>allTabIds.add(t.id));if(n.type==='split'&&n.children)n.children.forEach(walk)};
    for(const sess of this.app.ws.windows){if(sess&&sess.layout)walk(sess.layout)}
    for(const[tid,v] of this.app.fileEditors){if(!allTabIds.has(tid)){v.destroy();this.app.fileEditors.delete(tid)}}
    // Git 창이 사라졌으면 루트를 area 로 되돌린다. 인스턴스는 유지 — 다시 열릴 수 있다.
    if(!this.app._gitWindow()) this.app.gitPanel.detach();
    requestAnimationFrame(()=>{
      for(const p of this.app.tools.values()){
        if(p.el.classList.contains('vis')){
          if(!p._opened)p.open();
          p.doFit();
          // Restore scrollback after DOM detach.
          //
          // xterm v5 keeps two states: internal `buffer.ydisp` (drives row
          // rendering) and DOM `.xterm-viewport.scrollTop` (drives scrollbar
          // and scroll events). Detach + display:none + reattach via
          // appendChild fires scroll events which `_handleScroll` either
          // ignores (offsetParent null) or applies (offsetParent non-null).
          // The exact timing is browser-dependent, leaving us in any of:
          //   (a) ydisp preserved, scrollTop reset → scrollbar at top, content correct
          //   (b) ydisp reset, scrollTop preserved → scrollbar at original, content at top
          //   (c) both reset → both at top  (the user-reported case)
          //   (d) both preserved → no fix needed
          // `term.scrollLines(delta)` early-returns when delta==0, so the
          // case where ydisp matches our target is a no-op and leaves the
          // DOM unsynced. We force a guaranteed resync by toggling ydisp
          // through 0 (or away from target if target==0) before scrolling
          // back, which always fires `_onScroll` → `syncScrollArea` →
          // `_innerRefresh`. _innerRefresh then sets scrollTop = ydisp *
          // rowHeight authoritatively. As a safety net we also write the
          // captured pixel value directly.
          if(p.term&&typeof p._viewportY==='number'){
            try{
              const buf=p.term.buffer.active;
              const max=Math.max(0,buf.length-p.term.rows);
              const target=Math.min(Math.max(0,p._viewportY),max);
              if(target>0){
                p.term.scrollToTop();
                p.term.scrollToLine(target);
              }else if(max>0){
                p.term.scrollToBottom();
                p.term.scrollToTop();
              }else{
                p.term.scrollToTop();
              }
            }catch{}
          }
          if(typeof p._scrollTop==='number'){
            const vp=p.el.querySelector('.xterm-viewport');
            if(vp){try{vp.scrollTop=p._scrollTop}catch{}}
          }
        }
      }
      // FR-MTI-25: 모바일에서는 render 가 터미널에 focus 하지 않는다. focus 된
      // 입력 요소가 있으면 Android Chrome 이 탭마다 키보드를 재표시하므로, 첫
      // 로드와 모든 재렌더가 키보드를 불러들이게 된다. 모바일에서 키보드를
      // 올리는 길은 사용자가 터미널을 탭하는 것 하나뿐이다 (_buildPane 의
      // mousedown). 편집기는 그 대상이 아니다 — 자기 UI 를 가진다.
      if(this.app.focused && !this.app.isMobile){
        const pn=findPane(s.layout,this.app.focused);
        if(pn){const tab=pn.tabs.find(t=>t.id===pn.activeTab);if(tab){
          if(tab.type==='editor'){const v=this.app.fileEditors.get(tab.id);if(v)v.el.focus()}
          else{const p=this.app.tools.get(tab.toolId);if(p)p.focus()}
        }}
      }
      // After fit, panes have correct dimensions. Re-send sizes for the
      // active window if this window owns it and has OS focus.
      if(this.app._windowFocused){
        this.app._resendWindowSizes(this.app.ws.activeWindow);
      }
    });
  }

  _buildNode(n){
    if(!n) return null;
    if(n.type==='pane') return this._buildPane(n);
    if(n.type==='split'&&n.children) return this._buildSp(n);
    return null;
  }


  // 활성 탭의 **본문**을 pane body 에 붙인다. 타입별로 실체가 다르다 — git 은
  // 싱글턴 패널의 view DOM, editor 는 FileEditor 인스턴스, terminal 은 PTY 를 든
  // Tool 의 DOM 이다.
  //
  // 분기를 함수로 뽑아 둔 이유는 ORCHESTRATION_V2_SRS FR-RVZ-6 의 네 번째 타입
  // ('run' — Run 대시보드)이 여기 들어오기 때문이다. 병렬 중 이 파일을 여럿이
  // 만지지 않도록 자리를 미리 갈라 둔다 (PARALLEL_DELIVERY_PLAN Step 0-4).
  _mountTabBody(body,at){
    if(at.type===TAB_TYPE_GIT){
      // GitPanel 은 Git 창이 싱글턴이므로 앱에 하나다 — 탭마다 인스턴스를
      // 만들지 않고 view 별 루트 DOM 만 캐시한다 (FR-GIT-26).
      const el=this.app.gitPanel.elFor(at.gitView);
      body.appendChild(el); el.classList.add('vis');
      return;
    }
    if(at.type==='editor'){
      let editor=this.app.fileEditors.get(at.id);
      if(!editor){editor=new FileEditor(at.id,at.name,at.filePath);this.app.fileEditors.set(at.id,editor)}
      body.appendChild(editor.el);editor.el.classList.add('vis');
      return;
    }
    if(at.type==='run'){
      // FR-RVZ-6: 네 번째 타입. editor 와 같은 비-PTY 탭이며 at.runId 를 요구한다.
      // 루트 DOM 은 탭마다 하나로 캐시된다 — pane 을 다시 그려도 SVG 가 새로
      // 만들어지지 않아야 hover 가 살아남는다 (NFR-RVZ-2). 구현은 app-runs.js.
      const el=this.app._runViewEl(at);
      body.appendChild(el); el.classList.add('vis');
      return;
    }
    const p=this.app.tools.get(at.toolId);
    if(p){body.appendChild(p.el);p.el.classList.add('vis')}
  }

  _buildPane(n){
    const el=document.createElement('div');
    // FR-PAN-9: 활성탭 pane 이 주의 상태이고 pane 이 포커스 안 됐을 때만 pane 강조
    const focused=n.id===this.app.focused;
    const at0=(n.tabs||[]).find(t=>t.id===n.activeTab);
    const paneAttn=!focused&&at0&&this.app._attnHas(at0.toolId);
    el.className='pn'+(focused?' focused':'')+(paneAttn?' attn':'');
    el.dataset.paneid=n.id;
    const tabs=document.createElement('div'); tabs.className='pn-tabs';
    for(const tab of(n.tabs||[])){
      const t=document.createElement('div');
      // FR-PAN-9/TC-PAN-17: 사용자가 지금 보고 있는 탭(포커스+활성)은 강조하지 않음
      const tabActive=tab.id===n.activeTab;
      const tabAttn=this.app._attnHas(tab.toolId)&&!(focused&&tabActive);
      // FR-GIT-28: git 탭은 고정이다 — 닫기·이름변경·드래그를 달지 않는다.
      // 자리가 항상 같아야 근육 기억이 선다.
      const isGit=tab.type===TAB_TYPE_GIT;
      t.className='pn-tab'+(tabActive?' active':'')+(tabAttn?' attn':'')+(isGit?' git':'');
      t.dataset.tabId=tab.id;
      if(tab.toolId) t.dataset.toolid=tab.toolId;
      if(isGit) t.dataset.gitView=tab.gitView;
      t.innerHTML='<span class="pn-tab-label"></span>'+(isGit?'':'<span class="pn-tab-x">×</span>');
      t.querySelector('.pn-tab-label').textContent=this._tabDisplayName(tab);
      t.addEventListener('click',e=>{
        e.stopPropagation();
        if(e.target.classList.contains('pn-tab-x')) this.app.closeTab(n.id,tab.id);
        else this.app.switchTab(n.id,tab.id);
      });
      t.draggable=!isGit;
      t.addEventListener('dragstart',e=>{this.app._drag={type:'tab',srcPaneId:n.id,tabId:tab.id};e.dataTransfer.effectAllowed='move';e.stopPropagation();setTimeout(()=>t.classList.add('dragging'),0)});
      t.addEventListener('dragend',()=>{this.app._drag=null;t.classList.remove('dragging');tabs.querySelectorAll('.pn-tab').forEach(r=>r.classList.remove('drag-left','drag-right'));document.querySelectorAll('.pn-drop-indicator').forEach(ind=>ind.style.display='none')});
      t.addEventListener('dragover',e=>{if(!this.app._drag||this.app._drag.type!=='tab')return;e.preventDefault();e.stopPropagation();tabs.querySelectorAll('.pn-tab').forEach(r=>r.classList.remove('drag-left','drag-right'));const rect=t.getBoundingClientRect();t.classList.add(e.clientX<rect.left+rect.width/2?'drag-left':'drag-right');document.querySelectorAll('.pn-drop-indicator').forEach(ind=>ind.style.display='none')});
      t.addEventListener('drop',e=>{e.preventDefault();e.stopPropagation();if(!this.app._drag||this.app._drag.type!=='tab')return;const{srcPaneId,tabId}=this.app._drag;this.app._drag=null;tabs.querySelectorAll('.pn-tab').forEach(r=>r.classList.remove('drag-left','drag-right'));const s=this.app._aw();if(!s)return;if(srcPaneId===n.id){const pn=findPane(s.layout,n.id);if(!pn)return;const si=pn.tabs.findIndex(tt=>tt.id===tabId);const di=pn.tabs.findIndex(tt=>tt.id===tab.id);if(si<0||di<0||si===di)return;const rect=t.getBoundingClientRect();const insBefore=e.clientX<rect.left+rect.width/2;const[moved]=pn.tabs.splice(si,1);let ins=pn.tabs.findIndex(tt=>tt.id===tab.id);if(!insBefore)ins++;pn.tabs.splice(ins,0,moved);pn.activeTab=tabId;this.app._save();this.app.render()}else{const rect=t.getBoundingClientRect();this.app._moveTabToPane(srcPaneId,tabId,n.id,tab.id,e.clientX<rect.left+rect.width/2)}});
      tabs.appendChild(t);
    }
    // FR-GIT-180: Git 창에는 `+` 자리를 만들지 않는다 — 눌리지만 아무 일도 하지
    // 않는 버튼은 고장으로 읽힌다.
    const gitWin=this.app._isGitWin(this.app._aw());
    if(!gitWin){
      const add=document.createElement('button'); add.className='pn-tab-add'; add.textContent='+';
      add.addEventListener('click',e=>{e.stopPropagation();this.app.addTab(n.id)});
      tabs.appendChild(add);
    }
    tabs.addEventListener('dragover',e=>{if(!this.app._drag||this.app._drag.type!=='tab')return;e.preventDefault();e.stopPropagation();if(this.app._drag.srcPaneId!==n.id)tabs.classList.add('drag-target')});
    tabs.addEventListener('dragleave',e=>{if(!tabs.contains(e.relatedTarget))tabs.classList.remove('drag-target')});
    tabs.addEventListener('drop',e=>{e.preventDefault();e.stopPropagation();tabs.classList.remove('drag-target');tabs.querySelectorAll('.pn-tab').forEach(r=>r.classList.remove('drag-left','drag-right'));if(!this.app._drag||this.app._drag.type!=='tab')return;const{srcPaneId,tabId}=this.app._drag;this.app._drag=null;const s=this.app._aw();if(!s)return;if(srcPaneId===n.id){const pn=findPane(s.layout,n.id);if(!pn)return;const si=pn.tabs.findIndex(t=>t.id===tabId);if(si<0)return;const[moved]=pn.tabs.splice(si,1);pn.tabs.push(moved);pn.activeTab=tabId;this.app._save();this.app.render()}else{this.app._moveTabToPane(srcPaneId,tabId,n.id,null,false)}});
    el.appendChild(tabs);
    const body=document.createElement('div'); body.className='pn-body';
    const at=(n.tabs||[]).find(t=>t.id===n.activeTab);
    if(at) this._mountTabBody(body,at);
    body.addEventListener('dragover',e=>{if(!this.app._drag||this.app._drag.type!=='tab')return;e.preventDefault();e.stopPropagation();tabs.querySelectorAll('.pn-tab').forEach(r=>r.classList.remove('drag-left','drag-right'));this.app._showBodyDropIndicator(body,this.app._getDragZone(body,e))});
    body.addEventListener('dragleave',e=>{if(!body.contains(e.relatedTarget))this.app._clearBodyDropIndicator(body)});
    body.addEventListener('drop',e=>{e.preventDefault();e.stopPropagation();if(!this.app._drag||this.app._drag.type!=='tab')return;const zone=this.app._getDragZone(body,e);const{srcPaneId,tabId}=this.app._drag;this.app._drag=null;this.app._clearBodyDropIndicator(body);if(zone==='center'){if(srcPaneId===n.id)return;this.app._moveTabToPane(srcPaneId,tabId,n.id,null,false)}else{this.app._splitPaneWithTab(srcPaneId,tabId,n.id,zone)}});
    el.appendChild(body);
    el.addEventListener('mousedown',()=>{
      this.app.setFocus(n.id);
      // FR-MTI-25: 모바일에서 키보드를 올리는 유일한 경로. render 는 focus 하지
      // 않으므로(위) 여기서 하지 않으면 모바일에서 입력을 시작할 길이 없다.
      // 스크롤 제스처는 touchmove 가 blur 하고 합성 mousedown 도 만들지 않는다.
      if(this.app.isMobile){
        const pn=findPane(this.app._aw()?.layout,n.id);
        const tab=pn&&(pn.tabs||[]).find(t=>t.id===pn.activeTab);
        if(tab&&tab.type!=='editor'){
          const p=this.app.tools.get(tab.toolId);
          if(p) p.focus();
        }
      }
    });
    return el;
  }

  _buildSp(n){
    const el=document.createElement('div'); el.className='sp'; el.dataset.d=n.direction; el._node=n;
    for(let i=0;i<n.children.length;i++){
      const sc=document.createElement('div'); sc.className='sc';
      if(n.sizes&&n.sizes[i]!=null) sc.style.flex=n.sizes[i];
      const built=this._buildNode(n.children[i]);
      if(built) sc.appendChild(built);
      el.appendChild(sc);
      if(i<n.children.length-1){const h=document.createElement('div');h.className='sh';el.appendChild(h);this._handle(h,el)}
    }
    return el;
  }

  _handle(h,sp){
    h.addEventListener('mousedown',e=>{
      e.preventDefault();
      const dir=sp.dataset.d, prev=h.previousElementSibling, next=h.nextElementSibling;
      const sx=e.clientX, sy=e.clientY;
      const tot=dir==='horizontal'?prev.offsetWidth+next.offsetWidth:prev.offsetHeight+next.offsetHeight;
      const start=dir==='horizontal'?prev.offsetWidth:prev.offsetHeight;
      const mv=e=>{
        if(dir==='horizontal'){
          const nw=start+(e.clientX-sx);if(nw<60||tot-nw<60)return;
          prev.style.flex=`${nw/tot}`;next.style.flex=`${(tot-nw)/tot}`;
        }else{
          const nh=start+(e.clientY-sy);if(nh<60||tot-nh<60)return;
          prev.style.flex=`${nh/tot}`;next.style.flex=`${(tot-nh)/tot}`;
        }
      };
      const up=()=>{
        document.removeEventListener('mousemove',mv);document.removeEventListener('mouseup',up);
        const nd=sp._node;
        if(nd){nd.sizes=[];for(const c of sp.children){if(c.classList.contains('sc'))nd.sizes.push(parseFloat(c.style.flex)||1)}this.app._save()}
        for(const p of this.app.tools.values())if(p.el.classList.contains('vis'))p.doFit();
      };
      document.addEventListener('mousemove',mv);document.addEventListener('mouseup',up);
    });
  }
}
