# 기능

## 창 & 레이아웃

| 기능 | 설명 |
|------|------|
| 창 관리 | 사이드바에서 창 생성/삭제/전환, 더블클릭으로 이름 변경, 드래그로 순서 변경 |
| 탭 관리 | 각 분할 칸마다 독립 탭 바, 탭 추가/삭제/전환, 드래그로 순서 변경 + 다른 분할 칸으로 이동·분할 |
| 분할 칸 | 가로/세로 분할, 드래그로 크기 조절, 비율 유지 |
| 레이아웃 프리셋 | 현재 분할 구조를 저장 → 설정에서 관리, 기본 프리셋 지정 → 사이드바 ★ 버튼으로 원클릭 생성 |
| cwd 상속 | 새 탭 / 분할 시 포커스된 도구의 현재 디렉터리 상속. 새 창은 `$HOME` 에서 시작 |
| 포커스 기억 | 창 전환 시 이전에 포커스된 분할 칸 복원. 분할 칸 삭제 시 인접 분할 칸으로 포커스 이동 |

분할·삭제 시 낙관적 UI 적용: 키 입력 → 레이아웃 즉시 반영 → 서버 상태 동기화는 백그라운드. 로컬호스트에서 체감 지연이 거의 없습니다.

## 터미널

| 기능 | 설명 |
|------|------|
| 한국어 IME | xterm.js Unicode11 addon, 로케일 설정 (`LANG=en_US.UTF-8`) |
| TUI 프로그램 | vim, htop, tmux 등 완벽 동작 |
| 터미널 검색 | `Ctrl+F` / `Cmd+F` → 검색 바, Enter/Shift+Enter 이동, 대소문자 구분 토글 |
| 링크 열기 | URL 자동 감지, 클릭 시 새 탭에서 열기 |
| Shift+Enter | `ESC + CR` (iTerm 관례) 로 전송 |
| 파일 업로드 | 터미널에 파일 드래그앤드롭 → 그 도구의 현재 cwd 에 저장. 중복 시 `(1)`, `(2)` 자동 넘버링. 업로드 종료 시 CR 전송 → 쉘 프롬프트 자동 갱신 |
| 파일 다운로드 | `download <path>` 명령 → 브라우저 다운로드 |
| 자동 재연결 | 연결 끊김 시 지수 백오프(1s→30s), 오버레이 표시, 복원 시 버퍼 리플레이 |
| 종료 확인 | 분할 칸/탭/창 닫을 때 foreground 프로세스 감지 → 경고 다이얼로그 (Enter=확인 / ESC=취소 / **백그라운드로**) |

## 파일 편집기

터미널에서 `edit <path>` 실행 → 현재 분할 칸에 편집기 탭이 열린다. Monaco Editor 기반이며 확장자로 언어를 판별한다.

- 저장은 `POST /api/file/write`, 읽기는 `GET /api/file/read`. 절대경로만 허용한다.
- 편집기 탭은 백그라운드로 보낼 수 없다 (`backgroundCapable=false`) — 탭을 닫으면 그대로 닫힌다.
- Monaco 자산은 CDN 에서 로드하므로 이 탭만 네트워크 접근이 필요하다.

과거에는 `code-server`(원격 VSCode)를 서브프로세스로 띄우고 `/cs/<id>/` 로 프록시했으나, 내장 편집기로 대체되며 제거됐습니다.

## 백그라운드 도구

tmux 의 detach 처럼, 탭을 닫아도 도구를 계속 돌게 할 수 있다.

- 창(Window)은 서버에 영속되므로 **아무 브라우저가 보지 않아도 도구는 계속 돈다**. 별도 조작이 필요 없다.
- 탭을 닫으면 기본적으로 도구가 **종료**된다. 계속 돌리려면 명시적으로 백그라운드로 보낸다.
  - 터미널에서 `detach` — 그 도구를 백그라운드로 보내고 탭을 닫는다.
  - 실행 중인 프로세스가 있어 종료 확인창이 떴을 때 **백그라운드로** 버튼.
- 백그라운드 도구가 1개 이상이면 상태 바에 `⏻ <개수>` 배지가 뜬다. 클릭하면 목록이 열리고, 항목을 클릭하면 현재 분할 칸의 새 탭으로 복귀한다. `detach --list` / `detach --restore <id>` 도 같은 경로다.
- **데몬을 재시작하면 백그라운드 도구는 복원되지 않는다.** 복원해도 돌던 작업이 아니라 같은 cwd 의 빈 셸이 되살아날 뿐이므로, 되살리지 않는 쪽이 고아 프로세스 누적을 원리적으로 막는다.
- 터미널만 백그라운드로 갈 수 있다. 편집기 탭은 대상이 아니다.

이름이 `bg` 가 아닌 이유: `bg` 는 zsh/bash 의 작업 제어 빌트인이다.

## 원격 제어 CLI (`dmctl`)

터미널 안에서 실행해 브라우저 워크스페이스를 HTTP 로 직접 제어:

```bash
dmctl new-window                       # 새 창
dmctl split-h 3                        # 가로 3 분할
dmctl list-workspace                   # 열린 도구 목록 (uuid 포함)
dmctl focus <uuid>                     # 위치 이동 — uuid 만 허용
dmctl new-tab --at <uuid> --no-focus   # 특정 위치에 탭, 포커스 유지
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
| 현재 위치 | `📍 W1.P2.T1` — MCP/dmctl 대상 지정용 | ✅ |
| 백그라운드 도구 | `⏻ <개수>` — 1개 이상일 때만 표시. 클릭 시 목록 팝오버 | 자동 |

## 주의 알림 (Tool Attention)

터미널 안에서 실행 중인 **임의의 에이전트/CLI**(Claude Code, Codex, Gemini, 빌드 스크립트 등)가 작업을 끝냈거나 입력을 기다리는 상태가 되면, 그 도구를 보고 있지 않아도 알아챌 수 있게 알린다. **터미널 출력 감시 기반이라 에이전트 종류·설정과 무관(zero-config)** 하게 동작한다.

- **감지** (서버, 관찰 전용):
  - 표준 알림 이스케이프 시퀀스 `OSC 9` / `OSC 99`(kitty) / `OSC 777;notify` 를 출력 스트림에서 감지.
  - 출력이 한동안 흐르다 멎으면(idle) 감지 — 기본 임계값 `DONGMINAL_ATTENTION_IDLE_MS`(기본 10000ms, `0` 이면 비활성).
  - 단독 터미널 벨(BEL)은 노이즈가 커 기본 비활성 — `DONGMINAL_ATTENTION_BELL=1` 로 켜기.
  - 터미널 출력 바이트는 변형하지 않음(표시 동작 무변경).
- **표시** (브라우저):
  - 주의가 필요한 도구의 **탭/분할 칸을 포커스와 구분되는 강조색(`--attn`, 호박색)** 으로 표시. 지금 보고 있는(포커스+활성) 탭은 강조하지 않음.
  - 상단 🔔 배지 + 클릭 시 **주의 도구 모아보기(notification center)** — 항목 클릭하면 그 도구로 이동.
  - 브라우저 탭 제목에 개수 배지(`(2) Terminal`).
  - 선택: 데스크톱 알림(Web Notification, 권한 필요)·사운드. 설정 → Notifications 에서 토글(브라우저별 저장).
- **해제**: 해당 도구를 포커스/클릭하거나 입력을 보내면 자동 해제(다른 브라우저에도 전파).

## 에이전트 활동 모아보기 (Agent Activity Panel)

여러 도구에서 동시에 도는 에이전트가 **지금 무엇을 하는지**를, 터미널 화면을 일일이 열지 않고 우측 패널에 카드로 모아 본다. 각 카드는 "현재 이 순간" 상태 하나만 보여준다(작업 중/완료/대기, 무슨 툴·명령어·파일).

- **열기**: 상단 툴바의 **Agents** 버튼(Split V 옆) 또는 단축키(기본 `Ctrl+Shift+A`, 설정 → Shortcuts 에서 변경). 우측 접이식 패널이 열리며, 핸들로 너비 조절. 헤더에 새로고침·닫기 버튼. 열림/너비는 브라우저별로 저장.
- **카드**: 도구 위치(창·탭), 상태(글꼴 기호 + 테마 색으로 구분: `●` 작업 중 / `✓` 완료 / `…` 입력 대기 / `○` 멈춤), 툴 라벨, 명령어/파일 **원문**(로컬·본인용이라 마스킹하지 않음). 최근 갱신된 카드가 맨 위. 카드를 클릭하면 그 도구로 바로 이동. 포커스 중인 도구의 카드는 강조 표시.
- **자동 새로고침**: 패널이 열려 있으면 주기적으로 서버 상태와 동기화(비정상 종료·hook 누락 보정). 주기는 설정 → Notifications 에서 변경. 에이전트/도구가 종료되면 카드가 사라진다.
- **알람 통합**: 그 도구에 주의 알림이 떠 있으면 카드에도 알람 강조(`--attn`)가 함께 표시된다. 클릭하면 이동하면서 알람도 해제.
- **에이전트별 충실도** (설정 영구 수정 없이 per-invocation 주입):
  - **Claude Code**: `PreToolUse` 로 "무슨 툴·명령어/파일"까지 실시간 표시(가장 풍부).
  - **Codex**: 턴 완료(`done`)만 — 표준 notify 가 turn-complete 만 주기 때문(명령어 단위 표시는 후속).
  - **그 외**(gemini 등): 명시 신호가 없어 출력 활동 기반 작업 중/멈춤만 추정.

## 테마

44 개 프리셋 (다크 33 · 라이트 11) + 커스텀 테마 편집기.

다크: Tokyo Night, Dracula, One Dark, Nord, Catppuccin, Solarized Dark, Monokai, GitHub Dark, Material Ocean, Material Palenight, Ayu Dark, Gruvbox Dark, Rosé Pine, Night Owl, Cobalt², Shades of Purple, Horizon, Doom One, Everforest, Kanagawa, Synthwave '84, VSCode Dark+, VSCode Dark Modern, Vesper, Vitesse Dark, Houston, Andromeda, Iceberg, Tomorrow Night, Monokai Pro, Apprentice, Snazzy, Catppuccin Frappé.

라이트: GitHub Light, Solarized Light, One Light, Tokyo Night Light, Catppuccin Latte, Gruvbox Light, Rosé Pine Dawn, Ayu Light, Everforest Light, Quiet Light, Vitesse Light.

커스텀 테마: UI 10색 + 터미널 20색을 컬러 피커로 개별 조정. 모든 UI 요소(사이드바, 탭, 검색 바, 상태 표시줄)에 CSS 변수 기반 일괄 적용. 스크롤바는 `--text-dim`/hover 시 `--text-muted` 로 가시성 보장.

## 파일 영속성

`DONGMINAL_HOME` (기본 `~/.dongminal`) 아래에 저장:

| 파일/디렉터리 | 설명 | 재시작 시 |
|---------------|------|-----------|
| `settings.json` | 테마·단축키·프리셋·상태 바·사이드바 너비 | 유지 |
| `workspace.json` | 창/탭/분할 구조 (비동기 latest-wins 쓰기) | 유지 |
| `tools.json` | 탭이 참조하는 도구별 cwd 스냅샷. 백그라운드 도구는 기록되지 않는다 | 유지 |
| `bin/` | 런타임 헬퍼 스크립트 (서버 기동 시 재배포) | 덮어쓰기 |

PTY 프로세스 자체는 서버 메모리에만 존재 → 서버 재시작 시 초기화. 브라우저 새로고침은 서버 버퍼로부터 복원 (bufMax 1 MiB, 오래된 바이트는 드롭되며 `dropped_bytes` 관측 가능).

## 부가 CLI (자동 배포)

서버 시작 시 `$DONGMINAL_HOME/bin/` 아래 자동 생성. 터미널 도구는 이 경로가 `PATH` 에 들어간 상태로 스폰되므로 별도 설정이 필요 없습니다.

`dmctl`·`edit`·`download`·`detach` 는 dongminal 바이너리를 가리키는 symlink 입니다 (multi-call CLI).

| 파일 | 용도 |
|------|------|
| `bin/dmctl` | 워크스페이스 원격 제어 (분할/탭/포커스/창) + 목록 조회·알림·활동 보고 |
| `bin/edit` | `edit <path>` → 내장 편집기 탭으로 파일 열기 |
| `bin/download` | `download <path>` → OSC 777 로 브라우저 다운로드 트리거 |
| `bin/detach` | 현재 도구를 백그라운드로 보내고 탭을 닫기 (`--list`, `--restore <id>`) |
| `bin/zdotdir/.zshrc` | zsh cwd 훅 (상태 바의 현재 디렉터리용). `~/.zshrc` 를 먼저 source 후 `precmd`/`chpwd` 훅 추가 |
| `bin/bash-hook.sh` | bash cwd 훅. `BASH_ENV` 로 자동 로드 |

외부 터미널에서 `dmctl`/`edit` 를 쓰려면 해당 쉘에서 `export PATH="$DONGMINAL_HOME/bin:$PATH"` + `export DONGMINAL_PORT=<포트>` 를 수동 설정.
