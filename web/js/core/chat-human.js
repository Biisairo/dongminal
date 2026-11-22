/**
 * 사람 명령 — 강제 삭제·강퇴의 고르기·메뉴·확인 창 (PEER_CHAT_SRS §3.12, FR-PCH-86·87).
 *
 * 도우미가 없으면(`GET /api/chat` 의 `helper` 가 거짓) 메뉴를 보이지 않고 고르기도 하지 않는다.
 * 고르기는 Chats 의 방 목록과 채팅 탭마다의 참가자 목록에 따로 있고 화면 메모리에만 둔다.
 * 코드는 매번 받는다 — 도우미가 묶음 전체에 서명 하나를 붙인다 (FR-PCH-71).
 *
 * `ChatHuman` 은 `ChatController` 의 부품이다(`chat.human`, REFACTOR3_FE_APPCTL_SRS 9c). 고르기 상태(`_chatRoomsSel`)와
 * 방 순서(`_chatRoomOrder`)는 뿌리가 든다.
 *
 * 로드 순서 계약: `chat-views.js` 뒤.
 */

/**
 * 목록 고르기 한 번. Cmd(Ctrl)는 하나를 더하고 빼고, Shift 는 anchor 부터 id 까지 고른다.
 * 수식키가 없으면 고르기를 지우고 `handled` 가 거짓이다 — 부르는 쪽이 보통 동작을 한다.
 */
function chatPick(sel,anchor,order,id,e){
  if(e.metaKey||e.ctrlKey){
    if(sel.has(id)) sel.delete(id); else sel.add(id);
    return {anchor:id,handled:true};
  }
  if(e.shiftKey){
    const a=order.indexOf(anchor),b=order.indexOf(id);
    if(a<0||b<0){ sel.add(id); return {anchor:id,handled:true} }
    for(let i=Math.min(a,b);i<=Math.max(a,b);i++) sel.add(order[i]);
    return {anchor,handled:true};
  }
  sel.clear();
  return {anchor:id,handled:false};
}

/** 우클릭 대상: 그 줄이 고른 것 가운데 하나면 고른 것 모두(목록 순서), 아니면 그 줄 하나. */
function chatCtxTargets(sel,id,order){
  if(!sel.has(id)) return [id];
  const out=order.filter(x=>sel.has(x));
  return out.length?out:[id];
}

/** FR-PCH-87: 확인 창의 할 일과 대상 전체. */
function chatCmdText(op,names){
  return t(op==='kill'?'chat.kill_what':'chat.kick_what',{n:names.length,list:names.join(', ')});
}

class ChatHuman extends Controller {
  _chatHelper(){ return !!(this.app._chat&&this.app._chat.helper) }

  _chatRoomSel(){
    if(!this.app.chat._chatRoomsSel) this.app.chat._chatRoomsSel={sel:new Set(),anchor:null};
    return this.app.chat._chatRoomsSel;
  }

  /** Chats 방 줄의 클릭. 고르기로 처리했으면 참이다. */
  _chatRoomPick(id,e){
    if(!this._chatHelper()) return false;
    const s=this._chatRoomSel(),had=s.sel.size>0;
    const r=chatPick(s.sel,s.anchor,this.app.chat._chatRoomOrder||[],id,e);
    s.anchor=r.anchor;
    if((r.handled||had)&&this.app.chat.window._chatRepaint) this.app.chat.window._chatRepaint();
    return r.handled;
  }

  /** FR-PCH-86: Chats 방 줄 우클릭 → 강제 삭제. */
  _chatRoomCtx(id,e){
    const r=this.app.chat._chatRoom(id);
    if(!this._chatHelper()&&!(r&&r.joined)) return;
    e.preventDefault();
    this._chatRoomMenu(id,{x:e.clientX,y:e.clientY});
  }

  /**
   * CHAT_WINDOW_SRS FR-CW-23·30 (D-22): 방 행의 메뉴 — 나가기(들어간 방), 도우미가 있으면 강제 삭제.
   * 강제 삭제의 대상은 종전대로 고른 방들이다(FR-PCH-86).
   */
  _chatRoomMenu(id,at){
    const r=this.app.chat._chatRoom(id),items=[];
    if(r&&r.joined) items.push({id:'leave',icon:'x',label:t('chat.leave'),onClick:()=>this.app.chat._chatLeave(id)});
    if(this._chatHelper()){
      const ids=chatCtxTargets(this._chatRoomSel().sel,id,this.app.chat._chatRoomOrder||[id]);
      if(items.length) items.push({sep:true});
      items.push({id:'kill',icon:'trash',label:t('chat.kill'),danger:true,onClick:()=>this._chatKillAsk(ids)});
    }
    if(items.length) UIKit.menu(items,{at,cls:'chat-menu'});
  }

  /** 채팅 탭 참가자 줄의 클릭. 고르기로 처리했으면 참이다. */
  _chatPeoplePick(v,id,e){
    if(!this._chatHelper()) return false;
    if(!v.sel) v.sel=new Set();
    const had=v.sel.size>0;
    const r=chatPick(v.sel,v.anchor,v.order||[],id,e);
    v.anchor=r.anchor;
    if(r.handled||had) this.app.chat.views._chatViewPaint(v);
    return r.handled;
  }

  /** 강퇴 대상: 고르기 규칙을 따르되 내 사람 참가자는 뺀다. */
  _chatKickTargets(v,pid){
    const me=this.app.chat._chatMe(),meId=me&&me.id;
    return chatCtxTargets(v.sel||new Set(),pid,v.order||[pid]).filter(id=>id!==meId).map(id=>({room:v.roomId,participant:id}));
  }

  /** FR-PCH-86: 참가자 줄 우클릭 → 강퇴. */
  _chatPersonCtx(v,p,e){
    if(!this._chatHelper()) return;
    const kicks=this._chatKickTargets(v,p.id);
    if(!kicks.length) return;
    e.preventDefault();
    UIKit.menu([{id:'kick',icon:'minus',label:t('chat.kick'),danger:true,onClick:()=>this._chatKickAsk(kicks)}],{at:{x:e.clientX,y:e.clientY},cls:'chat-menu'});
  }

  /** FR-PCH-86: 대화 속 보낸 이 이름 우클릭 → 그 참가자 하나 강퇴. */
  _chatAuthorCtx(m,e){
    this._chatPersonCtx({roomId:m.room},{id:m.from},e);
  }

  _chatKillAsk(ids){
    const me=this.app.chat._chatMe(),meId=me&&me.id;
    const names=ids.map(id=>{ const r=this.app.chat._chatRoom(id); return '#'+(r?chatRoomTitle(r,meId):chatShortId(id)) });
    return this._chatCmdAsk('kill',{rooms:ids},chatCmdText('kill',names));
  }

  _chatKickAsk(kicks){
    const names=kicks.map(k=>{
      const r=this.app.chat._chatRoom(k.room),p=r&&(r.people||[]).find(x=>x.id===k.participant);
      return (p?p.label+' ':'')+chatShortId(k.participant);
    });
    return this._chatCmdAsk('kick',{kicks},chatCmdText('kick',names));
  }

  /**
   * FR-PCH-87: 확인 창. 틀린 코드는 창을 닫지 않고 그 자리에 다시 넣게 하고, 잠겼으면 풀리는
   * 시각을 보인다. 맞으면 닫고 고르기를 지운다.
   */
  async _chatCmdAsk(op,body,what){
    const box=domEl('div','chat-create chat-cmd');
    const title=domEl('div','chat-create-title',t('chat.cmd_title'));
    const code=domEl('input','sbx-input chat-cmd-code');
    code.autocomplete='one-time-code';
    code.maxLength=CHAT_CODE_MAX;
    const note=domEl('div','chat-note chat-cmd-note');
    note.hidden=true;
    box.append(title,domEl('div','chat-cmd-what',what),UIKit.field({label:t('chat.cmd_code'),control:code}),domEl('div','chat-cmd-hint',t('chat.cmd_hint')),note);
    let finish=()=>{},busy=false;
    const say=text=>{ note.textContent=text; note.hidden=false };
    const submit=async()=>{
      const c=code.value.trim();
      if(!c||busy) return;
      busy=true;
      const r=await apiPost('/api/chat/'+op,Object.assign({},body,{code:c}));
      busy=false;
      if(r.ok){ finish(true); return }
      const ec=r.data&&r.data.code;
      if(ec==='chat_bad_code'){ say(t('chat.cmd_bad_code')); code.value=''; code.focus(); return }
      if(ec==='chat_locked'){ const at=Date.parse(r.data.message); say(t('chat.cmd_locked',{time:Number.isNaN(at)?'?':chatClock(at)})); return }
      Toast.show(apiErrText(r,t('chat.err_cmd')),'err');
      finish(false);
    };
    code.addEventListener('keydown',e=>{ if(e.key==='Enter'&&!e.isComposing){ e.preventDefault(); submit() } });
    const ok=await UIKit.ask({body:box,labelledBy:title,label:t('chat.cmd_title'),focus:code,escValue:false,
      onOpen:(m,done)=>{ finish=done },
      actions:[
        {label:t('chat.cmd_run'),kind:'danger',cls:'confirm-ok',tip:TIP_CHAT_CMD_RUN,keepOpen:true,default:true,onClick:()=>submit()},
        {label:t('core.cancel'),cls:'confirm-cancel',tip:TIP_CHAT_CMD_CANCEL,value:false},
      ]});
    if(ok!==true) return false;
    this._chatRoomSel().sel.clear();
    for(const v of this.app.chat.views._chatViewMap().values()) if(v.sel) v.sel.clear();
    await this.app.chat._chatRestore();
    return true;
  }
}

/** 코드 칸의 글자 상한 — 복구 코드 `xxxxx-xxxxx` 의 길이다. */
const CHAT_CODE_MAX=11;
