/**
 * Otterminal — 채팅 창 (CHAT_WINDOW_SRS FR-CW-1~31, 사용자 결정 D-7·D-CW-1~6).
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
 * PERF 3.4.12.10 (D-47): 이 파일은 부팅 껍데기다. 불러온 창 목록의 정리(`_chatNormalize`, 부팅 때 부른다)와 채팅 목록
 * 그리기는 여기 있고, 창 열기·방 탭의 본체는 `chat` 묶음의 `chat-window-open.js` 가 이 원형에 바꿔 단다. 채팅 목록은 묶음이
 * 실린 뒤에 그린다 — 목록의 행이 사람 명령(`ChatHuman`, 같은 묶음)을 동기로 부른다.
 *
 * 로드 순서 계약: `chat-controller.js` 뒤.
 */

/** FR-CW-14: 채팅 창 밖의 채팅 탭을 닫았을 때 남기는 경고. */
const CHAT_STRAY_WARN='[chat] closed {n} chat tab(s) outside the chat window (CHAT_WINDOW_SRS FR-CW-14)';

class ChatWindow extends Controller {
  /** FR-CW-2: 워크스페이스의 채팅 창. 없으면 null. */
  chatWindow(){ return this.app.ws.windows.find(s=>this.app.git.isChatWin(s))||null }

  /** FR-CW-12: 탭을 놓을 칸 — 포커스 칸, 없으면 첫 칸, 칸이 없으면 새 칸이다. */
  _chatPaneOf(w){
    const f=w.focusedPane&&findPane(w.layout,w.focusedPane);
    if(f) return f;
    const first=w.layout&&firstPane(w.layout);
    if(first) return first;
    w.layout={type:'pane',id:newEntityId(),tabs:[],activeTab:null};
    return w.layout;
  }

  /**
   * FR-CW-2·14: 불러온 창 목록을 정리한다. 채팅 창이 여럿이면 첫 창으로 합치고(같은 방은 버린다),
   * 채팅 창 밖의 채팅 탭은 닫는다. 바꾼 수를 돌려준다 — 칸·창의 붕괴는 부르는 쪽의 필터가 한다.
   */
  _chatNormalize(list){
    if(!Array.isArray(list)) return 0;
    const chats=list.filter(s=>this.app.git.isChatWin(s));
    const keep=chats[0]||null;
    let n=0,stray=0;
    const rooms=new Set();
    if(keep&&keep.layout) for(const p of panesOf(keep.layout)) for(const tab of p.tabs||[]) rooms.add(tab.roomId);
    for(const extra of chats.slice(1)){
      if(extra.layout) for(const p of panesOf(extra.layout)) for(const tab of p.tabs||[]){
        if(tab.type!==TAB_TYPE_CHAT||rooms.has(tab.roomId)) continue;
        rooms.add(tab.roomId);
        this.app.layout.tabAdd._pushTab(keep,this._chatPaneOf(keep),tab,false);
      }
      list.splice(list.indexOf(extra),1);
      n++;
    }
    for(const s of list){
      if(!s||!s.layout||this.app.git.isChatWin(s)) continue;
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
    if(!Screens.ready('chat')){ Screens.load('chat').then(()=>this.chatPanelRender(),()=>{}); return }
    const items=this.app.chat._chatItems();
    if(!items.length) items.push({id:'empty',el:domEl('div','ui-empty chat-none',t('chat.empty'))});
    reconcileList(host,items,{key:it=>it.id,sig:it=>it.el.outerHTML,build:it=>it.el});
  }

  chatWindowOpen(...a){ return Screens.call('chat',this,'chatWindowOpen',a) }
  _chatOpenTab(...a){ return Screens.call('chat',this,'_chatOpenTab',a) }
  _chatCloseRoomTabs(...a){ return Screens.call('chat',this,'_chatCloseRoomTabs',a) }
}
