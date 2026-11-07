/**
 * Dongminal — 보이는 디렉터리의 **서버 감시** (EDITOR_LIVE_RELOAD_SRS 묶음 C).
 *
 * 등록(`edWatchSync`)과 반응(`_onFsChanged`)이 여기 있다. 폴링(`_edTick`)은 그대로
 * 돈다 — 감시는 체감 속도를, 폴링은 정확성의 안전망을 맡는다 (FR-ELR-61).
 */
Object.assign(App.prototype, {
  /**
   * FR-ELR-65: 등록할 디렉터리 — 보이는 창의 열린 파일(Diff 문서 포함)의 부모와
   * 보이는 탐색기의 루트·펼친 겹. 재귀는 하지 않는다 (D-5).
   */
  _edWatchDirs(){
    const set=new Set();
    for(const p of this._edVisibleDocPaths()){
      const d=edWatchParent(p);
      if(d) set.add(d);
    }
    const stores=new Set();
    for(const tree of this._edVisibleTrees()){
      const st=tree.store;
      if(!st||stores.has(st)) continue;
      stores.add(st);
      for(const d of st.stampDirs()) set.add(d);
    }
    const out=[...set].sort();
    return capToServer(out,serverMeta.fsWatchDirsMax);
  },

  /** FR-ELR-66: 집합이 바뀌었으면 다시 등록한다. 같은 프레임의 부름은 한 번으로 모은다. */
  edWatchSync(){
    if(this._edWatchOff) return;
    TIMERS.frame(()=>this._edWatchSend(false),{owner:this,coalesce:'ed-watch',label:'ed-watch'});
  },

  /** FR-ELR-52·66: SSE 가 (다시) 열리면 서버의 집합은 비어 있다 — 같은 집합이라도 보낸다. */
  _edWatchRestore(){
    this._edWatchKey=null;
    return this._edWatchSend(true);
  },

  async _edWatchSend(force){
    if(this._edWatchOff) return;
    if(this._edWatchBusy){ this._edWatchAgain=true; return }
    const dirs=this._edWatchDirs();
    const key=dirs.join('\n');
    if(!force&&key===this._edWatchKey) return;
    this._edWatchBusy=true;
    const r=await apiPut(FS_WATCH_API,{clientId:this.clientId,dirs});
    this._edWatchBusy=false;
    if(r.ok) this._edWatchKey=key;
    // 종단이 없는 옛 서버다. 폴링은 그대로 돈다 (FR-ELR-15 와 같은 관례).
    else if(r.status===404) this._edWatchOff=true;
    if(this._edWatchAgain){ this._edWatchAgain=false; this._edWatchSend(false) }
  },

  /** FR-ELR-67~70: `fs_changed` 방송. */
  _onFsChanged(args){
    if(!args||document.hidden) return;
    if(args.overflow){ this._edTick(); return }
    for(const c of (Array.isArray(args.changes)?args.changes:[])){
      if(!c||typeof c.path!=='string') continue;
      if(c.type==='updated'||c.type==='added') this._edDocReload(c.path);
      if(c.type==='added'||c.type==='deleted') this._edTreeFsChanged(c.path);
    }
  },

  /** FR-ELR-67: 폴링과 같은 조건(dirty 아님·버퍼 있음)에서 다시 읽는다. */
  _edDocReload(p){
    const d=this._edDocs&&this._edDocs.get(p);
    if(!d||d.dirty||!d.buf) return;
    const q=this._edDocReloads||(this._edDocReloads=new Map());
    const n=q.get(p)||0;
    if(n>=EDITOR_DOC_RELOAD_QUEUE) return;
    q.set(p,n+1);
    if(n===0) this._edDocReloadRun(p);
  },

  async _edDocReloadRun(p){
    const q=this._edDocReloads;
    while(q.get(p)>0){
      await this.edDocRefresh(p);
      const left=q.get(p)-1;
      if(left>0) q.set(p,left); else q.delete(p);
    }
  },

  /** FR-ELR-68: 읽힌 겹의 추가·삭제만 본다. 첫 이벤트부터 모아 한 번에 처리한다. */
  _edTreeFsChanged(p){
    const dir=edWatchParent(p);
    const hit=this._edTreeFsHits||(this._edTreeFsHits=new Set());
    for(const tree of this._edVisibleTrees()){
      const st=tree.store;
      if(st&&st.kids&&st.kids.has(dir)) hit.add(st);
    }
    if(hit.size) this._edTreeFsArm();
  },

  _edTreeFsArm(){
    if(this._edTreeFsTimer) return;
    this._edTreeFsTimer=TIMERS.after(EXPLORER_FS_CHANGES_DELAY_MS,()=>{
      this._edTreeFsTimer=null;
      // 이름을 고치는 동안은 목록을 흔들지 않는다 (VS Code #112293).
      if(this._edVisibleTrees().some(tree=>tree&&tree._edit)){ this._edTreeFsArm(); return }
      const stores=[...this._edTreeFsHits];
      this._edTreeFsHits.clear();
      for(const st of stores) st.pollStamp();
    },{owner:this,label:'ed-tree-fs-changes'});
  },
});

// 구분자는 둘 다 본다 — 서버는 OS 구분자로 싣는다 (`filepath.Join`).
function edWatchParent(p){
  const s=String(p||'');
  const i=Math.max(s.lastIndexOf('/'),s.lastIndexOf('\\'));
  return i<=0?(i===0?'/':''):s.slice(0,i);
}
