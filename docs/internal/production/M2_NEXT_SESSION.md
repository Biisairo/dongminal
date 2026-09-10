# M2 다음 세션 착수 프롬프트

아래 블록을 새 세션에 그대로 붙여넣으면 된다.

**이 파일은 `M2_PROGRESS.md` §5 의 사본이다** — 두 벌이 되면 한쪽만 고쳐지므로,
고칠 때는 그쪽을 고치고 여기로 옮긴다.

---

```
프로젝트: /Users/dykim/personal/dongminal

프로덕션화 로드맵 M2 를 이어서 진행한다. P0 5건과 P1 10건이 끝났다.

먼저 읽어라 — 이게 진실이고 나머지는 배경이다:
- docs/internal/production/M2_PROGRESS.md   ← 무엇이 끝났고 무엇이 남았는지
- docs/internal/REQUEST_GATE_SRS.md          ← 게이트 계약 (구현됨)
- docs/internal/FILE_API_BOUNDARY_SRS.md     ← 파일 경계 계약 (구현됨)
- docs/internal/MONACO_VENDORING_SRS.md      ← 벤더링·사전압축·CSP (구현됨)

남은 일은 셋이다.

1) P1 마지막 — FE-8: web/js/core/api.js 통합 (fetch 51곳).
   M4 인증의 선행 권장이다. 통합하지 않으면 401 공통 처리가 29파일로 흩어진다.
   중 규모이므로 스펙을 먼저 쓴다.

2) 사용자 보고 5건 (M2_PROGRESS §3.4) — U-1~U-5.
   U-1(LSP 파일 연결 안 됨)·U-3(스크롤 위로 붙음)은 결함이라 재현부터.
   U-2·U-4·U-5 는 동작 변경이라 현재 동작이 의도된 것인지 먼저 확인한다.
   **U-5(탐색기 다중 선택)는 규모가 다르다** — 선택 모델을 바꾸면 그것을 읽는
   모든 명령이 함께 바뀐다. 착수 전에 스펙 필요 여부를 판정하라.

3) P2·기능축 (M2_PROGRESS §3.2).

규약:
- 게이트를 먼저 돌려라: make gates · npm run typecheck · npm run lint ·
  npm run unit · go test -race -shuffle=on ./... · npx playwright test
- **e2e 는 단독으로 돌려라.** 다른 세션이 같은 기계에서 테스트를 돌리면
  PTY 가 소진되고 실패 목록이 오염된다 (kern.tty.ptmx_max 기본 511).
- 게이트를 느슨하게 만들어 통과시키지 마라. 415·403 이 보이면 스펙으로 먼저
  판정하고, 게이트가 옳으면 호출부를 고친다.
- 커밋 메시지에 AI 서명 금지. 커밋은 사용자 확인 후에만.
```
