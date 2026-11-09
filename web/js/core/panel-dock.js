// PANEL_DOCK_SRS: 패널 좌우 도킹의 순수 계산 (NFR-PDK-1). DOM 을 읽지 않는다 —
// 자리(rect)는 부르는 쪽이 재어 넘긴다.
//
// 도크 상태는 `{left:[], right:[]}` 이고 각 배열은 **바깥 → 안쪽** 순서다 (FR-PDK-1).
const DOCK_PANELS=['sidebar','activity'];
const DOCK_SIDES=['left','right'];
const REPO_SIDE_DOCK_DEFAULT='left';
// FR-PDK-10: `#content` 의 order 는 0 이다. 왼쪽은 음수, 오른쪽은 양수로 벌린다.
const DOCK_ORDER_BASE=100;

function dockDefault(){ return {left:['sidebar'],right:['activity']} }

/** FR-PDK-1·4: 규칙을 어기는 값은 모두 기본값이 된다. 문자열 해석은 `PrefStore.local.json` 의 일이다. */
function dockNormalize(v){
  if(!v||typeof v!=='object'||!Array.isArray(v.left)||!Array.isArray(v.right)) return dockDefault();
  const all=v.left.concat(v.right);
  if(all.length!==DOCK_PANELS.length) return dockDefault();
  if(!DOCK_PANELS.every(p=>all.includes(p))) return dockDefault();
  return {left:v.left.slice(),right:v.right.slice()};
}

function dockSideOf(s,panel){ return s.left.includes(panel)?'left':'right' }

function dockEqual(a,b){
  return a.left.join()===b.left.join()&&a.right.join()===b.right.join();
}

/** 패널을 `side` 의 `index`(바깥에서 센 자리)에 넣은 새 배치. 원본은 건드리지 않는다. */
function dockMove(s,panel,side,index){
  const n={left:s.left.slice(),right:s.right.slice()};
  if(!DOCK_PANELS.includes(panel)||!DOCK_SIDES.includes(side)) return n;
  for(const k of DOCK_SIDES) n[k]=n[k].filter(p=>p!==panel);
  const i=Math.max(0,Math.min(n[side].length,index));
  n[side].splice(i,0,panel);
  return n;
}

/**
 * FR-PDK-10·11: 패널과 그 폭 손잡이의 flex order. 손잡이는 패널의 **안쪽**에 붙는다.
 * 반환은 `{<panel>:{panel,handle}}` 이다.
 */
function dockOrders(s){
  const out={};
  s.left.forEach((p,i)=>{ out[p]={panel:-DOCK_ORDER_BASE+2*i,handle:-DOCK_ORDER_BASE+2*i+1} });
  s.right.forEach((p,j)=>{ out[p]={panel:DOCK_ORDER_BASE-2*j,handle:DOCK_ORDER_BASE-2*j-1} });
  return out;
}

function dockOthers(s,panel,side){ return s[side].filter(p=>p!==panel) }

/**
 * FR-PDK-31·32: 포인터 x 에서 놓일 자리 `{side,index}`. index 는 끌고 있는 패널을
 * 뺀 그 쪽 배열에서의 자리다 (`dockMove` 에 그대로 넘긴다). 폭이 0 인(숨은)
 * 패널은 순서를 정하지 않고 그 바깥에 남는다.
 */
function dockDropTarget(s,panel,x,app,rects){
  const side=x<app.left+app.width/2?'left':'right';
  const others=dockOthers(s,panel,side);
  let index=0;
  for(const p of others){
    const r=rects[p];
    if(r&&r.width>0){
      const c=r.left+r.width/2;
      const outward=side==='left'?x<c:x>c;
      if(outward) break;
    }
    index++;
  }
  return {side,index};
}

/** FR-PDK-33: 막대가 설 x. 바깥 끝이면 앱 가장자리, 아니면 바로 바깥 패널의 안쪽 면이다. */
function dockIndicatorX(s,panel,at,app,rects){
  const others=dockOthers(s,panel,at.side);
  if(at.index===0) return at.side==='left'?app.left:app.left+app.width;
  const r=rects[others[at.index-1]];
  return at.side==='left'?r.left+r.width:r.left;
}

/** FR-PDK-5 */
function repoSideNormalize(v){ return v==='right'?'right':REPO_SIDE_DOCK_DEFAULT }

/** FR-PDK-34 */
function repoSideDropTarget(x,r){ return x<r.left+r.width/2?'left':'right' }
