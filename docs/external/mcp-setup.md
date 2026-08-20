# Claude Code MCP 연동

Dongminal 은 내장 MCP (Model Context Protocol) SSE 서버를 `/mcp/sse` 엔드포인트로 노출합니다. Claude Code 에 등록하면 Claude 가 열린 도구 목록을 조회하고 터미널에 입력을 보내고 출력을 읽을 수 있습니다.

## 설치

```bash
./scripts/install-mcp.sh                 # 기본 포트(8080)로 등록
PORT=58146 ./scripts/install-mcp.sh      # 다른 포트로 등록
./scripts/install-mcp.sh status          # 등록 상태 확인 (claude mcp list)
./scripts/install-mcp.sh uninstall       # 해제
```

스크립트 동작:

1. `claude` CLI 존재 확인. 없으면 수동 등록용 JSON 예시를 출력하고 종료.
2. 동일 이름(`dongminal`)이 이미 user 스코프에 등록돼 있으면 조용히 제거.
3. `claude mcp add --transport sse -s user dongminal http://localhost:<PORT>/mcp/sse` 실행.
4. `claude mcp list` 로 등록 확인.

`install-mcp.sh` 의 기본값은 `PORT=8080` 이므로, `start.sh`(기본 58146) 로 서버를 띄웠다면 `PORT=58146 ./scripts/install-mcp.sh` 로 맞춰 등록해야 합니다.

등록은 user 스코프(`~/.claude.json`) 에 SSE 전송으로 추가됩니다. 수동으로 등록하려면:

```json
"mcpServers": {
  "dongminal": {
    "type": "sse",
    "url": "http://localhost:58146/mcp/sse"
  }
}
```

## 사용

1. Dongminal 서버 실행 중인지 확인.
2. Claude Code 를 새로 시작 → `/mcp` 로 `dongminal` 연결 확인.
3. 화면 하단의 라벨(예: `📍 W1.P2.T3`)을 Claude 에 알려주면 해당 탭을 타깃.

## 제공 MCP 툴

| 툴 | 역할 |
|----|------|
| `list_workspace` | 현재 창/분할 칸/탭/도구 구조 조회 (라벨·toolId 포함) |
| `read_screen` | 특정 도구의 현재 화면 스냅샷 |
| `read_output` | 특정 도구의 출력 버퍼 (바이트 수 지정) |
| `send_input` | 도구에 문자열 입력 (Enter 여부 선택) |
| `send_agent_message` | 봉투 프로토콜로 다른 Claude 에이전트에게 메시지 |
| `who_am_i` | 호출 중인 Claude 가 어느 탭에 붙어 있는지 |
| `workspace_command` | 브라우저 UI 동작(splitH/splitV/closeTab 등) 원격 트리거 — `dmctl` 과 동일 백엔드 |

툴 7 종 모두 JSON 스키마는 `tools/list` 로 조회 가능. 도구 식별은 uuid(권장)·toolId·라벨 어느 형식이든 받습니다.

## dmctl 과의 차이

`workspace_command` MCP 툴과 `/api/commands` (dmctl 이 호출) 는 동일한 브로드캐스트 버스를 공유합니다. 차이는 호출 주체뿐:

- `dmctl` → 터미널 안에서 사람/스크립트가 직접 실행.
- `workspace_command` → Claude Code (또는 다른 MCP 클라이언트) 가 원격 호출.

## 라벨 체계

`W<창번호>.P<분할칸번호>.T<탭번호>` 형식. 사이드바 창 순서와 분할 순서에 따라 자동 부여. 예: `W1.P2.T1` = 첫 번째 창의 두 번째 분할 칸의 첫 번째 탭.

Claude 에 `W1.P2.T1 에서 ls 실행해줘` 식으로 지시하면 MCP 로 해당 도구에 입력이 전달됩니다.
