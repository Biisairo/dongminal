// Package toolhub는 PTY 도구 레지스트리(ToolManager)와 브라우저 WebSocket
// 접합면, 그리고 주의 알림 탐지(OSC/idle)를 담는다.
//
// 두 프로세스가 이 코드를 실행한다 — dongminald(데몬)는 PTY 를 소유하기 위해,
// dongminal(웹 서버)은 데몬 없이 도는 직접 모드를 위해. 그래서 shared/ 에 있다.
//
// 의존은 shared/outbuf, shared/uuid, creack/pty, gorilla/websocket 뿐이다.
// webserver/** 와 daemon/** 를 import 하지 않는다 (FR-SPL-6).
package toolhub
