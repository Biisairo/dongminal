// 메인 패널의 `채팅` 탭 서술자 (CHAT_WINDOW_SRS FR-CW-20·22, 사용자 결정 D-7).
//
// 서술자만 둔다 — 그리기와 창 다루기는 `chat-window.js`(`ChatWindow`) 다. 이 파일은 `sidebar-tabs.js` **앞**에
// 로드된다: 그 파일이 배열을 세우는 순간 직행 키(`Ctrl+Shift+Digit3`)를 파생하기 때문이다.

const CHAT_TAB_ID='chat';
const CHAT_PANEL_ID='sb-panel-chat';

const SB_CHAT_TAB={
  id:CHAT_TAB_ID,label:t('chat.title'),icon:'messages-square',panelId:CHAT_PANEL_ID,
  title:'Chat rooms and people online',
  // PEER_CHAT_SRS FR-PCH-81 → FR-CW-20: 배지는 지금 있는 방의 안 읽은 수의 합이다.
  badge:app=>app.chat.chatUnreadTotal?app.chat.chatUnreadTotal():0,
  // FR-CW-22: 탭을 고르면 콘텐츠가 채팅 창으로 바뀐다 (FR-SBT-22). FR-CW-50: 모바일은 바꾸지 않는다 —
  // 창이 바뀌면 서랍이 닫혀 방 목록이 사라진다. 모바일은 방을 누를 때 채팅 창으로 간다.
  onActivate:app=>{if(!app.isMobile&&app.chat.window.chatWindowOpen)app.chat.window.chatWindowOpen()},
  onEnter:app=>{if(app.chat.window.chatPanelRender)app.chat.window.chatPanelRender()},
};
