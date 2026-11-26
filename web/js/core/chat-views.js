/**
 * 채팅 탭 — 방 하나의 대화 (PEER_CHAT_SRS §3.11, FR-PCH-84·85).
 *
 * 위에 방 이름·목적·종류와 `⋯` 메뉴, 가운데 대화, 아래 입력칸, 오른쪽 참가자 목록이다.
 * 뷰는 `slotKey(탭 id, 칸)` 마다 하나이고 탭보다 오래 살지 않는다 (`runViewEl` 과 같은 규약).
 * 대화는 `ChatStore` 에만 있다 — 새로고침하면 사라진다.
 *
 * 망에서 온 문자열은 `textContent` 로 그린다. 글 본문만 마크다운이며 `chatMdFragment`(원시 HTML 끔 · DOMPurify)를 지난다
 * (ISSUE_TREE_CHAT_SRS FR-CUX-8). 보낸 이 묶음·날짜 구분선·부른 글 표시는 `chat-log.js` 가 정한다 (FR-CUX-1~7).
 *
 * `ChatViews` 는 `ChatController` 의 부품이다(`chat.views`, REFACTOR3_FE_APPCTL_SRS 9c). 옛 `ui/chat-view.js` 는 App 의
 * 내부(`this.app._chat*`)를 부르므로 계층 게이트(`check-layer.sh`)에 맞춰 `core/` 로 옮겼다.
 *
 * `chat` 화면 묶음이다 (PERF 3.4.9). 부팅 코드는 `app.chat.views` 로만 닿고, 그 값은 묶음이 실리기 전에는 null 이다.
 *
 * 로드 순서 계약: `chat-controller.js` 뒤.
 */

class ChatViews extends Controller {
  _chatViewMap(){
    if(!this._chatViews) this._chatViews=new Map();
    return this._chatViews;
  }

  /** renderer._mountTabBody 가 부른다. 루트 DOM 은 탭과 칸의 쌍마다 하나이며 재사용된다. */
  chatViewEl(tab,slot){
    const m=this._chatViewMap();
    const key=this.app.slot.slotKey(tab.id,slot||0);
    let v=m.get(key);
    if(!v){
      v=this._chatViewBuild(key,tab);
      // 생명주기 계약 (PERF M3 §3.5) — 뷰가 탭 본문의 주인이다.
      v.lifeKind='ChatView'; v.wake=()=>this._chatViewWake(v); v.sleep=()=>this._chatViewSleep(v);
      m.set(key,v);
    }
    v.roomId=tab.roomId;
    this._chatViewPaint(v);
    // 탭이 보였다 — 그 방의 안 읽은 수가 0 이 된다. 패널은 그리는 중이 아닐 때 다시 그린다.
    // ISSUE_TREE_CHAT_SRS FR-CAL-16: 알람도 함께 꺼진다 — 방 탭의 표식은 다음 그리기에서 빠진다.
    if(this.app.chat._chatS().read(v.roomId)) TIMERS.defer(()=>{if(this.app.chat.window._chatRepaint)this.app.chat.window._chatRepaint();this.app.render?.()},{owner:this.app,label:'chat-read'});
    return v.root;
  }

  /** 렌더러가 생명주기에 넘길 그 탭·칸의 뷰 (`chatViewEl` 뒤에 부른다). */
  chatViewOwner(tab,slot){ return this._chatViewMap().get(this.app.slot.slotKey(tab.id,slot||0))||null }

  /**
   * PERF M3 §3.5 (FR-SPA-3): 잠든 뷰는 다시 그리지 않는다. 그동안 온 변화는 표시만 해 두고 깰 때 한 번 그린다.
   *   이전: 가려진 채팅 탭도 방이 바뀔 때마다 다시 그렸다
   *   새:   가려지고 2초 뒤 잠들면 그리기가 0 이고, 깰 때 밀린 것을 한 번 그린다
   *   이유: 잠든 화면은 그리기를 하지 않는다
   */
  _chatViewSleep(v){ v.asleep=true }

  _chatViewWake(v){
    v.asleep=false;
    if(!v.stale) return;
    v.stale=false;
    this._chatViewPaint(v);
  }

  _chatViewBuild(key,tab){
    const root=domEl('div','chat-view');
    const head=domEl('div','chat-head');
    const title=domEl('span','chat-title');
    const kind=domEl('span','chat-kind ui-badge');
    const purpose=domEl('span','chat-purpose');
    const v={key,tabId:tab.id,roomId:tab.roomId,root,title,kind,purpose,drawn:[],peopleSig:''};
    // EDGE_MESH_SRS FR-EGM-56: 개인채팅 상대 노드가 간선이 아닌 온라인 망 이웃이면 간선 초대를 보낸다.
    v.invite=UIKit.button({label:t('edge.invite_send'),kind:'ghost',size:'sm',cls:'chat-edge-invite',
      title:TIP_EDGE_INVITE_SEND,onClick:e=>{e.stopPropagation();if(v.invitePeer) this.app.edges._egInviteSend(v.invitePeer)}});
    v.invite.hidden=true;
    head.append(title,kind,purpose,v.invite,UIKit.button({icon:'ellipsis',title:TIP_CHAT_ROOM_ACTIONS,kind:'ghost',size:'sm',cls:'chat-more',
      onClick:e=>{e.stopPropagation();const r=e.currentTarget.getBoundingClientRect();this._chatViewMenu(v,{x:r.left,y:r.bottom})}}));
    const main=domEl('div','chat-main');
    v.log=document.createElement('div');
    v.log.className='chat-log ui-scroll';
    v.people=document.createElement('div');
    v.people.className='chat-people ui-scroll';
    main.append(v.log,v.people);
    const foot=domEl('div','chat-foot');
    v.note=domEl('div','chat-note');
    v.input=domEl('textarea','chat-input');
    v.input.rows=2;
    v.input.placeholder=t('chat.input_ph');
    v.input.addEventListener('keydown',e=>this._chatViewKey(v,e));
    foot.append(v.note,v.input);
    root.append(head,main,foot);
    return v;
  }

  /** Enter 는 보내고 Shift+Enter 는 줄을 바꾼다. 한글 조합 중의 Enter 는 조합을 끝낼 뿐이다. */
  async _chatViewKey(v,e){
    if(e.key!=='Enter'||e.shiftKey||e.isComposing) return;
    e.preventDefault();
    const text=v.input.value;
    if(await this.app.chat._chatSend(v.roomId,text)) v.input.value='';
  }

  _chatViewMenu(v,at){
    const r=this.app.chat._chatRoom(v.roomId);
    const items=[{id:'leave',icon:'log-out',label:t('chat.leave'),disabled:!(r&&r.joined),onClick:()=>this.app.chat._chatLeave(v.roomId)}];
    // FR-PCH-86: 도우미가 있을 때만 강제 삭제를 보인다.
    if(r&&this.app.chat.human._chatHelper()) items.push({sep:true},{id:'kill',icon:'trash-2',label:t('chat.kill'),danger:true,onClick:()=>this.app.chat.human._chatKillAsk([v.roomId])});
    UIKit.menu(items,{at,cls:'chat-menu'});
  }

  /** 열린 뷰를 다시 그린다. `roomId` 가 있으면 그 방의 뷰만이다. 닫힌 탭의 뷰는 여기서 거둔다. */
  _chatViewsPaint(roomId){
    const live=this._chatLiveTabIds();
    for(const [key,v] of this._chatViewMap()){
      if(!live.has(v.tabId)){ this.app.renderer.life.unmount(v); this._chatViewMap().delete(key); continue }
      if(roomId&&v.roomId!==roomId) continue;
      if(v.asleep){ v.stale=true; continue }
      this._chatViewPaint(v);
    }
  }

  _chatLiveTabIds(){
    const live=new Set();
    for(const s of this.app.ws.windows||[])
      for(const pn of panesOf(s&&s.layout)) for(const tab of pn.tabs||[]) if(tab.type===TAB_TYPE_CHAT) live.add(tab.id);
    return live;
  }

  /** 그 방의 탭이 화면에 붙어 보이는가 (안 읽은 수의 기준, §3.11). */
  _chatRoomShown(roomId){
    for(const v of this._chatViewMap().values()) if(v.roomId===roomId&&v.root.isConnected&&v.root.classList.contains('vis')) return true;
    return false;
  }

  _chatViewPaint(v){
    const r=this.app.chat._chatRoom(v.roomId),me=this.app.chat._chatMe(),meId=me&&me.id;
    if(r){
      v.title.textContent=chatRoomTitle(r,meId);
      v.kind.textContent=t(r.kind==='direct'?'chat.direct':'chat.group');
      v.purpose.textContent=r.purpose||'';
    }
    v.invitePeer=meshDirectPeer(r,meId,this.app._edges&&this.app._edges.mesh);
    v.invite.hidden=!v.invitePeer;
    // FR-PCH-84·§3.11: 방이 사라졌거나 내가 들어 있지 않으면 입력칸을 막고 그 사실을 보인다.
    const why=!r?t('chat.gone'):!r.joined?t('chat.not_joined'):'';
    v.note.textContent=why;
    v.note.hidden=!why;
    v.input.disabled=!!why;
    this._chatPeoplePaint(v,r,meId);
    this._chatLogPaint(v,meId);
  }

  _chatPeoplePaint(v,r,meId){
    const people=(r&&r.people)||[];
    v.order=people.map(p=>p.id);
    const sel=v.sel||new Set();
    const sig=JSON.stringify([people.map(p=>[p.id,p.label,p.kind,p.online]),[...sel]]);
    if(sig===v.peopleSig) return;
    v.peopleSig=sig;
    const els=[domEl('div','chat-sub-h',t('chat.people'))];
    for(const p of people){
      const row=domEl('div','chat-person'+(p.online?'':' off')+(p.kind==='user'?' human':'')+(sel.has(p.id)?' sel':''));
      row.title=p.label+' · '+chatShortId(p.id);
      row.append(domEl('span','chat-row-name',chatName(p.label,p.id,meId)),domEl('span','chat-row-sub',(p.kind==='user'?t('chat.human')+' · ':'')+chatShortId(p.id)));
      row.addEventListener('click',e=>{
        if(this.app.chat.human._chatPeoplePick(v,p.id,e)) return;
        if(p.id!==meId&&p.online) this.app.chat._chatPersonMenu(p,{x:e.clientX,y:e.clientY});
      });
      row.addEventListener('contextmenu',e=>this.app.chat.human._chatPersonCtx(v,p,e));
      els.push(row);
    }
    v.people.replaceChildren(...els);
  }

  /** 그린 글 뒤에 새 글만 붙인다. 앞이 잘렸으면(방별 상한) 다시 그린다. */
  _chatLogPaint(v,meId){
    const list=this.app.chat._chatS().list(v.roomId);
    const r=this.app.chat._chatRoom(v.roomId),people=(r&&r.people)||[];
    const same=v.drawn.length<=list.length&&v.drawn.every((m,i)=>m===list[i]);
    const atEnd=v.log.scrollHeight-v.log.scrollTop-v.log.clientHeight<4;
    if(!same){ v.log.replaceChildren(); v.drawn=[] }
    for(let i=v.drawn.length;i<list.length;i++){
      const m=list[i],place=chatMsgPlace(v.drawn[i-1]||null,m);
      if(place.day) v.log.appendChild(domEl('div','chat-day',chatDayLabel(m.at)));
      v.log.appendChild(this._chatMsgEl(m,meId,place,people));
      v.drawn.push(m);
    }
    if(atEnd||!same) v.log.scrollTop=v.log.scrollHeight;
  }

  _chatMsgEl(m,meId,place,people){
    const mine=m.from&&m.from===meId,human=m.fromKind==='user';
    const d=domEl('div','chat-msg'+(mine?' mine':'')+(human?' human':'')+(place.head?' head':'')+(m.called?' called':''));
    if(place.head){
      const label=chatName(m.fromLabel,m.from,meId);
      const who=domEl('div','chat-msg-who');
      const name=domEl('span','chat-msg-name',label);
      name.title=(m.fromLabel||label)+' · '+chatShortId(m.from);
      d.style.setProperty('--chat-c','var('+chatColorVar(m.from,meId)+')');
      if(!mine) name.addEventListener('contextmenu',e=>this.app.chat.human._chatAuthorCtx(m,e));
      who.append(domEl('span','chat-avatar',chatInitial(label)),name,
        domEl('span','chat-msg-kind',t(human?'chat.human':'chat.agent')),domEl('span','chat-msg-meta',chatClock(m.at)));
      d.append(who);
    }
    const tags=chatCallTags(m,meId,people);
    if(tags.length) d.append(domEl('div','chat-msg-call',tags.join(' ')));
    const body=domEl('div','chat-msg-text');
    if(chatMdReady()){ body.classList.add('chat-md'); body.append(chatMdFragment(m.text)) }
    else body.textContent=m.text||'';
    d.append(body);
    return d;
  }
}
