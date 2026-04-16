# Remote Terminal

Browser-based terminal multiplexer with split panes and tabs.

## 실행

```bash
./start.sh    # 빌드 + 실행 (port 58146)
./stop.sh     # 중지
```

## 아키텍처

```
Browser (xterm.js) ← Binary WebSocket → Go Server (PTY) → Shell
                    ↕
              Workspace State (workspace.json)
              - Tab/Pane layout persistence
              - PTY survives page refresh
```

## 단축키

| 단축키 | 동작 |
|--------|------|
| Ctrl+Shift+H | 가로 분할 |
| Ctrl+Shift+V | 세로 분할 |
| Ctrl+Shift+W | 현재 Pane 닫기 |
| Ctrl+Shift+T | 새 탭 |

## API

```
GET  /api/state       → { panes, workspace }
POST /api/panes       → create new PTY
DELETE /api/panes/:id → kill PTY
PUT  /api/workspace   → save layout
WS   /ws?pane=<id>    → connect to PTY
```
