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
| PUT | `/api/workspace` | workspace 저장. `If-Match: <rev>` 로 낙관적 동시성 제어. stale 시 409 + 최신 `ETag` 반환 |
| GET | `/api/settings` | 설정 조회 |
| PUT | `/api/settings` | 설정 저장 (`settings.json` 영속화) |
| GET | `/api/stats` | `{ hostname, cpu, memUsed, memTotal, diskPct, sysUptime, srvUptime }` |
| GET | `/api/cwd?pane=<id>` | 해당 pane 의 현재 작업 디렉터리. `pane` 생략 시 서버 프로세스 cwd |
| GET | `/api/ping` | `"ok"` (레이턴시 측정용) |
| POST | `/api/upload?dir=<path>` | multipart 업로드 (`file` 필드). 중복 파일은 `(1)`, `(2)` suffix. `{ name, size, path }` 반환 |
| GET | `/api/download?path=<path>` | 파일 다운로드 (절대/상대경로 모두 허용) |
| GET | `/api/code-server` | 열린 code-server 인스턴스 목록 `[{id, folder, createdAt, ...}]` |
| POST | `/api/code-server?path=<path>` | code-server 인스턴스 새로 열기. `{ id, path: "/cs/<id>/", folder }` 반환 |
| POST | `/api/code-server/heartbeat?id=<id>` | 창이 살아 있음을 알림 (30s 미수신 시 서버가 kill) |
| POST | `/api/code-server/stop?id=<id>` | 인스턴스 종료 |
| POST | `/api/commands` | 워크스페이스 action 브로드캐스트. 바디 `{action, args?}` — `dmctl` 가 사용 |
| GET | `/api/commands/sse` | Server-Sent Events. 브라우저가 구독해 다른 pane 의 `dmctl` 명령을 수신 |

### `/api/commands` 허용 action

`newSession`, `newTab`, `splitH`, `splitV`, `focus`, `closeTab`, `closeSession`, `sessionNext`, `sessionPrev`, `tabNext`, `tabPrev`, `paneUp`, `paneDown`, `paneLeft`, `paneRight`. 그 외는 400.

args 스키마 (optional):

```json
{ "location": "S1.P2.T1", "count": 3, "keepFocus": true }
```

### 리버스 프록시

`/cs/<id>/...` — 해당 id 의 code-server Unix 소켓으로 HTTP/WebSocket 프록시.

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

서버는 `gorilla/websocket` ping/pong 으로 keep-alive (pong 60s, ping 54s). 모든 쓰기는 `safeConn` mutex 로 직렬화.

## SSE: `/api/commands/sse`

`/api/commands` 로 들어온 action 을 구독 중인 모든 브라우저에 브로드캐스트. 15s 주기 keep-alive 주석. 브라우저가 여러 탭으로 열려 있으면 모두 동일 action 을 수행.

## MCP

| 경로 | 설명 |
|------|------|
| `/mcp/sse` | Claude Code MCP 클라이언트용 SSE 스트림. 세션 open 시 `session=<hex>` 할당 |
| `/mcp/message?session=<id>` | JSON-RPC 2.0 요청 POST 경로 |

툴 카탈로그 및 Claude Code 등록 방법은 [mcp-setup.md](./mcp-setup.md).

## OSC 777 커스텀 이스케이프

PTY 출력에서 브라우저로 특수 명령 전달:

| 시퀀스 | 발신자 | 설명 |
|--------|--------|------|
| `ESC]777;Download;<path>BEL` | `download` 스크립트 | 브라우저 다운로드 트리거 (`/api/download`) |
| `ESC]777;Cwd;<path>BEL` | zsh/bash 훅 | 현재 디렉터리 실시간 보고 |
| `ESC]777;OpenCodeServer;<id>\|<path>\|<folder>BEL` | `edit` 스크립트 | code-server 새 창 열기 (`window.open('/cs/<id>/...')`) |
| `ESC]777;CodeServerList;<json>BEL` | `edit -l` | 열린 code-server 목록을 터미널에 렌더링 |
