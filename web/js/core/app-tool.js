/**
 * Remote Terminal — App 도구 생명주기 (PACKAGE_RESTRUCTURE_SRS FR-APP-2)
 *
 * class App 본문에서 옮겨온 메서드 12개. 본문은 수정하지 않았다 (FR-APP-3).
 * app.js 이후 main.js 이전에 로드된다 (FR-APP-5).
 */
Object.assign(App.prototype, {
  async _isToolBusy(toolId){
    try{const r=await fetch(`/api/tools/${toolId}/busy`);const d=await r.json();return d.busy}catch{return false}
  },

  _confirmClose(msg, opts = {}){
    return new Promise(resolve=>{
      const ov=document.createElement('div');ov.className='confirm-overlay';
      let btns = '<button class="confirm-ok">닫기</button><button class="confirm-cancel">취소</button>';
      if (opts.saveBtn) {
        btns = '<button class="confirm-save">저장 후 닫기</button>' + btns;
      }
      // FR-BG-3/4: 실행 중인 도구를 살려두고 닫는 선택지.
      if (opts.bgBtn) {
        btns = `<button class="confirm-bg">${opts.bgLabel||'백그라운드로'}</button>` + btns;
      }
      ov.innerHTML=`<div class="confirm-box"><div class="confirm-msg">${msg}</div><div class="confirm-btns">${btns}</div></div>`;
      document.body.appendChild(ov);
      const saveBtn = ov.querySelector('.confirm-save');
      const bgBtn = ov.querySelector('.confirm-bg');
      if (saveBtn) saveBtn.focus(); else if (bgBtn) bgBtn.focus(); else ov.querySelector('.confirm-ok').focus();
      const cleanup=v=>{ov.remove();document.removeEventListener('keydown',onKey);resolve(v)};
      const onKey=e=>{if(e.key==='Enter'){e.preventDefault();cleanup(saveBtn?'save':(bgBtn?'background':true))}else if(e.key==='Escape'){e.preventDefault();cleanup(false)}};
      document.addEventListener('keydown',onKey);
      if (saveBtn) saveBtn.addEventListener('click',()=>cleanup('save'));
      if (bgBtn) bgBtn.addEventListener('click',()=>cleanup('background'));
      ov.querySelector('.confirm-ok').addEventListener('click',()=>cleanup(true));
      ov.querySelector('.confirm-cancel').addEventListener('click',()=>cleanup(false));
      ov.addEventListener('click',e=>{if(e.target===ov)cleanup(false)});
    });
  },

  // ── 백그라운드 도구 (FR-BG) ──

  // _setToolBackground는 도구를 백그라운드로 보내거나 되돌린다. 실패해도
  // 호출자의 흐름을 막지 않는다 — 탭 닫기가 알림 실패로 멈추면 더 나쁘다.
  async _setToolBackground(toolId,bg){
    if(!toolId) return false;
    try{
      const r=await fetch('/api/tools/background/set',{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({toolId,background:!!bg})});
      return r.ok;
    }catch{return false}
  },

  async _bgRefresh(){
    try{
      const r=await fetch('/api/tools/background');
      if(!r.ok) return;
      const j=await r.json();
      this._bg=Array.isArray(j.background)?j.background:[];
    }catch{return}
    this._updateStatusBar();
    if(this._bgModalOpen) this._bgModalRender();
  },

  // FR-BGR-7: 복귀 대상 Pane 을 고른다.
  //
  // 명시 대상(opts.paneId)은 폴백하지 않는다 — 지목한 곳이 사라졌으면 실패가
  // 옳고, 그때 도구는 백그라운드 목록에 남아 여전히 닿을 수 있다 (TC-BGR-6b).
  // location 미지정은 "대상을 정하지 않았다"는 뜻이므로 폴백이 정당하다.
  async _restorePane(opts){
    if(opts.paneId){
      const win=this.ws.windows.find(s=>s.id===opts.windowId)||null;
      return win&&win.layout?findPane(win.layout,opts.paneId):null;
    }
    for(let i=0;i<RESTORE_PANE_WAIT_TRIES;i++){
      // FR-EDT-54: Editor 창에는 편집기 탭만 산다. 복귀는 `addTab` 을 거치지 않고
      // 터미널 탭을 pane 에 직접 넣으므로(`_restoreTool`) 그 게이트가 여기에도
      // 있어야 한다 — 없으면 Editor 창에 터미널 탭이 생기고, 일반 창만 걷는
      // `_migrateEditorTabs` 가 그것을 영원히 지나친다. Git 창도 같은 구멍이다.
      const a=this._aw();
      const cur=this._isEditorWin(a)||this._isGitWin(a)?null:a;
      const pn=(this.focused&&cur&&cur.layout?findPane(cur.layout,this.focused):null)
        ||(cur&&cur.layout?firstPane(cur.layout):null)
        ||this._plainWindows().map(s=>firstPane(s.layout)).find(Boolean)
        ||null;
      if(pn) return pn;
      // 창이 하나도 없는 것은 delWindow 가 _mkWindow 를 끝내기 전의 과도
      // 상태뿐이다. 조용히 무효가 되지 않도록 그 왕복만큼 기다린다.
      await new Promise(r=>setTimeout(r,RESTORE_PANE_WAIT_MS));
    }
    return null;
  },

  // FR-BG-7 / FR-BGR-1: 백그라운드 도구를 지정 분할 칸(opts.paneId, 미지정 시
  // 현재 포커스)의 새 탭으로 되돌린다.
  async _restoreTool(toolId,opts={}){
    if(!toolId) return;
    // FR-BGR-5: 대상을 먼저 확정한다. 백그라운드 해제를 앞세우면 대상이 없을 때
    // 도구가 목록에도 탭에도 없는 — 어디서도 닿을 수 없는 상태가 된다.
    const pn=await this._restorePane(opts);
    if(!pn){console.warn('[bg] 복귀할 분할 칸 없음',opts.paneId||this.focused);return}
    if(!await this._setToolBackground(toolId,false)) return;
    if(!this.tools.has(toolId)) this._mkTool(toolId,DEFAULT_TOOL_NAME);
    const t=newEntityId();
    pn.tabs.push({id:t,name:'Shell',type:'terminal',toolId});
    this.paneTabSet(pn,t);
    this.render();
    this._save();
    this._bgRefresh();
  },

  async _newTool(cwd,cwdTool){
    let q='';
    if(cwd) q='&cwd='+encodeURIComponent(cwd);
    else if(cwdTool) q='&cwdTool='+encodeURIComponent(cwdTool);
    const r=await fetch('/api/tools?cols=120&rows=40'+q,{method:'POST'});
    if(!r.ok) throw new Error('create pane failed');
    const {id,name}=await r.json();
    return this._mkTool(id,name);
  },

  async _focusedCwd(){
    const p=this._focusedTerminal();
    if(!p) return null;
    try{const r=await fetch('/api/cwd?tool='+p.id);const d=await r.json();return d.cwd||null}catch{return null}
  },

  // FR-ATL-7: 지우는 도구의 알람은 로컬에서 먼저 뗀다. 서버 브로드캐스트를
  // 기다리면 그 사이 배지가 없는 도구를 가리키고, 통지가 유실되면 영영 남는다.
  // FR-WSL-22: 도구를 지우는 경로는 **모든 슬롯의 인스턴스**를 파괴한다. 슬롯 1 의
  // 인스턴스가 남으면 이미 죽은 PTY 로 재연결을 시도한다.
  _killToolInstances(pid){
    for(const k of [pid,this._slotKey(pid,1)]){
      const p=this.tools.get(k);
      if(p){try{p.destroy()}catch{}; this.tools.delete(k)}
    }
  },

  async _kill(pid){
    this._killToolInstances(pid);
    if(this._attnDrop(pid)) this._attnRefresh();
    try{await fetch(`/api/tools/${pid}`,{method:'DELETE'})}catch{}
  },
  _killTool(pid){
    this._killToolInstances(pid);
    if(this._attnDrop(pid)) this._attnRefresh();
    fetch(`/api/tools/${pid}`,{method:'DELETE'}).catch(()=>{});
  },

  _aw(){return this.ws.windows.find(s=>s.id===this.ws.activeWindow)||null},

  // _isToolInActiveWindow reports whether a pane (by id) is present in the
  // currently active window's layout. Used to route focus commands only to
  // the window that is actually viewing the source pane (multi-window).
  _isToolInActiveWindow(toolId){
    if(!toolId) return false;
    const s=this._aw();
    if(!s||!s.layout) return false;
    let found=false;
    const walk=n=>{
      if(!n||found) return;
      if(n.type==='pane'&&n.tabs){
        for(const t of n.tabs) if(t.toolId===toolId){found=true;return}
      }
      if(n.type==='split'&&n.children) for(const c of n.children) walk(c);
    };
    walk(s.layout);
    return found;
  },
});
