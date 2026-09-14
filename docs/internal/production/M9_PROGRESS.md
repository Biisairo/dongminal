# M9 진행 — M8 이 남긴 것 + 사용자 이슈 9건

> 로드맵 §M9. 스펙은 [`M9_SRS`](../M9_SRS.md) (승인·구현중). 단계는 스펙 §4 —
> P1 재감사·스펙·작은 확정 건 → P2 크기 통보·재연결 → P3 스킬·테스트 결정성 → P4 구조.

---

## 1. 어디까지 왔나 (2026-09-14, 첫 세션 — **P1 완료**)

| 단계 | 상태 |
|---|---|
| **P1** 재감사 · 스펙 확정 · 작은 확정 건 | **완료** — 아래 §1-1·§1-2. 16항목 재감사 실측(§2.3) · 사용자 결정 일곱 · FR-M9-1·2·4·5·7·8·9·11·12 + FR-M9-18(구현 중 발견) + FR-M9-19(사용자 요구) 구현 · Go `-race -shuffle` 초록 · `make gates` 초록(36) · `make unit` 146/146 · 전량 e2e §1-3 |
| **P2** FR-M9-3(`OpSize`) · FR-M9-10(재연결 재수신) · B2 추적 | 미착수 |
| **P3** FR-M9-6(`migration` 스킬) · FR-M9-13·14(고정 대기) · FR-M9-16(§5-5 군집) | 미착수 |
| **P4** FR-M9-15(500줄) · FR-M9-17(GO-44) | 미착수 |

**사용자 결정 일곱은 P1 착수 중에 해소됐다** (2026-09-14): 노출 게이트 삭제 ·
비소유자는 소유자 크기를 따른다 · dmctl `--force`/`--background` · diff 미니맵은 끈 채
본문 폭 확보 · 인계는 문서+엔벨로프 · 키바는 가려짐 표식 · 고아 탭은 "다른 기기·dmctl 로
지운 것이 내 화면에 남는 것". 스펙 §5 의 D-M9-1~9 가 그 기록이며 `decisions.md` 를 다시 만들었다.

### 1-1. P1 재감사 판정 (16항목)

실측의 근거와 수치는 스펙 §2.3 이다. 여기는 **무엇으로 갈렸는가**만 적는다.

| 갈래 | 항목 | 요지 |
|---|---|---|
| **재현 + 기전 확정** | M9-B3 | 폭이 다른 두 클라이언트. 모바일(44열)이 PTY 를 잡으면 그 폭 기준 이스케이프가 나가고 데스크톱(151열)이 자기 폭으로 해석해 **앞 4줄이 사라졌다**. 와이어에 서버→클라이언트 크기 통보 op 가 없다 |
| | M9-B5 | diff 의 미니맵은 애초에 `enabled:false`(폭 0). 겹치던 것은 편집기 **안**의 개요 눈금 14px 이었다 |
| | M9-B9 | SSE 가 끊겼던 동안의 삭제는 **다시 붙어도**(readyState 1) 반영되지 않는다 — 실측 클라 3탭 / 서버 1탭, 14초까지 수렴하지 않았다 |
| | M9-B7 | ① 모바일 탭의 `×` 아이콘 중심이 탭 중심보다 **15.5px 위** ② 키바 내용 폭 830px 이 390px 안에 (열 개가 화면 밖, 표시 없음) |
| | M9-B1 | 경고가 아니라 **기동 거부**(exit 1). 새 발견: 도구 셸이 `DONGMINAL_HOST=0.0.0.0` 을 물려받아 `--isolated` 만 줘도 걸린다 |
| | M9-A3 | `--repeat-each=8` 로 **3/8 재현**. 원인은 제품이 아니라 테스트 한 줄 |
| **재현 실패 — 조건 좁힘** | M9-B2 | 셸 도구에서는 재현되지 않았다(탭 전환·델타 재개·DOM 렌더러 셋 다 `viewportY===baseY`). 남은 조건: TUI · 전량 재생 · `_restoreScrollOf` 가 `vis` 아닌 순간에 도는 경로 |
| **설계대로임을 확인 — 사용자가 좁혀 줌** | M9-B9(①②) | `exit` 한 탭이 오버레이로 남는 것(FUI-14)과 탭 0 인 에디터 창(FR-EDT-52)은 둘 다 설계다. 사용자가 지목한 것은 셋째 경로였다 |
| **결정으로 닫음** | M9-A4 | `go test` 전량 **82초**(패키지 시간 합 286초 — 패키지 간 병렬은 이미 돈다). `t.Parallel()` 도입 조건이 서지 않는다 (D-M9-9) |
| **수치 확인 (변동 없음)** | M9-A1·A5·A6·A7 | `.Service()` gitapi 비테스트 72 · `sandboxplace` 고정 대기 4+1 · `time.Sleep` 98 · 500줄 초과 비테스트 20 |
| **단계 말로 미룸** | M9-A2 | 전량 e2e 3회가 근거이므로 P3 에서 잰다 |

### 1-2. P1 항목별 구현 판정

| 요구 | 판정 | 어디에 |
|---|---|---|
| FR-M9-1 | **해소** — 노출 게이트 삭제. `expose_gate.go` 와 그 테스트 일곱, `--insecure-no-acl`(옵션·필드·헬프)이 함께 사라졌다. `REQUEST_GATE_SRS` FR-RQG-20 은 ⊘ 철회로 표시하고 **남은 위험(무인증 노출)을 그 자리에 적었다**. `FR-RQG-21`·`24` 는 그대로 | `cli/start.go` · `cli/options.go` · `cli/help.go` · `expose_start_test.go` · `exposure_label_test.go` · `REQUEST_GATE_SRS` §3.5·§4.4·§7 |
| FR-M9-2 | **해소** — `exposeFlagHost` → `startFlagHost`. 격리는 `--expose` 를 함께 주지 않는 한 `dmenv.DefaultHost` 를 플래그 계층에 낸다(환경변수를 이긴다) | `cli/config.go` · `expose_start_test.go` |
| FR-M9-4 | **해소 — 경계의 양 끝** — dmctl 에 `--force`/`--background`(배타, 닫기 전용), 브라우저에 `_closeOpts` + `delWindow(sid,opts)` + `closeWindow` 갈래. `--background` 는 `force` 를 함께 싣는다(답을 준 요청이 확인창을 만나면 멎는다) | `runtimebin/dmctl.go` · `dmctl_close_test.go` · `app-cmd.js` · `app-layout.js` · `commands.md` |
| FR-M9-5 | **해소** — `minimap:{enabled:false}` **명시** + `overviewRulerLanes:0`. 변경 표식은 diff 자신의 눈금(본문 밖)에만 남는다. 남는 겹침은 세로 스크롤바 14px 하나이며 그것은 Monaco 의 오버레이다(기록) | `constants-git-diff.js` · `git-diff.spec.ts` D14 |
| FR-M9-7 | **해소** — `body.mobile .pn-tab-x` 에 flex 가운데 정렬. 폭 18 은 그대로(E-4) | `style.css` · `m9-p1-ui.spec.ts` TC-M9-7 |
| FR-M9-8 | **해소** — `_mkbOverflowWatch` 가 `data-overflow`(`none`/`right`/`left`/`both`)를 적고 `::before`/`::after` 가 그림자를 그린다. **`position:sticky`** 다 — 가로 스크롤 상자에서 `absolute` 는 내용과 함께 밀린다. 음수 마진으로 자리를 차지하지 않아 키 수가 줄지 않는다 | `app-mobile.js` · `style.css` · `m9-p1-ui.spec.ts` TC-M9-8 |
| FR-M9-9 | **해소** — `_findPaint` 가 `overviewRuler`(`Right` 레인)·`minimap` 장식을 함께 붙인다. 색은 `monacoTheme()` 의 네 키에서 온다 — 현재 일치는 다른 키 | `file-editor-find.js` · `file-editor.js` · `constants-editor.js` · `editor-find-panel.spec.ts` |
| FR-M9-11 | **해소** — 불투명도 단정을 `expect.poll` 로. `--repeat-each=16 --workers=1` 이 16/16(이전 3/8 flaky) | `bg-kill.spec.ts` |
| FR-M9-12 | **결정** — GO-42 는 열지 않는다 (D-M9-9). 측정이 근거다 | 스펙 §5 |
| FR-M9-19 | **해소 (사용자 요구, 작업 중 접수)** — 탐색기 우클릭에 `절대 경로 복사`·`상대 경로 복사`. 상대의 기준은 그 탐색기 루트(D-M9-10). `pathRelative` 를 새로 두고(기존 `pathRel` 은 git 의 키라 구분자를 `/` 로 굳힌다 — 다른 함수다) 쓰기는 `TermClipboard.write` 한 벌 | `helpers.js` · `constants-editor.js` · `file-tree-xfer.js` · ko·en · `path-relative.test.mjs` 7건 · `explorer-copy.spec.ts` C9 |
| FR-M9-18 | **해소 (구현 중 발견)** — `Jobs.finish` 가 Done 을 공개한 **뒤** 기록을 썼다. `기록 → 훅 → 공개` 로. `-shuffle` 12회 중 3회 실패하던 것이 15회 연속 초록. 결정적 검사를 훅 안에 세웠다 | `git/jobs/job.go` · `job_test.go` · `GIT_SRS` FR-GIT-107 보강 |

### 1-3. 전량 e2e (P1 판정)

| 회차 | 결과 | 비고 |
|---|---|---|
| ① | **무효** | 내가 **전량이 도는 중에 Go 소스를 고쳤다.** 샤드 6·7·8 이 `go build` 에서 죽고 샤드 5 는 158건이 떨어졌다. 판정으로 세지 않는다 (§2-9) |
| ② | unexpected **1** · flaky 1 | `editor-minimap.spec.ts` **V-MMP-2b** — FR-M9-5 가 바꾼 계약(`GIT_DIFF_OPTIONS.minimap`)을 그 검사가 아직 옛 값으로 못박고 있었다. 검사와 `UX_BATCH8_SRS` FR-MMP-2 를 함께 고쳤다 (§2-8). flaky 는 `TC-AGT-11`(`page.goto` → `ERR_INVALID_HTTP_RESPONSE`) — `--repeat-each=8` 단독 8/8 초록 |
| ③ (FR-M9-19 포함) | **unexpected 0** · flaky 4 | flaky 넷 전부 재시도 통과: `slot-view-state` TC-SVS-40·51(§5-5 군집의 `slot-*` 그리기 대기 그대로) · `editor-save` TC-ESV-3 · `repo-diff-edit` E3. **뒤 둘은 `--repeat-each=8` 단독 8/8 초록** — 제품 결함이 아니라 군집의 이웃이다 (FR-M9-16, P3) |
| ④ | **unexpected 0** · flaky 5 | ③ 직후 표적 실행이 `test-results/` 를 덮어 `make e2e-rebalance` 가 리포트를 찾지 못했다 (§2-10). 코드 변경 없이 한 번 더 돌렸다 — **failed 0 · did not run 0 · 1666 passed**. flaky 다섯은 전부 **M9-A2 가 지목한 `git-*` 관측 주기 대기**다: `git-live-triggers` TC-GLW-4 · `git-observe-revive` TC-GOR-6 · `git-refresh-lifecycle` V-GRF-1 · `editor-explorer` X15 · `git-ui-metrics` V81. 군집이 그 자리에 그대로 있다는 확인이며 판정은 P3 의 것이다 (FR-M9-16). 직후 `make e2e-rebalance` 초록 — 158스펙 3665s, 불균형 1.00배 |

**판정**: P1 의 DoD 는 `unexpected 0` 이고 ③·④ 가 그것을 충족한다. flaky 는 M8 과 같은 취급이다 —
수를 적고, **반복으로 재현되는 것만** 결함으로 올린다 (§2-39). ③의 넷 중 둘을 그렇게 확인했고
(단독 8/8 초록) ④의 다섯은 이름이 이미 M9-A2 의 목록에 있다.

---

## 2. 배운 것

### 2-1. (P1) "경고" 라 불린 것이 기동 거부였다

접수한 말은 "최초 expose 실행 시 … 경고가 뜬다" 였다. 실측은 경고가 아니라 **exit 1** 이었다 —
`--insecure-no-acl` 없이는 서버가 아예 뜨지 않는다. 그리고 사유 셋(목록이 없다·꺼져 있다·
항목이 없다)이 각각 다른 문장을 내는데, 사용자에게는 그 셋이 하나로 읽혔다("IP 등록을 요구한다").
**사유를 가르는 것은 고칠 자리를 알려 주는 것이지, 막는 이유를 설명하는 것이 아니었다.**

재감사가 아니었으면 "경고 문구를 지운다" 로 끝났을 것이고 게이트는 남았을 것이다. 접수한
말의 **등급**을 실측으로 확인하는 것이 재감사의 첫 값어치다.

### 2-2. (P1) 같은 바이트를 다른 폭으로 읽으면 그 해석이 틀린다

M9-B3 의 가설은 넷이었다(리사이즈 소유 · 재생 스냅샷 · 기기 간 cols/rows · xterm 리플로우).
한 클라이언트 안에서는 **어느 것도 재현되지 않았다** — 데스크톱 → 모바일 → 데스크톱 왕복 뒤
버퍼가 정확히 원래대로 돌아왔다(25줄, 문자 단위 일치). xterm 의 리플로우는 멀쩡했다.

깨진 것은 **두 클라이언트가 동시에 볼 때**였다. 모바일이 포커스 소유자가 되어 PTY 를 44열로
잡으면 zsh 의 줄편집기가 44 기준으로 커서를 옮기고, 그 바이트를 151열로 해석한 데스크톱에서는
앞 4줄이 사라졌다. **소유는 이미 있었고(FR-XDF) 없던 것은 그 사실을 나머지에게 말하는 길이다** —
`toolhub/conn.go` 의 서버→클라이언트 op 는 다섯뿐이고 그중에 크기가 없다.

교훈: "리플로우가 깨진다" 는 한 프로세스 안의 가설이고, 접수한 말("다른 기기에서 쓰고
돌아오면")은 **둘**을 말하고 있었다. 재현 환경이 사용자의 환경과 같은 수의 참여자를 가져야 한다.

### 2-3. (P1) 죽은 옵션은 반대로 적혀 있었다

`GIT_DIFF_OPTIONS` 의 `minimap:{size:'fill'}` 에는 "미리보기도 같은 좌표계에 선다" 는 열 줄짜리
근거가 붙어 있었다. 실측하니 diff 의 `minimap.enabled === false`(폭 0) — `createDiffEditor` 의
기본값이 그렇고 `size` 는 켜진 미니맵의 값이다. **주석이 말하는 동작이 한 번도 일어나지 않았다.**

그래서 사용자가 본 "미니맵 영역" 은 미니맵이 아니라 편집기 안의 개요 눈금 14px 이었고, 고칠
자리도 미니맵이 아니었다. 고친 뒤 `enabled:false` 를 **적어 둔** 것이 이 변경의 절반이다 —
없는 것을 없다고 적지 않으면 다음 사람이 같은 착각을 한다.

### 2-4. (P1) 검사가 결함 위에서 초록이었다 — 쉼표 선택자

FR-M9-7 의 첫 검사는 `querySelector('.pn-tab-x svg, .pn-tab-x')` 로 닫기 표식을 집었다. 쉼표
선택자는 **문서 순서상 먼저 오는 것**을 돌려주므로 언제나 상자(`.pn-tab-x`)가 잡혔고, 그 상자는
세로 44 를 받아 탭 안에서 이미 가운데에 선다. 결함을 되돌려 놓고 돌려도 초록이었다.

RED 를 **실제로 보는** 것이 이것을 잡았다(`git stash` → 실행 → 15.5px 이 아니라 통과). 아이콘을
집도록 고치고, "상자를 쟀으면 이 검사는 아무것도 말하지 않는다" 는 단정을 하나 더 넣었다.
**테스트가 무엇을 집었는지도 테스트의 대상이다.**

### 2-5. (P1) 가로 스크롤 상자 안에서 `absolute` 는 내용과 함께 밀린다

키바의 가려짐 표식을 `position:absolute; left:0` 으로 두자 스크롤과 함께 밀려 화면 밖으로
나갔다 — 스크롤 상자의 절대 위치는 **보이는 끝이 아니라 스크롤 원점** 기준이다. 키바가 flex 라
두 의사요소가 곧 flex 항목이고, `position:sticky` 가 그것을 보이는 끝에 붙인다. 음수 마진으로
자리를 없애 키의 수는 줄지 않는다(E-3 의 근거를 건드리지 않는다).

### 2-6. (P1) §2-39 의 교훈이 두 번째로 값을 했다

TC-BGK-12 를 군집에 넣기 전에 `--repeat-each=8` 로 돌렸고 3/8 이 재현됐다. 실패는 전부
`Expected "1" / Received ""` — 빈 문자열은 **요소가 문서에서 떨어졌다**는 뜻이다. 그리고 바로
**한 줄 아래**의 `boundingBox` 단정에는 그 사유를 적은 주석과 `expect.poll` 이 이미 있었다.
같은 재렌더를 아는 코드가 한 줄 위에는 적용되지 않았다.

TC-AGT-4 는 그렇게 잡은 제품 결함이었고 이번 것은 테스트 결함이다. 갈라지는 자리는 같다 —
**반복으로 재현한 뒤 무엇이 규약을 어겼는지 본다.**

### 2-7. (P1) M8 이 "초록" 이라 적은 명령이 흔들리고 있었다

P1 을 마치고 `go test -race -shuffle=on -count=1 ./...` 을 돌리자 `git/jobs` 가 떨어졌다
(`기록: []`). 내 변경은 그 패키지를 스치지도 않는다. **clean 트리에서 같은 명령을 12회
돌리자 3회 떨어졌다** — 선재 결함이고, M8 P7 의 "초록" 은 그 회차의 사실이었다.

원인은 한 함수 안에 있었다. `Jobs.finish` 는 M8 P1 ②가 **훅**을 "끝이 공개되기 전" 으로
옮기면서 그 사유를 열 줄짜리 주석으로 적어 두었는데, **기록**(`RecordWrite`/
`RecordUnguarded`)은 여전히 공개 **뒤**에 있었다. 규칙은 세웠고 그 규칙을 어기는 이웃은
세 줄 아래 그대로 있었던 것이다.

교훈 둘. ① **한 번의 `-shuffle` 초록은 판정이 아니다** — 흔들리는 것은 반복으로만 보인다
(§2-6 과 같은 도구, 다른 층). ② **규칙을 세운 커밋은 그 규칙의 다른 적용처를 함께 세어야
한다.** "훅은 공개 전에" 를 적을 때 "이 함수에서 공개 뒤에 도는 것이 또 무엇인가" 를
묻지 않았다.

검사는 훅 **안에서** 기록 수를 센다. 밖에서 `Done` 을 기다렸다 세는 형식은 창이 좁아
12회 중 3회만 걸리고, 그런 검사는 결함이 있어도 대개 초록이다.

### 2-8. (P1) 계약을 바꾸면 그 계약을 못박은 검사를 찾아야 한다

FR-M9-5 는 `GIT_DIFF_OPTIONS.minimap` 의 값을 바꿨다. 근거 문서(`M9_SRS`)는 고쳤고 새 검증
(`git-diff.spec.ts` D14)도 썼다. 그런데 **그 옛 값을 못박는 검사가 이미 있었다** —
`editor-minimap.spec.ts` 의 `V-MMP-2b`("diff 옵션이 편집기와 갈라졌다"). 전량 e2e 가 그것을 잡았다.

내가 돌린 것은 **내가 건드린 파일의 스펙**뿐이었다(`git-diff`·`editor-find-panel`·새 파일).
계약을 바꾸면 찾아야 하는 것은 그 **값**이지 파일이 아니다 — `GIT_DIFF_OPTIONS.minimap` 한 줄만
`grep` 했어도 나왔다.

그리고 고칠 것은 검사만이 아니었다. `V-MMP-2b` 는 `UX_BATCH8_SRS` FR-MMP-2("편집기와 diff
둘 다")를 딛고 있었으므로 그 조항도 개정해야 했다 — diff 가 그 조항에서 빠진다는 것, 그리고
**그 값이 diff 에서 한 번도 효력이 없었다**는 사실과 함께. "동작을 바꾸면 근거 문서를 같은
변경에서 고친다" 의 근거 문서는 **한 장이 아닐 수 있다.**

### 2-9. (P1) 전량이 도는 중에 소스를 고쳤고, 그 회차를 통째로 잃었다

규약은 "전량 중 `web/js`·CSS·`scripts/`·`e2e/` 를 고치지 마라" 였다. 나는 **Go 소스**를 고쳤다 —
목록에 없다는 이유로. 각 샤드는 시작할 때 `go build` 로 자기 바이너리를 만들고, 마침 그 순간
미사용 import 로 빌드가 깨져 있었다. 샤드 6·7·8 이 `go build` 에서 죽고 샤드 5 는 158건이 떨어졌다.

목록은 예시였고 규칙은 **"전량이 도는 동안 제품 소스를 건드리지 않는다"** 였다. 회차 하나를
잃는 것으로 끝났지만, 더 나쁜 결과는 그 회차를 **믿는 것**이었다.

### 2-10. (P1) 표적 실행이 전량의 리포트를 덮는다 — 리밸런스는 **직후**다

전량이 `unexpected 0` 을 낸 뒤 flaky 넷을 `--repeat-each` 로 확인했고(§2-39 규약), 그러고 나서
`make e2e-rebalance` 를 불렀더니 "JSON 리포트를 찾지 못했다" 였다. 표적 실행이 `test-results/`
아래 샤드별 `report.json` 을 덮은 것이다.

규약은 이미 그 순서를 적고 있었다 — "전량 직후 `make e2e-rebalance`, **그 뒤** 표적". 순서가
취향이 아니라 **의존**이라는 것을 읽지 못했다. 되돌리는 값은 전량 한 회차(7분)였다.

### 2-11. (P1) `stop` 의 홈과 포트는 각각 풀린다 — 운영 인스턴스를 내렸다

검사용 격리 인스턴스를 치우려고 이렇게 돌았다:

```
for h in <격리홈들>; do dongminal stop --all --home "$h"; done
```

`--home` 으로 격리를 지목했으니 격리만 죽는다고 읽었다. **`--port` 를 주지 않으면 포트는**
**환경변수 `DONGMINAL_PORT` 에서 온다** — 도구 셸이 물려준 그 값은 **운영 포트(58146)** 였다.
홈과 포트는 한 덩어리가 아니라 각각 풀리는 값이고, 그래서 "격리 홈 + 운영 포트" 라는 조합이
만들어져 운영 서버가 내려갔다.

잃은 것은 없었다 — 데몬(`dongminal d`)이 PTY 를 들고 있어 창·탭·도구가 전부 살아 있었고
`dongminal start` 한 번으로 그대로 돌아왔다. 그 사실이 이 사고를 **작게** 만들었을 뿐
옳게 만들지는 않는다.

규칙 둘. ① **인스턴스를 지목하는 명령은 `--home` 과 `--port` 를 함께 준다.** 한쪽만 주면
나머지는 환경이 채우고, 이 워크스페이스의 환경은 언제나 운영을 가리킨다. ② 격리 인스턴스를
띄울 때 그 **정지 명령을 그 자리에 적어 둔다** — 기동 출력이 이미 `정지: dongminal stop --all
--port <P> --home <H>` 를 통째로 찍어 준다. 그것을 그대로 쓰면 이 실수가 나지 않는다.

---

## 3. 실측 방법 (다음 세션이 그대로 쓸 것)

### 3-1. 격리 인스턴스

```
DONGMINAL_HOST=127.0.0.1 /tmp/dm-m9 start --isolated --port 39321
```

`DONGMINAL_HOST` 를 **명시**해야 한다 — 도구 셸이 운영 인스턴스의 `0.0.0.0` 을 물려준다.
(FR-M9-2 가 그것을 고쳤으므로 그 뒤로는 `--isolated` 만으로 된다.)

**정지는 기동 출력이 찍어 준 줄을 그대로 쓴다:**

```
dongminal stop --all --port <그 포트> --home <그 격리홈>
```

`--port` 를 빼면 환경변수의 **운영 포트**가 채워져 운영 서버가 내려간다 (§2-11 에서 실제로 냈다).

### 3-2. 두 클라이언트 (M9-B3·B9 가 쓴 것)

Playwright 의 탭 둘은 **뷰포트가 따로**다 — `browser_tabs new` 뒤 각 탭에서
`browser_resize` 하면 한 브라우저로 모바일 폭과 데스크톱 폭을 동시에 세울 수 있다.
같은 도구를 두 탭이 열면 그것이 곧 두 기기다.

### 3-3. 잠든 기기 (M9-B9)

```js
window.__origFetch = window.fetch;
window.fetch = (u)=> /\/api\/(workspace|events)/.test(String(u)) ? new Promise(()=>{}) : window.__origFetch(...arguments);
app.bus._es.close();
window.EventSource = function(){ throw new Error('offline') };
```

되살릴 때는 둘을 되돌리고 `visibilitychange`·`focus`·`online` 을 쏜다.

### 3-4. Monaco 의 사실

레이아웃은 픽셀이 아니라 `editor.getLayoutInfo()` 로 읽는다(`minimap.minimapWidth`·
`overviewRuler.width`·`contentWidth`). 옵션의 실제 값은 `editor.getOption(monaco.editor.EditorOption.<name>)` —
**우리가 넘긴 값이 아니라 Monaco 가 채택한 값**이며, B5 의 실체가 그 차이였다.

---

## 4. 커밋

| 단계 | 커밋 |
|---|---|
| P1 | `e604cb5` |
