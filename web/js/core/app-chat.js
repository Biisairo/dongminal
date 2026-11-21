/**
 * 채팅 — Chats 탭과 사람 참가자의 동작 (PEER_CHAT_SRS §3.11, FR-PCH-80~85).
 *
 * 채팅은 데몬에 있다. 화면은 `GET /api/chat` 로 나·온라인 목록·방 목록을 읽고, 바뀌면 서버가
 * `chat_changed` 로 다시 읽게 한다. 사람에게 온 글은 `chat_message` 로 오고 `ChatStore` 에만 남는다.
 *
 * 망에서 온 문자열(이름·목적·표시 이름·본문)은 모두 `textContent` 로만 그린다. 사람과 에이전트는
 * 표시 이름이 아니라 참가자의 `kind`·글의 `fromKind` 로 가린다 (§3.11).
 *
 * 로드 순서 계약: `chat-store.js` 뒤, `app-activity.js` 뒤. 프로토타입 확장이다.
 */

/** 화면이 아는 실패. 코드 → 안내 문구 키. 없으면 `chat.unavailable` 이다. */
const CHAT_DOWN_KEYS=Object.freeze({
  chat_daemon_restart:'chat.need_restart',
});

/** 노드 지문은 화면에 앞 16자리를 보인다 (`edges-controller.js` 의 EDGE_FP_SHOWN 과 같다). */
const CHAT_FP_SHOWN=16;

Object.assign(App.prototype, {
  _chatS(){
    if(!this._chatStore) this._chatStore=new ChatStore();
    return this._chatStore;
  },

  /** 등록부의 restore. 실패면 코드를 남겨 Chats 탭이 까닭을 말하게 한다. */
  _chatRestore(src){
    const flight=this._restoreBegin('chat');
    return stateFetch(src,'/api/chat').then(r=>{
      if(!this._restoreLive('chat',flight)) return;
      if(r.ok&&r.data) this._chat=r.data;
      else if(r.status) this._chat={down:(r.data&&r.data.code)||'chat_unavailable'};
      this._restoreEnd('chat',flight);
      if(this._chatRepaint) this._chatRepaint(); // CHAT_WINDOW_SRS FR-CW-21: 목록은 메인 패널이다
      this._chatViewsPaint();
    });
  },

  _onChatChanged(){ return this._chatRestore() },

  /** FR-PCH-85: 사람에게 온 글. 그 방의 탭이 보이지 않으면 안 읽은 수가 는다. */
  _onChatMessage(a){
    const m=a&&a.msg;
    if(!m||!m.room) return;
    if(!this._chatS().add(m.room,m,this._chatRoomShown(m.room))) return;
    if(this._chatRepaint) this._chatRepaint();
    this._chatViewsPaint(m.room);
  },

  _chatRooms(){ return (this._chat&&Array.isArray(this._chat.rooms))?this._chat.rooms:[] },
  _chatMe(){ return (this._chat&&this._chat.me)||null },
  _chatRoom(id){ return this._chatRooms().find(r=>r.id===id)||null },

  /** FR-PCH-81 → CHAT_WINDOW_SRS FR-CW-20: 메인 패널 `채팅` 탭의 배지 — 지금 있는 방의 안 읽은 수의 합이다. */
  chatUnreadTotal(){
    const s=this._chatS();
    return this._chatRooms().reduce((n,r)=>n+s.unread(r.id),0);
  },

  // ── 채팅 목록 (FR-PCH-83 → CHAT_WINDOW_SRS FR-CW-21: 메인 패널의 `채팅` 탭) ──

  /** 들어간 방 먼저, 그다음 이름 순이다. */
  _chatItems(){
    const c=this._chat;
    if(!c) return [];
    if(c.down) return [{t:'row',sec:'chats',id:'down',el:domEl('div','ui-empty chat-down',t(CHAT_DOWN_KEYS[c.down]||'chat.unavailable'))}];
    const me=this._chatMe(),meId=me&&me.id;
    const out=[{t:'row',sec:'chats',id:'act',el:this._chatActEl()},
      {t:'row',sec:'chats',id:'h-rooms',el:domEl('div','chat-sub-h',t('chat.rooms'))}];
    const rooms=this._chatRooms().slice().sort((a,b)=>(b.joined?1:0)-(a.joined?1:0)||chatRoomTitle(a,meId).localeCompare(chatRoomTitle(b,meId)));
    this._chatRoomOrder=rooms.map(r=>r.id);
    if(!rooms.length) out.push({t:'row',sec:'chats',id:'no-rooms',el:domEl('div','ui-empty chat-none',t('chat.no_rooms'))});
    for(const r of rooms) out.push({t:'row',sec:'chats',id:'room:'+r.id,el:this._chatRoomRowEl(r,meId)});
    out.push({t:'row',sec:'chats',id:'h-online',el:domEl('div','chat-sub-h',t('chat.online'))});
    const on=c.online||{};
    for(const n of on.nodes||[]){
      out.push({t:'row',sec:'chats',id:'node:'+n.fp,el:this._chatNodeEl(n)});
      for(const p of (on.participants||[]).filter(x=>x.node===n.fp)){
        out.push({t:'row',sec:'chats',id:'p:'+p.id,el:this._chatPersonEl(p,meId)});
      }
    }
    return out;
  },

  _chatActEl(){
    const d=domEl('div','chat-act');
    d.appendChild(UIKit.button({icon:'plus',label:t('chat.new_group'),kind:'ghost',size:'sm',cls:'chat-new',
      title:'Create a group chat',onClick:e=>{e.stopPropagation();this._chatCreateAsk()}}));
    return d;
  },

  _chatRoomRowEl(r,meId){
    const sel=this._chatRoomsSel&&this._chatRoomsSel.sel.has(r.id);
    const row=domEl('div','chat-row chat-room'+(r.joined?' joined':'')+(sel?' sel':''));
    row.dataset.room=r.id;
    const title=chatRoomTitle(r,meId);
    row.title=title;
    row.appendChild(UIKit.icon(r.kind==='direct'?'message-square':'list',{cls:'chat-row-icon'}));
    row.appendChild(domEl('span','chat-row-name',title));
    row.appendChild(domEl('span','chat-row-sub',t('chat.members',{n:r.members})));
    const n=this._chatS().unread(r.id);
    if(n) row.appendChild(domEl('span','chat-row-n ui-badge',String(n)));
    // CHAT_WINDOW_SRS FR-CW-23 (D-22): 들어간 방의 행에는 `⋯` 가 선다 — 나가기가 여기서도 된다.
    if(r.joined) row.appendChild(UIKit.button({icon:'more-horizontal',kind:'ghost',size:'sm',cls:'chat-row-more',
      title:'More actions for this room',onClick:e=>{e.stopPropagation();const b=e.currentTarget.getBoundingClientRect();this._chatRoomMenu(r.id,{x:b.left,y:b.bottom})}}));
    row.addEventListener('click',e=>{ if(!this._chatRoomPick(r.id,e)) this._chatOpenRoom(r.id) });
    row.addEventListener('contextmenu',e=>this._chatRoomCtx(r.id,e));
    return row;
  },

  _chatNodeEl(n){
    const d=domEl('div','chat-node'+(n.online?'':' off'));
    d.appendChild(domEl('span','chat-node-name',n.name||'?'));
    d.appendChild(domEl('span','chat-node-fp',String(n.fp||'').slice(0,CHAT_FP_SHOWN)));
    d.title=n.online?'Online':'Disconnected';
    return d;
  },

  /** FR-PCH-84: 참가자를 누르면 메뉴에서 개인채팅을 연다. 나에게는 걸 수 없다. */
  _chatPersonEl(p,meId){
    const row=domEl('div','chat-row chat-person'+(p.online?'':' off')+(p.kind==='user'?' human':''));
    row.title=p.label+' · '+chatShortId(p.id);
    row.appendChild(domEl('span','chat-row-name',p.label));
    row.appendChild(domEl('span','chat-row-sub',(p.kind==='user'?t('chat.human')+' · ':'')+chatShortId(p.id)+(p.id===meId?' · '+t('chat.me'):'')));
    if(p.id!==meId&&p.online) row.addEventListener('click',e=>this._chatPersonMenu(p,{x:e.clientX,y:e.clientY}));
    return row;
  },

  _chatPersonMenu(p,at){
    UIKit.menu([{id:'direct',icon:'message-square',label:t('chat.direct_open'),onClick:()=>this._chatDirect(p.id)}],{at,cls:'chat-menu'});
  },

  // ── 동작 ──────────────────────────────────────────────────────

  /** 실패는 토스트로 알리고 null 이다. */
  async _chatPost(op,body,what){
    const r=await apiPost('/api/chat/'+op,body);
    if(!r.ok){ Toast.show(apiErrText(r,what),'err'); return null }
    return r.data;
  },

  /** FR-PCH-83: 들어가지 않은 방이면 들어간 뒤 채팅 탭을 연다. 같은 방의 탭이 있으면 그리로 간다. */
  async _chatOpenRoom(id){
    const r=this._chatRoom(id);
    if(r&&!r.joined&&!(await this._chatPost('join',{room:id},t('chat.err_join')))) return;
    if(r&&!r.joined) await this._chatRestore();
    this._chatOpenTab(id);
  },

  /**
   * PEER_CHAT_SRS FR-PCH-83: 채팅 탭. `TAB_OPENERS` 가 부른다. run 탭과 같은 비-PTY 경로이며 `opts.roomId` 를 요구한다.
   * 같은 방의 탭이 이미 있으면 그리로 옮긴다. 탭을 닫아도 방에서 나가지 않는다 (§3.11).
   */
  _addChatTab(s, pn, opts) {
    if (!opts.roomId) { console.warn('[addTab] chat tab requires roomId'); return }
    const existing = findTabWhere(this.ws.windows, tab => tab.type === TAB_TYPE_CHAT && tab.roomId === opts.roomId);
    if (existing) {
      this._revealTab(existing);
      this.render();
      this.save();
      return;
    }
    const id = newEntityId();
    this._pushTab(s, pn, { id, name: clampEntityName(opts.name || 'Chat'), type: TAB_TYPE_CHAT, roomId: opts.roomId }, true);
    this.render();
    this.save();
    return { uuid: id };
  },

  // `_chatOpenTab` 은 app-chat-window.js 다 — 탭은 채팅 창에만 선다 (CHAT_WINDOW_SRS FR-CW-12).

  async _chatCreateAsk(){
    const body=domEl('div','chat-create');
    const title=domEl('div','chat-create-title',t('chat.new_group'));
    const name=domEl('input','sbx-input chat-create-name');
    const purpose=domEl('input','sbx-input chat-create-purpose');
    body.append(title,UIKit.field({label:t('chat.name'),control:name}),UIKit.field({label:t('chat.purpose'),control:purpose}));
    const ok=await UIKit.ask({body,labelledBy:title,label:t('chat.new_group'),focus:name,escValue:false,actions:[
      {label:t('chat.create'),kind:'primary',cls:'confirm-ok',tip:TIP_CHAT_CREATE,value:true,default:true},
      {label:t('core.cancel'),cls:'confirm-cancel',tip:TIP_CHAT_CANCEL,value:false},
    ]});
    if(!ok) return;
    const d=await this._chatPost('create',{name:name.value.trim(),purpose:purpose.value.trim()},t('chat.err_create'));
    if(!d||!d.room) return;
    await this._chatRestore();
    this._chatOpenTab(d.room.id);
  },

  async _chatDirect(pid){
    const d=await this._chatPost('direct',{participant:pid},t('chat.err_direct'));
    if(!d||!d.room) return;
    await this._chatRestore();
    this._chatOpenTab(d.room.id);
  },

  /** FR-PCH-85: 보낸 글은 보낸 순간 대화에 넣는다. 데몬은 보낸 이에게 되돌려 주지 않는다. */
  async _chatSend(roomId,text){
    if(!text.trim()) return false;
    if(!(await this._chatPost('send',{room:roomId,text},t('chat.err_send')))) return false;
    const me=this._chatMe()||{};
    this._chatSeq=(this._chatSeq||0)+1;
    this._chatS().add(roomId,{id:'local-'+this._chatSeq,room:roomId,from:me.id,fromLabel:me.label,fromKind:'user',text,at:Date.now()},true);
    this._chatViewsPaint(roomId);
    return true;
  },

  async _chatLeave(roomId){
    if(!(await this._chatPost('leave',{room:roomId},t('chat.err_leave')))) return;
    // CHAT_WINDOW_SRS FR-CW-31 (D-CW-4): 나가면 그 방의 탭도 닫힌다.
    if(this._chatCloseRoomTabs) this._chatCloseRoomTabs(roomId);
    await this._chatRestore();
  },
});
