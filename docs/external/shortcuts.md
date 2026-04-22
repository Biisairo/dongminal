# 단축키

모든 앱 단축키는 **설정 → Shortcuts** 에서 커스터마이징 가능합니다. 설정된 단축키는 터미널/브라우저 기본 동작보다 우선합니다.

## 기본값

| 동작 | 기본 |
|------|------|
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

## 키 입력 우선순위

1. 단축키 녹음 중 → 모든 이벤트 차단
2. 설정된 앱 단축키 매칭 → 실행 + `stopImmediatePropagation`
3. `Ctrl+F` → 검색 바 토글
4. `Ctrl+` 나머지 → 터미널로 전달 (Ctrl+C, Ctrl+R 등)
5. `Cmd+` → 브라우저 유지 (Cmd+C/V 복사/붙여넣기)
