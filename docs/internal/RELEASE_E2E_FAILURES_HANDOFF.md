# 인계: 릴리스 전 e2e 실패 4건 정리 → CI 확인 → 릴리스

> 2026-11-10. 앞 세션(ARD-단계4)이 맥락이 차서 넘긴다. 이 문서의 「착수 블록」이 다음 세션의 지시 전부다.

## 착수 블록

1. 아래 「실패 4건」 을 하나씩 원인부터 본다. 모두 **이번 작업 전에도 실패하던 것**이다(커밋 `10868e05` 에서 같은 4건이 실패함을 확인했다). 그래서 회귀가 아니라 원래 있던 결함이거나, 낡은 시험이다.
   - 원인이 제품 결함이면 고친다. 시험의 기대가 낡았으면 시험을 고치되, 근거가 되는 SRS 요구를 확인하고 이유를 커밋 메시지에 적는다.
   - 규모가 중·대(여러 모듈·동작 변경)로 커지면 멈추고 사용자에게 묻는다.
2. 고칠 때마다 그 시험을 단독으로 돌리고(`--retries=0`), 끝에 `make gates`·`make lint`·`npm run unit`·`npm run typecheck` 와 바꾼 Go 패키지의 `go test` 를 돌린다.
3. 커밋하고(AI 서명 없이) `git push` 한다. CI `verify` 를 끝까지 본다: `gh run list --workflow verify.yml --branch main --limit 3` → `gh run watch <id> --exit-status`. 실패하면 `gh run view <id> --log-failed` 로 원인을 본다.
4. 로컬 전체 e2e 를 한 번 더 돌린다: `npx playwright test --reporter=line` (약 24분). CI 의 e2e 는 꺼져 있다(아래 규약).
5. 모두 통과하면 **사용자에게 판 번호를 묻고** 릴리스한다. 릴리스 절차는 `.github/workflows/release.yml` 과 CHANGELOG 의 판 형식을 따른다(`## [Unreleased]` → `## [x.y.z] — 날짜`). 태그는 `v*`. 사용자 확인 없이 태그를 푸시하지 않는다.
6. 맥락이 차면 `/dongminal:migration` 으로 넘긴다. 이 문서를 고쳐 쓴다.

## 지금 상태

- `main` = `ae4ce8f0`, 원격과 같다. 작업 트리 깨끗.
- CI `verify` (`42809820388`, `ae4ce8f0`): **6잡 모두 통과** (gates · frontend · test ubuntu · test windows · linux-runtime · windows-runtime).
- 로컬 전체 e2e (`e9f465c5` 기준, 2,068건): 2,060 통과 · 3 건너뜀 · 5 실패.
  - 4건은 아래(원래 있던 실패).
  - 1건 `editor-find-panel.spec.ts:431` FR-M9-9 는 전체 실행에서만 실패했다. 단독 3회·파일 전체 18건은 통과. 이전 커밋에서도 통과. **가끔 실패하는 시험**으로 본다 — 전체 e2e 에서 다시 실패하면 그때 본다 (실패 때 `ruler` 2, 기대 4: 개요 눈금이 일치 수보다 적게 찍힘).

## 실패 4건 (전체 실행 로그에서 뽑은 그대로)

### 1·2. `e2e/event-timer-hub-contract.spec.ts:122` T-1 · `:146` T-1b

```
Error: page.evaluate: TypeError: Cannot read properties of undefined (reading '_rPaintTitles')
   at ../web/js/core/app-ws-sync.js:271
```

시험이 부르는 `app-ws-sync.js:271` 근처에서 `_rPaintTitles` 를 가진 객체가 undefined 다. 이름이 바뀌었거나 그 객체(렌더러)가 다른 자리로 옮겨진 뒤 시험이나 코드가 따라오지 않은 것으로 보인다. 먼저 `_rPaintTitles` 의 정의와 참조를 LSP/grep 로 찾는다.

### 3. `e2e/git-sidebar.spec.ts:233` S7

```
Error: GIT 목록이 아직 사이드바 높이의 절반 아래다
expect(received).toBeGreaterThan(expected)   Expected: > 200   Received: 182
  255 |     // V-SBT-2: 40% 상한이 사라졌다 — 남은 높이 전부를 쓴다.
```

GIT 목록 높이가 182px 로 기대(200 초과)보다 작다. 사이드바의 다른 요소가 높이를 더 먹게 됐거나 시험의 뷰포트 가정이 낡았을 수 있다.

### 4. `e2e/ui-layout-defaults.spec.ts:186` V-LAY-1 (FR-LAY-50)

```
계산값이 달라진 자리 10개:
terminal|input.sbx-input :: display block → inline-block
git:changes|input.sbx-input :: display block → inline-block
… (git:diff · history · branches · stash · console · worktrees · submodules · editor 도 같다)
```

`input.sbx-input` 의 계산된 `display` 가 기준선 `block` 과 다르게 `inline-block` 이다. 기준선 파일(시험이 읽는 것)과 CSS 중 어느 쪽이 맞는지 정한다 — 최근 CSS 변경이 의도한 것이면 기준선을 고친다.

## 이번 날(2026-11-10) 커밋 — 참고

| 커밋 | 내용 |
|---|---|
| `315ddeee`·`c6229742`·`712379c7`·`4fd9a7b5` | ARD 단계 1~4 (`AGENT_RECORD_DAEMON_SRS`) |
| `ee7fe105` | 맥락 경고 기록 영속 되돌림 (D-ARD-10) |
| `1244018c`·`994fe338`·`f1e8c684` | SRS 문장 정리, `PutRecord`·`record` push 제거 (D-ARD-11) |
| `844556c4` | 패널 레이아웃 탭별 + 저장 레이아웃 (`PANEL_LAYOUT_SRS`) |
| `b613b495` | Run 비활성 노드 (`RUN_INACTIVE_NODE_SRS`) |
| `e9f465c5` | issue-tree 세션 시작 점검 (FR-ITA-20) |
| `ae4ce8f0` | Windows CI 단위 시험 4건 수정 (보고 소켓 모드 · peer 리스너 닫기 · worktree 시험 autocrlf) |

## 이 세션이 값을 치르고 배운 것

- **CI e2e 는 꺼져 있다** (`.github/workflows/e2e.yml` 의 `if: false`, 2026-11-04 사용자 결정). 릴리스의 `e2e-gate` 는 `skipped` 도 통과로 받는다. e2e 는 로컬(macOS)에서만 돈다.
- **실패가 회귀인지 가리는 법**: `git worktree add -q /tmp/dm-base <이전 커밋>` → `ln -s <저장소>/node_modules /tmp/dm-base/node_modules` → 거기서 `npx playwright test <spec:line> --retries=0`. 끝나면 `git worktree remove --force /tmp/dm-base && git worktree prune`.
- e2e 의 기본 리포터는 통과 수를 끝에 찍지 않는다. `--reporter=line` 또는 `list` 를 쓴다.
- Windows 에서만 깨지는 Go 시험: POSIX 권한 비트(소켓·파일 모드), `core.autocrlf`(서버 git 은 시스템 설정을 읽고 `gittest.Run` 은 끈다), 고루틴 시작 전 Close 경쟁. `GOOS=windows go vet` 으로 컴파일만은 로컬에서 본다.
- 게이트가 잡는 것: e2e 의 고정 대기(`waitForTimeout`)는 `TEST-16` 표식과 사유가 있어야 한다 · 저장소 직접 접근은 `PrefStore` 밖에서 금지(예외표 `scripts/check-storage.mjs`) · SRS 상태는 enum(`승인·구현중` 이면 `> **남은 것**:` 줄) · i18n 키는 `t('…')` 글자로 써야 쓰인 것으로 센다 · 바꾼 SRS 는 `go run ./scripts/gen-decisions`.
- CHANGELOG 의 `### 바뀜` 은 여러 판에 있다 — `[Unreleased]` 의 것(파일에서 첫 번째)에 넣는다.

## 규약 (변하지 않는 것)

- 사용자 전역 지침 `~/.claude/CLAUDE.md`: 한국어 응답 · 심볼 탐색은 LSP → Serena → grep · 커밋 메시지에 AI 서명 금지 · 동작이 바뀌면 이전/새/이유를 CHANGELOG 에 적는다 · 중·대 규모는 SRS → 시험 → 구현.
- 데몬 재시작(`dongminal start --restart-daemon`)은 하지 않는다. 사용자가 정한다.
- 릴리스 태그는 사용자 확인 뒤에만 푸시한다.

## 사용자 결정 (유효)

- 원래 있던 e2e 실패 4건은 **원인을 보고 고친 뒤** 릴리스한다 (2026-11-10, "보고 가자").
- 원격 PC 의 git 관측 오류(`age=never`)는 다시 정상이라 넘어간다. 다시 생기면 Network 탭의 `/api/git/status` 상태를 받는다.
- 실 사용 확인(서버만 재시작 시 기록 유지, TC-ARD-40)은 사용자가 직접 한다.
