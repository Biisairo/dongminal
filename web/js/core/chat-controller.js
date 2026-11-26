/**
 * 채팅 — Chats 탭과 사람 참가자의 동작 (PEER_CHAT_SRS §3.11, FR-PCH-80~85).
 *
 * 채팅은 데몬에 있다. 화면은 `GET /api/chat` 로 나·온라인 목록·방 목록을 읽고, 바뀌면 서버가
 * `chat_changed` 로 다시 읽게 한다. 사람에게 온 글은 `chat_message` 로 오고 `ChatStore` 에만 남는다.
 *
 * 망에서 온 문자열(이름·목적·표시 이름·본문)은 모두 `textContent` 로만 그린다. 사람과 에이전트는
 * 표시 이름이 아니라 참가자의 `kind`·글의 `fromKind` 로 가린다 (§3.11).
 *
 * `ChatController` 가 목록 읽기·Chats 탭 항목·사람 참가자의 동작을 진다. App 은 이것을 `chat` 으로 든다
 * (REFACTOR3_FE_APPCTL_SRS 9c). 부품 셋 — 채팅 창 `ChatWindow`(`chat-window.js`) `.window` · 사람 명령 `ChatHuman`
 * (`chat-human.js`) `.human` · 채팅 탭의 뷰 `ChatViews`(`chat-views.js`, 옛 `ui/chat-view.js`) `.views`. 읽은 상태 `_chat` 은
 * App 에 남는다 — 시험이 갈아 끼운다. 뷰는 `chat` 화면 묶음이고 처음 채팅 탭을 그릴 때 실린다 (PERF 3.4.9). 사람 명령과 채팅 창
 * 열기의 본체(`chat-window-open.js`), 망 그림 계산(`edges-mesh.js`)도 그 묶음이다 — 채팅 목록을 처음 그리거나 채팅 창을 처음 열
 * 때 실린다 (PERF 3.4.12.10).
 *
 * 로드 순서 계약: `chat-store.js` 뒤, `activity-list.js` 뒤, `core/screens.js` 뒤(끝에서 화면을 등록한다).
 */

/** 화면이 아는 실패. 코드 → 안내 문구 키. 없으면 `chat.unavailable` 이다. */
const CHAT_DOWN_KEYS=Object.freeze({
  chat_daemon_restart:'chat.need_restart',
});

/** 사람 참가자의 알림 단계 (ISSUE_TREE_CHAT_SRS FR-CAL-5, 와이어 `chatwire::NOTIFY_*`). */
const CHAT_NOTIFY_ALL='all';
const CHAT_NOTIFY_CALLED='called';

/** 노드 지문은 화면에 앞 16자리를 보인다 (`edges-controller.js` 의 EDGE_FP_SHOWN 과 같다). */
const CHAT_FP_SHOWN=16;

class ChatController extends Controller {
  constructor(app){
    super(app);
    this.window=new ChatWindow(app);
    this._human=null;
    this._views=null;
  }

  /**
   * 사람 명령 `ChatHuman` — `chat` 묶음에 있다 (PERF 3.4.12.10, D-47). 묶음이 실리기 전에는 null 이다. 부르는 자리(방 행·
   * 참가자 행)는 채팅 목록·채팅 탭에만 있고, 둘 다 묶음이 실린 뒤에 그려진다(`ChatWindow.chatPanelRender`·렌더러).
   */
  get human(){
    if(!this._human&&Screens.ready('chat')) this._human=new ChatHuman(this.app);
    return this._human;
  }

  /**
   * 채팅 탭의 뷰 `ChatViews` — `chat` 화면 묶음에 있다 (PERF 3.4.9, D-30). 묶음이 실리기 전에는 null 이다.
   * 뷰는 렌더러가 묶음을 기다린 뒤에야 생기므로, 그 전에는 다시 그릴 뷰도 보이는 방도 없다.
   */
  get views(){
    if(!this._views&&Screens.ready('chat')) this._views=new ChatViews(this.app);
    return this._views;
  }

  _chatS(){
    if(!this._chatStore) this._chatStore=new ChatStore();
    return this._chatStore;
  }

  /** 등록부의 restore. 실패면 코드를 남겨 Chats 탭이 까닭을 말하게 한다. */
  _chatRestore(src){
    const flight=this.app.wsSync._restoreBegin('chat');
    return stateFetch(src,'/api/chat').then(r=>{
      if(!this.app.wsSync._restoreLive('chat',flight)) return;
      if(r.ok&&r.data) this.app._chat=r.data;
      else if(r.status) this.app._chat={down:(r.data&&r.data.code)||'chat_unavailable'};
      this.app.wsSync._restoreEnd('chat',flight);
      if(this.app.chat.window._chatRepaint) this.app.chat.window._chatRepaint(); // CHAT_WINDOW_SRS FR-CW-21: 목록은 메인 패널이다
      this.app.chat.views?._chatViewsPaint();
    });
  }

  _onChatChanged(){ return this._chatRestore() }

  /**
   * FR-PCH-85: 사람에게 온 글. 그 방의 탭이 보이지 않으면 안 읽은 수가 는다.
   * ISSUE_TREE_CHAT_SRS FR-CAL-15: 그때 내 단계에 걸리는 글이면 방에 알람을 걸고 소리·OS 알림을 낸다. 낼지는 서버가
   * 글 id 로 컴퓨터마다 한 번 승낙한다(결정 I-3).
   */
  _onChatMessage(a){
    const m=a&&a.msg;
    if(!m||!m.room) return;
    const shown=!!this.views?._chatRoomShown(m.room);
    if(!this._chatS().add(m.room,m,shown)) return;
    if(!shown&&this._chatWakes(m)){
      this._chatS().alarm(m.room);
      this.app.attn?.claim?._attnAnnounceChat(m.id,()=>this._chatBanner(m));
      this.app.render?.(); // 방 탭의 알람 표식은 칸을 그릴 때 선다
    }
    if(this.app.chat.window._chatRepaint) this.app.chat.window._chatRepaint();
    this.app.chat.views?._chatViewsPaint(m.room);
  }

  /** FR-CAL-5·7: 사람 참가자의 그 방 단계에 걸리는 글인가. 단계가 없으면 called 다(A-1). */
  _chatWakes(m){
    const r=this._chatRoom(m.room);
    const level=(r&&r.notify)||CHAT_NOTIFY_CALLED;
    return level===CHAT_NOTIFY_ALL||(level===CHAT_NOTIFY_CALLED&&!!m.called);
  }

  /** FR-CAL-15: OS 알림. 에이전트 알람과 같은 설정을 따른다. 본문은 방 이름이다. */
  _chatBanner(m){
    const a=this.app;
    if(!a.attnDesktop||a.attnDesktopBlocked||typeof Notification==='undefined'||Notification.permission!=='granted') return;
    const me=this._chatMe();
    const body=chatRoomTitle(this._chatRoom(m.room),me&&me.id);
    ErrorLog.quiet('notify',()=>new Notification(t('chat.attn_head'),{body}));
  }

  chatRoomAlarmed(id){ return this._chatS().alarmed(id) }

  /** 메인 패널 `채팅` 탭의 알람 — 지금 있는 방 가운데 알람이 걸린 방이 있는가. */
  chatAlarmAny(){ return this._chatRooms().some(r=>this._chatS().alarmed(r.id)) }

  _chatRooms(){ return (this.app._chat&&Array.isArray(this.app._chat.rooms))?this.app._chat.rooms:[] }
  _chatMe(){ return (this.app._chat&&this.app._chat.me)||null }
  _chatRoom(id){ return this._chatRooms().find(r=>r.id===id)||null }

  /** FR-PCH-81 → CHAT_WINDOW_SRS FR-CW-20: 메인 패널 `채팅` 탭의 배지 — 지금 있는 방의 안 읽은 수의 합이다. */
  chatUnreadTotal(){
    const s=this._chatS();
    return this._chatRooms().reduce((n,r)=>n+s.unread(r.id),0);
  }

  // ── 채팅 목록 (FR-PCH-83 → CHAT_WINDOW_SRS FR-CW-21: 메인 패널의 `채팅` 탭) ──

  /** 들어간 방 먼저, 그다음 이름 순이다. */
  _chatItems(){
    const c=this.app._chat;
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
  }

  _chatActEl(){
    const d=domEl('div','chat-act');
    d.appendChild(UIKit.button({icon:'plus',label:t('chat.new_group'),kind:'ghost',size:'sm',cls:'chat-new',
      title:TIP_CHAT_NEW_GROUP,onClick:e=>{e.stopPropagation();this._chatCreateAsk()}}));
    return d;
  }

  _chatRoomRowEl(r,meId){
    const sel=this._chatRoomsSel&&this._chatRoomsSel.sel.has(r.id);
    const row=domEl('div','chat-row chat-room'+(r.joined?' joined':'')+(sel?' sel':'')+(this._chatS().alarmed(r.id)?' attn':''));
    row.dataset.room=r.id;
    const title=chatRoomTitle(r,meId);
    row.title=title;
    row.appendChild(UIKit.icon(r.kind==='direct'?'message-square':'hash',{cls:'chat-row-icon'}));
    row.appendChild(domEl('span','chat-row-name',title));
    row.appendChild(domEl('span','chat-row-sub',t('chat.members',{n:r.members})));
    const n=this._chatS().unread(r.id);
    if(n) row.appendChild(domEl('span','chat-row-n ui-badge',String(n)));
    // CHAT_WINDOW_SRS FR-CW-23 (D-22): 들어간 방의 행에는 `⋯` 가 선다 — 나가기가 여기서도 된다.
    if(r.joined) row.appendChild(UIKit.button({icon:'ellipsis',kind:'ghost',size:'sm',cls:'chat-row-more',
      title:TIP_CHAT_ROOM_MORE,onClick:e=>{e.stopPropagation();const b=e.currentTarget.getBoundingClientRect();this.human._chatRoomMenu(r.id,{x:b.left,y:b.bottom})}}));
    row.addEventListener('click',e=>{ if(!this.human._chatRoomPick(r.id,e)) this._chatOpenRoom(r.id) });
    row.addEventListener('contextmenu',e=>this.human._chatRoomCtx(r.id,e));
    return row;
  }

  _chatNodeEl(n){
    const d=domEl('div','chat-node'+(n.online?'':' off'));
    d.appendChild(domEl('span','chat-node-name',n.name||'?'));
    d.appendChild(domEl('span','chat-node-fp',String(n.fp||'').slice(0,CHAT_FP_SHOWN)));
    d.title=n.online?'Online':'Disconnected';
    return d;
  }

  /** FR-PCH-84: 참가자를 누르면 메뉴에서 개인채팅을 연다. 나에게는 걸 수 없다. */
  _chatPersonEl(p,meId){
    const row=domEl('div','chat-row chat-person'+(p.online?'':' off')+(p.kind==='user'?' human':''));
    row.title=p.label+' · '+chatShortId(p.id);
    row.appendChild(domEl('span','chat-row-name',chatName(p.label,p.id,meId)));
    row.appendChild(domEl('span','chat-row-sub',(p.kind==='user'?t('chat.human')+' · ':'')+chatShortId(p.id)+(p.id===meId?' · '+t('chat.me'):'')));
    if(p.id!==meId&&p.online) row.addEventListener('click',e=>this._chatPersonMenu(p,{x:e.clientX,y:e.clientY}));
    return row;
  }

  _chatPersonMenu(p,at){
    UIKit.menu([{id:'direct',icon:'message-square',label:t('chat.direct_open'),onClick:()=>this._chatDirect(p.id)}],{at,cls:'chat-menu'});
  }

  // ── 동작 ──────────────────────────────────────────────────────

  /** 실패는 토스트로 알리고 null 이다. */
  async _chatPost(op,body,what){
    const r=await apiPost('/api/chat/'+op,body);
    if(!r.ok){ Toast.show(apiErrText(r,what),'err'); return null }
    return r.data;
  }

  /** FR-PCH-83: 들어가지 않은 방이면 들어간 뒤 채팅 탭을 연다. 같은 방의 탭이 있으면 그리로 간다. */
  async _chatOpenRoom(id){
    const r=this._chatRoom(id);
    if(r&&!r.joined&&!(await this._chatPost('join',{room:id},t('chat.err_join')))) return;
    if(r&&!r.joined) await this._chatRestore();
    this.window._chatOpenTab(id);
  }

  /**
   * PEER_CHAT_SRS FR-PCH-83: 채팅 탭. `TAB_OPENERS` 가 부른다. run 탭과 같은 비-PTY 경로이며 `opts.roomId` 를 요구한다.
   * 같은 방의 탭이 이미 있으면 그리로 옮긴다. 탭을 닫아도 방에서 나가지 않는다 (§3.11).
   */
  _addChatTab(s, pn, opts) {
    if (!opts.roomId) { console.warn('[addTab] chat tab requires roomId'); return }
    const existing = findTabWhere(this.app.ws.windows, tab => tab.type === TAB_TYPE_CHAT && tab.roomId === opts.roomId);
    if (existing) {
      this.app.layout.tabAdd._revealTab(existing);
      this.app.render();
      this.app.wsSave.save();
      return;
    }
    const id = newEntityId();
    this.app.layout.tabAdd._pushTab(s, pn, { id, name: clampEntityName(opts.name || 'Chat'), type: TAB_TYPE_CHAT, roomId: opts.roomId }, true);
    this.app.render();
    this.app.wsSave.save();
    return { uuid: id };
  }

  // `_chatOpenTab` 은 `ChatWindow`(`chat-window.js`) 다 — 탭은 채팅 창에만 선다 (CHAT_WINDOW_SRS FR-CW-12).

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
    this.window._chatOpenTab(d.room.id);
  }

  async _chatDirect(pid){
    const d=await this._chatPost('direct',{participant:pid},t('chat.err_direct'));
    if(!d||!d.room) return;
    await this._chatRestore();
    this.window._chatOpenTab(d.room.id);
  }

  /** FR-PCH-85: 보낸 글은 보낸 순간 대화에 넣는다. 데몬은 보낸 이에게 되돌려 주지 않는다. */
  /** ISSUE_TREE_CHAT_SRS FR-CUX-13: `call` 은 부른 상대의 참가자 id 들이다. 비면 싣지 않는다. */
  async _chatSend(roomId,text,call){
    if(!text.trim()) return false;
    if(!(await this._chatPost('send',call&&call.length?{room:roomId,text,call}:{room:roomId,text},t('chat.err_send')))) return false;
    const me=this._chatMe()||{};
    this._chatSeq=(this._chatSeq||0)+1;
    this._chatS().add(roomId,{id:'local-'+this._chatSeq,room:roomId,from:me.id,fromLabel:me.label,fromKind:'user',text,at:Date.now(),call},true);
    this.app.chat.views?._chatViewsPaint(roomId);
    return true;
  }

  async _chatLeave(roomId){
    if(!(await this._chatPost('leave',{room:roomId},t('chat.err_leave')))) return;
    // CHAT_WINDOW_SRS FR-CW-31 (D-CW-4): 나가면 그 방의 탭도 닫힌다.
    if(this.window._chatCloseRoomTabs) this.window._chatCloseRoomTabs(roomId);
    await this._chatRestore();
  }
}

// PERF 3.4.9 (D-30): 채팅 탭의 본문은 `chat` 묶음이 그린다. 렌더러는 묶음이 실릴 때까지 자리표시를 둔다.
Screens.register('chat', { css: true, needs: ['mdlib', 'hljs'], i18n: true, tab: (at) => at.type === TAB_TYPE_CHAT });
