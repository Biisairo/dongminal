/**
 * 채팅 탭 — 방 하나의 대화 (PEER_CHAT_SRS §3.11, FR-PCH-84·85).
 *
 * 위에 방 이름·목적·종류와 `⋯` 메뉴, 가운데 대화, 아래 입력칸, 오른쪽 참가자 목록이다.
 * 뷰는 `slotKey(탭 id, 칸)` 마다 하나이고 탭보다 오래 살지 않는다 (`runViewEl` 과 같은 규약).
 * 대화는 `ChatStore` 에만 있다 — 새로고침하면 사라진다.
 *
 * 망에서 온 문자열은 모두 `textContent` 로만 그린다. HTML 로 넣지 않는다.
 *
 * 로드 순서 계약: `app-chat.js` 뒤. 프로토타입 확장이다.
 */

Object.assign(App.prototype, {
  _chatViewMap(){
    if(!this._chatViews) this._chatViews=new Map();
    return this._chatViews;
  },

  /** renderer._mountTabBody 가 부른다. 루트 DOM 은 탭과 칸의 쌍마다 하나이며 재사용된다. */
  chatViewEl(tab,slot){
    const m=this._chatViewMap();
    const key=this.slotKey(tab.id,slot||0);
    let v=m.get(key);
    if(!v){ v=this._chatViewBuild(key,tab); m.set(key,v) }
    v.roomId=tab.roomId;
    this._chatViewPaint(v);
    // 탭이 보였다 — 그 방의 안 읽은 수가 0 이 된다. 패널은 그리는 중이 아닐 때 다시 그린다.
    if(this._chatS().read(v.roomId)) TIMERS.defer(()=>this.agentsRender(),{owner:this,label:'chat-read'});
    return v.root;
  },

  _chatViewBuild(key,tab){
    const root=chatEl('div','chat-view');
    const head=chatEl('div','chat-head');
    const title=chatEl('span','chat-title');
    const kind=chatEl('span','chat-kind ui-badge');
    const purpose=chatEl('span','chat-purpose');
    const v={key,tabId:tab.id,roomId:tab.roomId,root,title,kind,purpose,drawn:[],peopleSig:''};
    head.append(title,kind,purpose,UIKit.button({icon:'more-horizontal',title:'Room actions',kind:'ghost',size:'sm',cls:'chat-more',
      onClick:e=>{e.stopPropagation();const r=e.currentTarget.getBoundingClientRect();this._chatViewMenu(v,{x:r.left,y:r.bottom})}}));
    const main=chatEl('div','chat-main');
    v.log=document.createElement('div');
    v.log.className='chat-log ui-scroll';
    v.people=document.createElement('div');
    v.people.className='chat-people ui-scroll';
    main.append(v.log,v.people);
    const foot=chatEl('div','chat-foot');
    v.note=chatEl('div','chat-note');
    v.input=chatEl('textarea','chat-input');
    v.input.rows=2;
    v.input.placeholder=t('chat.input_ph');
    v.input.addEventListener('keydown',e=>this._chatViewKey(v,e));
    foot.append(v.note,v.input);
    root.append(head,main,foot);
    return v;
  },

  /** Enter 는 보내고 Shift+Enter 는 줄을 바꾼다. 한글 조합 중의 Enter 는 조합을 끝낼 뿐이다. */
  async _chatViewKey(v,e){
    if(e.key!=='Enter'||e.shiftKey||e.isComposing) return;
    e.preventDefault();
    const text=v.input.value;
    if(await this._chatSend(v.roomId,text)) v.input.value='';
  },

  _chatViewMenu(v,at){
    const r=this._chatRoom(v.roomId);
    const items=[{id:'leave',icon:'x',label:t('chat.leave'),disabled:!(r&&r.joined),onClick:()=>this._chatLeave(v.roomId)}];
    // FR-PCH-86: 도우미가 있을 때만 강제 삭제를 보인다.
    if(r&&this._chatHelper()) items.push({sep:true},{id:'kill',icon:'trash',label:t('chat.kill'),danger:true,onClick:()=>this._chatKillAsk([v.roomId])});
    UIKit.menu(items,{at,cls:'chat-menu'});
  },

  /** 열린 뷰를 다시 그린다. `roomId` 가 있으면 그 방의 뷰만이다. 닫힌 탭의 뷰는 여기서 거둔다. */
  _chatViewsPaint(roomId){
    const live=this._chatLiveTabIds();
    for(const [key,v] of this._chatViewMap()){
      if(!live.has(v.tabId)){ this._chatViewMap().delete(key); continue }
      if(!roomId||v.roomId===roomId) this._chatViewPaint(v);
    }
  },

  _chatLiveTabIds(){
    const live=new Set();
    for(const s of this.ws.windows||[])
      for(const pn of panesOf(s&&s.layout)) for(const tab of pn.tabs||[]) if(tab.type===TAB_TYPE_CHAT) live.add(tab.id);
    return live;
  },

  /** 그 방의 탭이 화면에 붙어 보이는가 (안 읽은 수의 기준, §3.11). */
  _chatRoomShown(roomId){
    for(const v of this._chatViewMap().values()) if(v.roomId===roomId&&v.root.isConnected&&v.root.classList.contains('vis')) return true;
    return false;
  },

  _chatViewPaint(v){
    const r=this._chatRoom(v.roomId),me=this._chatMe(),meId=me&&me.id;
    if(r){
      v.title.textContent=chatRoomTitle(r,meId);
      v.kind.textContent=t(r.kind==='direct'?'chat.direct':'chat.group');
      v.purpose.textContent=r.purpose||'';
    }
    // FR-PCH-84·§3.11: 방이 사라졌거나 내가 들어 있지 않으면 입력칸을 막고 그 사실을 보인다.
    const why=!r?t('chat.gone'):!r.joined?t('chat.not_joined'):'';
    v.note.textContent=why;
    v.note.hidden=!why;
    v.input.disabled=!!why;
    this._chatPeoplePaint(v,r,meId);
    this._chatLogPaint(v,meId);
  },

  _chatPeoplePaint(v,r,meId){
    const people=(r&&r.people)||[];
    v.order=people.map(p=>p.id);
    const sel=v.sel||new Set();
    const sig=JSON.stringify([people.map(p=>[p.id,p.label,p.kind,p.online]),[...sel]]);
    if(sig===v.peopleSig) return;
    v.peopleSig=sig;
    const els=[chatEl('div','chat-sub-h',t('chat.people'))];
    for(const p of people){
      const row=chatEl('div','chat-person'+(p.online?'':' off')+(p.kind==='user'?' human':'')+(sel.has(p.id)?' sel':''));
      row.title=p.label+' · '+chatShortId(p.id);
      row.append(chatEl('span','chat-row-name',p.label),chatEl('span','chat-row-sub',(p.kind==='user'?t('chat.human')+' · ':'')+chatShortId(p.id)));
      row.addEventListener('click',e=>{
        if(this._chatPeoplePick(v,p.id,e)) return;
        if(p.id!==meId&&p.online) this._chatPersonMenu(p,{x:e.clientX,y:e.clientY});
      });
      row.addEventListener('contextmenu',e=>this._chatPersonCtx(v,p,e));
      els.push(row);
    }
    v.people.replaceChildren(...els);
  },

  /** 그린 글 뒤에 새 글만 붙인다. 앞이 잘렸으면(방별 상한) 다시 그린다. */
  _chatLogPaint(v,meId){
    const list=this._chatS().list(v.roomId);
    const same=v.drawn.length<=list.length&&v.drawn.every((m,i)=>m===list[i]);
    const atEnd=v.log.scrollHeight-v.log.scrollTop-v.log.clientHeight<4;
    if(!same){ v.log.replaceChildren(); v.drawn=[] }
    for(let i=v.drawn.length;i<list.length;i++){
      v.log.appendChild(this._chatMsgEl(list[i],meId));
      v.drawn.push(list[i]);
    }
    if(atEnd||!same) v.log.scrollTop=v.log.scrollHeight;
  },

  _chatMsgEl(m,meId){
    const mine=m.from&&m.from===meId;
    const d=chatEl('div','chat-msg'+(mine?' mine':'')+(m.fromKind==='user'?' human':''));
    const who=chatEl('div','chat-msg-who');
    const name=chatEl('span','chat-msg-name',m.fromLabel||chatShortId(m.from));
    if(!mine) name.addEventListener('contextmenu',e=>this._chatAuthorCtx(m,e));
    who.append(name,
      chatEl('span','chat-msg-meta',(m.fromKind==='user'?t('chat.human')+' · ':'')+chatShortId(m.from)+' · '+chatClock(m.at)));
    d.append(who,chatEl('div','chat-msg-text',m.text||''));
    return d;
  },
});

/** 글의 시각 `HH:MM`. */
function chatClock(ms){
  const d=new Date(ms||0);
  return String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0');
}
