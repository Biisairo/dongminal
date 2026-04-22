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
