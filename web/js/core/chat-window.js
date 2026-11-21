/**
 * Dongminal — 채팅 창 (CHAT_WINDOW_SRS FR-CW-1~31, 사용자 결정 D-7·D-CW-1~6).
 *
 * 채팅은 창 종류 `chat` 하나에 산다. 그 안은 일반 창처럼 칸과 탭이고, 탭 하나가 방 하나다.
 * 칸의 규칙은 Repo 창과 같다 — 칸이 0 이어도 창이 남고, 분할은 탭 끌어 놓기로만 한다.
 *
 *   이전 동작: 채팅 목록은 작업 패널의 Chats 탭, 채팅 탭은 활성 창의 포커스 칸에 열렸다
 *   새  동작: 목록은 메인 패널의 `채팅` 탭, 탭은 채팅 창에만 선다
 *   이유:     채팅이 자기 화면을 갖는다 (D-7). PEER_CHAT_SRS D-PCH-31 을 대체한다
 *
 * `ChatWindow` 는 `ChatController` 의 부품이다(`chat.window`, REFACTOR3_FE_APPCTL_SRS 9c).
 *
 * 로드 순서 계약: `chat-controller.js` 뒤.
 */

/** FR-CW-14: 채팅 창 밖의 채팅 탭을 닫았을 때 남기는 경고. */
const CHAT_STRAY_WARN='[chat] closed {n} chat tab(s) outside the chat window (CHAT_WINDOW_SRS FR-CW-14)';

class ChatWindow extends Controller {
  /** FR-CW-2: 워크스페이스의 채팅 창. 없으면 null. */
  chatWindow(){ return this.app.ws.windows.find(s=>this.app.isChatWin(s))||null }

  /** FR-CW-3: 없으면 칸 없는 채팅 창을 만든다. 저장은 부르는 쪽이 한다. */
  chatWindowEnsure(){
    const w=this.chatWindow();
    if(w) return w;
    const nw={id:newEntityId(),name:t('chat.window_name'),type:WINDOW_TYPE_CHAT,layout:null};
    this.app.ws.windows.push(nw);
    return nw;
  }

  /** FR-CW-22: `채팅` 탭을 고르면 채팅 창으로 간다. */
  chatWindowOpen(){
    const w=this.chatWindowEnsure();
    if(this.app.ws.activeWindow===w.id){ this.app.render(); return w }
    this.app.switchWindow(w.id);
    return w;
  }

  /** FR-CW-12: 탭을 놓을 칸 — 포커스 칸, 없으면 첫 칸, 칸이 없으면 새 칸이다. */
  _chatPaneOf(w){
    const f=w.focusedPane&&findPane(w.layout,w.focusedPane);
    if(f) return f;
    const first=w.layout&&firstPane(w.layout);
    if(first) return first;
    w.layout={type:'pane',id:newEntityId(),tabs:[],activeTab:null};
    return w.layout;
  }

  /** FR-CW-12: 방 하나 = 탭 하나. 있으면 그 탭으로, 없으면 채팅 창에 연다. 채팅 창이 활성이 된다. */
  _chatOpenTab(id){
    const r=this.app.chat._chatRoom(id),me=this.app.chat._chatMe();
    const w=this.chatWindowEnsure();
    const found=findTabWhere([w],tab=>tab.type===TAB_TYPE_CHAT&&tab.roomId===id);
    if(found) this.app._revealTab(found);
    else{
      // 창을 먼저 바꾼다 — `switchWindow` 는 떠나는 창의 포커스 칸을 지금 `focused` 로 적는다.
      if(this.app.ws.activeWindow!==w.id) this.app.switchWindow(w.id);
      const pn=this._chatPaneOf(w);
      this.app._pushTab(w,pn,{id:newEntityId(),name:clampEntityName(r?chatRoomTitle(r,me&&me.id):'Chat'),type:TAB_TYPE_CHAT,roomId:id},true);
    }
    this.app.render();
    this.app.save();
    // PANEL_TEMPLATE_SRS FR-PNT-15 · FR-CW-50: 방을 열었으면 모바일의 시트·서랍을 닫는다.
    if(this.app.actSheetLeave) this.app.actSheetLeave();
    if(this.app.isMobile&&this.app.drawerOpen) this.app._toggleDrawer(false);
  }

  /** FR-CW-31: 나간 방의 탭을 닫는다. */
  _chatCloseRoomTabs(roomId){
    const w=this.chatWindow();
    if(!w||!w.layout) return;
    for(const p of panesOf(w.layout).slice())
      for(const tab of (p.tabs||[]).slice())
        if(tab.type===TAB_TYPE_CHAT&&tab.roomId===roomId) this.app.closeTab(p.id,tab.id,w.id);
  }

  /**
   * FR-CW-2·14: 불러온 창 목록을 정리한다. 채팅 창이 여럿이면 첫 창으로 합치고(같은 방은 버린다),
   * 채팅 창 밖의 채팅 탭은 닫는다. 바꾼 수를 돌려준다 — 칸·창의 붕괴는 부르는 쪽의 필터가 한다.
   */
  _chatNormalize(list){
    if(!Array.isArray(list)) return 0;
    const chats=list.filter(s=>this.app.isChatWin(s));
    const keep=chats[0]||null;
    let n=0,stray=0;
    const rooms=new Set();
    if(keep&&keep.layout) for(const p of panesOf(keep.layout)) for(const tab of p.tabs||[]) rooms.add(tab.roomId);
    for(const extra of chats.slice(1)){
      if(extra.layout) for(const p of panesOf(extra.layout)) for(const tab of p.tabs||[]){
        if(tab.type!==TAB_TYPE_CHAT||rooms.has(tab.roomId)) continue;
        rooms.add(tab.roomId);
        this.app._pushTab(keep,this._chatPaneOf(keep),tab,false);
      }
      list.splice(list.indexOf(extra),1);
      n++;
    }
    for(const s of list){
      if(!s||!s.layout||this.app.isChatWin(s)) continue;
      for(const p of panesOf(s.layout)){
        const before=(p.tabs||[]).length;
        p.tabs=(p.tabs||[]).filter(tab=>!tab||tab.type!==TAB_TYPE_CHAT);
        stray+=before-p.tabs.length;
        if(!p.tabs.find(tab=>tab.id===p.activeTab)) p.activeTab=p.tabs.length?p.tabs[0].id:null;
      }
      for(const p of panesOf(s.layout)) if(!p.tabs.length) s.layout=doRemove(s.layout,p.id);
    }
    if(stray) console.warn(CHAT_STRAY_WARN.replace('{n}',String(stray)));
    return n+stray;
  }

  // ── 메인 패널의 `채팅` 탭 (FR-CW-21) ──────────────────────────

  /** 채팅 목록과 탭 배지를 다시 그린다. 채팅 상태가 바뀌는 자리가 부른다. */
  _chatRepaint(){
    this.chatPanelRender();
    if(this.app._sbUpdateBadges) this.app._sbUpdateBadges();
  }

  chatPanelRender(){
    const host=document.getElementById('chat-list');
    if(!host||this.app.sbTab!==CHAT_TAB_ID) return;
    const items=this.app._chatItems();
    if(!items.length) items.push({id:'empty',el:domEl('div','ui-empty chat-none',t('chat.empty'))});
    reconcileList(host,items,{key:it=>it.id,sig:it=>it.el.outerHTML,build:it=>it.el});
  }
}

// `ui/sidebar-tab-chat.js`·창 정규화(`layout-window-state.js`)·시험이 App 에서 부르는 이름 (FR-FEA-4).
Controller.delegate(App,'chat.window',['chatWindowOpen','_chatNormalize','_chatRepaint','chatPanelRender']);
