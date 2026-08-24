# HTTP & WebSocket API

외부 통합용 공개 엔드포인트 정리. 내부 구현 세부는 [docs/internal/architecture.md](../internal/architecture.md) 참고.

용어는 [features.md](./features.md) 와 같다 — 창(Window) ▸ 분할 칸(Pane) ▸ 탭(Tab) ▸ 도구(Tool).

## REST

### 상태

| 메서드 | 경로 | 설명 |
|--------|------|------|
| GET | `/api/state` | `{ tools, workspace }` 스냅샷. 응답 헤더 `ETag: <rev>` 포함 |
| GET | `/api/whoami?toolId=<id>` | 요청자의 도구 식별 정보. `toolId` 생략 시 remoteAddr → PID 부모 체인으로 역추적 |
| GET | `/api/workspace` | workspace.json raw (`schemaVersion: 2`). ETag 헤더 포함 |
| PUT | `/api/workspace` | workspace 저장. `If-Match: <rev>` 로 낙관적 동시성 제어. stale 시 409 + 최신 `ETag` 반환 |
| GET | `/api/settings` | 설정 조회 |
| PUT | `/api/settings` | 설정 저장 (`settings.json` 즉시 영속화) |
| GET | `/api/stats` | `{ hostname, cpu, memUsed, memTotal, diskPct, sysUptime, srvUptime }` |
| GET | `/api/ping` | `"ok"` (레이턴시 측정용) |

### 도구

| 메서드 | 경로 | 설명 |
|--------|------|------|
| POST | `/api/tools?cols=&rows=&cwd=&cwdTool=` | 새 PTY 생성. `cwd` 또는 `cwdTool`(참조 도구 id) 중 하나로 시작 디렉터리 지정 |
| DELETE | `/api/tools/<id>` | PTY 종료 |
| GET | `/api/tools/<id>/busy` | `{ busy: bool }` — foreground process 여부 |
| GET | `/api/cwd?tool=<id>` | 해당 도구의 현재 작업 디렉터리. `tool` 생략 시 서버 프로세스 cwd |

### 주의 알림 · 활동

| 메서드 | 경로 | 설명 |
|--------|------|------|
| GET | `/api/tools/attention` | 주의 상태인 도구 목록 |
| POST | `/api/tools/attention/set` | 주의 상태 설정 (`dmctl notify` 가 사용) |
| POST | `/api/tools/attention/clear` | 도구 하나의 주의 상태 해제 |
| POST | `/api/tools/attention/clear-all` | 전체 해제 |
| GET | `/api/tools/activity` | 도구별 현재 활동 상태 (도구당 최신 1건) |
| POST | `/api/tools/activity/set` | 활동 상태 보고 (`dmctl activity` 가 사용) |

### 백그라운드 도구

| 메서드 | 경로 | 설명 |
|--------|------|------|
| GET | `/api/tools/background` | `{ background: [{toolId, name, cwd, since}] }` — 어느 탭에도 매이지 않고 도는 도구 |
| POST | `/api/tools/background/set` | 바디 `{toolId, background}`. 도구를 백그라운드로 보내거나 복귀시킨다. 미지 `toolId` 는 404 |

백그라운드 도구는 데몬 재시작을 넘기지 않는다 — `tools.json` 에는 탭이 참조하는 도구만 기록된다.

### 파일

| 메서드 | 경로 | 설명 |
|--------|------|------|
| POST | `/api/upload?dir=<path>` | multipart 업로드 (`file` 필드). 중복 파일은 `(1)`, `(2)` suffix. `{ name, size, path }` 반환 |
| GET | `/api/download?path=<path>` | 파일 다운로드 |
| GET | `/api/file/read?path=<abs>` | 편집기 탭이 파일을 읽는 경로. 절대경로만 허용 |
| POST | `/api/file/write` | 바디 `{path, content}`. 편집기 탭의 저장 |

### 원격 제어

| 메서드 | 경로 | 설명 |
|--------|------|------|
| POST | `/api/commands` | 워크스페이스 action 브로드캐스트. 바디 `{action, args?, reqId?}` — `dmctl`·`edit`·`detach` 가 사용 |
| GET | `/api/commands/sse` | Server-Sent Events. 브라우저가 구독해 다른 도구의 명령을 수신 |
| POST | `/api/command-result` | 브라우저가 생성 결과(`newWindows`/`newPanes`/`newTabs`)를 `reqId` 로 되돌려주는 경로 |

#### `/api/commands` 허용 action

20개. 그 외는 400.

| 분류 | action |
|------|--------|
| 생성 | `newWindow`, `newTab`, `splitH`, `splitV`, `openEditorTab` |
| 이동 | `focus`, `windowNext`, `windowPrev`, `tabNext`, `tabPrev`, `paneUp`, `paneDown`, `paneLeft`, `paneRight` |
| 종료 | `closeTab`, `closeWindow` |
| 이름 | `renameTab`, `renameWindow` |
| 백그라운드 | `detachTab`, `restoreTool` |

`args` 스키마 (전부 선택):

```json
{ "location": "<탭 uuid>", "count": 3, "keepFocus": true, "name": "worker-1",
  "filePath": "/abs/path", "toolId": "12" }
```

`location` 은 **uuid 만 허용**한다 — `dmctl list-workspace` 의 `uuid=` 컬럼 값. 좌표(`W4.P1.T1`)·라벨·`toolId` 는 400 으로 거부된다. 다른 창이 닫히면 좌표가 reflow 되어 엉뚱한 탭을 가리키기 때문이다. 서버가 broadcast 직전에 uuid → 좌표로 변환한다.

`detachTab` 은 `location` 이 아니라 `toolId` 를 받는다 — `toolId` 만으로 대상이 완전히 결정되므로 대상 지정 수단이 필요 없다. `restoreTool` 은 `toolId` 에 더해 `location`(선택)을 받는다: 지정하면 그 탭이 **속한 분할 칸**에 복귀하고(탭 성분은 무시), 없으면 브라우저가 현재 포커스한 분할 칸에 복귀한다.

둘 다 MCP `workspace_command` 로는 호출할 수 없다 (`toolId` 인자가 없어 `detach` CLI 전용 경로다).

## WebSocket: `/ws?tool=<id>`

Binary 프로토콜. 첫 바이트가 opcode.

| Opcode | 방향 | 페이로드 |
|--------|------|----------|
| `0x00` | S→C | 터미널 출력 (UTF-8 바이트) |
| `0x00` | C→S | 터미널 입력 |
| `0x01` | C→S | 리사이즈: `cols uint16 BE + rows uint16 BE` |
| `0x01` | S→C | 에러 메시지 (UTF-8) |
| `0x02` | S→C | 프로세스 종료 알림 |
| `0x03` | S→C | 도구 id 할당 (문자열). 연결 직후 서버가 보내고 브라우저가 `dataset.toolid` 에 반영 |

서버는 `gorilla/websocket` ping/pong 으로 keep-alive (pong 60s, ping 54s). 모든 쓰기는 `safeConn` mutex 로 직렬화.

## SSE: `/api/commands/sse`

`/api/commands` 로 들어온 action 을 구독 중인 모든 브라우저에 브로드캐스트. 15s 주기 keep-alive 주석. 브라우저가 여러 탭으로 열려 있으면 모두 동일 action 을 수행.

서버가 자체적으로 발행하는 이벤트도 같은 스트림을 쓴다:

| 이벤트 | 의미 |
|--------|------|
| `workspace_changed` | 다른 클라이언트가 워크스페이스를 바꿨다 |
| `tool_attention` | 도구가 주의를 요구한다 |
| `tool_attention_clear` | 주의 상태 해제 |
| `tool_activity` | 도구의 활동 상태 갱신 |

## MCP

| 경로 | 설명 |
|------|------|
| `/mcp/sse` | Claude Code MCP 클라이언트용 SSE 스트림. 세션 open 시 `sessionId=<hex>` 할당 |
| `/mcp/message?sessionId=<id>` | JSON-RPC 2.0 요청 POST 경로 |

툴 카탈로그 및 Claude Code 등록 방법은 [mcp-setup.md](./mcp-setup.md).

## OSC 777 커스텀 이스케이프

PTY 출력에서 브라우저로 특수 명령 전달. 형식은 `ESC ] 777 ; <cmd> ; <payload> BEL`.

| 시퀀스 | 발신자 | 설명 |
|--------|--------|------|
| `ESC]777;Download;<path>BEL` | `download` 헬퍼 | 브라우저 다운로드 트리거 (`/api/download`) |
| `ESC]777;Cwd;<path>BEL` | zsh/bash 훅 | 현재 디렉터리 실시간 보고 |
| `ESC]777;notify;<body>BEL` | 임의의 CLI·에이전트 | 주의 알림. 서버가 관찰해 `tool_attention` 으로 전환 |

서버는 스냅샷을 재생할 때 이 사설 시퀀스를 제거한다 (`stripOSC777`) — 새로고침 때 다운로드가 다시 트리거되는 것을 막기 위함이다.
