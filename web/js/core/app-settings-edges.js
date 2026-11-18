/**
 * Dongminal — 설정창의 **Edges 패널** (PEER_NETWORK_SRS FR-PNW-80, EDGE_PAIRING_SRS FR-EPR-70·71).
 *
 * 구역은 셋이다: 이 노드 · 초대(만들기와 붙여 넣기) · 간선. 목록은 `app-edges.js` 가 읽은
 * `_edges` 를 그린다 — 방송(`edges_changed`)이 오면 그쪽이 다시 읽고 여기를 부른다.
 * 노드 설정 칸은 탭을 열 때와 저장한 뒤에만 채운다. 방송마다 채우면 고치던 값이 덮인다.
 *
 * 초대 코드는 **만든 응답에만** 있다 (FR-PNW-95, I-3). 그 코드는 이 창의 메모리에만 둔다.
 */

/** 초대의 남은 시간을 다시 그리는 주기. */
const EDGE_REMAIN_TICK_MS=1000;

Object.assign(App.prototype, {
  _egNodePaint(v=this._edges){
    const n=v&&v.node;
    if(!n) return;
    document.getElementById('eg-enabled').checked=!!n.enabled;
    // PROFILE_NAME_SRS FR-PFN-31: 이름은 프로필에서 바꾼다. 여기는 보여 주기만 한다.
    document.getElementById('eg-handle').textContent=edgeHandle(n);
    document.getElementById('eg-port').value=n.port?String(n.port):'';
    document.getElementById('eg-bind').value=n.bind||'';
    document.getElementById('eg-advertise').value=n.advertise||'';
  },

  _egNodeCollect(){
    return {
      enabled:document.getElementById('eg-enabled').checked,
      port:parseInt(document.getElementById('eg-port').value,10)||0,
      bind:document.getElementById('eg-bind').value.trim(),
      advertise:document.getElementById('eg-advertise').value.trim(),
    };
  },

  /** `app-edges.js` 가 다시 읽을 때마다 부른다. 패널이 없는 화면에서는 아무것도 하지 않는다. */
  _edgesPaint(){
    const v=this._edges;
    if(!v||!document.getElementById('panel-edges')) return;
    const n=v.node||{};
    const st=document.getElementById('eg-port-state');
    st.classList.toggle('err',!n.listening&&!!n.error);
    st.textContent=n.listening?t('edge.port_open',{addr:n.addr||''})
      :n.error?t('edge.port_error',{error:n.error}):t('edge.port_off');
    document.getElementById('eg-fp').textContent=edgeFp16(n.fingerprint);
    this._egInvitePaint();
    this._egEdgesPaint(v.edges||[]);
    this._egMeshPaint();
    this._egInvitesPaint();
  },

  /** 고치던 줄(열린 입력 칸이 있는 줄)은 그대로 두고 나머지만 새로 만든다. force 면 전부 새로 만든다. */
  _egKeepEditing(box,key,open,force){
    const keep=new Map();
    if(!force){
      for(const row of box.querySelectorAll('.eg-item')){
        if(row.querySelector(open)) keep.set(row.dataset[key],row);
      }
    }
    return keep;
  },

  _egInvitePaint(){
    const box=document.getElementById('eg-inv-box');
    if(!box) return;
    const inv=this._edges&&this._edges.invite;
    const now=Date.now();
    const left=inv?edgeRemain(inv.expires,now):'';
    const mine=this._egInvite;
    // 내 코드는 그 만료가 지나거나 서버에 더 새 초대가 있을 때만 버린다. 늦게 도착한 읽기가
    // "초대 없음" 을 말해도 방금 만든 코드를 지우지 않는다 — 다음 읽기가 다시 보인다.
    if(mine&&(!edgeRemain(mine.expires,now)||(inv&&Date.parse(inv.expires)>Date.parse(mine.expires)))) this._egInvite=null;
    const codeOk=!!(left&&this._egInvite&&Date.parse(this._egInvite.expires)===Date.parse(inv.expires));
    box.hidden=!codeOk;
    document.getElementById('eg-inv-code').value=codeOk?this._egInvite.code:'';
    document.getElementById('eg-inv-remain').textContent=left||t('edge.inv_none');
  },

  _egEdgesPaint(edges,force){
    const box=document.getElementById('eg-edges');
    const keep=this._egKeepEditing(box,'fp','.eg-addr:not([hidden])',force);
    box.replaceChildren(...edges.map(p=>keep.get(p.fp)||this._egEdgeRow(p)));
    if(!edges.length){
      const none=document.createElement('span');
      none.className='sbx-status';
      none.textContent=t('edge.edges_none');
      box.appendChild(none);
    }
  },

  _egEdgeRow(p){
    const row=document.createElement('div');
    row.className='eg-item';
    row.dataset.fp=p.fp;
    const who=document.createElement('span');
    who.className='eg-who';
    who.textContent=edgeWho(p);
    // PROFILE_NAME_SRS FR-PFN-22: 지문 앞자리는 줄에서 빠지고 툴팁으로 간다.
    who.title=edgeFp16(p.fp);
    const addr=document.createElement('input');
    addr.type='text';addr.className='sbx-input eg-addr';addr.value=p.addr;addr.hidden=true;
    addr.setAttribute('aria-label',t('edge.addr_label'));
    const port=document.createElement('input');
    port.type='number';port.className='ds-num eg-port';port.value=p.port?String(p.port):'';port.hidden=true;
    port.setAttribute('aria-label',t('edge.port_label'));
    const edit=UIKit.button({label:t('edge.edit_addr'),kind:'ghost',size:'sm',cls:'eg-edit'});
    const cancel=UIKit.button({label:t('core.cancel'),kind:'ghost',size:'sm',cls:'eg-edit-cancel'});
    cancel.hidden=true;
    const st=document.getElementById('eg-edges-status');
    const editing=(on)=>{
      addr.hidden=!on;port.hidden=!on;cancel.hidden=!on;
      edit.querySelector('.ui-btn-label').textContent=on?t('html.save'):t('edge.edit_addr');
    };
    edit.addEventListener('click',()=>{
      if(addr.hidden){ editing(true);addr.focus();return }
      statusRun(st,{ok:t('core.saved'),fail:t('core.save_fail')},async()=>{
        const r=await apiPut('/api/edges/address',{fp:p.fp,addr:addr.value.trim(),port:parseInt(port.value,10)||0});
        if(r.ok){ editing(false); await this._edgesRestore() }
        return r;
      });
    });
    // M-7: 고치기를 그만두면 이 줄도 다시 방송을 따른다.
    cancel.addEventListener('click',()=>{
      addr.value=p.addr;port.value=p.port?String(p.port):'';editing(false);
      if(this._edges) this._egEdgesPaint(this._edges.edges||[]);
    });
    const del=UIKit.button({label:t('edge.remove'),kind:'ghost',size:'sm',cls:'eg-remove'});
    del.addEventListener('click',()=>this._egRemoveConfirm(p));
    // EDGE_MESH_SRS FR-EGM-54: 알림 대기·옛 판 표시와 수동 알리기.
    const marks=meshNodeMarks(p).map(k=>t(k));
    const mark=document.createElement('span');
    mark.className='eg-mark';
    mark.textContent=marks.join(' · ');
    mark.hidden=!marks.length;
    const notify=UIKit.button({label:t('edge.notify'),kind:'ghost',size:'sm',cls:'eg-notify',
      title:'Send my name, node port and address to this edge',onClick:()=>this._egNotify(p)});
    row.append(who,mark,addr,port,edit,cancel,notify,del);
    return row;
  },

  // 끊으면 다시 간선을 맺어야 한다 — 한 걸음 확인을 받는다 (CONFIRM_ONE_STAGE_SRS, FR-EPR-71).
  _egRemoveConfirm(p){
    const body=document.createElement('p');
    body.textContent=t('edge.remove_body',{name:edgeHandle(p),fp:edgeFp16(p.fp)});
    const st=document.getElementById('eg-edges-status');
    const m=UIKit.modal({
      title:t('edge.remove_title'),
      cls:'eg-confirm',
      width:'min(420px,90vw)',
      body,
      actions:[
        {label:t('core.cancel')},
        {label:t('edge.remove'),kind:'danger',onClick:()=>statusRun(st,{fail:t('edge.remove_fail')},()=>this._egRemove(p))},
      ],
    });
    document.body.appendChild(m.el);
  },

  /** 간선을 끊는다. 상대에게 알리지 못했으면 그 사실을 알린다 (FR-EPR-71). */
  async _egRemove(p){
    const r=await apiPost('/api/edges/remove',{fp:p.fp});
    if(r.ok&&r.data&&r.data.notified===false) Toast.show(t('edge.remove_unnotified'),'',0);
    return r;
  },

  async _loadEdgesPanel(){
    let v=null,got=null;
    await statusRun(document.getElementById('eg-node-status'),{fail:t('edge.read_fail')},async()=>{
      const r=await apiGet('/api/edges');
      if(r.ok&&r.data){ v=r.data; got=r; await this._edgesRestore(Promise.resolve(r)) }
      return r;
    });
    // 방송의 다시 읽기가 이 읽기를 밀어내면 `_edges` 가 아직 비어 있을 수 있다 — 이 읽기의
    // 값으로 그린다. 더 새 값은 그 다시 읽기가 목록에 그린다.
    v=v||this._edges;
    if(!v) return;
    this._egNodePaint(v);
    if(got) this._liveMark('edges',got,this._egNodeCollect());
    // 탭을 열면 고치던 줄도 버리고 지금 값으로 그린다.
    this._egEdgesPaint(v.edges||[],true);
  },

  _egInviteShown(){
    const panel=document.getElementById('panel-edges');
    const overlay=document.getElementById('modal-overlay');
    return !!(panel&&!panel.hidden&&overlay&&overlay.classList.contains('open')&&this._edges&&this._edges.invite);
  },

  _initEdgesPanel(){
    const save=document.getElementById('eg-save');
    if(!save) return;
    save.addEventListener('click',()=>statusRun(document.getElementById('eg-node-status'),
      {pending:t('core.saving'),ok:t('core.saved'),fail:t('core.save_fail')},async()=>{
        // UX_BATCH12 FR-LIV-5: 읽을 때의 지문을 싣는다. 낡았으면 409 이고 저장하지 않는다.
        const r=await apiPut('/api/edges/node',this._egNodeCollect(),this._liveOpts('edges'));
        if(this._liveStale('edges',r,()=>this._loadEdgesPanel())) return r;
        if(r.ok&&r.data){ this._edges=r.data; this._egNodePaint(); this._edgesPaint(); this._liveMark('edges',r,this._egNodeCollect()) }
        return r;
      }));
    const invSt=document.getElementById('eg-inv-status');
    document.getElementById('eg-inv-make').addEventListener('click',()=>statusRun(invSt,{fail:t('edge.inv_fail')},async()=>{
      const addr=document.getElementById('eg-inv-addr').value.trim();
      const r=await apiPost('/api/edges/invite',addr?{addr}:{});
      if(r.ok&&r.data){
        this._egInvite={code:r.data.code,expires:r.data.expires};
        if(this._edges) this._edges.invite={expires:r.data.expires};
        this._egInvitePaint();
      }
      return r;
    }));
    document.getElementById('eg-inv-copy').addEventListener('click',async()=>{
      const code=document.getElementById('eg-inv-code').value;
      if(!code) return;
      const ok=await ClipboardWriter.write(code);
      invSt.classList.toggle('err',!ok);
      invSt.textContent=ok?t('edge.copied'):t('edge.copy_fail');
    });
    const addSt=document.getElementById('eg-add-status');
    document.getElementById('eg-add').addEventListener('click',()=>statusRun(addSt,{fail:t('edge.add_fail')},async()=>{
      const code=document.getElementById('eg-add-code').value.trim();
      const r=await apiPost('/api/edges/add',{code});
      if(!r.ok||!r.data) return r;
      document.getElementById('eg-add-code').value='';
      addSt.textContent=t('edge.add_ok',{name:edgeHandle(r.data)});
      return r;
    }));
    this.timers.every({
      id:'edges.invite', owner:'edges', whenHidden:'pause',
      every:()=>EDGE_REMAIN_TICK_MS,
      when:()=>this._egInviteShown(),
      run:()=>this._egInvitePaint(),
    });
  },
});
