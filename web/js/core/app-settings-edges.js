/**
 * Dongminal — 설정창의 **Edges 패널** (PEER_NETWORK_SRS FR-PNW-80).
 *
 * 구역은 넷이다: 이 노드 · 초대 · 승인 대기 · 간선. 목록은 `app-edges.js` 가 읽은
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
    document.getElementById('eg-name').value=n.name||'';
    document.getElementById('eg-port').value=n.port?String(n.port):'';
    document.getElementById('eg-bind').value=n.bind||'';
    document.getElementById('eg-advertise').value=n.advertise||'';
  },

  _egNodeCollect(){
    return {
      enabled:document.getElementById('eg-enabled').checked,
      name:document.getElementById('eg-name').value.trim(),
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
    this._egPendingPaint(v.pending||[]);
    this._egEdgesPaint(v.edges||[]);
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

  _egPendingPaint(pending,force){
    const box=document.getElementById('eg-pending');
    const keep=this._egKeepEditing(box,'id','.eg-rename:not([hidden])',force);
    box.replaceChildren(...pending.map(p=>keep.get(p.id)||this._egPendingRow(p)));
    if(!pending.length){
      const none=document.createElement('span');
      none.className='sbx-status';
      none.textContent=t('edge.pending_none');
      box.appendChild(none);
    }
  },

  _egPendingRow(p){
    const row=document.createElement('div');
    row.className='eg-item';
    row.dataset.id=p.id;
    const who=document.createElement('span');
    who.className='eg-who';
    who.textContent=p.name+' · '+p.addr+':'+p.port;
    const fp=document.createElement('code');
    fp.className='eg-fp';
    fp.textContent=edgeFp16(p.fp);
    // FR-PNW-30: 이름이 이미 있으면 서버가 409 로 답한다. 그때만 이름 칸을 연다.
    const name=document.createElement('input');
    name.type='text';name.className='sbx-input eg-rename';name.hidden=true;
    name.value=p.name;
    name.setAttribute('aria-label',t('edge.rename_label'));
    const ok=UIKit.button({label:t('edge.approve'),kind:'primary',size:'sm',cls:'eg-approve'});
    const no=UIKit.button({label:t('edge.reject'),kind:'ghost',size:'sm',cls:'eg-reject'});
    const st=document.getElementById('eg-pending-status');
    // L-10: 처음 승인할 때 지문 대조를 한 번 거친다. 이름을 바꿔 다시 승인할 때는 묻지 않는다.
    // 확인창이 열린 동안 방송이 줄을 새로 만들 수 있다 — 대조 여부는 id 로, 이름 칸은 지금
    // 화면의 줄에서 찾는다.
    const verified=this._egVerified||(this._egVerified=new Set());
    ok.addEventListener('click',()=>{
      if(verified.has(p.id)) return approve();
      this._egApproveConfirm(p,()=>{ verified.add(p.id); return approve() });
    });
    const nameNow=()=>{
      const cur=document.querySelector('#eg-pending .eg-item[data-id="'+CSS.escape(p.id)+'"]');
      return (cur&&cur.querySelector('.eg-rename'))||name;
    };
    const approve=()=>statusRun(st,{fail:t('edge.approve_fail')},async()=>{
      const body={id:p.id};
      const nm=nameNow();
      if(!nm.hidden) body.name=nm.value.trim();
      const r=await apiPost('/api/edges/approve',body);
      if(!r.ok&&r.data&&r.data.code==='edge_name_taken'){
        const field=nameNow();
        field.hidden=false;field.focus();
        return {ok:false,status:r.status,data:{message:t('edge.name_taken',{name:body.name||p.name})},text:'',headers:null};
      }
      if(r.ok&&r.data&&r.data.confirmed===false) st.textContent=t('edge.confirm_failed',{reason:r.data.reason||''});
      return r;
    });
    no.addEventListener('click',()=>statusRun(st,{fail:t('edge.reject_fail')},
      ()=>apiPost('/api/edges/reject',{id:p.id})));
    row.append(who,fp,name,ok,no);
    return row;
  },

  _egEdgesPaint(edges,force){
    const box=document.getElementById('eg-edges');
    const keep=this._egKeepEditing(box,'name','.eg-addr:not([hidden])',force);
    box.replaceChildren(...edges.map(p=>keep.get(p.name)||this._egEdgeRow(p)));
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
    row.dataset.name=p.name;
    const who=document.createElement('span');
    who.className='eg-who';
    who.textContent=p.name+' · '+p.addr+':'+p.port;
    const state=document.createElement('span');
    state.className='sbx-status eg-state';
    state.textContent=!p.state?t('edge.state_paired')
      :p.state==='pending-out'?t('edge.state_pending_out'):t('edge.state_unknown',{state:p.state});
    const addr=document.createElement('input');
    addr.type='text';addr.className='sbx-input eg-addr';addr.value=p.addr;addr.hidden=true;
    addr.setAttribute('aria-label',t('edge.addr_label'));
    const port=document.createElement('input');
    port.type='number';port.className='ds-num eg-port';port.value=String(p.port);port.hidden=true;
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
        const r=await apiPut('/api/edges/address',{name:p.name,addr:addr.value.trim(),port:parseInt(port.value,10)||0});
        if(r.ok){ editing(false); await this._edgesRestore() }
        return r;
      });
    });
    // M-7: 고치기를 그만두면 이 줄도 다시 방송을 따른다.
    cancel.addEventListener('click',()=>{
      addr.value=p.addr;port.value=String(p.port);editing(false);
      if(this._edges) this._egEdgesPaint(this._edges.edges||[]);
    });
    const del=UIKit.button({label:t('edge.remove'),kind:'ghost',size:'sm',cls:'eg-remove'});
    del.addEventListener('click',()=>this._egRemoveConfirm(p.name));
    row.append(who,state,addr,port,edit,cancel,del);
    return row;
  },

  // L-10: 초대 코드를 얻은 남이 먼저 등록할 수 있다. 지문이 상대 화면의 것과 같은지 확인받는다.
  _egApproveConfirm(p,onOk){
    const body=document.createElement('div');
    const msg=document.createElement('p');
    msg.textContent=t('edge.approve_body',{name:p.name});
    const fp=document.createElement('code');
    fp.className='eg-fp eg-fp-big';
    fp.textContent=edgeFp16(p.fp);
    body.append(msg,fp);
    const m=UIKit.modal({
      title:t('edge.approve_title'),
      cls:'eg-approve-confirm',
      width:'min(420px,90vw)',
      body,
      actions:[
        {label:t('core.cancel')},
        {label:t('edge.approve'),kind:'primary',onClick:onOk},
      ],
    });
    document.body.appendChild(m.el);
  },

  // 끊으면 다시 간선을 맺어야 한다 — 한 걸음 확인을 받는다 (CONFIRM_ONE_STAGE_SRS).
  _egRemoveConfirm(name){
    const body=document.createElement('p');
    body.textContent=t('edge.remove_body',{name});
    const st=document.getElementById('eg-edges-status');
    const m=UIKit.modal({
      title:t('edge.remove_title'),
      cls:'eg-confirm',
      width:'min(420px,90vw)',
      body,
      actions:[
        {label:t('core.cancel')},
        {label:t('edge.remove'),kind:'danger',onClick:()=>statusRun(st,{fail:t('edge.remove_fail')},
          ()=>apiPost('/api/edges/remove',{name}))},
      ],
    });
    document.body.appendChild(m.el);
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
    this._egPendingPaint(v.pending||[],true);
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
      const name=document.getElementById('eg-add-name').value.trim();
      const r=await apiPost('/api/edges/add',name?{code,name}:{code});
      if(!r.ok||!r.data) return r;
      document.getElementById('eg-add-code').value='';
      // FR-PNW-33: 등록은 됐지만 상대가 이 노드로 보낼 수 없다.
      const msg=t('edge.add_ok',{name:r.data.name});
      addSt.textContent=r.data.warning==='port_closed'?msg+' '+t('edge.add_port_closed'):msg;
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
