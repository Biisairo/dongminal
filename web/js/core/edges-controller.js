/**
 * Otterminal — 간선 상태와 그 알림 (PEER_NETWORK_SRS FR-PNW-81, EDGE_PAIRING_SRS FR-EPR-5·23).
 *
 * 서버가 `edges_changed` 를 밀면 `GET /api/edges` 를 다시 읽는다 — 주기로 묻지 않는다.
 * 설정의 Edges 패널(`settings-edges.js`)은 여기서 읽은 `_edges` 를 그린다.
 *
 * `EdgesController` 가 읽기·알림과 설정 ▸ Edges 의 망 그림·받은 초대(EDGE_MESH_SRS FR-EGM-50~56)를 진다. App 은 이것을
 * `edges` 로 든다(REFACTOR3_FE_APPCTL_SRS 9a). 읽은 `_edges` 는 App 에 남는다 — 설정 섹션·채팅이 읽는다(FR-FEA-2).
 * 망 그림의 순수 함수(`meshLayout` 등)는 `edges-mesh.js` 다.
 *
 * 로드 순서 계약: `app.js` 뒤, `state-registry.js` 뒤.
 */

/** FR-EPR-32: 화면에 보이는 지문의 길이. */
const EDGE_FP_SHOWN=16;

function edgeFp16(fp){ return String(fp||'').slice(0,EDGE_FP_SHOWN) }

/** UX_AUDIT_FIX_SRS FR-UXF-53: 지문의 4자 묶음. 앞 `EDGE_FP_SHOWN` 자가 강조(`key`)다. 이어 붙이면 원문이다. */
const EDGE_FP_GROUP=4;
function edgeFpGroups(fp){
  const s=String(fp||''),out=[];
  for(let i=0;i<s.length;i+=EDGE_FP_GROUP) out.push({text:s.slice(i,i+EDGE_FP_GROUP),key:i<EDGE_FP_SHOWN});
  return out;
}

/** PROFILE_NAME_SRS FR-PFN-6: `이름#번호`. 번호는 서버가 준 값이고, 없으면 이름만이다. */
function edgeHandle(p){ return p.tag?p.name+'#'+p.tag:p.name }

/** FR-EPR-32 · PROFILE_NAME_SRS FR-PFN-22: 간선 한 줄 — `이름#번호 · 주소:포트`. 주소를 모르면 `-` 다. */
function edgeWho(p){
  const addr=!p.addr?'-':(String(p.addr).includes(':')?'['+p.addr+']':p.addr)+':'+p.port;
  return edgeHandle(p)+' · '+addr;
}

/** 만료까지 남은 시간 `m:ss`. 지났거나 읽을 수 없으면 빈 값이다. */
function edgeRemain(expires,now){
  const ms=Date.parse(expires)-now;
  if(!(ms>0)) return '';
  const s=Math.ceil(ms/MS_PER_SEC);
  return Math.floor(s/60)+':'+String(s%60).padStart(2,'0');
}

class EdgesController extends Controller {
  _edgesRestore(src){
    const flight=this.app.wsSync._restoreBegin('edges');
    return stateFetch(src,'/api/edges').then(r=>{
      if(!this.app.wsSync._restoreLive('edges',flight)) return;
      // 503 은 노드 계층이 없는 서버다.
      if(r.ok&&r.data){
        this.app._edges=r.data;
        // PROFILE_NAME_SRS FR-PFN-20: 탭 제목의 이름은 노드 이름이다. 이름을 바꾸면 방송이 다시 읽힌다.
        if(r.data.node&&r.data.node.name!==profileName){ profileName=r.data.node.name; this.app.settings.apply._applyPageTitle() }
        this.app.settings.section('profile')?._pfFollow(r);
        this.app.settings.section('edges')?._edgesPaint();
        // EDGE_MESH_SRS FR-EGM-56: 개인채팅의 초대 버튼은 망 그림을 따른다.
        if(this.app.chat.views._chatViewsPaint) this.app.chat.views._chatViewsPaint();
        // UX_BATCH12 FR-LIV-4: 노드 설정 폼은 목록과 따로 — 지문이 바뀌었을 때만 따라간다.
        const v=r.data;
        if(this.app.settings.live._liveOpen('edges')) this.app.settings.live._liveChanged('edges',r,this.app.settings.section('edges')?._egNodeCollect(),()=>{
          this.app.settings.section('edges')?._egNodePaint(v); this.app.settings.live._liveMark('edges',r,this.app.settings.section('edges')?._egNodeCollect());
        });
      }
      this.app.wsSync._restoreEnd('edges',flight);
    });
  }

  /** CHANNEL_PROTOCOL C2b: `edges.notice` 사건. 상태는 `edges` 토픽이 따로 준다. */
  _onEdgesNotice(a){
    const paired=a&&a.paired, removed=a&&a.removed;
    if(paired) Toast.show(t('edge.paired_notice',{name:edgeHandle(paired)}),'ok',0);
    // FR-EPR-23: 상대가 지운 간선만 알린다. 이쪽에서 끊은 것은 끊기 단계에서 이미 보였다.
    if(removed&&a.byPeer) Toast.show(t('edge.removed_notice',{name:edgeHandle(removed)}),'',0);
    // EDGE_MESH_SRS FR-EGM-55: 망 이웃이 보낸 간선 초대를 받았다. 맺기·거절은 Edges 에서 한다.
    if(a&&a.invited) Toast.show(t('edge.invited_notice',{name:edgeHandle(a.invited)}),'',0);
  }

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
  }

  _egMeshSelect(fp){
    this._egMeshSel=this._egMeshSel===fp?null:fp;
    this._egMeshPaint();
    const g=document.querySelector('#eg-mesh .eg-mesh-node[data-fp="'+fp+'"]');
    if(g) g.focus();
  }

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
  }

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
  }

  /** 망 이웃 n 에게 간선 초대를 보낸다 (FR-EGM-53·56). */
  async _egInviteSend(n){
    const r=await apiPost('/api/edges/invite/send',{to:n.fp});
    if(r.ok) Toast.show(t('edge.invite_sent',{name:edgeHandle(n)}),'ok');
    else Toast.show(apiErrText(r,t('edge.invite_send_fail')),'err');
    return r;
  }

  /** 간선 p 에 내 직접 정보를 지금 알린다 (FR-EGM-54). */
  async _egNotify(p){
    const r=await apiPost('/api/edges/notify',{fp:p.fp});
    if(r.ok) Toast.show(t('edge.notified',{name:edgeHandle(p)}),'ok');
    else Toast.show(apiErrText(r,t('edge.notify_fail')),'err');
    await this._edgesRestore();
    return r;
  }

  async _egInviteAccept(inv){
    const r=await apiPost('/api/edges/invite/accept',{id:inv.id});
    if(!r.ok) Toast.show(apiErrText(r,t('edge.add_fail')),'err');
    await this._edgesRestore();
    return r;
  }

  async _egInviteReject(inv){
    const r=await apiPost('/api/edges/invite/reject',{id:inv.id});
    await this._edgesRestore();
    return r;
  }
}
