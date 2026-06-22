# 기능

## 세션 & 레이아웃

| 기능 | 설명 |
|------|------|
| 세션 관리 | 사이드바에서 세션 생성/삭제/전환, 더블클릭으로 이름 변경, 드래그로 순서 변경 |
| 탭 관리 | 각 Pane 마다 독립 탭 바, 탭 추가/삭제/전환, 드래그로 순서 변경 + 다른 pane 으로 이동·분할 |
| 분할 Pane | 가로/세로 분할, 드래그로 크기 조절, 비율 유지 |
| 레이아웃 프리셋 | 현재 분할 구조를 저장 → 설정에서 관리, 기본 프리셋 지정 → 사이드바 ★ 버튼으로 원클릭 생성 |
| cwd 상속 | 새 탭 / pane 분할 시 포커스된 pane 의 현재 디렉터리 상속. 새 세션은 `$HOME` 에서 시작 |
| 포커스 기억 | 세션 전환 시 이전에 포커스된 pane 복원. pane 삭제 시 인접 pane 으로 포커스 이동 |

분할·삭제 시 낙관적 UI 적용: 키 입력 → 레이아웃 즉시 반영 → 서버 상태 동기화는 백그라운드. 로컬호스트에서 체감 지연이 거의 없습니다.

## 터미널

| 기능 | 설명 |
|------|------|
| 한국어 IME | xterm.js Unicode11 addon, 로케일 설정 (`LANG=en_US.UTF-8`) |
| TUI 프로그램 | vim, htop, tmux 등 완벽 동작 |
| 터미널 검색 | `Ctrl+F` / `Cmd+F` → 검색 바, Enter/Shift+Enter 이동, 대소문자 구분 토글 |
| 링크 열기 | URL 자동 감지, 클릭 시 새 탭에서 열기 |
| Shift+Enter | `ESC + CR` (iTerm 관례) 로 전송 |
| 파일 업로드 | 터미널에 파일 드래그앤드롭 → pane 의 현재 cwd 에 저장. 중복 시 `(1)`, `(2)` 자동 넘버링. 업로드 종료 시 CR 전송 → 쉘 프롬프트 자동 갱신 |
| 파일 다운로드 | `download <path>` 명령 → 브라우저 다운로드 |
| 자동 재연결 | 연결 끊김 시 지수 백오프(1s→30s), 오버레이 표시, 복원 시 버퍼 리플레이 |
| 종료 확인 | pane/탭/세션 닫을 때 foreground 프로세스 감지 → 경고 다이얼로그 (Enter=확인 / ESC=취소) |

## code-server 연동 (원격 VSCode)

pane 에서 `edit <path>` 실행 → 서버가 `code-server` 를 Unix 소켓 모드로 스폰, 브라우저가 `/cs/<id>/` 리버스 프록시를 새 창으로 오픈.

- 하트비트 10s 주기로 서버에 heartbeat → 30s 미수신 시 서버가 인스턴스 kill.
- 창 닫힘 감지 1s 주기 → `/api/code-server/stop?id=...` 자동 호출.
- 동일 서버에 여러 인스턴스 공존, id 별 격리된 `user-data-dir`/`extensions-dir`.
- `edit -l` 로 인스턴스 목록, `edit -s <id|all>` 로 종료.

요구: 서버 호스트에 `code-server` 바이너리가 `PATH` 에 있어야 합니다. 사용법 상세는 [commands.md](./commands.md).

## 원격 제어 CLI (`dmctl`)

pane 내부에서 실행해 브라우저 워크스페이스를 HTTP 로 직접 제어:

```bash
dmctl new-session                    # 새 세션
dmctl split-h 3                      # 가로 3 분할
dmctl focus S1.P2.T1                 # 위치 이동
dmctl new-tab --at 2.1.1 --no-focus  # 특정 위치에 탭, 포커스 유지
```

상세는 [commands.md](./commands.md).

## 상태 표시줄

하단 상태 바에서 실시간 정보 표시. 설정에서 항목 토글·갱신 주기 변경 가능.

| 항목 | 설명 | 기본 |
|------|------|------|
| 연결 상태 | 🟢/🔴 + 연결됨/끊김 | ✅ |
| 레이턴시 | `/api/ping` RTT (ms) | ✅ |
| 현재 디렉터리 | 셸 훅으로 실시간 감지 (OSC 777 `Cwd;`) | ✅ |
| 메모리 | 사용량/전체 | ✅ |
| CPU | 서버 CPU 사용률 | ❌ |
| 호스트명 | 서버 이름 | ❌ |
| 디스크 | 루트 볼륨 사용률 | ❌ |
| 터미널 크기 | cols × rows | ❌ |
| 업타임 | 시스템 + 서버 프로그램 | ❌ |
| Pane 라벨 | `📍 S1.P2.T1` — MCP/dmctl 대상 지정용 | ✅ |

## 주의 알림 (Pane Attention)

pane 안에서 실행 중인 **임의의 에이전트/CLI**(Claude Code, Codex, Gemini, 빌드 스크립트 등)가 작업을 끝냈거나 입력을 기다리는 상태가 되면, 그 pane 을 보고 있지 않아도 알아챌 수 있게 알린다. **터미널 출력 감시 기반이라 에이전트 종류·설정과 무관(zero-config)** 하게 동작한다.

- **감지** (서버, 관찰 전용):
  - 표준 알림 이스케이프 시퀀스 `OSC 9` / `OSC 99`(kitty) / `OSC 777;notify` 를 출력 스트림에서 감지.
  - 출력이 한동안 흐르다 멎으면(idle) 감지 — 기본 임계값 `DONGMINAL_ATTENTION_IDLE_MS`(기본 10000ms, `0` 이면 비활성).
  - 단독 터미널 벨(BEL)은 노이즈가 커 기본 비활성 — `DONGMINAL_ATTENTION_BELL=1` 로 켜기.
  - 터미널 출력 바이트는 변형하지 않음(표시 동작 무변경).
- **표시** (브라우저):
  - 주의가 필요한 pane 의 **탭/리전을 포커스와 구분되는 강조색(`--attn`, 호박색)** 으로 표시. 지금 보고 있는(포커스+활성) 탭은 강조하지 않음.
  - 상단 🔔 배지 + 클릭 시 **주의 pane 모아보기(notification center)** — 항목 클릭하면 그 pane 으로 이동.
  - 브라우저 탭 제목에 개수 배지(`(2) Terminal`).
  - 선택: 데스크톱 알림(Web Notification, 권한 필요)·사운드. 설정 → Notifications 에서 토글(브라우저별 저장).
- **해제**: 해당 pane 을 포커스/클릭하거나 입력을 보내면 자동 해제(다른 브라우저에도 전파).

## 에이전트 활동 모아보기 (Agent Activity Panel)

여러 pane 에서 동시에 도는 에이전트가 **지금 무엇을 하는지**를, 터미널 화면을 일일이 열지 않고 우측 패널에 카드로 모아 본다. 각 카드는 "현재 이 순간" 상태 하나만 보여준다(작업 중/완료/대기, 무슨 툴·명령어·파일).

- **열기**: 상단 툴바의 **Agents** 버튼(Split V 옆) 또는 단축키(기본 `Ctrl+Shift+A`, 설정 → Shortcuts 에서 변경). 우측 접이식 패널이 열리며, 핸들로 너비 조절. 헤더에 새로고침·닫기 버튼. 열림/너비는 브라우저별로 저장.
- **카드**: pane 위치(세션·탭), 상태(글꼴 기호 + 테마 색으로 구분: `●` 작업 중 / `✓` 완료 / `…` 입력 대기 / `○` 멈춤), 툴 라벨, 명령어/파일 **원문**(로컬·본인용이라 마스킹하지 않음). 최근 갱신된 카드가 맨 위. 카드를 클릭하면 그 pane 으로 바로 이동. 포커스 중인 pane 의 카드는 강조 표시.
- **자동 새로고침**: 패널이 열려 있으면 주기적으로 서버 상태와 동기화(비정상 종료·hook 누락 보정). 주기는 설정 → Notifications 에서 변경. 에이전트/pane 이 종료되면 카드가 사라진다.
- **알람 통합**: 그 pane 에 주의 알림이 떠 있으면 카드에도 알람 강조(`--attn`)가 함께 표시된다. 클릭하면 이동하면서 알람도 해제.
- **에이전트별 충실도** (설정 영구 수정 없이 per-invocation 주입):
  - **Claude Code**: `PreToolUse` 로 "무슨 툴·명령어/파일"까지 실시간 표시(가장 풍부).
  - **Codex**: 턴 완료(`done`)만 — 표준 notify 가 turn-complete 만 주기 때문(명령어 단위 표시는 후속).
  - **그 외**(gemini 등): 명시 신호가 없어 출력 활동 기반 작업 중/멈춤만 추정.

## 테마

21 개 프리셋 + 커스텀 테마 편집기.

Tokyo Night, Dracula, One Dark, Nord, Catppuccin, Solarized Dark, Monokai, GitHub Dark, Material Ocean, Material Palenight, Ayu Dark, Gruvbox Dark, Rosé Pine, Night Owl, Cobalt², Shades of Purple, Horizon, Doom One, Everforest, Kanagawa, Synthwave '84.

커스텀 테마: UI 10색 + 터미널 20색을 컬러 피커로 개별 조정. 모든 UI 요소(사이드바, 탭, 검색 바, 상태 표시줄)에 CSS 변수 기반 일괄 적용. 스크롤바는 `--text-dim`/hover 시 `--text-muted` 로 가시성 보장.

## 파일 영속성

`DONGMINAL_HOME` (기본 `~/.dongminal`) 아래에 저장:

| 파일/디렉터리 | 설명 | 재시작 시 |
|---------------|------|-----------|
| `settings.json` | 테마·단축키·프리셋·상태 바·사이드바 너비 | 유지 |
| `workspace.json` | 세션/탭/분할 구조 (비동기 latest-wins 쓰기) | 유지 |
| `panes/<id>.json` | 각 pane 의 cwd 스냅샷 | 유지 |
| `bin/` | 런타임 헬퍼 스크립트 (서버 기동 시 재배포) | 덮어쓰기 |

PTY 프로세스 자체는 서버 메모리에만 존재 → 서버 재시작 시 초기화. 브라우저 새로고침은 서버 버퍼로부터 복원 (bufMax 1 MiB, 오래된 바이트는 드롭되며 `dropped_bytes` 관측 가능).

## 부가 CLI (자동 배포)

서버 시작 시 `$DONGMINAL_HOME/bin/` 아래 자동 생성. pane 은 이 경로가 `PATH` 에 들어간 상태로 스폰되므로 별도 설정이 필요 없습니다.

| 파일 | 용도 |
|------|------|
| `bin/dmctl` | 워크스페이스 원격 제어 (분할/탭/포커스/세션) |
| `bin/edit` | code-server 인스턴스 열기/조회/종료 |
| `bin/download` | `download <path>` → OSC 777 로 브라우저 다운로드 트리거 |
| `bin/zdotdir/.zshrc` | zsh cwd 훅 (상태 바의 현재 디렉터리용). `~/.zshrc` 를 먼저 source 후 `precmd`/`chpwd` 훅 추가 |
| `bin/bash-hook.sh` | bash cwd 훅. `BASH_ENV` 로 자동 로드 |

외부 터미널에서 `dmctl`/`edit` 를 쓰려면 해당 쉘에서 `export PATH="$DONGMINAL_HOME/bin:$PATH"` + `export DONGMINAL_PORT=<포트>` 를 수동 설정.
