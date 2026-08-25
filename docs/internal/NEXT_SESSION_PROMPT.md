# 다음 세션 프롬프트

**현재 트랙: Git 창 — 코드 1~20단계 완료. 남은 것은 미구현 2건 + 21단계 수동 검증.**

아래 §1 지시 블록을 새 세션 첫 메시지로 붙여넣는다.

---

## 1. 새 세션에 붙여넣을 지시 블록

```
dongminal Git 창 트랙을 마무리한다. MVP 코드는 1~20단계가 끝나 있다.

읽을 것 (순서대로):
  docs/internal/GIT_REMAINING.md          ← 이번 세션의 작업 목록. 여기가 출발점이다
  docs/internal/GIT_SRS.md                ← 스펙. FR-GIT-1~178, §7 결정, §7.1 해석 I1~I8
  docs/internal/design/README.md          ← 계약 색인·픽스처·검증 게이트
  docs/internal/GIT_MANUAL_CHECKLIST.md   ← 21단계 절차

이번 세션의 일은 셋이다. 순서대로 한다.

■ 1) 미구현 2건을 구현한다 (GIT_REMAINING.md §1)
  G-1 FR-GIT-141 커밋에서 "여기서 브랜치 생성"  (web/js/git-menu.js:28)
  G-2 FR-GIT-144 dirty 상태의 Checkout (Detached) (web/js/git-menu.js:38)

  둘 다 "M5 에서 제공됩니다"로 막아 둔 P0 항목이고, 막을 당시엔 없던 것이
  지금은 전부 있다. 기존 것을 재사용해라 — 같은 판정을 두 벌로 만들지 마라:
    · 브랜치 생성 다이얼로그·이름 검증 → GitBranches (web/js/git-branches.js)
    · dirty 3선택(취소/stash 후 진행/강제) → GitBranches 의 흐름
    · 파괴적 2단계 확인 → GitConfirm (web/js/git-confirm.js)
    · 다이얼로그 골격 → GitDialog (web/js/git-dialog.js)

  기본은 항상 안전한 쪽이다 (FR-GIT-97, O14) — dirty 기본 선택은 취소다.

  e2e 두 개가 지금 "막혀 있음"을 고정하고 있으니 함께 바꾼다:
    e2e/git-menu.spec.ts N7(FR-GIT-141) · N8(FR-GIT-144)
    N9(clean 경로)는 그대로 유효하다 — 건드리지 마라.

■ 2) 21단계 수동 검증 (GIT_MANUAL_CHECKLIST.md)
  scripts/git_fixture.sh 로 저장소 10종을 만들고 dongminal 을 띄운 뒤 G1~G6 과
  보안 S.1~S.4 를 훑는다. 각 항목을 ☑ / ✗(사유) 로 문서에 기록한다.
  · 결함이 나와도 그 자리에서 고치지 말고 먼저 전부 훑는다. 목록을 모은 뒤
    우선순위를 정한다.
  · 화면 배치·색·읽힘은 스펙이 정하지 않은 것이 많다. "결함"과 "취향"을 구분해
    기록한다.
  · G7(모바일 실기기)은 사용자 몫이다. 내게 넘겨라.

■ 3) 마무리
  GIT_REMAINING.md 를 갱신하고, 트랙이 닫히면 design/ 계약 문서를
  docs/internal/archive/ 로 옮긴다 (archive 규칙: 옮긴 뒤 갱신하지 않는다).

작업 방식:
- 스펙이 이미 있으므로 각 항목은 테스트 → 구현 순서다.
- 서브에이전트를 쓸 거면 JS 레인 하나만 쓴다. 남은 일이 전부 web/js/ 라
  둘을 띄우면 같은 파일에서 충돌한다.
- 각 항목이 끝나면 검증하고 커밋한다. 커밋 메시지에 AI 서명(Co-Authored-By 등)을
  넣지 않는다.

검증 (기준선: Go 전부 통과 / Playwright 348):
  go build ./... && go vet ./... && go test ./... -race && gofmt -l .
  npx playwright test --retries=1

  ※ --retries=1 을 주는 이유는 GIT_REMAINING.md §4 에 있다. 전체 실행은 부하에
    민감해 0~1건이 간헐 실패하며, 제품 결함이 아님을 이미 확인했다. 진짜 실패는
    두 번 모두 실패하므로 게이트의 뜻은 그대로다.

하지 말 것 (GIT_REMAINING.md §2):
- Console 탭의 "준비 중"을 고치지 마라. 표시는 의도적으로 P1(비목표)이고 자리와
  기록은 이미 MVP 에 들어 있다.
- 비목표(hunk 스테이징·merge editor·인터랙티브 rebase·브랜치 삭제·clone/init 등)를
  구현하지 마라.
- 자격증명 저장·중계 경로를 만들지 마라. 의도적 배제다 (FR-GIT-104).
```

---

## 2. 감사할 때 조심할 것 (이번 세션에서 실제로 당한 것)

FR 번호가 코드에 **언급되는지**만 기계로 확인하면 **"막아 두고 사유를 보이는 것"도
통과한다.** 실제로 `FR-GIT-1~178 전부 참조됨`이라는 감사가 초록이었는데
141·144 는 미구현이었다.

차단 표식을 함께 훑어라:

```bash
grep -rn "disabled:()=>\|disabled: (" web/js/git-*.js
grep -rn "제공됩니다\|준비 중\|pending:true" web/js/constants.js
```

---

## 3. 완료된 것 (기록)

### Git 창 — 1~20단계

기준선: `go test ./... -race` 전부 통과 · gofmt clean · Playwright **187 → 348**.
FR-GIT-1~178 구현(§1 의 2건 제외), 검증 V1~V59·V62~V69 자동화.

| 마일스톤 | 단계 | 커밋 |
|---|---|---|
| **M1 읽기** | 1 A · 2 B·C서버 · 3 D · 4 B클라 · 5·6 E·C클라 · 7 F · 8 G | `f455137` `cc62d09` `8ed0396` `72bbe00` `747db3a` `a9f244e` `f078fdf` `1493a8a` |
| **M2 커밋** | 9 J(안전 정책) · 10 H(스테이징) · 11 I(커밋) | `71ed098` `579a070` `54d869c` `5d25d65` |
| **M3 원격** | 12 job 인프라 · 13 K(fetch/pull/push) | `ef45143` `677b059` |
| **M4 히스토리** | 14 조회 · 15 레인 · 16·17 History+메뉴 프레임워크 · diff 축 | `a036af5` `6a01d4d` `a25abd0` `90d93a4` `5b649df` |
| **M5 참조** | 18 N(Branches) · 19 O(Stash) · 20 P(다이얼로그 규약) | `c9f8134` `7dd4130` `525ca24` |
| 기반 | 설계 계약 21단계 · 결정 O1~O14 · 해석 I1~I8 · 픽스처 10종 · 수동 체크리스트 · `-race` 게이트 복구 | `67bc325` `6157476` `ddb4307` `cece980` `a2c3abe` `b8a288a` |

### 구현 중 실측으로 잡은 함정 (다시 밟지 마라 — 근거는 계약 문서에 있다)

| 함정 | 결과 |
|---|---|
| `git log` 에 `-z` 를 주지 않으면 git 이 **레코드 사이에 개행을 끼운다** | 다음 레코드의 첫 필드가 오염돼 조용히 틀린 목록이 된다 |
| `git config --get` 은 **미설정 시 exit 1** (stderr 비어 있음) | 오류로 올리면 identity 없는 저장소에서 preflight 자체가 막혀 차단 사유를 못 보인다 |
| 없는 blob 은 **exit 128** + `does not exist in 'HEAD'` | 오류로 올리면 새 파일·삭제 파일의 diff 가 전부 500 이 된다 |
| `git check-ref-format --branch '@{-1}'` 이 **exit 0 으로 다른 브랜치 이름을 출력** | 종료 코드만 믿으면 사용자가 입력한 것과 다른 브랜치가 조작된다 (§7.1 I8) |
| `commit-parent` 축의 빈 `oid` 는 `:<path>` = **index** | 커밋 축이 조용히 다른 축이 된다 |
| `constants.js` 의 `const` 는 **`window` 프로퍼티가 아니다** | e2e 가 `window.X` 로 읽으면 조용히 undefined |
| 소스에 **리터럴 NUL 바이트** | grep·diff 가 파일을 바이너리로 취급해 조사 도구가 무력화된다 |

### 병렬 운영에서 배운 것

- **Go 레인 1개 + JS 레인 1개.** 같은 레인에 둘을 띄우면
  `internal/server/handlers_api.go` 의 라우트 표와 `web/js/*.js` 에서 충돌한다.
- **Playwright 는 동시에 두 번 돌 수 없다** — 고정 포트 58147 +
  `reuseExistingServer:false`.
- `git add <디렉터리>` 는 **다른 에이전트의 미완성 변경을 삼킨다.** 파일을 명시해
  add 한다 (실제로 한 번 삼켜 히스토리를 되돌렸다).
- **실측을 계약 문서에 먼저 반영하면 뒤 단계가 같은 함정을 밟지 않는다.**
- **에이전트 산출물은 독립 검증한다.** 그렇게 찾은 실제 결함: detached 경고의
  preflight 경합, 리터럴 NUL, `commit-parent` 축의 빈 oid, `@{-1}` 이름 확장.

### 이전 트랙

| 트랙 | 상태 |
|---|---|
| 1. 사용자 확인 피드백 | 완료 — iOS 실기기 수동 확인만 남음 |
| 2. MCP 폐지 → 세션 스코프 스킬 주입 | 완료 |
| 3. 상태바 지표 재설계 | 완료 |
| 4. AI 오케스트레이터 | 완료 (묶음 S·R·P·A·K·W) |
| 5. 브랜드 아이콘·파비콘 | 완료 |

---

## 4. 이번 트랙의 확정 사항 (다시 논의하지 말 것)

| 항목 | 결정 |
|---|---|
| 형태 | Git = **창(window)**, 워크스페이스에 1개 (싱글턴) |
| 진입 | 좌측 사이드바 GIT 섹션 — `⟳` cwd 자동 + `📌` 고정 + `+ Add` |
| 창 내부 | **고정 탭** `Changes / Diff / History / Branches / Stash / Console` |
| 변경 감지 | **`git status` 폴링** (즉시 신호 4종 + signature 500ms + status 1s) |
| diff 엔진 | **Monaco DiffEditor** |
| 안전 | 파괴적 동작은 `ExecWrite` 단일 경로 + 서버측 `confirm` 강제 + 2단계 확인 |
| 자격증명 | **저장·중계하지 않는다.** git credential helper 에 위임 |

기각된 것: 우측 사이드 패널 · 일반 탭 · fsnotify/watcher/git hooks · 칸 최대화(zoom).
사유는 `GIT_INTEGRATION_ANALYSIS.md` §4.5.3 과 `GIT_SRS.md` §5 에 있다.
