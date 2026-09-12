# SRS: 터미널에 폴더를 놓는다 — IEEE 29148

> **문서 상태**: 초안
>
> 로드맵 §M6 (나) `FUI-16` 의 스펙이다. 요구 번호 접두어는 **`FR-TFD`**
> (Terminal Folder Drop).

## 1. 개요 (Introduction)

### 1.1 목적 (Purpose)

**문서가 거짓을 말하고 있다.** `README.md:183` 과 `docs/external/features.md` ·
`commands.md` 가 이렇게 적는다:

> 터미널이나 탐색기에 파일을 **끌어다 놓으면** 올라갑니다. 폴더를 놓으면 하위
> 구조가 그대로 올라갑니다.

**터미널 쪽은 사실이 아니다.** `term-pane.js:31` 이 `dataTransfer.files` 만 보고
`_uploadFiles` 로 넘긴다 — entry 재귀가 없으므로 폴더를 놓으면 아무 일도 일어나지
않거나(브라우저가 폴더를 `files` 에 싣지 않는다) 크기 0 의 실패가 된다.

탐색기는 같은 일을 **이미 옳게 한다** — `FileTree._dropEntries` 가
`webkitGetAsEntry` 로 항목을 얻고 `_walkEntry` 가 재귀로 펴서 `{file, relPath}`
배열을 만든다 (`FR-ETR-21·22`).

> **⚠ 이 문서의 초안은 여기서 틀렸다.** *"서버도 이미 `relPath` 를 받는다"* 고
> 적었는데, 그것은 **탐색기용 `/api/fs/upload`** 였다. 터미널이 쓰는
> `/api/upload` 는 `relPath` 를 읽지 않고 `filepath.Base` 로 이름만 취한다 —
> 그대로 두면 폴더를 놓아도 파일이 cwd 에 **평평하게** 떨어지고 이름만 `(1)`,
> `(2)` 로 붙는다. 같은 이름의 함수를 두 표면이 공유한다는 사실(`uploadInto`)이
> 그 착각을 쉽게 만들었다 — **공유하는 것은 본문 파싱이지 자리 정하기가
> 아니었다.** §3.3 이 그 몫을 더한다.

### 1.2 범위 (Scope)

| | 대상 |
|---|---|
| 신규 | `web/js/ui/drop-entries.js` — 드롭을 `{file, relPath}` 로 펴는 **순수 함수** |
| 변경 | `web/js/ui/term-pane.js` — 드롭 핸들러 · `_uploadFiles` |
| 변경 | `web/js/ui/file-tree-xfer.js` — `_dropEntries`·`_walkEntry` 를 공용 함수에 위임 |
| 변경 | `internal/webserver/httpapi/handlers_files.go` — `/api/upload` 가 `relPath` 를 읽는다 (§3.3) |
| 변경 | `e2e/reconnect-storm.spec.ts` — 격리 하네스가 새 파일을 싣는다 (§2.2) |
| 검사 | 단위(`node --test`) · e2e |

**비포함** (§5): 새 종단 없음. 진행 표시의 재설계 없음.

### 1.3 정의 (Definitions)

| 용어 | 정의 |
|---|---|
| **항목(entry)** | `DataTransferItem.webkitGetAsEntry()` 가 준 `FileSystemEntry`. 파일이거나 디렉터리다 |
| **폄(walk)** | 디렉터리 항목을 재귀로 걸어 `{file, relPath}` 의 평평한 배열로 만드는 것 |
| **`relPath`** | 드롭한 **뿌리부터의** 상대 경로. 서버가 이것으로 하위 폴더를 만든다 |

### 1.4 참고 (References)

- `FILE_TRANSFER_SRS` `FR-FTR-10`·`11` — 끝나도 엔터를 보내지 않는다 · 서버 cwd 는 이 도구의 폴더가 아니다
- `EXPLORER_TRANSFER_IGNORE_SRS` `FR-ETR-21`·`22` — 드롭을 `{file, relPath}` 로 편다
- `docs/internal/production/12-func-ui.md` FUI-16 — 원본 감사 (§7 에 미확인 항목)

---

## 2. 전체 기술 (Overall Description)

### 2.1 두 표면이 같은 일을 한다

| | 탐색기 | 터미널 |
|---|---|---|
| 어디에 놓는가 | 드롭이 향하는 **폴더** (FR-FTR-20) | 그 도구의 **cwd** (FR-FTR-11) |
| 무엇을 올리는가 | `{file, relPath}` 배열 | **지금은 `File` 배열** |
| 하위 구조 | 편다 | **펴지 않는다** ← 이 문서가 고치는 것 |

**"어디에" 는 다르고 "무엇을" 은 같아야 한다.** 그래서 공용으로 뽑는 것은
*폄*뿐이고, 대상 폴더를 정하는 일과 진행을 보이는 일은 각자 그대로 둔다.

### 2.2 제약 — **격리 하네스가 이 변경의 범위 안에 있다**

`e2e/reconnect-storm.spec.ts` 는 `term-pane.js` 를 **빈 페이지에 홀로 싣는다**
(`addScriptTag` 로 `timer-hub.js` · `api.js` · `term-pane.js` 셋만). 이 저장소가
비싸게 배운 것 넷째가 바로 이 자리다:

> **격리 하네스는 전역을 손으로 세운다.** 상수를 `constants.js` 로 옮기는 순간
> 그 하네스가 죽는다 — 격리가 그 검사의 값이므로 `constants.js` 를 싣는 것은
> 답이 아니다.

그러므로 공용 함수는 **의존이 0 인 파일**이어야 하고, 하네스는 그 파일 하나를
더 실으면 된다. `FileTree` 에 붙은 `static` 을 터미널이 부르게 하는 것은
**답이 아니다** — 그러면 하네스가 `file-tree*.js` 넉 장을 싣게 된다.

| # | 제약 | 출처 |
|---|---|---|
| C-1 | 공용 함수 파일은 **의존이 0** 이다. 상수도 참조하지 않는다 | §2.2 |
| C-2 | 격리 하네스가 그 파일을 싣도록 **같은 변경에서** 고친다 | 비싸게 배운 것 4·5 |
| C-3 | 업로드가 끝나도 셸에 **엔터를 보내지 않는다** | `FR-FTR-10` |
| C-4 | 서버의 cwd 가 이 도구의 것이 아니면 올리지 않는다 | `FR-FTR-11` / D-4 |
| C-5 | 문서를 고치면 그것이 같은 변경 안에 있어야 한다 | 저장소 규약 |

### 2.3 가정 — **하나는 실측으로 지운다**

감사가 남긴 미확인 항목(`12-func-ui.md` §7-1):

> Chrome/Safari 가 터미널 `drop` 의 `dataTransfer.files` 에 폴더를 어떤 `File` 로
> 싣는지는 실행하지 않았다.

**이 문서는 그 물음을 우회한다.** `dataTransfer.files` 를 읽지 않고
`dataTransfer.items` + `webkitGetAsEntry` 를 먼저 보기 때문이다 — 탐색기가 이미
그 길로 가고 그 길은 검증돼 있다. `items` 가 없는 브라우저에서만 `files` 로
내려가며, **그때는 지금과 같은 동작**이다 (파일만 올라간다).

---

## 3. 상세 요구사항 (Specific Requirements)

### 3.1 공용 함수 — `ui/drop-entries.js`

**FR-TFD-1** 전역 함수 둘을 세운다. 클래스에 붙이지 않는다 (C-1).

    dropEntries(e)              → FileSystemEntry[] | null
    walkDropEntry(en, prefix, out, max) → boolean   // false = 상한 초과

**FR-TFD-2** 동작은 지금의 `FileTree._dropEntries`·`_walkEntry` 와 **같다.**
구간 이동이며 한 글자도 고치지 않는다 — 그 둘은 이미 옳고 검증돼 있다.

**FR-TFD-3** 상한(`EDITOR_UPLOAD_MAX_ENTRIES`)은 **인자로 받는다.** 상수를
참조하면 의존이 0 이 아니게 된다 (C-1). 부르는 쪽이 자기 상한을 준다.

**FR-TFD-4** `FileTree._dropEntries`·`_walkEntry` 는 **남는다** — 공용 함수를
부르는 얇은 겹이 된다. 그 둘을 부르는 자리가 여럿이고, 이름을 지우면 이 변경이
"이음매를 더한다" 를 넘어 "탐색기를 고친다" 가 된다.

### 3.2 터미널

**FR-TFD-10** 드롭 핸들러가 `dropEntries(e)` 를 먼저 본다. 항목이 있으면 펴서
`{file, relPath}` 배열로 올린다. 없으면 지금처럼 `dataTransfer.files` 로 간다
(§2.3).

**FR-TFD-11** `dragover` 의 조건은 그대로 `types` 에 `'Files'` 가 있는가다 —
폴더 드래그에서도 그 값이 선다.

**FR-TFD-12** `_uploadFiles` 가 `{file, relPath}` 를 받는다. `relPath` 가 있으면
multipart 에 **`file` 보다 먼저** 싣는다 — 서버가 스트림으로 파싱하므로 순서가
계약이다 (`file-tree-xfer.js:87` 의 근거와 같다).

**FR-TFD-13** 진행·성공·실패 팝업의 **이름은 `relPath`** 다. `a/b/c.txt` 를
`c.txt` 로만 보이면 어느 것이 끝났는지 알 수 없다.

**FR-TFD-14** 상한을 넘으면 **하나도 올리지 않고** 사유를 보인다 — 탐색기와 같다
(`EDITOR_UPLOAD_TOO_MANY`). 절반만 올라간 폴더는 되돌릴 길이 없다.

**FR-TFD-15** 순차 업로드·엔터 미전송·cwd 판정은 **그대로다** (C-3·C-4).

### 3.3 서버 — `/api/upload` 가 `relPath` 를 읽는다

**FR-TFD-30** `POST /api/upload` 가 `relPath` 폼 값을 받는다. 없으면 지금까지와
같다 — **확장이지 대체가 아니다** (`FR-ETR-17` / D-8 과 같은 규약).

**FR-TFD-31** 자리를 정하는 규칙은 탐색기와 **같은 함수**(`fsUploadTarget`)가
진다. 문자열 탈출 · 경계 밖 · 링크를 따라가는 `MkdirAll` 세 가지를 그것이 이미
막는다 (`FR-ETR-18`). 두 벌로 적으면 한쪽만 고쳐진다.

**FR-TFD-32** **경계는 그 도구의 cwd 자신이다.** 터미널에는 편집기 루트가 없고,
넘지 말아야 할 선이 cwd 다. 그래서 `fsUploadTarget(dir, dir, rel, name)` 이다.

**FR-TFD-33** 충돌은 **자동 개명**이고 **마지막 조각에만** 걸린다 —
`(1)`·`(2)` 는 `api.md` 의 공개 계약이며 탐색기의 409 와 다른 것은 의도다 (D-3).
중간 디렉터리까지 개명하면 한 번의 드롭이 `top` 과 `top (1)` 로 갈라진다.

**FR-TFD-34** `docs/external/api.md` 의 `/api/upload` 항목에 `relPath` 를 적는다
(게이트가 강제한다).

### 3.4 문서

**FR-TFD-20** `README.md` · `features.md` · `commands.md` 의 진술이 **참이
된다.** 고치는 것이 아니라 코드가 문서를 따라잡는 것이다.

---

## 4. 검증 (Verification)

### 4.1 단위 (`web/js/test/drop-entries.test.mjs`)

의존이 0 이므로 단위로 잰다 — 이 저장소에서 순수 함수는 그렇게 한다.

| ID | 확인 |
|---|---|
| TC-TFD-1 | 파일만 있는 드롭은 `relPath` 가 이름 하나다 |
| TC-TFD-2 | 폴더는 재귀로 펴지고 `relPath` 가 뿌리부터다 |
| TC-TFD-3 | 빈 폴더는 항목을 만들지 않는다 |
| TC-TFD-4 | 상한을 넘으면 `false` 를 돌려준다 — 부분 결과를 쓰지 않는다 |
| TC-TFD-5 | `items` 가 없으면 `null` (호출자가 `files` 로 간다) |

### 4.2 e2e (`file-transfer.spec.ts`)

| ID | 확인 |
|---|---|
| V-TFD-1 | 터미널에 폴더를 놓으면 cwd 아래에 **하위 구조가 선다** |
| V-TFD-2 | 팝업의 이름이 `relPath` 다 (FR-TFD-13) |
| V-TFD-3 | 업로드 뒤 셸에 **엔터가 가지 않는다** (C-3, 기존 단정 유지) |
| V-TFD-4 | cwd 가 이 도구의 것이 아니면 올리지 않는다 (C-4, 기존 단정 유지) |

### 4.3 서버 단위 (`handlers_term_relpath_test.go`)

탐색기 쪽 검사(`handlers_fs_relpath_test.go`)를 되풀이하지 않는다 — 같은 함수를
쓰므로 이미 덮인다. **다른 두 가지**와 그 경계만 잰다.

| ID | 확인 |
|---|---|
| TC-TFD-10 | 중간 디렉터리가 생기고 파일이 그 안에 놓인다 (FR-TFD-30) |
| TC-TFD-11 | `relPath` 가 없으면 지금까지와 같다 |
| TC-TFD-12 | 개명은 **마지막 조각에만** — `top (1)` 이 생기지 않는다 (FR-TFD-33) |
| TC-TFD-13 | `..`·절대경로는 400 이고 cwd 밖에 파일이 생기지 않는다 (FR-TFD-32) |
| TC-TFD-14 | 이미 있는 중간 디렉터리는 충돌이 아니다 |

### 4.4 격리 하네스

`reconnect-storm.spec.ts` 가 `drop-entries.js` 를 함께 싣고 **그대로 통과한다**
(C-2). 싣지 않으면 그 검사가 `ReferenceError` 로 죽는다 — 그것이 이 제약이
실재함의 증거다.

---

## 5. 비목표 (Non-Goals)

| # | 하지 않는 것 | 사유 |
|---|---|---|
| ~~N1~~ | ~~서버 변경~~ | **⊘ 철회** — 전제가 틀렸다 (§1.1). `/api/upload` 는 `relPath` 를 읽지 않았고, 그것 없이는 이 요구가 성립하지 않는다. 새 종단은 만들지 않으며 기존 하나에 폼 값 하나를 더한다 (§3.3) |
| N2 | 병렬 업로드 | 순차는 `FR-FTR` 의 결정이고 이 문서가 그것을 뒤집을 근거가 없다 |
| N3 | 진행 팝업의 재설계 (전체 진행률 등) | 지금 규약은 "파일 하나의 일은 팝업 하나에서 마친다" (`FR-TXN-3·5`). 폴더가 커지면 팝업이 많아지지만, 그 판단은 이 문서의 범위 밖이다 |
| N4 | `FileTree._dropEntries` 제거 | FR-TFD-4 |
