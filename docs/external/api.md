# HTTP & WebSocket API

외부 통합용 공개 엔드포인트 정리. 내부 구현 세부는 [docs/internal/architecture.md](../internal/architecture.md) 참고.

## REST

| 메서드 | 경로 | 설명 |
|--------|------|------|
| GET | `/api/state` | `{ panes, workspace }` 스냅샷. 응답 헤더 `ETag: <rev>` 포함 |
| POST | `/api/panes?cols=&rows=&cwd=&cwdPane=` | 새 PTY 생성. `cwd` 또는 `cwdPane`(참조 pane ID) 중 하나로 시작 디렉터리 지정 |
| DELETE | `/api/panes/:id` | PTY 종료 |
| GET | `/api/panes/:id/busy` | `{ busy: bool }` — foreground process 여부 |
| GET | `/api/workspace` | workspace.json raw. ETag 헤더 포함 |
| PUT | `/api/workspace` | workspace 저장. `If-Match: <rev>` 로 낙관적 동시성 제어. stale 시 409 |
| GET | `/api/settings` | 설정 조회 |
| PUT | `/api/settings` | 설정 저장 (`settings.json` 영속화) |
| GET | `/api/stats` | `{ hostname, cpu, memUsed, memTotal, diskPct, sysUptime, srvUptime }` |
| GET | `/api/cwd?pane=<id>` | 해당 pane 의 현재 작업 디렉터리 |
| GET | `/api/ping` | `"ok"` (레이턴시 측정용) |
| POST | `/api/upload?dir=<path>` | multipart 업로드. 중복 파일은 `(1)`, `(2)` suffix |
| GET | `/api/download?path=<path>` | 파일 다운로드 |
| GET | `/api/code-server` | 열린 code-server 인스턴스 목록 |
| POST | `/api/code-server?path=<path>` | code-server 인스턴스 새로 열기 |
| POST | `/api/code-server/stop?id=<id>` | 인스턴스 종료 |

## WebSocket: `/ws?pane=<id>`

Binary 프로토콜. 첫 바이트가 opcode.

| Opcode | 방향 | 페이로드 |
|--------|------|----------|
| `0x00` | S→C | 터미널 출력 (UTF-8 바이트) |
| `0x00` | C→S | 터미널 입력 |
| `0x01` | C→S | 리사이즈: `cols uint16 BE + rows uint16 BE` |
| `0x01` | S→C | 에러 메시지 (UTF-8) |
| `0x02` | S→C | 프로세스 종료 알림 |
| `0x03` | S→C | 세션 ID 할당 (문자열) |

## SSE: `/events`

서버 측 이벤트 브로드캐스트 (워크스페이스 명령, code-server 상태 등). `Accept: text/event-stream`.

## MCP: `/mcp/sse`

JSON-RPC 2.0 over SSE. Claude Code MCP 클라이언트 연결용. 툴 카탈로그는 [mcp-setup.md](./mcp-setup.md) 참고.

## OSC 777 커스텀 이스케이프

PTY 출력에서 브라우저로 특수 명령 전달:

| 시퀀스 | 설명 |
|--------|------|
| `ESC]777;Download;<path>BEL` | 브라우저 다운로드 트리거 |
| `ESC]777;Cwd;<path>BEL` | 현재 디렉터리 실시간 보고 |
| `ESC]777;OpenCodeServer;<id>\|<path>\|<folder>BEL` | code-server 새 창 열기 |
| `ESC]777;CodeServerList;<json>BEL` | 열린 code-server 목록 표시 |
