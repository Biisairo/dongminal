# 단축키

모든 앱 단축키는 **설정 → Shortcuts** 에서 커스터마이징 가능합니다. 설정된 단축키는 터미널/브라우저 기본 동작보다 우선합니다.

`Pane ↑/↓/←/→` 는 분할 칸 사이의 포커스 이동입니다.

## 기본값

| 동작 | 기본 |
|------|------|
| 다음 창 | `Ctrl+Shift+]` |
| 이전 창 | `Ctrl+Shift+[` |
| 다음 탭 | `Ctrl+Tab` |
| 이전 탭 | `Ctrl+Shift+Tab` |
| Pane ↑ | `Ctrl+Shift+↑` |
| Pane ↓ | `Ctrl+Shift+↓` |
| Pane ← | `Ctrl+Shift+←` |
| Pane → | `Ctrl+Shift+→` |
| 가로 분할 | `Ctrl+Shift+H` |
| 세로 분할 | `Ctrl+Shift+V` |
| 새 창 | `Ctrl+Shift+N` |
| 새 탭 | `Ctrl+Shift+T` |
| 창 닫기 | `Ctrl+Shift+W` |
| 탭 닫기 | `Ctrl+Shift+D` |
| 에이전트 패널 | `Ctrl+Shift+A` |
| 내부 새로고침 | `Ctrl+Shift+K` |
| 사이드바 탭: Windows | `Ctrl+Shift+1` |
| 사이드바 탭: Git | `Ctrl+Shift+2` |
| 터미널 검색 | `Ctrl+F` / `Cmd+F` (고정) |

## 브라우저 기본 단축키 차단

**설정 → Shortcuts → 브라우저 기본 단축키 차단** (기본 켬).

켜져 있으면 앱 단축키에 매칭되지 않은 `Ctrl`/`Cmd` 조합의 **브라우저 기본 동작**을
막습니다 — 저장(`Ctrl+S`)·인쇄(`Ctrl+P`)·북마크(`Ctrl+D`) 등이 열리지 않으므로 그
조합을 자유롭게 단축키로 배정할 수 있습니다. 키는 **터미널로는 그대로 전달**됩니다.

다음은 막지 않습니다.

- 복사·붙여넣기·잘라내기·전체선택 (`Ctrl+C`/`V`/`X`/`A`)
- 새로고침·전체화면·개발자도구 (`F5`·`F11`·`F12`, `Ctrl+Shift+I`/`J`, `Ctrl+R`)

브라우저가 페이지에 넘기지 않는 조합(`Ctrl+T`·`Ctrl+N`·`Ctrl+W`·`Ctrl+Shift+T` 등)은
어떤 설정으로도 막을 수 없습니다. 그 키를 단축키로 배정하면 조용히 동작하지 않으므로
다른 조합을 쓰세요.

## 키 입력 우선순위

1. 단축키 녹음 중 → 모든 이벤트 차단
2. 설정된 앱 단축키 매칭 → 실행 + `stopImmediatePropagation`
3. `Ctrl+F` → 검색 바 토글
4. `Ctrl+` 나머지 → 터미널로 전달 (Ctrl+C, Ctrl+R 등). 차단 설정이 켜져 있으면
   브라우저 기본 동작만 함께 막힙니다 (전달은 그대로)
5. `Cmd+` → 브라우저 유지 (Cmd+C/V 복사/붙여넣기)
