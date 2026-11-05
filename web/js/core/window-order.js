/**
 * window 그룹의 불변식과 위치 해석 (ISSUE_AGENT_TREE_SRS 묶음 G·O).
 *
 * 순수 함수다 — 받은 배열을 고치지 않고 새 배열을 돌려준다. 상태를 쥐는 쪽은 App 이다.
 *
 * window 순서의 출처는 `ws.windows` 하나다 (D-IAT-11). 같은 그룹의 window 는 늘 붙어
 * 있고(FR-WGR-4), 그룹의 자리는 그 첫 window 의 자리다. 빈 그룹은 최상위 목록의
 * 끝이다(FR-WGR-5). 대상은 type 없는 window(일반 창)뿐이다(FR-WGR-7) — git·editor
 * window 는 그룹에 들지 않고 배열 안의 자리를 지킨다.
 *
 * 위치 지정(FR-ORD-1~5)은 `{index}` · `{prev}` · `{next}` · `{before}` · `{after}` 중
 * 하나이고, window 는 `{to}`(그룹 id 또는 'top')로 담는 곳을 바꾼다. 실패는 예외가
 * 아니라 `{ok:false, error}` 다.
 */

const WIN_ORDER_TOP='top';

function _woPlain(w){return !!w&&!w.type}

/** spec 의 위치 지정 열쇠들. 정확히 몇 개가 왔는지가 판정의 재료다. */
function _woKeys(spec){
  const s=spec||{};
  const keys=[];
  if(s.index!==undefined&&s.index!==null) keys.push('index');
  if(s.prev) keys.push('prev');
  if(s.next) keys.push('next');
  if(s.before) keys.push('before');
  if(s.after) keys.push('after');
  return keys;
}

function winOrderNormalize(windows, groups){
  const known=new Set((groups||[]).map(g=>g.id));
  // 고칠 것이 없는 window 는 **같은 객체**로 둔다. 화면(사이드바 행·이름 편집)이 쥔
  // 참조가 정규화 뒤에도 워크스페이스의 것이어야 그 고침이 저장된다.
  //   이전: 언제나 복사했다 — 그룹이 있으면 창 이름 편집이 확정되지 않았다
  const wins=(windows||[]).map(w=>{
    if(w.groupId===undefined||(_woPlain(w)&&known.has(w.groupId))) return w;
    const c=Object.assign({},w);
    delete c.groupId;
    return c;
  });
  const plainWins=wins.filter(_woPlain);
  const byGroup=new Map();
  for(const w of plainWins){
    if(!w.groupId) continue;
    if(!byGroup.has(w.groupId)) byGroup.set(w.groupId,[]);
    byGroup.get(w.groupId).push(w);
  }
  const seq=[];
  const seen=new Set();
  for(const w of plainWins){
    if(!w.groupId){ seq.push(w); continue }
    if(seen.has(w.groupId)) continue;
    seen.add(w.groupId);
    for(const m of byGroup.get(w.groupId)) seq.push(m);
  }
  return _woWriteBack(wins,seq);
}

/** 일반 창의 새 순서를 원래 배열의 일반 창 자리에 채운다 — git·editor 창은 제자리. */
function _woWriteBack(wins, seq){
  let i=0;
  return wins.map(w=>_woPlain(w)?seq[i++]:w);
}

/**
 * 최상위 목록. 그룹은 `{kind:'group',id,windows}` 하나, 빈 그룹은 끝. dmctl 의 Go `windowPositions` 와
 * 같은 규칙이다 — `internal/helper/runtimebin/testdata/window_order_vectors.json` 을 함께 시험한다.
 */
function winOrderItems(windows, groups){
  const out=[];
  let cur=null;
  for(const w of (windows||[]).filter(_woPlain)){
    if(w.groupId){
      if(cur&&cur.id===w.groupId){ cur.windows.push(w.id); continue }
      cur={kind:'group',id:w.groupId,windows:[w.id]};
      out.push(cur);
      continue;
    }
    cur=null;
    out.push({kind:'window',id:w.id});
  }
  const present=new Set(out.filter(it=>it.kind==='group').map(it=>it.id));
  for(const g of (groups||[])) if(!present.has(g.id)) out.push({kind:'group',id:g.id,windows:[]});
  return out;
}

/** 목록 안 위치 해석의 공통부. list 는 대상을 뺀 뒤의 목록, from 은 뺀 자리(없으면 -1). */
function _woSlot(list, from, spec, key, anchorIdx){
  if(key==='index'){
    const n=Number(spec.index);
    if(!Number.isInteger(n)||n<1||n>list.length+1) return {error:'out_of_range'};
    return {at:n-1};
  }
  if(key==='prev'||key==='next'){
    const at=key==='prev'?from-1:from+1;
    if(from<0||at<0||at>list.length) return {error:'at_edge'};
    return {at};
  }
  if(anchorIdx<0) return {error:'not_found'};
  return {at:key==='before'?anchorIdx:anchorIdx+1};
}

function winOrderMoveInList(list, id, spec){
  const keys=_woKeys(spec);
  if(keys.length!==1) return {ok:false,error:'bad_spec'};
  const from=list.indexOf(id);
  if(from<0) return {ok:false,error:'not_found'};
  const key=keys[0];
  const anchor=spec[key];
  if((key==='before'||key==='after')&&anchor===id) return {ok:true,list:list.slice(),position:{index:from+1,count:list.length}};
  const rest=list.filter(x=>x!==id);
  const s=_woSlot(rest,from,spec,key,(key==='before'||key==='after')?rest.indexOf(anchor):-1);
  if(s.error) return {ok:false,error:s.error};
  rest.splice(s.at,0,id);
  return {ok:true,list:rest,position:{index:s.at+1,count:rest.length}};
}

/** 최상위 목록을 window 배열로 펼친다. 빈 그룹 자리는 남기지 않는다(끝으로 간다). */
function _woFlatten(wins, items, byId){
  const seq=[];
  for(const it of items){
    if(it.kind==='window'){ seq.push(byId.get(it.id)); continue }
    for(const wid of it.windows) seq.push(byId.get(wid));
  }
  return _woWriteBack(wins,seq);
}

function _woTopIndexOf(items, id){return items.findIndex(it=>it.id===id)}

function _woTopCount(items){return items.filter(it=>it.kind==='window'||it.windows.length).length}

function winOrderMoveWindow(windows, groups, id, spec){
  spec=spec||{};
  const keys=_woKeys(spec);
  const to=spec.to;
  if(to!==undefined&&to!==null&&to!==''){
    if(keys.length>1||(keys.length===1&&keys[0]!=='index')) return {ok:false,error:'bad_spec'};
  }else if(keys.length!==1) return {ok:false,error:'bad_spec'};

  const wins=winOrderNormalize(windows,groups);
  const byId=new Map(wins.filter(_woPlain).map(w=>[w.id,w]));
  const me=byId.get(id);
  if(!me) return {ok:false,error:'not_found'};
  const known=new Set((groups||[]).map(g=>g.id));

  const items=winOrderItems(wins,groups).filter(it=>it.kind==='window'||it.windows.length);
  // 뺀다 — 그룹이 비어도 그 자리(덩어리)는 이 조작이 끝날 때까지 남긴다.
  const srcGroup=me.groupId||null;
  let srcTop=-1;
  let srcInGroup=-1;
  if(srcGroup){
    const g=items[_woTopIndexOf(items,srcGroup)];
    srcInGroup=g.windows.indexOf(id);
    g.windows.splice(srcInGroup,1);
    srcTop=_woTopIndexOf(items,srcGroup);
  }else{
    srcTop=_woTopIndexOf(items,id);
    items.splice(srcTop,1);
  }

  const key=keys[0];
  let container;
  let anchorIdx=-1;
  if(key==='before'||key==='after'){
    const anchor=spec[key];
    if(anchor===id) return _woResult(windows,groups,id,{ok:true,windows:winOrderNormalize(windows,groups)});
    const aw=byId.get(anchor);
    if(aw&&aw.groupId){
      container=aw.groupId;
      anchorIdx=items[_woTopIndexOf(items,container)].windows.indexOf(anchor);
    }else if(aw||known.has(anchor)){
      container=WIN_ORDER_TOP;
      anchorIdx=_woTopIndexOf(items,anchor);
      if(anchorIdx<0&&known.has(anchor)) return {ok:false,error:'empty_group'};
    }else return {ok:false,error:'not_found'};
  }else if(to!==undefined&&to!==null&&to!==''){
    if(to!==WIN_ORDER_TOP&&!known.has(to)) return {ok:false,error:'not_found'};
    container=to;
  }else{
    container=srcGroup||WIN_ORDER_TOP;
  }

  let list;
  let from;
  if(container===WIN_ORDER_TOP){
    list=items.map(it=>it.id);
    from=srcGroup?-1:srcTop;
  }else{
    let gi=_woTopIndexOf(items,container);
    if(gi<0){
      // 빈 그룹에 들어간다 — 이 window 가 있던 자리가 그룹의 자리가 된다 (FR-WGR-5).
      const at=srcGroup?srcTop+1:srcTop;
      items.splice(at,0,{kind:'group',id:container,windows:[]});
      gi=at;
    }
    list=items[gi].windows;
    from=container===srcGroup?srcInGroup:-1;
  }
  if((key==='prev'||key==='next')&&from<0) return {ok:false,error:'bad_spec'};
  const s=key?_woSlot(list,from,spec,key,anchorIdx):{at:list.length};
  if(s.error) return {ok:false,error:s.error};

  const moved=Object.assign({},me);
  if(container===WIN_ORDER_TOP){
    delete moved.groupId;
    items.splice(s.at,0,{kind:'window',id});
  }else{
    moved.groupId=container;
    items[_woTopIndexOf(items,container)].windows.splice(s.at,0,id);
  }
  byId.set(id,moved);
  const out=_woFlatten(wins.map(w=>w.id===id?moved:w),items.filter(it=>it.kind==='window'||it.windows.length),byId);
  return {ok:true,windows:out,position:_woPosition(out,groups,id)};
}

function _woResult(windows, groups, id, r){
  return Object.assign(r,{position:_woPosition(r.windows,groups,id)});
}

/** window 하나의 최종 위치 `{container,index,count}` (FR-ORD-6). */
function _woPosition(wins, groups, id){
  const items=winOrderItems(wins,groups);
  const w=wins.find(x=>x.id===id);
  if(w&&w.groupId){
    const g=items[_woTopIndexOf(items,w.groupId)];
    return {container:w.groupId,index:g.windows.indexOf(id)+1,count:g.windows.length};
  }
  const live=items.filter(it=>it.kind==='window'||it.windows.length);
  return {container:WIN_ORDER_TOP,index:_woTopIndexOf(live,id)+1,count:live.length};
}

function winOrderMoveGroup(windows, groups, gid, spec){
  spec=spec||{};
  const keys=_woKeys(spec);
  if(keys.length!==1||(spec.to!==undefined&&spec.to!==null)) return {ok:false,error:'bad_spec'};
  if(!(groups||[]).some(g=>g.id===gid)) return {ok:false,error:'not_found'};
  const wins=winOrderNormalize(windows,groups);
  const byId=new Map(wins.filter(_woPlain).map(w=>[w.id,w]));
  const items=winOrderItems(wins,groups).filter(it=>it.kind==='window'||it.windows.length);
  const from=_woTopIndexOf(items,gid);
  if(from<0) return {ok:false,error:'empty_group'};
  const key=keys[0];
  let anchorId=spec[key];
  if(key==='before'||key==='after'){
    const aw=byId.get(anchorId);
    if(aw&&aw.groupId) anchorId=aw.groupId;
    if(anchorId===gid) return {ok:true,windows:wins,position:{container:WIN_ORDER_TOP,index:from+1,count:items.length}};
  }
  const me=items.splice(from,1)[0];
  const s=_woSlot(items.map(it=>it.id),from,spec,key,(key==='before'||key==='after')?_woTopIndexOf(items,anchorId):-1);
  if(s.error) return {ok:false,error:s.error};
  items.splice(s.at,0,me);
  return {ok:true,windows:_woFlatten(wins,items,byId),position:{container:WIN_ORDER_TOP,index:s.at+1,count:items.length}};
}
