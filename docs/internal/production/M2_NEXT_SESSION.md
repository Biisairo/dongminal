# M2 다음 세션 착수 프롬프트

아래 블록을 새 세션에 그대로 붙여넣으면 된다.

---

```
프로젝트: /Users/dykim/personal/dongminal

프로덕션화 로드맵 M2(브라우저 매개 공격 봉합 + 서버 하드닝)를 **이어서** 진행한다.
지난 세션에서 P0 5건과 P1 8건이 끝났고, 커밋 5개로 들어가 있다.

먼저 이것부터 읽어라 — 이게 진실이고 나머지는 배경이다:
- docs/internal/production/M2_PROGRESS.md   ← 무엇이 끝났고 무엇이 남았는지
- docs/internal/REQUEST_GATE_SRS.md          ← 게이트 계약 (이미 구현됨)
- docs/internal/FILE_API_BOUNDARY_SRS.md     ← 파일 경계 계약 (이미 구현됨)

배경이 필요하면:
- docs/internal/production/MILESTONE_KICKOFF.md 의 "M2" 섹션
- docs/internal/production/04-secops.md §3(P1-5 잔여)·§4.2·§4.3·§4.4
- docs/internal/production/02-fe-arch.md 의 P1 "Monaco CDN"·"fetch 관용구 중복"

## 첫 번째 일 — 전체 e2e 분류

지난 세션이 전체 e2e(1,425건)를 끝까지 보지 못하고 중단했다. 중단 시점까지
**20개 스펙이 실패로 기록됐고, 그 목록과 분류 지침이 M2_PROGRESS.md §6.2 에
있다.** 그것부터 읽어라.

    npx playwright test --reporter=line

**다른 것을 동시에 돌리지 마라.** 이 저장소는 e2e 워커가 인스턴스마다 PTY 를
여러 개 연다. macOS 의 kern.tty.ptmx_max 는 기본 511 인데 지난 세션에서 218개까지
올라갔고, 그 상태에서는 daemon 통합 테스트가 **HEAD 에서도** 실패했다. 즉 §6.2 의
목록에는 코드와 무관한 실패가 섞여 있다.

실패를 만나면 순서가 있다.

1. **깨끗한 단독 실행에서도 남는가** — 아니면 자원 경합이다.
2. 남으면 **게이트가 옳은지 스펙(REQUEST_GATE_SRS·FILE_API_BOUNDARY_SRS)으로
   판정**한다.
3. 게이트가 옳으면 **호출부를 고친다.** 게이트를 느슨하게 만들어 통과시키지 마라 —
   그것이 이 마일스톤이 막으려던 것이다.

415(Content-Type)와 403(`/api/file/*` 경계)이 게이트 냄새다. 415 넷은 이미
`e2e/focus-invariant.spec.ts` 에서 고쳐 두었다(워킹트리 또는 커밋에 있다).

## 그다음 — 남은 P1

M2_PROGRESS.md §3.1 의 넷이다. 그중 하나는 사용자 결정을 기다린다(아래).

  · GO-11 / SEC-17  오류 분류·문구 노출. §3.3 에 실측한 자리 목록이 있다 —
                    http.Error(w, err.Error(), …) 8곳, strings.Contains(err.Error(), …) 3곳.
                    query/blame.go:82 은 git stderr 를 보는 것이라 대상이 아니다.
  · FE-8            web/js/core/api.js 통합 (fetch 51곳). M4 인증의 선행 권장.
  · FE-6 + B7       Monaco 벤더링 — **사용자에게 먼저 물어라** (아래)

## 사용자에게 물어야 하는 것 — Monaco 벤더링

편집기만 런타임에 cdn.jsdelivr.net 에서 받는다. 벤더링하면 CSP 의 script-src 에서
외부 호스트가 사라지고 폐쇄망에서도 편집기가 서지만, **바이너리가 16MB → 약
21MB** 가 된다. README 첫 문장이 "의존이 없는 단일 파일" 이라 크기는 제품의 성격에
닿는다. 임의로 정하지 말고 M2_PROGRESS.md §4 의 표를 보여 주고 결정을 받아라.

## 그다음 — P2와 기능축

M2_PROGRESS.md §3.2 목록. 착수 전에 킥오프 M2 의 "건드리지 말 것" 을 다시 읽어라 —
git 실행 초크포인트·/api/fs/* 가드·업로드 상한·ACL 설계·파괴적 확인창 설계는
전부 양호 판정이며 보존 대상이다.

## 규약

- 중·대 규모는 스펙 → 테스트(RED) → 구현(GREEN). SRS 2건은 이미 있으니 그 범위
  안이면 새로 쓰지 않는다.
- 게이트를 먼저 돌려라: make gates · npm run typecheck · npm run lint · npm run unit ·
  go test -race -shuffle=on ./...
- 커밋 메시지에 AI 서명(Co-Authored-By 등) 금지. 커밋은 사용자 확인 후에만.
- 완료 후 M2_PROGRESS.md 를 갱신하고, 킥오프 M2 의 Definition of Done 을 하나씩
  검증해 보고하라.
```

---

## 붙여넣기 전에 알아 두면 좋은 것

- 마지막 커밋은 `39096f1 docs: M2 진행 상황과 노출 시 운영 안내` 다.
- 워킹트리에 `e2e/focus-invariant.spec.ts` 수정이 남아 있을 수 있다 — 게이트
  때문에 415 를 받던 라우팅 검사 넷에 헤더를 단 것이다.
- `--expose` 는 이제 허용 목록 없이는 뜨지 않는다. 로컬 시험에서 막히면
  `--insecure-no-acl` 이 있고, 그 이름이 의도다.
