/**
 * Otterminal — 설정 ▸ Edges 의 망 그림 계산 (EDGE_MESH_SRS FR-EGM-50~56).
 *
 * 망 그림은 `GET /api/edges` 의 `mesh {nodes, links}` 를 SVG 로 그린다. 나는 가운데에 고정하고
 * 나머지는 힘 배치로 놓는다 — 처음 자리를 지문 순서로 정하고 정해진 횟수만 계산하므로 같은 망은
 * 늘 같은 그림이다. 노드를 누르면 그림 아래에 할 수 있는 일(초대 보내기·알리기)이 나온다.
 *
 * 망에서 온 문자열(이름)은 `textContent` 로만 그린다.
 *
 * 여기는 순수 함수와 크기다. 그리기·받은 초대 줄·초대 보내기는 `EdgesController`(`edges-controller.js`)가 한다
 * (REFACTOR3_FE_APPCTL_SRS 9a).
 *
 * 로드 순서 계약: `settings-edges.js` 뒤.
 */

/** 그림의 크기(viewBox)와 노드 반지름, 가장자리 여백, 힘 배치 계산 횟수. */
const MESH_W=360;
const MESH_H=240;
const MESH_NODE_R=7;
const MESH_MARGIN=36;
const MESH_ITER=300;
/** 이름 줄과 표시 줄의 노드 중심에서의 거리. */
const MESH_LABEL_DY=20;
const MESH_MARK_DY=32;

/**
 * 노드 자리 `Map<fp,{x,y}>`. 나(`self`)는 가운데에 고정하고, 나머지는 지문 순서로 원 위에 둔 뒤
 * 힘 배치(이어진 노드는 당기고 모든 노드는 민다)를 MESH_ITER 번 계산한다.
 */
function meshLayout(nodes,links,w,h){
  const cx=w/2,cy=h/2;
  const self=nodes.find(n=>n.self);
  const others=nodes.filter(n=>!n.self).map(n=>n.fp).sort();
  const pos=new Map();
  if(self) pos.set(self.fp,{x:cx,y:cy});
  const r=Math.max(1,Math.min(w,h)/2-MESH_MARGIN);
  others.forEach((fp,i)=>{
    const a=2*Math.PI*i/others.length-Math.PI/2;
    pos.set(fp,{x:cx+r*Math.cos(a),y:cy+r*Math.sin(a)});
  });
  const ids=[...pos.keys()];
  const k=Math.sqrt(w*h/Math.max(1,ids.length))*0.6;
  const lo=Math.min(MESH_MARGIN,w/2),hiX=Math.max(w-MESH_MARGIN,w/2),hiY=Math.max(h-MESH_MARGIN,h/2);
  for(let it=0;it<MESH_ITER;it++){
    const temp=(1-it/MESH_ITER)*k*0.5;
    const disp=new Map(ids.map(id=>[id,{x:0,y:0}]));
    for(let i=0;i<ids.length;i++) for(let j=i+1;j<ids.length;j++){
      const a=pos.get(ids[i]),b=pos.get(ids[j]);
      let dx=a.x-b.x,dy=a.y-b.y,d=Math.hypot(dx,dy);
      if(d<0.01){ dx=0.01*(j-i);dy=0.01;d=Math.hypot(dx,dy) }
      const f=k*k/d;
      disp.get(ids[i]).x+=dx/d*f;disp.get(ids[i]).y+=dy/d*f;
      disp.get(ids[j]).x-=dx/d*f;disp.get(ids[j]).y-=dy/d*f;
    }
    for(const [p,q] of links){
      const a=pos.get(p),b=pos.get(q);
      if(!a||!b) continue;
      const dx=a.x-b.x,dy=a.y-b.y,d=Math.hypot(dx,dy)||0.01;
      const f=d*d/k;
      disp.get(p).x-=dx/d*f;disp.get(p).y-=dy/d*f;
      disp.get(q).x+=dx/d*f;disp.get(q).y+=dy/d*f;
    }
    for(const id of ids){
      if(self&&id===self.fp) continue;
      const p=pos.get(id),v=disp.get(id),len=Math.hypot(v.x,v.y);
      if(!len) continue;
      const step=Math.min(len,temp);
      p.x=Math.min(hiX,Math.max(lo,p.x+v.x/len*step));
      p.y=Math.min(hiY,Math.max(lo,p.y+v.y/len*step));
    }
  }
  for(const p of pos.values()){ p.x=Math.round(p.x);p.y=Math.round(p.y) }
  return pos;
}

/** 노드를 골랐을 때 할 일: 간선 상대는 'notify', 온라인 망 이웃은 'invite', 그 밖은 '' (FR-EGM-53). */
function meshNodeAction(n){
  if(!n||n.self) return '';
  if(n.edge) return 'notify';
  return n.online?'invite':'';
}

/** 간선 상대의 표시 문구 키 — 알림 대기·옛 판 (FR-EGM-52·54). */
function meshNodeMarks(e){
  const out=[];
  if(e&&e.pending) out.push('edge.pending');
  if(e&&e.outdated) out.push('edge.outdated');
  return out;
}

/**
 * 개인채팅 방의 상대 노드가 초대를 보낼 수 있는 망 이웃이면 그 노드, 아니면 null 이다 (FR-EGM-56).
 * 참가자 id 의 앞 64자는 그 노드의 지문 전체다 (PEER_CHAT_SRS §3.9).
 */
function meshDirectPeer(room,meId,mesh){
  if(!room||room.kind!=='direct'||!mesh||!Array.isArray(mesh.nodes)) return null;
  const other=(room.people||[]).find(p=>p.id!==meId);
  if(!other) return null;
  const fp=String(other.id).slice(0,64);
  const n=mesh.nodes.find(x=>x.fp===fp);
  return meshNodeAction(n)==='invite'?n:null;
}
