/**
 * Dongminal — 설정 ▸ Edges 의 망 그림과 받은 간선 초대 (EDGE_MESH_SRS FR-EGM-50~56).
 *
 * 망 그림은 `GET /api/edges` 의 `mesh {nodes, links}` 를 SVG 로 그린다. 나는 가운데에 고정하고
 * 나머지는 힘 배치로 놓는다 — 처음 자리를 지문 순서로 정하고 정해진 횟수만 계산하므로 같은 망은
 * 늘 같은 그림이다. 노드를 누르면 그림 아래에 할 수 있는 일(초대 보내기·알리기)이 나온다.
 *
 * 망에서 온 문자열(이름)은 `textContent` 로만 그린다.
 *
 * 로드 순서 계약: `app-settings-edges.js` 뒤. 프로토타입 확장이다.
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
const SVG_NS='http://www.w3.org/2000/svg';

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

function meshSvg(tag,attrs){
  const e=document.createElementNS(SVG_NS,tag);
  for(const [k,v] of Object.entries(attrs||{})) e.setAttribute(k,String(v));
  return e;
}

Object.assign(App.prototype, {
  /** 망 그림과 그 아래의 할 일을 그린다. 패널이 없는 화면에서는 아무것도 하지 않는다. */
  _egMeshPaint(){
    const box=document.getElementById('eg-mesh');
    if(!box) return;
    const v=this._edges||{};
    const mesh=v.mesh;
    if(!mesh||!Array.isArray(mesh.nodes)){
      const none=document.createElement('span');
      none.className='sbx-status';
      none.textContent=t('edge.mesh_none');
      box.replaceChildren(none);
      this._egMeshSel=null;
      this._egMeshActPaint();
      return;
    }
    const edges=new Map((v.edges||[]).map(e=>[e.fp,e]));
    if(this._egMeshSel&&!mesh.nodes.some(n=>n.fp===this._egMeshSel)) this._egMeshSel=null;
    const pos=meshLayout(mesh.nodes,mesh.links||[],MESH_W,MESH_H);
    const svg=meshSvg('svg',{viewBox:'0 0 '+MESH_W+' '+MESH_H,class:'eg-mesh-svg',role:'group','aria-label':t('edge.mesh_label')});
    const self=mesh.nodes.find(n=>n.self);
    const online=new Map(mesh.nodes.map(n=>[n.fp,n.online]));
    for(const [p,q] of mesh.links||[]){
      const a=pos.get(p),b=pos.get(q);
      if(!a||!b) continue;
      const mine=self&&(p===self.fp||q===self.fp);
      svg.appendChild(meshSvg('line',{x1:a.x,y1:a.y,x2:b.x,y2:b.y,
        class:'eg-mesh-link'+(mine?' mine':'')+(online.get(p)&&online.get(q)?'':' off')}));
    }
    for(const n of mesh.nodes){
      const at=pos.get(n.fp);
      const g=meshSvg('g',{class:'eg-mesh-node'+(n.self?' self':'')+(n.online?'':' off')+(this._egMeshSel===n.fp?' sel':''),
        transform:'translate('+at.x+','+at.y+')',tabindex:0,role:'button','data-fp':n.fp});
      const handle=edgeHandle(n);
      const marks=meshNodeMarks(edges.get(n.fp)).map(k=>t(k));
      g.setAttribute('aria-label',[handle,n.self?t('edge.mesh_me'):t(n.online?'edge.online':'edge.offline'),...marks].join(' · '));
      g.appendChild(meshSvg('circle',{r:MESH_NODE_R}));
      const label=meshSvg('text',{y:MESH_LABEL_DY,'text-anchor':'middle',class:'eg-mesh-name'});
      label.textContent=handle;
      g.appendChild(label);
      if(marks.length){
        const mark=meshSvg('text',{y:MESH_MARK_DY,'text-anchor':'middle',class:'eg-mesh-mark'});
        mark.textContent=marks.join(' · ');
        g.appendChild(mark);
      }
      g.addEventListener('click',()=>this._egMeshSelect(n.fp));
      g.addEventListener('keydown',e=>{
        if(e.key!=='Enter'&&e.key!==' ') return;
        e.preventDefault();
        this._egMeshSelect(n.fp);
      });
      svg.appendChild(g);
    }
    box.replaceChildren(svg);
    this._egMeshActPaint();
  },

  _egMeshSelect(fp){
    this._egMeshSel=this._egMeshSel===fp?null:fp;
    this._egMeshPaint();
    const g=document.querySelector('#eg-mesh .eg-mesh-node[data-fp="'+fp+'"]');
    if(g) g.focus();
  },

  /** 고른 노드의 이름·상태와 할 일 버튼 (FR-EGM-53). */
  _egMeshActPaint(){
    const bar=document.getElementById('eg-mesh-act');
    if(!bar) return;
    const v=this._edges||{};
    const n=v.mesh&&(v.mesh.nodes||[]).find(x=>x.fp===this._egMeshSel);
    if(!n){
      const hint=document.createElement('span');
      hint.className='sbx-status';
      hint.textContent=v.mesh?t('edge.mesh_pick'):'';
      bar.replaceChildren(hint);
      return;
    }
    const who=document.createElement('span');
    who.className='eg-who';
    who.textContent=edgeHandle(n)+' · '+(n.self?t('edge.mesh_me'):t(n.online?'edge.online':'edge.offline'));
    who.title=edgeFp16(n.fp);
    const els=[who];
    const act=meshNodeAction(n);
    if(act==='invite') els.push(UIKit.button({label:t('edge.invite_send'),kind:'ghost',size:'sm',cls:'eg-mesh-invite',
      title:'Send an edge invite to this node',onClick:()=>this._egInviteSend(n)}));
    if(act==='notify'){
      const e=(v.edges||[]).find(x=>x.fp===n.fp);
      if(e) els.push(UIKit.button({label:t('edge.notify'),kind:'ghost',size:'sm',cls:'eg-mesh-notify',
        title:'Send my name, node port and address to this edge',onClick:()=>this._egNotify(e)}));
    }
    if(!act&&!n.self){
      const none=document.createElement('span');
      none.className='sbx-status';
      none.textContent=t('edge.no_action');
      els.push(none);
    }
    bar.replaceChildren(...els);
  },

  /** 받은 간선 초대 줄 (FR-EGM-55). */
  _egInvitesPaint(){
    const box=document.getElementById('eg-invites');
    if(!box) return;
    const list=(this._edges&&this._edges.invites)||[];
    if(!list.length){
      const none=document.createElement('span');
      none.className='sbx-status';
      none.textContent=t('edge.invites_none');
      box.replaceChildren(none);
      return;
    }
    box.replaceChildren(...list.map(inv=>{
      const row=document.createElement('div');
      row.className='eg-item eg-invite';
      row.dataset.id=inv.id;
      const who=document.createElement('span');
      who.className='eg-who';
      who.textContent=t('edge.invited_row',{name:edgeHandle(inv)});
      who.title=edgeFp16(inv.from);
      row.append(who,
        UIKit.button({label:t('edge.invite_accept'),kind:'ghost',size:'sm',cls:'eg-invite-accept',
          title:'Make an edge with this node',onClick:()=>this._egInviteAccept(inv)}),
        UIKit.button({label:t('edge.invite_reject'),kind:'ghost',size:'sm',cls:'eg-invite-reject',
          title:'Discard this invite',onClick:()=>this._egInviteReject(inv)}));
      return row;
    }));
  },

  /** 망 이웃 n 에게 간선 초대를 보낸다 (FR-EGM-53·56). */
  async _egInviteSend(n){
    const r=await apiPost('/api/edges/invite/send',{to:n.fp});
    if(r.ok) Toast.show(t('edge.invite_sent',{name:edgeHandle(n)}),'ok');
    else Toast.show(apiErrText(r,t('edge.invite_send_fail')),'err');
    return r;
  },

  /** 간선 p 에 내 직접 정보를 지금 알린다 (FR-EGM-54). */
  async _egNotify(p){
    const r=await apiPost('/api/edges/notify',{fp:p.fp});
    if(r.ok) Toast.show(t('edge.notified',{name:edgeHandle(p)}),'ok');
    else Toast.show(apiErrText(r,t('edge.notify_fail')),'err');
    await this._edgesRestore();
    return r;
  },

  async _egInviteAccept(inv){
    const r=await apiPost('/api/edges/invite/accept',{id:inv.id});
    if(!r.ok) Toast.show(apiErrText(r,t('edge.add_fail')),'err');
    await this._edgesRestore();
    return r;
  },

  async _egInviteReject(inv){
    const r=await apiPost('/api/edges/invite/reject',{id:inv.id});
    await this._edgesRestore();
    return r;
  },
});
