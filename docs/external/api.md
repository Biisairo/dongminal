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

### 에이전트 접합면

`dmctl read-screen`/`read-output`/`send-input`/`msg` 의 백엔드다. 개념과 사용법은
[agent-orchestration.md](./agent-orchestration.md).

| 메서드 | 경로 | 설명 |
|--------|------|------|
| GET | `/api/tools/output?id=&bytes=&strip=` | 도구의 스크롤백. `strip=1` 이면 ANSI 제거. `bytes<=0`/생략이면 전체 (기본값 판단은 `dmctl` 몫). `{ toolId, text, dropped }` |
| POST | `/api/tools/input` | `{ id, text, execute }` — bracketed paste 로 주입, `execute` 면 자동 엔터 |
| POST | `/api/tools/message` | `{ to, from, message }` — 신뢰 봉투로 감싸 주입 + 자동 엔터. `from` 이 비면 `unknown`. 응답의 `from`/`to` 는 정규화된 라벨 |

`id`/`to` 는 tab uuid·`toolId`·라벨 모두 받는다. 대상이 없으면 404 `{ "error": … }`.

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

### 창 포커스 소유권

한 Window 를 어느 클라이언트가 보고 있는지를 서버가 들고 있다. 이 상태는 dim 표시와
**PTY 리사이즈 권한**을 함께 결정한다 — 소유자만 그 Window 의 PTY 크기를 정한다.

| 메서드 | 경로 | 설명 |
|--------|------|------|
| GET | `/api/focus` | `{ owners: { "<windowId>": "<clientId>" } }` — 현재 소유권 스냅샷 |
| POST | `/api/focus/claim` | 바디 `{clientId, windowId}`. 그 클라이언트를 소유자로 만든다. 둘 중 하나라도 비면 400 |

- **last-focus-wins**: 기존 소유자는 협상 없이 밀려난다. 한 클라이언트는 동시에 한 Window 만 소유한다
- **in-memory**: 영속화하지 않는다. 서버 재시작이면 전원 해제다
- **해제**: `/api/commands/sse?clientId=<id>` 구독이 끊기면 그 클라이언트의 소유권을 **즉시** 해제한다. grace period 는 없다. 같은 `clientId` 의 더 새로운 구독이 있으면 옛 구독의 종료는 해제하지 않는다
- 소유권이 없는 Window 는 모두에게 밝게 보이고 모두가 리사이즈할 수 있다

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

`detachTab` 은 `location` 이 아니라 `toolId` 를 받는다 — `toolId` 만으로 대상이 완전히 결정되므로 대상 지정 수단이 필요 없다. `restoreTool` 은 `toolId` 에 더해 `location`(선택)을 받는다: 지정하면 그 탭이 **속한 분할 칸**에 복귀하고(탭 성분은 무시), 그 분할 칸이 사라졌으면 복귀하지 않는다(도구는 백그라운드 목록에 남는다). `location` 을 생략하면 브라우저가 현재 포커스한 분할 칸에 복귀하며, 포커스가 해소되지 않으면 활성 창의 첫 분할 칸으로 폴백한다 — 생략 경로는 조용히 무효가 되지 않는다.

둘 다 `dmctl` 의 레이아웃 서브커맨드로는 호출할 수 없다 — `detach` CLI 전용 경로다.

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

`?clientId=<id>` 를 붙이면 서버가 그 구독을 클라이언트와 결선한다 — 구독이 끊길 때 창 포커스 소유권을 해제하기 위한 것이다. 생략해도 스트림은 정상 동작한다 (소유권 결선만 없다).

서버가 자체적으로 발행하는 이벤트도 같은 스트림을 쓴다:

| 이벤트 | 의미 |
|--------|------|
| `workspace_changed` | 다른 클라이언트가 워크스페이스를 바꿨다 |
| `tool_attention` | 도구가 주의를 요구한다 |
| `tool_attention_clear` | 주의 상태 해제 |
| `tool_activity` | 도구의 활동 상태 갱신 |
| `window_focus` | 창 포커스 소유권이 바뀌었다. `args.owners` 는 **전체 맵**이다 (증분이 아니다) |

## OSC 777 커스텀 이스케이프

PTY 출력에서 브라우저로 특수 명령 전달. 형식은 `ESC ] 777 ; <cmd> ; <payload> BEL`.

| 시퀀스 | 발신자 | 설명 |
|--------|--------|------|
| `ESC]777;Download;<path>BEL` | `download` 헬퍼 | 브라우저 다운로드 트리거 (`/api/download`) |
| `ESC]777;Cwd;<path>BEL` | zsh/bash 훅 | 현재 디렉터리 실시간 보고 |
| `ESC]777;notify;<body>BEL` | 임의의 CLI·에이전트 | 주의 알림. 서버가 관찰해 `tool_attention` 으로 전환 |

서버는 스냅샷을 재생할 때 이 사설 시퀀스를 제거한다 (`stripOSC777`) — 새로고침 때 다운로드가 다시 트리거되는 것을 막기 위함이다.
