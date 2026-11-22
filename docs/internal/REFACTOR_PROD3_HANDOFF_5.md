# 인계 — 프로덕션 리팩토링 3차 (다섯째 세션): 아이콘 세트 재정비 → 「정독하지 않은 곳」 감사

> 넘긴 날: 2026-11-22. 넘긴 세션: `리팩터-3차-4`(넷째 세션). 맥락 51% 에서 넘겼다. 앞 인계서는 `REFACTOR_PROD3_HANDOFF_4.md`·`_3.md`·`_2.md`·`REFACTOR_PROD3_HANDOFF.md` 다. **앞 문서들의 규약·배운 것(HANDOFF_2 §6·§7·§8, HANDOFF_3 §4, HANDOFF_4 §4)은 그대로 유효하다.** 다만 HANDOFF_4 §4 의 「위임자 표(`Controller.delegate`)」 는 이제 없다(아래 §1).

## 착수 블록 — 이번 세션의 지시 전부

1. `git status` 가 깨끗한지, 브랜치가 `main` 인지 본다. 직전 커밋은 이 문서를 담은 커밋이다. **main 은 origin 보다 약 230커밋 앞서 있고 푸시 전이다. 푸시는 사용자가 정할 때까지 하지 않는다**(사용자가 "아직 하지 않는다" 로 답했다).
2. **사용자 지시(유효)**: 하나씩 끝나면 커밋한다. 알아서 끝까지 간다. 큰 일은 범위를 줄이지 말고 **하위 이슈로 나눈다.** **e2e 는 하위 이슈마다 돌리지 않는다** — 하위 이슈마다 단위·typecheck·게이트·lint·정적 검사, e2e 는 묶음 끝에 한 번(사용자가 "e2e 를 줄여라" 로 정했다). 병렬로 할 수 있는 일은 작업 트리(`isolation: worktree`)로 나눠 돌린다.
3. 할 일 순서: **① 아이콘 세트 재정비(§2)** → **② PROD3 §8 「정독하지 않은 곳」 읽기 감사(§3)** → ③ 끝에 사용자 보고(§4 의 남은 보고 대상 포함).
4. 규약: 중·대 규모는 SRS(IEEE 29148) → 시험(RED) → 구현. 코드·설계 문서로 답이 나오는 갈림길은 권장안으로 정하고 SRS 결정 표(D-*)에 이유를 적는다. **사용자가 정한 범위를 줄여야 하면 묻는다.**

## 1. 어디까지 왔나 (넷째 세션, `c96988c7..` 약 150커밋)

| 묶음 | SRS | 요지 |
|---|---|---|
| PROD3 FE 나머지 R1~R4 | `REFACTOR3_FE_REST1~4_SRS` | FC-03 redmean(Ayu Mirage 알림색 변경) · FU-17 서브모듈 stage 409 · FC-11 자동 전환 범위 서버 원천 · 큰 함수 분할 · CSS `data-rail`·조각 분할 · **간격 토큰 `--sp-1~8`(사용자 결정: 1~2px 골든 변경 허용, 105곳)** |
| Go FR-RGS-1 · P7 | `REFACTOR3_GO_STRUCT_SRS` · PROD3 P7 | 처리기 14개 분할 · 문서 동기화, 게이트 `check-code-refs`·SRS 상태 검사 |
| FIX · P8 | `REFACTOR3_FE_FIX_SRS` | 작업 중 aria · 숫자 칸 덮어쓰기 · 설정 열 때 다시 읽기 · 죽은 API 2개 삭제 · 계정 범위 서버 원천 |
| QUALITY | `QUALITY_FIX_SRS` · `QUALITY_GO_SRS` · `QUALITY_FLAKY_SRS` | 원래 실패 e2e 5(V80 은 실제 결함 — 접기 단추 30px) · lint 0 · 부팅 순서 · 디코드 문구·customTheme 서버 검증·403 코드·텔레그램 병렬 · 흔들림 원인(앱 결함 둘: SSE 구독 시 전경 이름, 프로필 이름 덮어쓰기) |
| 구조 부채 | `REFACTOR3_FE_REST5_SRS` · `REFACTOR3_FE_DELEG_SRS` | 500줄 초과 JS 0·CSS 0, 100줄 초과 함수 0, FileTree·TerminalTool 부품화, **위임자 768 → 0**(`Controller.delegate` 삭제, 게이트 `check-delegates`) |
| 화면 | `THEME_SEED_COLOR_SRS` FR-SEED-15 | 모바일 메인색 견본 넘침·색 입력 44px |

마지막 검증(`fa990d74` 이후 여러 번): `make gates` · 단위 1532 · typecheck · `make lint` 0 · `go test -race -shuffle=on ./...` 75 패키지 · **e2e 전량 통과 2,304·실패 0**(흔들림 1: `editor-ops` O7). 그 뒤 바뀐 것은 시험 주석 정리·메인색 CSS 둘(관련 e2e 만 통과).

## 2. 할 일 ① — 아이콘 세트 재정비 (인터뷰 끝, 스펙부터)

### 사용자 결정 (2026-11-22)
- 사용자 문제 제기: Repo·History 아이콘이 어울리지 않고, Submodule·Worktree 는 한 번 더 생각해야 이해된다. 짝을 다시 맞추고, 이쁘고 귀엽게 해도 좋다.
- 시안 세 벌(A Lucide 선 / B Phosphor Duotone / C 직접 그린 시범)을 모두 확인한 뒤의 지시: **"너가 최선의 모양, 가장 봤을 때 한번에 이해되는 모양으로 하되, 세 선택지를 왔다갔다 하면 모양의 톤이 달라지니까 톤을 맞춰야 한다 — 두께·느낌 등."**
- 그래서 정한 톤 규칙(넷째 세션이 사용자에게 알렸다 — SRS 결정 표에 그대로 옮긴다):
  - **선 기반 한 벌.** FR-GLY-2(stroke·currentColor) 규약을 유지한다. B(Phosphor, fill 기반)의 **모양**을 고르는 뜻은 선으로 다시 그려 같은 톤에 맞춘다
  - **stroke-width 2.25, round cap/join** 통일(지금 2 → 2.25)
  - **옅은 면(opacity .18)은 「물체」 모양에만** 일관되게(폴더·상자·책·창·말풍선 등). 화살표·꺾쇠·점 같은 기호에는 깔지 않는다
  - **한 뜻 = 한 아이콘, 한 아이콘 = 한 뜻.** 남는 겹침 하나(`chevron-right` 접힘/다음)는 방향 꺾쇠 관례라 둔다(시안 페이지에 이유)
  - 쓰는 곳 없는 `file`·`panel-left` 는 스프라이트에서 뺀다

### 자료 (저장소에 옮겨 두었다 — `/tmp` 는 사라질 수 있다)
`docs/internal/design/icons-2026-11-22/`:
- `proposal.html` — 시안 비교 페이지(뜻 63개 × 지금|A|B|C, 목업, 겹침 해소 표, C 갤러리). 사용자가 본 그것
- `meanings.mjs` — **뜻 63개 표**(id·묶음·뜻·쓰는 자리·지금·A·B·C·이유). 스펙의 원천으로 쓴다
- `gen.mjs` — 시안 생성기. C(직접 그린 16개)의 SVG 경로가 여기 있다. 입력 경로가 `/tmp/icons/pkgs`(lucide-static 1.77.0 · @phosphor-icons/core 2.1.1 를 `npm pack` 으로 받아 푼 곳)·`/tmp/icons/data2.json` 이다 — 다시 돌리려면 `npm pack` 으로 다시 받고 `current-usage.json` 을 그 자리에 둔다
- `current-icons.html` — 지금 아이콘 54개와 쓰는 자리 정리 · `current-usage.json`·`scan.mjs`·`scan2.mjs` — 쓰는 자리 스캔(상수 경유 포함)
- `preview-mock-tokyo-32.png` — 목업 사진

### 진행 권장
1. SRS(`docs/internal/ICON_SET_SRS.md` 류, `UI_KIT_SRS` FR-GLY 를 개정하는 관계를 적는다): 뜻 63개 표 → 뜻마다 최종 모양(근거: 한눈에 이해) · 톤 규칙 D-* · 바뀌는 화면(이전/새/이유) · 라이선스(Lucide 는 **ISC**, Phosphor MIT — 모양을 빌리면 고지)
2. 시험(RED): 스프라이트 심볼마다 stroke 2.25·round·viewBox 24 · 옅은 면 규칙 · 「한 뜻 = 한 아이콘」 을 지키는 정적 검사(뜻 표 ↔ 코드의 쓰는 자리) · 쓰는 곳 없는 심볼 0 · 기존 `web/js/test/icon-glyph.test.mjs` 갱신
3. 구현: 스프라이트(`web/index.html` `#ui-sprite`) 교체 · 쓰는 자리 이름 교체(상수 `GIT_ACT_ICON`·`GIT_REMOTE_ICON`·`AGENT_STATE_ICON`·`EDITOR_TREE_*`·`GIT_BR_*_MARK`·`GIT_COMMIT_MORE`·`GIT_REMOTE_MORE`·`constants-git.js` 탭 표 등과 `UIKit.icon`/`iconHTML`/`#i-` 직접 호출 — `scan2.mjs` 로 전수) · 스타일(`.ui-icon` stroke 값, 옅은 면 클래스)
4. 화면 확인: 넷째 세션의 전후 스크린샷 방법(`/tmp/shots/` 의 `run.sh`·`zz-tmp-shots.spec.ts`·`compare.py` — 없어졌으면 다시 짠다: 두 트리에서 e2e 픽스처로 띄우고 같은 화면을 찍어 PIL 로 차이) 으로 비교 HTML 을 만들어 **로컬 html 파일 경로**를 사용자에게 준다(사용자 선호: 서버 띄우지 말고 파일 경로만. 큰 파일은 브라우저가 못 그리니 이미지는 파일로 두고 상대 경로로 참조)
5. e2e: 아이콘을 단정하는 spec(`grep -rln "i-\|ui-icon\|icon(" e2e`) 을 묶음 끝에

### 시안 단계에서 나온 문서·코드 어긋남 (작업 후 보고 대상)
- `UI_KIT_SRS.md` FR-GLY-3 가 Lucide 를 「MIT」 라고 적음 — 실제 **ISC**
- FR-GLY-4 초기 사상 `undo-2`·`columns-2` ↔ 코드 `undo`·`columns`

## 3. 할 일 ② — PROD3 §8 「정독하지 않은 곳」 읽기 감사

`docs/internal/refactor/PROD3.md` §8 과 넷째 세션 실측(아래)을 따른다. 결함·성능·중복·문서 어긋남을 찾는 **읽기 감사**를 먼저 하고(읽기 전용 분석 에이전트를 영역별로 병렬), 찾은 것을 PROD3 와 같은 표(ID·자리·현상·제안·규모·확인)로 새 문서(`docs/internal/refactor/PROD3_ATTIC.md` 류)에 모은 뒤, 사용자 결정이 필요 없는 것은 묶음으로 고친다(SRS→RED→구현). 동작이 바뀌는 것은 묶어서 사용자에게 묻는다.

대상(기준 이후 거의 손대지 않은 곳):
- Go 도메인: `internal/webserver/domain/ext`(1,939줄) · `lsp`(849) · `sysstat`(712) · `git/store`(496) · `git/jobs`(1,237) · `telegram` 렌더(`render.go`)
- `internal/webserver/gitapi` 의 branch(`handlers_git_branch.go`)·write 처리기 본문
- `internal/shared/edgemesh/mesh.go`(718) · `internal/daemon/chat/service.go`(668) · `internal/shared/edge/config.go`(528) · `internal/shared/runtime/install.go`(497)

## 4. 남은 보고 대상 (사용자에게 마지막에 묻거나 알린다)

- 설정 탭 4곳 터치 하한 미달(`THEME_SEED_COLOR_SRS` D-SEED-7): display `button` 34×18·`#ds-attnedge`·`#ds-focusedge` 120×14 · shortcuts `.ui-key.sc-key` 80×22 · telegram `#tg-token` 316×24 · edges `g.eg-mesh-node.self` 174×30. 공용 시험 `touch-targets` TC-A11Y-13b 가 Profile 탭만 훑어서 못 잡았다 — 고칠지·공용 시험을 모든 탭으로 넓힐지 묻는다
- 재현 못 한 흔들림 7: `ux-audit-fix-7` TC-UXF-94 · `editor-ops` O7 · `edges-settings` 간선 주소·망 그림 · `claude-accounts` TC-CAC-27 · `kit-components` TC-CMP-19 · TC-UXF-1 `ERR_INVALID_HTTP_RESPONSE`(+ 부하에서 본 `editor-cwd-inherit` V-CWD-2 · `git-feedback` F-9.3 · `explorer-copy` C5). 조건은 `QUALITY_FLAKY_SRS` §2.5·§2.6
- linux·win32 레이아웃 기준선: 푸시 뒤 사용자가 GitHub `layout-baseline` 워크플로를 돌린다(`UI_LAYOUT_DEFAULTS_SRS` §9)
- GH-17(폴더 복사 중 잠금) — 사용자 결정: 지금대로 둔다(D-QG-7). 다시 열지 않는다
- 푸시 여부

## 5. 넷째 세션이 값을 치르고 배운 것

- **e2e 가 가장 비싸다.** 하위 이슈마다 관련 spec 을 돌리면 묶음 하나가 30~60분이 된다. 이름 바꾸기 같은 기계적 변경은 정적 검사(파서 스캔으로 옛 이름 0)·단위·typecheck 로 하위 이슈를 닫고, e2e 전량은 합친 뒤 한 번. 다만 **정적 검사는 문자열 `evaluate` 안의 이름과 가짜 앱 대역의 모양을 못 본다** — 위임자 걷기 뒤 첫 전량에서 16건이 그것이었다
- **병렬은 주인이 다른 것끼리.** App 위임자 넷은 계약·`fixtures.ts`·같은 spec 을 같이 고쳐 병렬이 안 됐고, GitPanel·FileTree 는 작업 트리 둘로 병렬이 됐다. 합칠 때 충돌은 「한 줄에 두 쪽 이름이 함께 있으면 둘 다 새 경로로」. 병렬 e2e 는 `E2E_PORT_BASE` 를 다르게, 워커는 `PW_WORKERS=3` 정도로
- **격리 작업 트리는 오래된 커밋(`097d6a73`)에서 시작한다(매번).** 브리프 첫 줄에 「HEAD 를 보고 `git merge --ff-only main`」
- 작업 트리 브랜치를 합칠 때 `docs/internal/decisions.md` 는 충돌 나면 `--theirs` 뒤 `go run ./scripts/gen-decisions` 로 다시 만든다. CHANGELOG·PROD3 §7.1 은 양쪽 줄을 모두 살린다
- 흔들림 재현은 `--repeat-each=N --retries=0` 과 `PW_WORKERS=8`, 다른 샤드를 다른 포트로 함께 돌려 부하를 준다. 원인 대부분은 「상태가 바뀌기 전에 재는」 시험이었고, 둘은 앱의 경합이었다. 재시도·시한 늘리기로 덮지 않는다
- e2e 를 기다릴 때 `pgrep -f "[p]laywright test"`(대괄호가 없으면 기다리는 셸 자신과 맞는다)
- 화면 비교: `0.0.0.0` 서버는 권한 분류기가 막는다(사용자가 명시하면 허락). 사용자는 **로컬 html 파일 경로**를 원한다. 이미지를 base64 로 넣은 3MB 파일은 브라우저가 못 그렸다 — 이미지는 파일로 두고 상대 경로
- playwright MCP 는 `file:` 을 막고 `.playwright-mcp/` 안에만 쓴다 — 확인은 `127.0.0.1` 임시 서버로, 끝나면 끈다
- 하위 에이전트가 끝나도 백그라운드 e2e 를 남기는 일이 있다 — 브리프 끝에 「백그라운드 작업 정리」

## 6. 변하지 않는 규약 · 유효한 사용자 결정

`REFACTOR_PROD3_HANDOFF_2.md` §7·§8 과 같다. 더한 것: PROD3 §6 Q8(간격 토큰 골든 변경 허용) · GH-17 유지 · FX-6 죽은 API 삭제 · FX-7 계정 범위 서버 원천 · 위의 아이콘 결정. 툴팁·`aria-label` 은 영어, 보이는 글자는 로케일. 하드코딩 색 금지. 문서와 코드가 충돌하면 코드를 우선하고, 어긋남은 모았다가 끝에 보고해 사용자가 고를 때 문서를 고친다. 커밋 메시지에 AI 서명 금지.
