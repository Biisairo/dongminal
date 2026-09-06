# SRS: 서버도 도구의 cwd 를 듣는다 (IEEE 29148 준수)

| 항목 | 값 |
|---|---|
| 문서 | WINDOWS_TOOL_CWD_SRS |
| 선행 | CROSS_PLATFORM_SRS · CI_E2E_MATRIX_SRS · FILE_TRANSFER_SRS(FR-FTR-7) |
| 상태 | 구현 중 |

## 1. 개요 (Introduction)

### 1.1 목적 (Purpose)

Windows CI 가 드러낸 것은 검사의 문제가 아니라 **제품의 구멍**이다.

```
Expected: "C:\Users\runneradmin\AppData\Local\Temp\dm-git-fx-uxr-844\basic"
Received: "D:\a\dongminal\dongminal"          ← 서버 자신의 cwd
```

`GET /api/cwd?tool=<id>` 가 20초를 기다려도 **서버의 cwd** 를 답한다. 그 도구는
분명히 다른 자리에서 떴는데도 그렇다.

### 1.2 범위 (Scope)

**포함**

- 셸 훅의 `OSC 777;Cwd` 를 **서버가** 읽어 그 도구의 값으로 기억하는 것
- `Tool.Cwd()` 의 우선순위
- 그 값을 딛는 자리들(`/api/cwd`, 영속, 배경 목록, git follow, `+ Add` 자동채움)이
  **바뀌지 않고** 옳아지는 것

**비포함** — §6.

### 1.3 정의 (Definitions)

| 용어 | 정의 |
|---|---|
| **직접 조회** | 프로세스의 cwd 를 OS 에 묻는 길. `platform.ProcInfo.CWD` |
| **훅 보고** | 셸이 매 프롬프트마다 내보내는 `ESC ] 777 ; Cwd ; <경로> BEL` |
| **폴백** | 둘 다 없을 때 서버 자신의 cwd 를 답하는 것 (`cwdOrServer`) |

## 2. 현황 (Current State)

| 자리 | 지금 |
|---|---|
| POSIX | `platform.ProcInfo.CWD` 가 `/proc`·lsof 로 **직접** 읽는다 — 언제나 지금의 값 |
| Windows | `windowsProcInfo.CWD` 는 **언제나 거짓**이다. 다른 프로세스의 cwd 를 읽으려면 원격 스레드나 디버그 권한이 필요하다 |
| 훅 | POSIX(`zshrc`·`bash-hook.sh`)와 Windows(`powershell-hook.ps1`)가 **모두** OSC 777;Cwd 를 내보낸다 |
| 그 보고를 먹는 쪽 | **브라우저뿐이다** (`term-pane.js` `_onCwd`) — 상태바와 git 신호에 쓰고 끝난다 |

그래서 Windows 에서 `Tool.Cwd()` 는 언제나 빈 값이고, 그것을 딛는 자리는 전부
서버의 cwd 로 떨어진다.

**이것이 검사 하나의 문제가 아닌 이유**는 그 값을 딛는 자리의 목록이다.

- `/api/cwd` → `+ Add` 다이얼로그의 자동채움, 상태바
- `toolhub/persist.go` → 재기동 뒤 도구가 되살아나는 자리
- `manager_hub.go` 의 배경 목록
- `gitapi` 의 follow — "지금 보고 있는 셸의 저장소"
- 새 도구의 cwd 승계 (`_newTool(cwdTool=…)`)

Windows 사용자에게 이 전부가 **서버가 뜬 자리**를 가리킨다.

### 2.1 설계 결정

- **D-1 이미 흐르고 있는 것을 읽는다.** 훅은 이미 매 프롬프트마다 보고하고 있고
  서버는 그 바이트를 이미 읽고 있다(`readPTY` → `observeOutput`, OSC 777;notify 를
  거기서 잡는다). 새 종단도, 브라우저의 되보고도 필요 없다 — **같은 스트림에서 한
  가지를 더 알아보면 된다.**
- **D-2 직접 조회가 먼저다.** 둘 다 있으면 직접 조회가 **지금**의 값이고 보고는
  마지막 프롬프트의 값이다. POSIX 의 동작은 한 글자도 바뀌지 않는다.
- **D-3 폴백은 그대로 둔다.** `Tool.Cwd()` 의 계약("모르면 빈 값")과 `cwdOrServer`
  의 폴백은 그대로다 — 이 문서는 **모르는 경우를 줄일 뿐** 계약을 바꾸지 않는다.
- **D-4 알람 배선과 무관하게 읽는다.** 종전 `observeOutputAt` 은 `onAttention == nil`
  이면 곧바로 돌아갔다. 알람을 켜지 않은 도구도 자기 자리는 말해야 한다.
- **D-5 마지막 것이 이긴다.** 한 청크에 프롬프트가 여럿 들어 있으면 가장 나중의
  보고가 지금의 자리다.

## 3. 요구사항 (Requirements)

| ID | 요구사항 | 우선 |
|----|---------|------|
| FR-WTC-1 | 서버는 PTY 출력에서 `ESC ] 777 ; Cwd ; <경로>` 를 읽는다. 종단자는 BEL 과 ST 둘 다 받는다. 관측 전용이며 스트림을 바꾸지 않는다. | 필수 |
| FR-WTC-2 | 읽은 값은 그 도구에 기록된다. 기록은 알람 배선 여부와 무관하다 (D-4). 한 청크에 여럿이면 마지막이 이긴다 (D-5). | 필수 |
| FR-WTC-3 | `Tool.Cwd()` 는 ① 직접 조회 ② 훅 보고 순으로 답하고, 둘 다 없으면 빈 값이다 (D-2·D-3). | 필수 |
| FR-WTC-4 | 끝나지 않은 OSC 는 다음 청크의 carry 로 이어진다 — 알람 검출이 이미 쓰는 그 carry 다. | 필수 |
| FR-WTC-5 | 빈 경로 보고(`…;Cwd;` 뒤가 없음)는 기록하지 않는다 — 아는 것을 모르는 것으로 덮지 않는다. | 필수 |

## 4. 검증 (Verification)

| ID | 검증 |
|---|---|
| V-WTC-1 | `DetectCwdReport` 가 BEL·ST 두 종단, 여러 개 중 마지막, 다른 OSC 와 섞인 경우, 빈 값을 각각 옳게 답한다 (단위) |
| V-WTC-2 | 직접 조회가 되는 처지에서는 보고가 있어도 직접 조회 값이 나온다 (단위) |
| V-WTC-3 | 직접 조회가 안 되는 처지에서 보고가 있으면 그 값이 나온다 (단위) |
| V-WTC-4 | Windows CI 에서 `ux-revision` 의 묶음 W(새 창의 cwd) 셋이 초록이다 |
| V-WTC-5 | POSIX 전량이 종전과 같이 초록이다 — 이 문서로 바뀌는 동작이 없다 |

## 5. 비기능 (Non-functional)

| ID | 요구사항 |
|---|---|
| NFR-WTC-1 | 스캔은 이미 도는 한 번의 순회 옆에 붙는다. 출력 경로에 새 할당이 생기지 않는다(스캔은 기존 `scan` 버퍼를 그대로 본다) |
| NFR-WTC-2 | 브라우저의 `_onCwd` 는 그대로 둔다 — 상태바의 즉시성은 그쪽이 빠르다 |

## 6. 비목표 (Non-goals)

- **Windows 에서 직접 조회를 구현하는 것** — 원격 스레드·디버그 권한이 필요하고,
  훅 보고로 충분하다 (CROSS_PLATFORM_SRS 의 판단 그대로).
- **`cwdOrServer` 폴백의 제거** — 영속과 배경 목록이 그것을 딛는다 (D-3).
- **셸 훅의 개정** — 훅은 이미 옳게 보내고 있다.

## 7. 위험 (Risks)

| # | 위험 | 판단 |
|---|---|---|
| R-1 | 훅이 없는 셸(사용자가 `--norc` 로 띄운 것 등)에서는 보고가 없다 | 종전과 같다 — 빈 값이고 폴백이 받는다 (D-3) |
| R-2 | 보고는 마지막 프롬프트의 값이라 명령이 도는 **중**의 이동을 모른다 | POSIX 는 직접 조회가 이긴다(D-2). Windows 는 그 길이 없고, 프롬프트 단위의 값이 서버의 cwd 보다 언제나 낫다 |
| R-3 | 알람 신호가 먼저 잡히면 `DetectAttentionSignal` 이 조기 반환해 carry 가 비고, 같은 청크 뒤쪽의 잘린 cwd OSC 가 유실될 수 있다 | 다음 프롬프트가 다시 보고한다. 브라우저 쪽도 같은 성질이며 실측된 문제가 아니다 |
