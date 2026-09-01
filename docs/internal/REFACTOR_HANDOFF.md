# 인수인계 — 리팩터 브랜치 (`refactor`)

> 세션 종료 시점의 상태. 근거 SRS 넷은 §6 에 있다.
> **모든 변경이 커밋·푸시돼 있다.** 워킹 트리는 비어 있어야 한다.

## 0. 한 줄 상태

**아홉 단계가 끝났고 열린 항목이 없다.** 통짜 파일 분할, e2e 헬퍼 회수, flaky
수정, `RunsPanel` 추출, 추출 후보 넷 재측정(전부 패스), `app-attn.js` 공용 유틸
회수, **복원 경쟁 조사**, **복원 비행 결함 수정**, **`agents-poll` 배선 회수**.

`App` 상태 추출 노선은 종결됐고(§3.1), `FG_RESTORE_RACE_SRS` §7.4 가 미조사로
남겼던 복원 경쟁도 조사·수정까지 끝났다. **남은 것은 `main` 병합 판단 하나뿐이다.**

---

## 1. 무엇을 했나

| 단계 | 결과 | SRS |
|---|---|---|
| 통짜 파일 넷 분할 | `tool.go` 1,390→5파일 · `panel.js` 2,984→10 · `file-tree.js` 1,279→5 · `style.css` 2,673→4 | `SPLIT_REFACTOR_SRS.md` |
| e2e 헬퍼 회수 + 죽은 코드 | 43파일 −410줄 · staticcheck 14→8 | `E2E_HELPER_RECLAIM_SRS.md` |
| flaky 수정 | `tab-names` 3/10 실패 → **10/10 통과** | `FG_RESTORE_RACE_SRS.md` |
| `RunsPanel` 추출 | `app-runs.js` 730→38줄 · App 필드 88→77 | `APP_STATE_EXTRACT_SRS.md` |
| 추출 후보 넷 재측정 | `statusbar`·`editor`·`attn`·`reload` **전부 패스**. 코드 변경 0 | `APP_STATE_EXTRACT_SRS.md` §8 |
| `app-attn.js` 유틸 회수 | `_findToolLocation`·`_toolName` → `app-tool.js`. 25줄 이동, 본문 무변경 | `ATTN_UTIL_RELOCATE_SRS.md` |
| 복원 경쟁 조사 | 셋 중 **하나가 결함**. 양방향 확정 재현 + 묶음 A 의 잔여 발견 | `FG_RESTORE_RACE_SRS.md` §8 |
| 복원 비행 수정 | 규약을 함수로. 세 복원의 **양방향** 결함 제거. e2e 933 | `RESTORE_FLIGHT_SRS.md` |
| `agents-poll` 배선 회수 | `_initAttn` → `_initAgentsSettings`(`app-agents.js`) | 위 SRS §5 N2 의 유보를 해제 |

저장소 최대 파일: **2,984줄 → 1,245줄**(`constants-git.js`, 의도적 비목표).

---

## 2. `App` 을 다시 건드리려는 사람이 먼저 읽을 것

**이 노선은 종결됐다** (§3.1). 그래도 다시 열려면 아래를 읽고 **같은 측정을
재현한 뒤** 열어라 — 이 저장소는 이 측정을 **두 번 틀렸다.**

- **`APP_STATE_EXTRACT_SRS` §8.1 — 이번에 쓴 측정 절차.** 정의 파일 사전을 먼저
  만들고, 사전에 없는 `this.X` 만 필드로 센다
- **§7.2 — 1차 측정이 틀린 이유.** `this.<이름>` 을 전부 필드로 셌는데 상당수가
  **다른 파일이 정의한 메서드 호출**이었다 (60/107 → 실제 41/88)
- **§7.3 — 추출의 세 조건.** 셋을 **동시에** 만족해야 한다. `RunsPanel` 은 예외였다
- **§2.3 — 바깥이 붙잡는 것은 메서드만이 아니다.** e2e 가 `app.<필드>` 를 직접 읽는다

---

## 3. 남은 판단 — 하나

| # | 판단 | 상태 |
|---|---|---|
| 1 | **`refactor` 를 `main` 에 병합할 것인가** | **미결.** `git log --oneline origin/main..HEAD` 가 세는 커밋 전부가 `main` 밖에 있다 |

앞선 판단 둘(§3.3)은 처리됐다.

### 3.1 왜 추출을 더 하지 않는가 — 종결된 근거

판정 기준 셋(`APP_STATE_EXTRACT_SRS` §7.3)을 후보 넷에 **다시 적용해** 실측했다:

| 대상 | 정의 메서드 | 바깥이 붙잡음 | 필드 후보 | 전용 | 판정 |
|---|---|---|---|---|---|
| `app-statusbar.js` | 19 | 6 | 15 | **6** | 부적합 — `_gitJobs` 를 `app-git.js` 가 13곳에서 쓴다 |
| `app-editor.js` | 50 | **35** | 12 | **2** | 부적합 — 위임 껍데기 35개가 본체를 압도한다 |
| `app-attn.js` | 26 | **15** | 15 | **6** | 부적합 — 대신 주제 혼재를 처리했다 |
| `app-reload.js` | 6 | 2 | 5 | **1** | 이득 없음 — 옮길 상태가 없다 |

**앞 세션이 남긴 "`app-statusbar.js` 가 전용 필드 7개로 가장 유망" 은 틀렸다.** 실제 전용은
6개이고, 나머지 9개 중 `_gitJobs`·`_bg`·`_cwd` 는 **다른 파일이 쓰는** 상태다.
떼면 `app-git.js`·`app-tool.js`·`term-pane.js` 가 남의 객체를 만지게 된다.

결론: **`App` 의 46%가 전용 필드인 것은 사실이나, 그 전용 필드들이 파일 경계와
정렬돼 있지 않다.** 전문은 `APP_STATE_EXTRACT_SRS` §8.

### 3.2 대신 한 것 — `app-attn.js` 의 공용 유틸 회수

`_findToolLocation`·`_toolName` 을 `app-tool.js` 로 옮겼다. 도착지가 이미
`_isToolInActiveWindow(toolId)` — 같은 모양의 layout walk — 를 들고 있어 `toolId`
조회가 한자리에 모인다. `App.prototype` 의 메서드로 남으므로 **위임 껍데기 없음 ·
호출부 무변경**, `git diff` 는 삭제 25줄 = 추가 25줄이다.

**`_jumpToTool` 은 옮기지 않았다** — `APP_STATE_EXTRACT_SRS` §7.4 가 이것도 공용
유틸로 지목했으나 재조사하면 아니다. 본문이 `_attnClear`·`_attnLand` 를 직접
부르고 존재 이유로 FR-ATA-6·FR-ATJ-1·2 를 든다. **알림 전용이 맞다**
(`ATTN_UTIL_RELOCATE_SRS` §5 N1 에서 정정).

### 3.3 닫힌 판단 둘

**복원 경쟁** — `FG_RESTORE_RACE_SRS` §7.4 가 미조사로 남긴 셋을 조사했다. 결함이
성립하는 조건은 "SSE 가 그 상태를 **증분으로** 갱신하고 restore 가 스냅숏에 없는
것을 지운다" 이며, `_bgRefresh`·`_focusRestore` 는 증분 경로가 없어 **결함이 없다.**
`_activityRestore` 만 결함이고 **두 방향 다** 확정 재현됐다.

조사 중에 **묶음 A 의 수정이 한 방향만 막았다**는 것도 드러났다 — `before` 규약은
지울 후보만 좁히고 되살리는 쪽은 그대로였다(`_fgRestore`·`_attnRestore` 재현됨).
`RESTORE_FLIGHT_SRS` 로 규약을 **함수로** 만들어 세 복원의 양방향을 다 막았다.
`before` 는 전부 걷어냈다 — `touched` 가 그것을 포함한다.

**`agents-poll` 배선** — `ATTN_UTIL_RELOCATE_SRS` §5 N2 가 "메서드 안의 13줄이라
옮기면 본문 무변경을 증명할 수 없다" 는 이유로 유보했던 것이다. 그 SRS 의 증명
수단에 매인 제약이었으므로, 별도 작업으로 `_initAgentsSettings` 를 만들어 옮겼다.

---

## 4. 반드시 지킬 절차

### 4.1 추출 대상 조사 — 세 가지를 **모두** 센다

```
① 바깥이 부르는 메서드     grep '\.<이름>\('
② 바깥이 app. 으로 읽는 필드  grep 'app)\?\.<이름>'
③ 형제 파일이 this. 로 만지는 필드   grep 'this\.<이름>'     ← 최대 함정
```

이번 세션은 이것을 **스크립트로** 했다 — `Object.assign(App.prototype,{…})`·
`class App` 본문의 2칸 들여쓴 멤버를 전수로 뽑아 `이름 → 정의 파일` 사전을 만든 뒤,
사전에 없는 `this.X` 만 필드로 세고, 각 이름을 `web/js/**` + `e2e/*.ts` 에서
`\.이름\b` 로 다시 훑었다. `\.이름\b` 는 `this.`·`app.`·`this.app.` 을 모두
잡으므로 ③ 이 자동으로 걸린다. 절차 전문은 `APP_STATE_EXTRACT_SRS` §8.1.

**③ 이 함정인 이유**: `app-slots.js` 는 `App` 의 메서드 안이라 `app.` 이 아니라
`this._runViews` 로 접근한다. `app\._run` 으로 찾으면 **걸리지 않는다.** 파일은
갈렸어도 **`this` 는 하나다.** 이번 세션에서 이것을 놓쳐 e2e 3건이 깨졌다.

### 4.2 옮기기는 `Object.assign` 증강으로

원본이 이미 `Object.assign(App.prototype, { … })` 의 객체 리터럴이므로, 받는 쪽을
`Object.assign(NewClass.prototype, { … })` 로 두면 **쉼표까지 그대로**다. 클래스
본문에 넣으면 메서드마다 쉼표를 떼야 하고 그 편집이 diff 를 덮는다.

**메서드 이름도 바꾸지 않는다.** 이름을 다듬으면 내부 호출 전부가 diff 에 섞인다.

### 4.3 검증

```bash
go build ./... && go vet ./... && go test ./...
npx playwright test --reporter=line          # 13~14분
```

**e2e 실패 1건은 회귀가 아닐 수 있다.** 이 저장소는 전량 실행에서 927개 중 1개
정도가 산발로 흔들리며 **실행마다 다른 스펙이 걸린다** (관측된 것: `git-commit` E11,
`git-repo-missing` M3, `sidebar-tabs` T9). 실패가 나면 **반드시 단독 재실행으로
가른다** — 단독에서 통과하면 산발 흔들림이고, 재현되면 회귀다.

자산을 고쳤으면 `index.html` 의 `?v=` 와 `web/assets.lock` 을 함께 올린다
(`go test ./web/` 가 새 해시를 알려준다).

---

## 5. 손대지 않기로 한 것과 사유

| 대상 | 사유 |
|---|---|
| `GitPanel` 객체 분해 | 주제 그룹끼리 필드를 **10~21개** 공유한다. 떼면 참조만 늘어난다 (`APP_STATE_EXTRACT_SRS` §5 N2) |
| `constants-git.js`(1,245줄) | 578개 상수가 이미 주제별 정렬. 이름으로 grep 된다 |
| `windowsPaths`·`posixPaths`·`execRun` 등 staticcheck U1000 5건 | **오탐.** GOOS 를 바꾸면 반대쪽이 unused 로 나온다 — 의도된 설계 |
| SA4000 2건 | `Render() != Render()` 는 결정성 테스트다 |
| ST1005 1건 | `dmctl` 이 사용자에게 내보내는 안내문. 고치면 CLI 출력이 바뀐다 |
| `_bgRefresh`·`_focusRestore` 에 복원 비행 규약 적용 | `FG_RESTORE_RACE_SRS` §8.2 가 결함 없음을 확정했다. 증분 갱신 경로가 없어 규약을 붙이면 **죽은 코드가 된다** (`RESTORE_FLIGHT_SRS` §5 N1) |

---

## 6. 근거 문서

- `SPLIT_REFACTOR_SRS.md` — 통짜 파일 분할. §7.3 이 선행 주석이 경계에서 떨어지는 것
- `E2E_HELPER_RECLAIM_SRS.md` — 헬퍼 회수. §2.1 이 검증 독립성 원칙
- `FG_RESTORE_RACE_SRS.md` — flaky. §7.1 이 기각된 가설 둘의 기록
- `APP_STATE_EXTRACT_SRS.md` — `RunsPanel`. **§7.3 판정 기준과 §8 종결이 핵심**
- `ATTN_UTIL_RELOCATE_SRS.md` — 공용 유틸 회수. §2.2 가 도착지 선정 근거
- `RESTORE_FLIGHT_SRS.md` — 복원 비행. **§1.2 가 규약을 함수로 만든 사유**
- `architecture.md` — 갈라진 자리와 그 규약

## 7. 브랜치

```bash
git log --oneline origin/main..HEAD   # 이 브랜치의 모든 작업
```

`main` 은 `7cbb6d6` 에서 손대지 않았다. 커밋 수를 여기 적지 않는 것은 그 숫자를
갱신하는 커밋이 다시 숫자를 틀리게 하기 때문이다 — 세어야 하면 위 명령을 쓴다.

`main` 병합은 하지 않았다. 사용자 판단이 필요하다.
