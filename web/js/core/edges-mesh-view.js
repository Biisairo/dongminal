/**
 * 간선 망 그림과 받은 초대 — 설정 ▸ Edges 의 화면 (EDGE_MESH_SRS FR-EGM-50~56). `EdgesController.prototype` 증강이다.
 *
 * `settings` 화면 묶음에 있다 (PERF D-41). 부르는 자리는 `EdgesSection`(settings-edges.js) 뿐이다. 읽기·알림과 채팅이 쓰는
 * 초대 보내기(`_egInviteSend`)는 부팅의 `edges-controller.js` 에 남는다. 망 배치의 순수 함수는 `edges-mesh.js` 다.
 *
 * 로드 순서: `edges-controller.js` 뒤.
 */

Object.assign(EdgesController.prototype, {
  /** 망 그림과 그 아래의 할 일을 그린다. 패널이 없는 화면에서는 아무것도 하지 않는다. */
  _egMeshPaint(){
    const box=document.getElementById('eg-mesh');
    if(!box) return;
    const v=this.app._edges||{};
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
    const svg=svgEl('svg',{viewBox:'0 0 '+MESH_W+' '+MESH_H,class:'eg-mesh-svg',role:'group','aria-label':t('edge.mesh_label')});
    const self=mesh.nodes.find(n=>n.self);
    const online=new Map(mesh.nodes.map(n=>[n.fp,n.online]));
    for(const [p,q] of mesh.links||[]){
      const a=pos.get(p),b=pos.get(q);
      if(!a||!b) continue;
      const mine=self&&(p===self.fp||q===self.fp);
      svg.appendChild(svgEl('line',{x1:a.x,y1:a.y,x2:b.x,y2:b.y,
        class:'eg-mesh-link'+(mine?' mine':'')+(online.get(p)&&online.get(q)?'':' off')}));
    }
    for(const n of mesh.nodes){
      const at=pos.get(n.fp);
      const g=svgEl('g',{class:'eg-mesh-node'+(n.self?' self':'')+(n.online?'':' off')+(this._egMeshSel===n.fp?' sel':''),
        transform:'translate('+at.x+','+at.y+')',tabindex:0,role:'button','data-fp':n.fp});
      const handle=edgeHandle(n);
      const marks=meshNodeMarks(edges.get(n.fp)).map(k=>t(k));
      g.setAttribute('aria-label',[handle,n.self?t('edge.mesh_me'):t(n.online?'edge.online':'edge.offline'),...marks].join(' · '));
      g.appendChild(svgEl('rect',{class:'eg-mesh-hit'}));
      g.appendChild(svgEl('circle',{r:MESH_NODE_R}));
      const label=svgEl('text',{y:MESH_LABEL_DY,'text-anchor':'middle',class:'eg-mesh-name'});
      label.textContent=handle;
      g.appendChild(label);
      if(marks.length){
        const mark=svgEl('text',{y:MESH_MARK_DY,'text-anchor':'middle',class:'eg-mesh-mark'});
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
    const v=this.app._edges||{};
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
      title:TIP_EDGE_INVITE_SEND,onClick:()=>this._egInviteSend(n)}));
    if(act==='notify'){
      const e=(v.edges||[]).find(x=>x.fp===n.fp);
      if(e) els.push(UIKit.button({label:t('edge.notify'),kind:'ghost',size:'sm',cls:'eg-mesh-notify',
        title:TIP_EDGE_NOTIFY,onClick:()=>this._egNotify(e)}));
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
    const list=(this.app._edges&&this.app._edges.invites)||[];
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
          title:TIP_EDGE_INVITE_ACCEPT,onClick:()=>this._egInviteAccept(inv)}),
        UIKit.button({label:t('edge.invite_reject'),kind:'ghost',size:'sm',cls:'eg-invite-reject',
          title:TIP_EDGE_INVITE_REJECT,onClick:()=>this._egInviteReject(inv)}));
      return row;
    }));
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
