// Package toolhub는 PTY 도구 레지스트리(ToolManager)와 브라우저 WebSocket
// 접합면, 그리고 주의 알림 탐지(OSC/idle)를 담는다.
//
// 레지스트리는 dongminald(데몬)가 PTY 를 소유하며 실행한다. dongminal(웹 서버)은 그 표면
// (ToolHub)과 프레임 규약·주의 판정 도우미를 쓴다. 그래서 shared/ 에 있다
// (DIRECT_MODE_REMOVAL_SRS — 웹 서버가 레지스트리를 직접 들던 직접 모드는 없다).
//
// 의존은 shared/outbuf, shared/uuid, shared/platform, gorilla/websocket 뿐이다.
// webserver/** 와 daemon/** 를 import 하지 않는다 (FR-SPL-6).
package toolhub
