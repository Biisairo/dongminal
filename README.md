# Dongminal

브라우저 기반 터미널 멀티플렉서. 분할 Pane, 탭, 세션 관리, 테마 시스템, 파일 전송 등을 지원합니다.

단일 Go 바이너리에 프론트엔드(xterm.js)가 포함되어 있어 실행 파일 하나로 서비스가 가능합니다.

## 실행

```bash
./start.sh                     # 빌드 + 실행 (port 58146)
./stop.sh                      # 중지
PORT=1234 ./dongminal          # 포트 지정 실행 (기본값: 8080)
```

## 아키텍처

```
Browser (xterm.js) ← Binary WebSocket → Go Server (PTY) → Shell
                                          ↕
                                    settings.json (테마, 단축키, 프리셋)
```

- 프론트엔드는 `go:embed`로 바이너리에 포함
- PTY 프로세스는 페이지 새로고침해도 유지됨 (서버 메모리에 버퍼 보관)
- 워크스페이스(탭/분할 구조)는 서버 메모리에 저장 → 페이지 새로고침 시 복원, 서버 재시작 시 초기화
- 설정(테마, 단축키, 프리셋, 상태 표시줄)은 `settings.json`에 저장 → 서버 재시작해도 유지



```bash
# 터널 설정 후

```

## 기능

### 세션 & 레이아웃

| 기능 | 설명 |
|------|------|
| **세션 관리** | 사이드바에서 세션 생성/삭제/전환, 더블클릭으로 이름 변경 |
| **탭 관리** | 각 Pane마다 독립 탭 바, 탭 추가/삭제/전환 |
| **분할 Pane** | 가로/세로 분할, 드래그로 크기 조절, 비율 유지 |
| **레이아웃 프리셋** | 현재 분할 구조를 저장 → 설정에서 관리, 기본 프리셋 지정 → 사이드바 ★ 버튼으로 원클릭 생성 |

### 터미널

| 기능 | 설명 |
|------|------|
| **한국어 IME** | xterm.js Unicode11 addon, 로케일 설정 |
| **TUI 프로그램** | vim, htop, tmux 등 완벽 동작 |
| **터미널 검색** | `Ctrl+F` / `Cmd+F` → 검색 바, Enter/Shift+Enter 이동, 대소문자 구분 토글 |
| **링크 열기** | URL 자동 감지, 클릭 시 새 탭에서 열기 (web-links addon) |
| **파일 업로드** | 터미널에 파일 드래그앤드롭 → 현재 작업 디렉토리에 저장, 동일 파일명 시 `(1)`, `(2)` 자동 넘버링 |
| **파일 다운로드** | `download <path>` 명령어 → 브라우저 다운로드 |
| **자동 재연결** | 연결 끊김 시 지수 백오프(1s→30s)로 자동 재시도, 오버레이 표시, 복원 시 버퍼 리플레이 |

### 상태 표시줄

하단 상태 바에서 실시간 정보 표시. 설정에서 항목 토글 및 갱신 주기 변경 가능.

| 항목 | 설명 | 기본 |
|------|------|------|
| 연결 상태 | 🟢/🔴 + 연결됨/끊김 | ✅ |
| 레이턴시 | `/api/ping` RTT 측정 (ms) | ✅ |
| 현재 디렉토리 | 쉘 훅으로 실시간 감지 | ✅ |
| 메모리 | 사용량/전체 | ✅ |
| CPU | 서버 CPU 사용률 | ❌ |
| 호스트명 | 서버 이름 | ❌ |
| 디스크 | 루트 볼륨 사용률 | ❌ |
| 터미널 크기 | cols × rows | ❌ |
| 업타임 | 시스템 + 서버 프로그램 | ❌ |

### 테마

21개 프리셋 + 커스텀 테마 편집기.

| 프리셋 | | | |
|--------|-|-|-|
| Tokyo Night | Dracula | One Dark | Nord |
| Catppuccin | Solarized Dark | Monokai | GitHub Dark |
| Material Ocean | Material Palenight | Ayu Dark | Gruvbox Dark |
| Rosé Pine | Night Owl | Cobalt² | Shades of Purple |
| Horizon | Doom One | Everforest | Kanagawa |
| Synthwave '84 | | | |

커스텀 테마: UI 10색 + 터미널 20색을 컬러 피커로 개별 조정. 모든 UI 요소(사이드바, 탭, 검색 바, 상태 표시줄 등)에 CSS 변수 기반 일괄 적용.

### 단축키

모든 단축키는 설정에서 커스터마이징 가능. 설정된 단축키는 터미널/브라우저 기본 동작보다 **우선**됩니다.

| 동작 | 기본값 |
|------|--------|
| 다음 세션 | `Ctrl+Shift+]` |
| 이전 세션 | `Ctrl+Shift+[` |
| 다음 탭 | `Ctrl+Tab` |
| 이전 탭 | `Ctrl+Shift+Tab` |
| Pane ↑ | `Ctrl+Shift+↑` |
| Pane ↓ | `Ctrl+Shift+↓` |
| Pane ← | `Ctrl+Shift+←` |
| Pane → | `Ctrl+Shift+→` |
| 가로 분할 | `Ctrl+Shift+H` |
| 세로 분할 | `Ctrl+Shift+V` |
| 새 세션 | `Ctrl+Shift+N` |
| 새 탭 | `Ctrl+Shift+T` |
| 세션 닫기 | `Ctrl+Shift+W` |
| 탭 닫기 | `Ctrl+Shift+D` |
| 터미널 검색 | `Ctrl+F` / `Cmd+F` (고정) |

**키 입력 우선순위:**
1. 단축키 설정 녹음 중 → 모든 이벤트 차단
2. 설정된 앱 단축키 → 매칭 시 실행, `stopImmediatePropagation`
3. `Ctrl+F` (검색) → 검색 바 토글
4. `Ctrl+` 나머지 → 터미널로 전달 (Ctrl+C, Ctrl+R 등)
5. `Cmd+` → 브라우저 유지 (Cmd+C/V 복사/붙여넣기 등)

## 설정

`settings.json`에 저장되는 항목:

```json
{
  "themeName": "Tokyo Night",
  "customTheme": null,
  "shortcuts": { "sessionNext": "Ctrl+Shift+BracketRight", ... },
  "statusBar": { "connection": true, "latency": true, ... },
  "statsInterval": 3000,
  "layoutPresets": [{ "name": "개발", "layout": {...} }],
  "defaultPreset": 0
}
```

- **Theme** 탭: 프리셋 선택, 커스텀 테마 편집
- **Shortcuts** 탭: 단축키 녹음 변경, 초기화
- **Status Bar** 탭: 항목 토글, 갱신 주기 선택 (1s~30s)
- **Presets** 탭: 레이아웃 저장/불러오기/삭제, 기본 프리셋(★) 지정, 더블클릭 이름 변경

## API

```
GET  /api/state          → { panes, workspace }
POST /api/panes          → PTY 생성
DELETE /api/panes/:id    → PTY 종료
PUT  /api/workspace      → 워크스페이스 저장 (서버 메모리)
GET  /api/settings       → 설정 조회
PUT  /api/settings       → 설정 저장 (settings.json)
GET  /api/stats          → { hostname, cpu, memUsed, memTotal, diskPct, sysUptime, srvUptime }
GET  /api/cwd?pane=<id>  → { cwd } (PTY 현재 작업 디렉토리)
GET  /api/ping           → "ok" (레이턴시 측정용)
POST /api/upload?dir=<path>  → 파일 업로드 (multipart)
GET  /api/download?path=<path> → 파일 다운로드
WS   /ws?pane=<id>       → PTY WebSocket 연결
```

### WebSocket 프로토콜 (Binary)

| Opcode | 방향 | 설명 |
|--------|------|------|
| 0x00 | S→C | 터미널 출력 |
| 0x00 | C→S | 터미널 입력 |
| 0x01 | C→S | 리사이즈 (cols uint16 + rows uint16) |
| 0x01 | S→C | 에러 메시지 |
| 0x02 | S→C | 프로세스 종료 |
| 0x03 | S→C | 세션 ID 할당 |

### OSC 777 커스텀 이스케이프 시퀀스

PTY 출력에서 특수 명령을 전달합니다:

| 시퀀스 | 설명 |
|--------|------|
| `ESC]777;Download;<path>BEL` | 브라우저 파일 다운로드 트리거 |
| `ESC]777;Cwd;<path>BEL` | 현재 작업 디렉토리 실시간 보고 |

## 프로젝트 구조

```
dongminal/
├── main.go              # Go 서버 (PTY 관리, WebSocket, API)
├── go.mod
├── static/
│   ├── index.html       # 프론트엔드 HTML
│   ├── app.js           # 프론트엔드 로직
│   └── style.css        # 스타일시트
├── start.sh             # 빌드 + 실행 스크립트
├── stop.sh              # 중지 스크립트
├── TODO.md              # 기능 구현 목록
└── README.md
```

실행 시 자동 생성:
- `settings.json` — 설정 파일
- `bin/download` — 다운로드 명령어 스크립트
- `bin/zdotdir/.zshrc` — zsh cwd 훅
- `bin/bash-hook.sh` — bash cwd 훅

## 기술 스택

**백엔드:** Go, `creack/pty`, `gorilla/websocket`, `go:embed`

**프론트엔드:** xterm.js v5, addon-fit, addon-search, addon-web-links, addon-unicode11


