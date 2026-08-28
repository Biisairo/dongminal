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
    // UX_REVISION_SRS FR-BLP-1: 창 목록은 이제 블루프린트가 그린다. 이 함수가
    // 남아 있는 이유는 호출처(render·SSE·알람)가 이름으로 부르기 때문이다 —
    // 그 배선을 바꾸는 것은 이 SRS 의 일이 아니다.
    SidebarList.paint(this.app,SB_TAB_DEFS.find(d=>d.id==='windows'));
  }

  // FR-GIT-13: 좌측 GIT 섹션. 데이터는 app._gitRepos 다 — 없으면 본문만 비운다.
  //
  // FR-BLP-1: 창 목록과 **같은 구현**을 쓴다. 두 목록의 차이는 서술자뿐이다
  // (sidebar-tabs.js 의 `list`).
  _rGitSection(){
    SidebarList.paint(this.app,SB_TAB_DEFS.find(d=>d.id==='git'));
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

  // 탭 하나가 탭 바에 **보이는 이름**이다. 단일 자리인 이유는 CONVENIENCE_SRS
  // FR-TAN-17 이다 — 전경 프로세스에서 파생한 이름이 붙을 때, 탭 바와 사이드바와
  // dmctl list-workspace 가 서로 다른 것을 말하면 안 된다.
  //
  // 판정과 파생은 `tabName` 한 곳에 있다 (helpers.js) — dmctl 이 같은 규칙을
  // Go 로 다시 쓰므로, 브라우저 안에서만이라도 자리가 둘이면 안 된다.
  _tabDisplayName(tab){
    return (tab.dirty?'● ':'')+tabName(tab,this.app._fgNames);
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
      // 탭은 `_renameTab` 이다 — 창의 `_rename` 과 달리 빈 문자열에 뜻이 있다
      // (FR-TAN-21).
      if(!isGit) t.querySelector('.pn-tab-label').addEventListener('dblclick',e=>{e.stopPropagation();this.app._renameTab(tab,e.target)});
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
