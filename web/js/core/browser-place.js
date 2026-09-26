/**
 * 브라우저 탭을 놓을 자리 (BROWSER_TAB_SRS FR-BRT-32·33).
 *
 * 순수 함수다 — 창 하나의 레이아웃 트리만 받는다. 그래서 **창 경계를 넘지 않는다**
 * (옆 창 슬롯으로 가는 `slotNavigate` 가 여기에는 없다).
 *
 * 로드 순서: `layout-tree.js` 뒤.
 */

/**
 * 창 안에서 `dir` 쪽으로 도착하는 칸. `paneNavigate` 와 같은 규칙이다 — 그 방향의
 * 분할을 거슬러 올라가 다음 형제의 `firstPane`. `_paneSiblingOf` 는 쓰지 않는다 —
 * 방향을 보지 않고 이전 형제로도 가기 때문이다.
 */
function browserNeighbor(layout,rid,dir){
  const path=layout?findPath(layout,rid):null;
  if(!path||path.length<2) return null;
  const wantH=dir==='right';
  for(let i=path.length-2;i>=0;i--){
    const parent=path[i],child=path[i+1];
    if(parent.type!=='split') continue;
    if((parent.direction==='horizontal')!==wantH) continue;
    const ti=parent.children.indexOf(child)+1;
    if(ti<parent.children.length){
      const fp=firstPane(parent.children[ti]);
      if(fp) return fp.id;
    }
  }
  return null;
}

/**
 * 터미널에서 연 탭의 자리 (FR-BRT-32). `split` 은 `right|down|none`.
 *
 *   {pane:id}                   그 칸에 새 탭
 *   {split:{target:id,dir}}     그 칸을 dir 쪽으로 나눠 새 칸에
 *
 * 호출 칸이 트리에 없으면 `fallback`(그 창의 포커스 칸)을, 그것도 없으면 첫 칸을 쓴다.
 */
function browserPlace(layout,callerId,split,fallback){
  let caller=callerId&&findPane(layout,callerId)?callerId:null;
  if(!caller&&fallback&&findPane(layout,fallback)) caller=fallback;
  if(!caller){ const f=firstPane(layout); caller=f?f.id:null }
  if(!caller) return null;
  if(split==='none') return {pane:caller};
  const dir=split==='down'?'down':'right';
  const near=browserNeighbor(layout,caller,dir);
  if(near) return {pane:near};
  return {split:{target:caller,dir}};
}

/** 페이지가 연 탭은 연 탭 **바로 뒤**다 (FR-BRT-33). 연 탭이 없으면 끝이다. */
function browserInsertAfter(pane,afterTabId,tab){
  const i=pane.tabs.findIndex(x=>x.id===afterTabId);
  if(i<0) pane.tabs.push(tab); else pane.tabs.splice(i+1,0,tab);
}

/** target 칸을 dir 쪽으로 나눠 newPane 을 세운 새 트리를 낸다. */
function browserSplitInsert(layout,targetId,dir,newPane){
  const direction=dir==='down'?'vertical':'horizontal';
  const walk=n=>{
    if(!n) return n;
    if(n.type==='pane') return n.id===targetId?{type:'split',direction,children:[n,newPane]}:n;
    if(n.children) n.children=n.children.map(walk);
    return n;
  };
  return walk(layout);
}
