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
    this._rSidebar();this._rTopbar();this._rLayout();
    this.app._updateCwd();
    this.app._updateStatusBar();
    // Apply window focus overlay after every render so the DOM is
    // guaranteed to exist (BroadcastChannel may trigger _applyFocusOverlay
    // before the first render completes).
    this.app._applyFocusOverlay();
  }

  _rSidebar(){
    const el=document.getElementById('windows'); el.innerHTML='';
    for(const s of this.app.ws.windows){
      const d=document.createElement('div');
      // FR-PAN-16: 알람이 있는 창을 사이드바에서 구분 표시
      d.className='si'+(s.id===this.app.ws.activeWindow?' active':'')+(this.app._windowHasAttn(s)?' attn':'');
      d.dataset.sid=s.id;
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
      el.appendChild(d);
    }
  }

  _rTopbar(){
    const a=this.app._aw();
    document.getElementById('window-name').textContent=a?a.name:'';
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
      if(this.app.focused){
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
      t.className='pn-tab'+(tabActive?' active':'')+(tabAttn?' attn':'');
      t.dataset.tabId=tab.id;
      if(tab.toolId) t.dataset.toolid=tab.toolId;
      t.innerHTML='<span class="pn-tab-label"></span><span class="pn-tab-x">×</span>';
      t.querySelector('.pn-tab-label').textContent=(tab.dirty?'● ':'')+tab.name;
      t.addEventListener('click',e=>{
        e.stopPropagation();
        if(e.target.classList.contains('pn-tab-x')) this.app.closeTab(n.id,tab.id);
        else this.app.switchTab(n.id,tab.id);
      });
      t.querySelector('.pn-tab-label').addEventListener('dblclick',e=>{e.stopPropagation();this.app._rename(tab,e.target)});
      t.draggable=true;
      t.addEventListener('dragstart',e=>{this.app._drag={type:'tab',srcPaneId:n.id,tabId:tab.id};e.dataTransfer.effectAllowed='move';e.stopPropagation();setTimeout(()=>t.classList.add('dragging'),0)});
      t.addEventListener('dragend',()=>{this.app._drag=null;t.classList.remove('dragging');tabs.querySelectorAll('.pn-tab').forEach(r=>r.classList.remove('drag-left','drag-right'));document.querySelectorAll('.pn-drop-indicator').forEach(ind=>ind.style.display='none')});
      t.addEventListener('dragover',e=>{if(!this.app._drag||this.app._drag.type!=='tab')return;e.preventDefault();e.stopPropagation();tabs.querySelectorAll('.pn-tab').forEach(r=>r.classList.remove('drag-left','drag-right'));const rect=t.getBoundingClientRect();t.classList.add(e.clientX<rect.left+rect.width/2?'drag-left':'drag-right');document.querySelectorAll('.pn-drop-indicator').forEach(ind=>ind.style.display='none')});
      t.addEventListener('drop',e=>{e.preventDefault();e.stopPropagation();if(!this.app._drag||this.app._drag.type!=='tab')return;const{srcPaneId,tabId}=this.app._drag;this.app._drag=null;tabs.querySelectorAll('.pn-tab').forEach(r=>r.classList.remove('drag-left','drag-right'));const s=this.app._aw();if(!s)return;if(srcPaneId===n.id){const pn=findPane(s.layout,n.id);if(!pn)return;const si=pn.tabs.findIndex(tt=>tt.id===tabId);const di=pn.tabs.findIndex(tt=>tt.id===tab.id);if(si<0||di<0||si===di)return;const rect=t.getBoundingClientRect();const insBefore=e.clientX<rect.left+rect.width/2;const[moved]=pn.tabs.splice(si,1);let ins=pn.tabs.findIndex(tt=>tt.id===tab.id);if(!insBefore)ins++;pn.tabs.splice(ins,0,moved);pn.activeTab=tabId;this.app._save();this.app.render()}else{const rect=t.getBoundingClientRect();this.app._moveTabToPane(srcPaneId,tabId,n.id,tab.id,e.clientX<rect.left+rect.width/2)}});
      tabs.appendChild(t);
    }
    const add=document.createElement('button'); add.className='pn-tab-add'; add.textContent='+';
    add.addEventListener('click',e=>{e.stopPropagation();this.app.addTab(n.id)});
    tabs.addEventListener('dragover',e=>{if(!this.app._drag||this.app._drag.type!=='tab')return;e.preventDefault();e.stopPropagation();if(this.app._drag.srcPaneId!==n.id)tabs.classList.add('drag-target')});
    tabs.addEventListener('dragleave',e=>{if(!tabs.contains(e.relatedTarget))tabs.classList.remove('drag-target')});
    tabs.addEventListener('drop',e=>{e.preventDefault();e.stopPropagation();tabs.classList.remove('drag-target');tabs.querySelectorAll('.pn-tab').forEach(r=>r.classList.remove('drag-left','drag-right'));if(!this.app._drag||this.app._drag.type!=='tab')return;const{srcPaneId,tabId}=this.app._drag;this.app._drag=null;const s=this.app._aw();if(!s)return;if(srcPaneId===n.id){const pn=findPane(s.layout,n.id);if(!pn)return;const si=pn.tabs.findIndex(t=>t.id===tabId);if(si<0)return;const[moved]=pn.tabs.splice(si,1);pn.tabs.push(moved);pn.activeTab=tabId;this.app._save();this.app.render()}else{this.app._moveTabToPane(srcPaneId,tabId,n.id,null,false)}});
    tabs.appendChild(add); el.appendChild(tabs);
    const body=document.createElement('div'); body.className='pn-body';
    const at=(n.tabs||[]).find(t=>t.id===n.activeTab);
    if(at){
      if(at.type==='editor'){
        let editor=this.app.fileEditors.get(at.id);
        if(!editor){editor=new FileEditor(at.id,at.name,at.filePath);this.app.fileEditors.set(at.id,editor)}
        body.appendChild(editor.el);editor.el.classList.add('vis');
      }else{
        const p=this.app.tools.get(at.toolId);
        if(p){body.appendChild(p.el);p.el.classList.add('vis')}
      }
    }
    body.addEventListener('dragover',e=>{if(!this.app._drag||this.app._drag.type!=='tab')return;e.preventDefault();e.stopPropagation();tabs.querySelectorAll('.pn-tab').forEach(r=>r.classList.remove('drag-left','drag-right'));this.app._showBodyDropIndicator(body,this.app._getDragZone(body,e))});
    body.addEventListener('dragleave',e=>{if(!body.contains(e.relatedTarget))this.app._clearBodyDropIndicator(body)});
    body.addEventListener('drop',e=>{e.preventDefault();e.stopPropagation();if(!this.app._drag||this.app._drag.type!=='tab')return;const zone=this.app._getDragZone(body,e);const{srcPaneId,tabId}=this.app._drag;this.app._drag=null;this.app._clearBodyDropIndicator(body);if(zone==='center'){if(srcPaneId===n.id)return;this.app._moveTabToPane(srcPaneId,tabId,n.id,null,false)}else{this.app._splitPaneWithTab(srcPaneId,tabId,n.id,zone)}});
    el.appendChild(body);
    el.addEventListener('mousedown',()=>this.app.setFocus(n.id));
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
