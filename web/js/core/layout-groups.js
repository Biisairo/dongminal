/**
 * window 그룹과 순서 명령 (ISSUE_AGENT_TREE_SRS 묶음 G·O).
 *
 * 순서 계산은 `window-order.js` 의 순수 함수가 한다. 여기는 그 결과를 `ws` 에 얹고
 * 저장·다시 그리기를 부르는 자리다. 실패는 `{error}` 로 돌려준다 — 원격 명령은 그
 * 값을 dmctl 에 회신한다 (FR-ORD-6).
 *
 * `LayoutController` 의 부품 `.groups` 다(REFACTOR3_FE_APPCTL_SRS 9i-2, 옛 `app-groups.js`). 접기 `_wgFold` 와 마지막으로 본
 * 활성 창 `_wgSeenActive` 는 이 부품의 것이다(§2.2 SH-4).
 */
class LayoutGroups extends Controller {
  windowGroups(){return this.app.ws.windowGroups||[]}

  /** FR-WGR-6: 읽은 워크스페이스의 불변식을 세운다. 그룹을 안 쓰면 아무것도 바꾸지 않는다 (NFR-WGR-1). */
  _groupsNormalizeWs(ws){
    const groups=ws.windowGroups;
    if(!(groups&&groups.length)&&!ws.windows.some(w=>w&&w.groupId)) return;
    ws.windows=winOrderNormalize(ws.windows,groups||[]);
  }

  _groupsCommit(windows){
    this.app.ws.windows=windows;
    this.app.wsSave.save();this.app.render();
  }

  /** FR-WGR-30 · FR-WGR-8: 빈 그룹을 만든다. 트리 표지가 같은 그룹은 둘이 될 수 없다. */
  newGroup(name,tree){
    const n=typeof name==='string'?name.trim():'';
    if(!n) return {error:'bad_name'};
    const groups=this.windowGroups();
    if(tree&&groups.some(g=>g.tree&&g.tree.repo===tree.repo&&g.tree.root===tree.root)) return {error:'tree_exists'};
    const g={id:newEntityId(),name:clampEntityName(n)};
    if(tree) g.tree={repo:tree.repo,root:tree.root};
    this.app.ws.windowGroups=groups.concat([g]);
    this.app.wsSave.save();this.app.render();
    return {id:g.id};
  }

  renameGroup(id,name){
    const n=typeof name==='string'?name.trim():'';
    if(!n) return {error:'bad_name'};
    const g=this.windowGroups().find(x=>x.id===id);
    if(!g) return {error:'not_found'};
    g.name=clampEntityName(n);
    this.app.wsSave.save();this.app.render();
    return {};
  }

  /** FR-WGR-12: 그룹을 지워도 window 는 닫지 않는다 — 풀어서 그 자리에 둔다. */
  deleteGroup(id){
    const groups=this.windowGroups();
    if(!groups.some(g=>g.id===id)) return {error:'not_found'};
    const rest=groups.filter(g=>g.id!==id);
    if(rest.length) this.app.ws.windowGroups=rest;
    else delete this.app.ws.windowGroups;
    for(const w of this.app.ws.windows) if(w&&w.groupId===id) delete w.groupId;
    this.app.wsSave.save();this.app.render();
    return {};
  }

  moveWindowTo(id,spec){
    const r=winOrderMoveWindow(this.app.ws.windows,this.windowGroups(),id,spec);
    if(!r.ok) return {error:r.error};
    this._groupsCommit(r.windows);
    return {position:r.position};
  }

  moveGroupTo(id,spec){
    const r=winOrderMoveGroup(this.app.ws.windows,this.windowGroups(),id,spec);
    if(!r.ok) return {error:r.error};
    this._groupsCommit(r.windows);
    return {position:r.position};
  }

  /** 칸 하나의 원소 — `to` 가 window 면 그 window 의 포커스 칸, 없으면 첫 칸이다 (FR-ORD-10). */
  _orderPaneOf(id){
    for(const w of this.app.ws.windows){
      if(!w||!w.layout) continue;
      const p=findPane(w.layout,id);
      if(p) return {win:w,pane:p};
      if(w.id===id){
        const f=(w.focusedPane&&findPane(w.layout,w.focusedPane))||firstPane(w.layout);
        return f?{win:w,pane:f}:null;
      }
    }
    return null;
  }

  _tabPosition(tabId){
    const r=this.app.tool.cmd._findTabById(tabId);
    if(!r) return null;
    return {container:r.pane.id,index:r.pane.tabs.findIndex(x=>x.id===tabId)+1,count:r.pane.tabs.length};
  }

  /**
   * FR-ORD-10: 탭 이동. 같은 칸 안이면 그 칸의 탭 배열만 다시 놓는다. 칸·window 를
   * 넘으면 UI 끌어 놓기와 같은 `moveTabToPane` 을 지난다 (FR-ORD-7).
   */
  moveTabTo(tabId,spec){
    spec=spec||{};
    const src=this.app.tool.cmd._findTabById(tabId);
    if(!src) return {error:'not_found'};
    let dst=null;
    const anchor=spec.before||spec.after;
    if(anchor){
      const a=this.app.tool.cmd._findTabById(anchor);
      if(!a) return {error:'not_found'};
      dst={win:a.win,pane:a.pane};
    }else if(spec.to){
      if(spec.prev||spec.next) return {error:'bad_spec'};
      dst=this._orderPaneOf(spec.to);
      if(!dst) return {error:'not_found'};
    }else dst={win:src.win,pane:src.pane};

    const ids=dst.pane.tabs.map(x=>x.id);
    if(dst.pane.id===src.pane.id){
      const r=winOrderMoveInList(ids,tabId,spec.to?(spec.index!==undefined?{index:spec.index}:{index:ids.length}):spec);
      if(!r.ok) return {error:r.error};
      const byId=new Map(src.pane.tabs.map(x=>[x.id,x]));
      src.pane.tabs=r.list.map(x=>byId.get(x));
      this.app.wsSave.save();this.app.render();
      return {position:this._tabPosition(tabId)};
    }
    if(spec.prev||spec.next) return {error:'bad_spec'};
    let before=null,insertBefore=false;
    if(anchor){
      before=anchor;insertBefore=!!spec.before;
    }else if(spec.index!==undefined&&spec.index!==null){
      const n=Number(spec.index);
      if(!Number.isInteger(n)||n<1||n>ids.length+1) return {error:'out_of_range'};
      if(n<=ids.length){before=ids[n-1];insertBefore=true}
    }
    this.app.layout.dnd.moveTabToPane(src.pane.id,tabId,dst.pane.id,before,insertBefore);
    const pos=this._tabPosition(tabId);
    if(!pos||pos.container!==dst.pane.id) return {error:'rejected'};
    return {position:pos};
  }

  // ── 사이드바 (FR-WGR-20~25) ──

  // FR-WGR-21: 접기는 그룹 id 별로 **클라이언트**에 남는다 (FR-AGG-10 과 같은 근거).
  _wgFolded(){
    if(!this._wgFold){
      const ids=PrefStore.local.json(STORE_KEYS.windowGroupFold,[]);
      this._wgFold=new Set(Array.isArray(ids)?ids:[]);
    }
    return this._wgFold;
  }

  wgFoldToggle(id){
    const f=this._wgFolded();
    if(f.has(id)) f.delete(id); else f.add(id);
    PrefStore.local.setJson(STORE_KEYS.windowGroupFold,Array.from(f));
    this.app.render();
  }

  /**
   * 창 목록의 항목: 그룹 머리 `{kind:'group',group,windows}` 와 창 객체가 섞인 평면 목록.
   * 접힌 그룹의 창은 빠진다. 접힌 그룹 안의 창이 활성이 **되는 순간** 그 그룹을 펼친다
   * (FR-WGR-22).
   *   이전: 활성 창이 든 동안 그릴 때마다 펼쳐, 그 그룹은 접을 수 없었다
   */
  sidebarWindowEntries(){
    const plain=this.app.git.plainWindows();
    const groups=this.windowGroups();
    if(!groups.length) return plain;
    const byId=new Map(plain.map(w=>[w.id,w]));
    const gById=new Map(groups.map(g=>[g.id,g]));
    const fold=this._wgFolded();
    const act=this.app.ws.activeWindow;
    const became=act!==this._wgSeenActive;
    this._wgSeenActive=act;
    const out=[];
    for(const it of winOrderItems(plain,groups)){
      if(it.kind==='window'){ out.push(byId.get(it.id)); continue }
      const wins=it.windows.map(id=>byId.get(id));
      if(became&&wins.some(w=>w.id===act)&&fold.has(it.id)){
        fold.delete(it.id);
        PrefStore.local.setJson(STORE_KEYS.windowGroupFold,Array.from(fold));
      }
      out.push({kind:'group',group:gById.get(it.id),windows:wins,folded:fold.has(it.id)});
      if(!fold.has(it.id)) out.push(...wins);
    }
    return out;
  }

  /**
   * 사이드바 끌어 놓기를 순서 명령으로 옮긴다. 키는 창 id 또는 `grp:<그룹 id>` 다.
   * `dr.out` 은 포인터가 그룹 들여쓰기 왼쪽에 있었다는 뜻이다. 그룹의 첫 창 위·마지막 창
   * 아래에서만 뜻이 있고, 그때는 그룹 밖(그룹 앞·뒤)에 놓는다 (FR-WGR-24).
   *   이전: 그룹 창의 아래에 놓으면 늘 그룹 안으로 들어갔다
   */
  sidebarReorder(dr){
    const gid=k=>k.startsWith(WG_KEY)?k.slice(WG_KEY.length):null;
    const srcG=gid(dr.src),tgtG=gid(dr.target);
    let r;
    // FR-WGR-24 (개정): 목록 끝 아래는 맨 뒤 그룹 밖이다. 그룹은 마지막 최상위 덩어리 뒤로 간다.
    if(dr.end){
      if(!srcG) r=winOrderMoveWindow(this.app.ws.windows,this.windowGroups(),dr.src,{to:WIN_ORDER_TOP});
      else{
        const last=winOrderItems(this.app.git.plainWindows(),this.windowGroups()).filter(it=>it.kind==='window'||it.windows.length).pop();
        if(!last||last.id===srcG) return false;
        r=winOrderMoveGroup(this.app.ws.windows,this.windowGroups(),srcG,{after:last.id});
      }
      if(!r.ok) return false;
      this.app.ws.windows=r.windows;
      return true;
    }
    if(srcG){
      r=winOrderMoveGroup(this.app.ws.windows,this.windowGroups(),srcG,{[dr.before?'before':'after']:tgtG||dr.target});
    }else if(tgtG){
      // 머리 위쪽 = 그룹 앞(최상위), 머리 아래쪽 = 그룹의 첫 자리.
      const empty=!this.app.ws.windows.some(w=>w&&w.groupId===tgtG);
      r=winOrderMoveWindow(this.app.ws.windows,this.windowGroups(),dr.src,
        dr.before&&!empty?{before:tgtG}:{to:tgtG,index:1});
    }else{
      const side=dr.before?'before':'after';
      const edge=dr.out?this.wgEdgeGroup(dr.target,dr.before):null;
      r=winOrderMoveWindow(this.app.ws.windows,this.windowGroups(),dr.src,{[side]:edge||dr.target});
    }
    if(!r.ok) return false;
    this.app.ws.windows=r.windows;
    return true;
  }

  /** 창 id 가 그룹의 첫 창(before)·마지막 창(after)이면 그 그룹 id 다. 아니면 null 이다. */
  wgEdgeGroup(id,before){
    const w=this.app.ws.windows.find(x=>x&&x.id===id);
    const g=w&&w.groupId;
    if(!g) return null;
    const mates=this.app.ws.windows.filter(x=>x&&x.groupId===g);
    return mates[before?0:mates.length-1].id===id?g:null;
  }

  /** `+ 그룹` 버튼: 빈 그룹을 만들고 바로 이름을 고치게 한다 (FR-WGR-23). */
  addGroupInteractive(){
    const r=this.newGroup(t('sidebar.group_default'));
    if(r.error) return;
    const el=document.querySelector('[data-group-id="'+r.id+'"] .sbl-name');
    const g=this.windowGroups().find(x=>x.id===r.id);
    if(el&&g) this.app.rename(g,el);
  }

  groupHasAttn(entry){return entry.windows.some(w=>this.app.attn.windowHasAttn(w))}

  // ── 원격 명령 (REMOTE_ACTIONS) — 회신할 결과를 약속으로 돌려준다 (FR-RCR-6) ──

  _remoteNewGroup(a){
    const tree=a.tree&&a.tree.repo&&a.tree.root?a.tree:null;
    const r=this.newGroup(a.name,tree);
    return Promise.resolve(r.error?{error:r.error}:{newGroups:[r.id]});
  }
  _remoteRenameGroup(a){this.renameGroup(a.group,a.name)}
  _remoteDeleteGroup(a){this.deleteGroup(a.group)}
  _remoteMoveWindow(a){return Promise.resolve(this.moveWindowTo(a.window,_orderSpec(a)))}
  _remoteMoveGroup(a){return Promise.resolve(this.moveGroupTo(a.group,_orderSpec(a)))}
  _remoteMoveTab(a){return Promise.resolve(this.moveTabTo(a.tab,_orderSpec(a)))}
}

/** 사이드바 항목 키에서 그룹 머리를 가르는 접두어. */
const WG_KEY='grp:';

/** 원격 인자에서 위치 지정만 꺼낸다 (FR-ORD-1). */
function _orderSpec(a){
  const s={};
  if(a.index!==undefined&&a.index!==null) s.index=a.index;
  if(a.prev) s.prev=true;
  if(a.next) s.next=true;
  if(a.before) s.before=a.before;
  if(a.after) s.after=a.after;
  if(a.to) s.to=a.to;
  return s;
}
