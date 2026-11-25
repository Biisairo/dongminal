/**
 * Otterminal — 채팅 창 열기와 방 탭 (CHAT_WINDOW_SRS FR-CW-3·12·22·31, PERF 3.4.12.10). `chat` 묶음이다.
 *
 * 부팅의 `ChatWindow`(`chat-window.js`) 원형에 창 만들기·열기·방 탭 열고 닫기를 바꿔 단다. 부팅 껍데기의 자리표시는 이
 * 묶음을 실은 뒤 여기로 넘긴다(`Screens.call`). 불러온 창 목록의 정리와 채팅 목록 그리기는 부팅에 남는다.
 */
Object.assign(ChatWindow.prototype,{

  /** FR-CW-3: 없으면 칸 없는 채팅 창을 만든다. 저장은 부르는 쪽이 한다. */
  chatWindowEnsure(){
    const w=this.chatWindow();
    if(w) return w;
    const nw={id:newEntityId(),name:t('chat.window_name'),type:WINDOW_TYPE_CHAT,layout:null};
    this.app.ws.windows.push(nw);
    return nw;
  },

  /** FR-CW-22: `채팅` 탭을 고르면 채팅 창으로 간다. */
  chatWindowOpen(){
    const w=this.chatWindowEnsure();
    if(this.app.ws.activeWindow===w.id){ this.app.render(); return w }
    this.app.layout.switchWindow(w.id);
    return w;
  },

  /** FR-CW-12: 방 하나 = 탭 하나. 있으면 그 탭으로, 없으면 채팅 창에 연다. 채팅 창이 활성이 된다. */
  _chatOpenTab(id){
    const r=this.app.chat._chatRoom(id),me=this.app.chat._chatMe();
    const w=this.chatWindowEnsure();
    const found=findTabWhere([w],tab=>tab.type===TAB_TYPE_CHAT&&tab.roomId===id);
    if(found) this.app.layout.tabAdd._revealTab(found);
    else{
      // 창을 먼저 바꾼다 — `switchWindow` 는 떠나는 창의 포커스 칸을 지금 `focused` 로 적는다.
      if(this.app.ws.activeWindow!==w.id) this.app.layout.switchWindow(w.id);
      const pn=this._chatPaneOf(w);
      this.app.layout.tabAdd._pushTab(w,pn,{id:newEntityId(),name:clampEntityName(r?chatRoomTitle(r,me&&me.id):'Chat'),type:TAB_TYPE_CHAT,roomId:id},true);
    }
    this.app.render();
    this.app.wsSave.save();
    // PANEL_TEMPLATE_SRS FR-PNT-15 · FR-CW-50: 방을 열었으면 모바일의 시트·서랍을 닫는다.
    if(this.app.mobile.nav.actSheetLeave) this.app.mobile.nav.actSheetLeave();
    if(this.app.isMobile&&this.app.drawerOpen) this.app.mobile._toggleDrawer(false);
  },

  /** FR-CW-31: 나간 방의 탭을 닫는다. */
  _chatCloseRoomTabs(roomId){
    const w=this.chatWindow();
    if(!w||!w.layout) return;
    for(const p of panesOf(w.layout).slice())
      for(const tab of (p.tabs||[]).slice())
        if(tab.type===TAB_TYPE_CHAT&&tab.roomId===roomId) this.app.layout.tabOps.closeTab(p.id,tab.id,w.id);
  },
});
