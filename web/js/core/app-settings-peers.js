/**
 * Dongminal — 설정창의 **Peers 패널** (PEER_NETWORK_SRS FR-PNW-80).
 *
 * 구역은 넷이다: 이 노드 · 초대 · 승인 대기 · 짝. 목록은 `app-peers.js` 가 읽은
 * `_peers` 를 그린다 — 방송(`peers_changed`)이 오면 그쪽이 다시 읽고 여기를 부른다.
 * 노드 설정 칸은 탭을 열 때와 저장한 뒤에만 채운다. 방송마다 채우면 고치던 값이 덮인다.
 *
 * 초대 코드는 **만든 응답에만** 있다 (FR-PNW-95, I-3). 그 코드는 이 창의 메모리에만 둔다.
 */

/** 초대의 남은 시간을 다시 그리는 주기. */
const PEER_REMAIN_TICK_MS=1000;

Object.assign(App.prototype, {
  _pnDirRow(v){
    const row=document.createElement('div');
    row.className='acl-row';
    const inp=document.createElement('input');
    inp.type='text';inp.className='acl-value';
    inp.placeholder='~/work';
    inp.value=v||'';
    const del=UIKit.button({icon:'x',title:t('peer.dir_del'),kind:'ghost',size:'sm'});
    del.addEventListener('click',()=>row.remove());
    row.append(inp,del);
    return row;
  },

  _pnNodePaint(){
    const n=this._peers&&this._peers.node;
    if(!n) return;
    document.getElementById('pn-enabled').checked=!!n.enabled;
    document.getElementById('pn-name').value=n.name||'';
    document.getElementById('pn-port').value=n.port?String(n.port):'';
    document.getElementById('pn-bind').value=n.bind||'';
    document.getElementById('pn-advertise').value=n.advertise||'';
    const box=document.getElementById('pn-dirs');
    box.replaceChildren(...(n.allowedDirs||[]).map(d=>this._pnDirRow(d)));
  },

  _pnNodeCollect(){
    const dirs=[];
    for(const inp of document.querySelectorAll('#pn-dirs .acl-value')){
      const v=inp.value.trim();
      if(v) dirs.push(v);
    }
    return {
      enabled:document.getElementById('pn-enabled').checked,
      name:document.getElementById('pn-name').value.trim(),
      port:parseInt(document.getElementById('pn-port').value,10)||0,
      bind:document.getElementById('pn-bind').value.trim(),
      advertise:document.getElementById('pn-advertise').value.trim(),
      allowedDirs:dirs,
    };
  },

  /** `app-peers.js` 가 다시 읽을 때마다 부른다. 패널이 없는 화면에서는 아무것도 하지 않는다. */
  _peersPaint(){
    const v=this._peers;
    if(!v||!document.getElementById('panel-peers')) return;
    const n=v.node||{};
    const st=document.getElementById('pn-port-state');
    st.classList.toggle('err',!n.listening&&!!n.error);
    st.textContent=n.listening?t('peer.port_open',{addr:n.addr||''})
      :n.error?t('peer.port_error',{error:n.error}):t('peer.port_off');
    document.getElementById('pn-fp').textContent=peerFp16(n.fingerprint);
    this._pnInvitePaint();
    this._pnPendingPaint(v.pending||[]);
    // 주소를 고치던 줄이 있으면 덮지 않는다 — 다음 방송이나 탭 열기가 그린다.
    if(!document.querySelector('#pn-peers .pn-addr:not([hidden])')) this._pnPeersPaint(v.peers||[]);
  },

  _pnInvitePaint(){
    const box=document.getElementById('pn-inv-box');
    if(!box) return;
    const inv=this._peers&&this._peers.invite;
    const left=inv?peerRemain(inv.expires,Date.now()):'';
    const mine=this._pnInvite;
    const codeOk=!!(left&&mine&&Date.parse(mine.expires)===Date.parse(inv.expires));
    if(!codeOk) this._pnInvite=null;
    box.hidden=!codeOk;
    document.getElementById('pn-inv-code').value=codeOk?mine.code:'';
    document.getElementById('pn-inv-remain').textContent=left||t('peer.inv_none');
  },

  _pnPendingPaint(pending){
    const box=document.getElementById('pn-pending');
    box.replaceChildren(...pending.map(p=>this._pnPendingRow(p)));
    if(!pending.length){
      const none=document.createElement('span');
      none.className='sbx-status';
      none.textContent=t('peer.pending_none');
      box.appendChild(none);
    }
  },

  _pnPendingRow(p){
    const row=document.createElement('div');
    row.className='pn-item';
    row.dataset.id=p.id;
    const who=document.createElement('span');
    who.className='pn-who';
    who.textContent=p.name+' · '+p.addr+':'+p.port;
    const fp=document.createElement('code');
    fp.className='pn-fp';
    fp.textContent=peerFp16(p.fp);
    // FR-PNW-30: 이름이 이미 있으면 서버가 409 로 답한다. 그때만 이름 칸을 연다.
    const name=document.createElement('input');
    name.type='text';name.className='sbx-input pn-rename';name.hidden=true;
    name.value=p.name;
    name.setAttribute('aria-label',t('peer.rename_label'));
    const ok=UIKit.button({label:t('peer.approve'),kind:'primary',size:'sm',cls:'pn-approve'});
    const no=UIKit.button({label:t('peer.reject'),kind:'ghost',size:'sm',cls:'pn-reject'});
    const st=document.getElementById('pn-pending-status');
    ok.addEventListener('click',()=>statusRun(st,{fail:t('peer.approve_fail')},async()=>{
      const body={id:p.id};
      if(!name.hidden) body.name=name.value.trim();
      const r=await apiPost('/api/peers/approve',body);
      if(!r.ok&&r.data&&r.data.code==='peer_name_taken'){
        name.hidden=false;name.focus();
        return {ok:false,status:r.status,data:{message:t('peer.name_taken',{name:body.name||p.name})},text:'',headers:null};
      }
      if(r.ok&&r.data&&r.data.confirmed===false) st.textContent=t('peer.confirm_failed',{reason:r.data.reason||''});
      return r;
    }));
    no.addEventListener('click',()=>statusRun(st,{fail:t('peer.reject_fail')},
      ()=>apiPost('/api/peers/reject',{id:p.id})));
    row.append(who,fp,name,ok,no);
    return row;
  },

  _pnPeersPaint(peers){
    const box=document.getElementById('pn-peers');
    box.replaceChildren(...peers.map(p=>this._pnPeerRow(p)));
    if(!peers.length){
      const none=document.createElement('span');
      none.className='sbx-status';
      none.textContent=t('peer.peers_none');
      box.appendChild(none);
    }
  },

  _pnPeerRow(p){
    const row=document.createElement('div');
    row.className='pn-item';
    row.dataset.name=p.name;
    const who=document.createElement('span');
    who.className='pn-who';
    who.textContent=p.name+' · '+p.addr+':'+p.port;
    const state=document.createElement('span');
    state.className='sbx-status pn-state';
    state.textContent=p.state==='pending-out'?t('peer.state_pending_out'):t('peer.state_paired');
    const seen=document.createElement('span');
    seen.className='sbx-status';
    seen.textContent=p.lastSeen?t('peer.last_seen',{at:new Date(p.lastSeen).toLocaleString()}):t('peer.never_seen');
    const addr=document.createElement('input');
    addr.type='text';addr.className='sbx-input pn-addr';addr.value=p.addr;addr.hidden=true;
    addr.setAttribute('aria-label',t('peer.addr_label'));
    const port=document.createElement('input');
    port.type='number';port.className='ds-num pn-port';port.value=String(p.port);port.hidden=true;
    port.setAttribute('aria-label',t('peer.port_label'));
    const edit=UIKit.button({label:t('peer.edit_addr'),kind:'ghost',size:'sm',cls:'pn-edit'});
    const st=document.getElementById('pn-peers-status');
    edit.addEventListener('click',()=>{
      if(addr.hidden){ addr.hidden=false;port.hidden=false;edit.querySelector('.ui-btn-label').textContent=t('html.save');addr.focus();return }
      statusRun(st,{ok:t('core.saved'),fail:t('core.save_fail')},async()=>{
        const r=await apiPut('/api/peers/address',{name:p.name,addr:addr.value.trim(),port:parseInt(port.value,10)||0});
        if(r.ok){ addr.hidden=true; await this._peersRestore() }
        return r;
      });
    });
    const del=UIKit.button({label:t('peer.remove'),kind:'ghost',size:'sm',cls:'pn-remove'});
    del.addEventListener('click',()=>this._pnRemoveConfirm(p.name));
    row.append(who,state,seen,addr,port,edit,del);
    return row;
  },

  // 해제하면 다시 짝을 맺어야 한다 — 한 걸음 확인을 받는다 (CONFIRM_ONE_STAGE_SRS).
  _pnRemoveConfirm(name){
    const body=document.createElement('p');
    body.textContent=t('peer.remove_body',{name});
    const st=document.getElementById('pn-peers-status');
    const m=UIKit.modal({
      title:t('peer.remove_title'),
      cls:'pn-confirm',
      width:'min(420px,90vw)',
      body,
      actions:[
        {label:t('core.cancel')},
        {label:t('peer.remove'),kind:'danger',onClick:()=>statusRun(st,{fail:t('peer.remove_fail')},
          ()=>apiPost('/api/peers/remove',{name}))},
      ],
    });
    document.body.appendChild(m.el);
  },

  async _loadPeersPanel(){
    await statusRun(document.getElementById('pn-node-status'),{fail:t('peer.read_fail')},async()=>{
      const r=await apiGet('/api/peers');
      if(r.ok) await this._peersRestore(Promise.resolve(r));
      return r;
    });
    this._pnNodePaint();
  },

  _pnInviteShown(){
    const panel=document.getElementById('panel-peers');
    const overlay=document.getElementById('modal-overlay');
    return !!(panel&&!panel.hidden&&overlay&&overlay.classList.contains('open')&&this._peers&&this._peers.invite);
  },

  _initPeersPanel(){
    const save=document.getElementById('pn-save');
    if(!save) return;
    document.getElementById('pn-dir-add').addEventListener('click',()=>
      document.getElementById('pn-dirs').appendChild(this._pnDirRow('')));
    save.addEventListener('click',()=>statusRun(document.getElementById('pn-node-status'),
      {pending:t('core.saving'),ok:t('core.saved'),fail:t('core.save_fail')},async()=>{
        const r=await apiPut('/api/peers/node',this._pnNodeCollect());
        if(r.ok&&r.data){ this._peers=r.data; this._pnNodePaint(); this._peersPaint() }
        return r;
      }));
    const invSt=document.getElementById('pn-inv-status');
    document.getElementById('pn-inv-make').addEventListener('click',()=>statusRun(invSt,{fail:t('peer.inv_fail')},async()=>{
      const addr=document.getElementById('pn-inv-addr').value.trim();
      const r=await apiPost('/api/peers/invite',addr?{addr}:{});
      if(r.ok&&r.data){
        this._pnInvite={code:r.data.code,expires:r.data.expires};
        if(this._peers) this._peers.invite={expires:r.data.expires};
        this._pnInvitePaint();
      }
      return r;
    }));
    document.getElementById('pn-inv-copy').addEventListener('click',async()=>{
      const code=document.getElementById('pn-inv-code').value;
      if(!code) return;
      const ok=await ClipboardWriter.write(code);
      invSt.classList.toggle('err',!ok);
      invSt.textContent=ok?t('peer.copied'):t('peer.copy_fail');
    });
    const addSt=document.getElementById('pn-add-status');
    document.getElementById('pn-add').addEventListener('click',()=>statusRun(addSt,{fail:t('peer.add_fail')},async()=>{
      const code=document.getElementById('pn-add-code').value.trim();
      const name=document.getElementById('pn-add-name').value.trim();
      const r=await apiPost('/api/peers/add',name?{code,name}:{code});
      if(!r.ok||!r.data) return r;
      document.getElementById('pn-add-code').value='';
      // FR-PNW-33: 등록은 됐지만 상대가 이 노드로 보낼 수 없다.
      const msg=t('peer.add_ok',{name:r.data.name});
      addSt.textContent=r.data.warning==='port_closed'?msg+' '+t('peer.add_port_closed'):msg;
      return r;
    }));
    this.timers.every({
      id:'peers.invite', owner:'peers', whenHidden:'pause',
      every:()=>PEER_REMAIN_TICK_MS,
      when:()=>this._pnInviteShown(),
      run:()=>this._pnInvitePaint(),
    });
  },
});
