# SRS: 탭 이름 전달 — 생성과 함께 이름 주기 · rename 확인과 재전송 · uuid 방송 — IEEE 29148

> **문서 상태**: 승인·구현중
> **남은 것**: 실물 확인 — 재빌드·재시작 뒤 이슈 트리에서 자식 탭과 migration 탭의 이름이 남는지 본다
> **입력**: 사용자 보고(2026-11-08) — migration·하위 탭 생성으로 새 세션을 띄울 때 탭 이름이 정해지지 않는다. 이슈 트리에서는 탭 이름이 사슬 경로 역할을 하므로 치명적이다.
> **사용자 결정**: D-TND-1 · D-TND-2 · D-TND-3 (§5)

## 1. 개요 (Introduction)

### 1.1 목적 (Purpose)

`dmctl rename-tab` 이 exit 0 으로 끝나도 탭 이름이 사라지는 결함을 없앤다. 이슈 트리와 migration 이 새 탭에 붙이는 이름이 반드시 남아야 한다.

### 1.2 범위 (Scope)

| 묶음 | 내용 | 산출물 |
|---|---|---|
| **S** | 서버가 `renameTab`·`renameWindow` 의 uuid 를 좌표로 바꾸지 않고 방송한다 | `internal/webserver/httpapi/commands.go` |
| **C** | dmctl 이 rename 의 반영을 확인하고, 반영되지 않으면 다시 보낸다 | `internal/helper/runtimebin/dmctl.go` |
| **K** | 스킬 문서가 새 탭을 만들 때 이름을 함께 준다 | `agentplugin/commands/migration.md` · `issue-tree.md` |

**미포함:** §6 비목표.

### 1.3 정의 (Definitions)

| 용어 | 정의 |
|---|---|
| **반영** | 서버 워크스페이스(`/api/state` 의 `workspace`)에 요청한 이름이 저장된 상태 |
| **확인 창** | 한 번 보낸 뒤 반영을 기다리는 시간 |
| **전송 상한** | 같은 rename 을 보내는 최대 횟수(첫 전송 포함) |
| **생성자** | `newTab`·`newWindow` 를 실제로 수행한 브라우저 하나 (FR-SXE-1) |

### 1.4 참고 (References)

- `WORKSPACE_SAVE_CONFLICT_SRS.md` FR-WSC-1·12·14 — 409 이면 그 저장을 버리고 원격을 채택한다. 원격이 모르는 탭은 지우지 않는다
- `archive/RENAME_TAB_SESSION_SRS.md` FR-RNS-1~5 — `renameTab` 액션과 dmctl
- `CONVENIENCE_SRS.md` FR-TAN-1·2·22 — 탭 이름의 출처(`nameSource`)와 `--auto`
- `ISSUE_AGENT_TREE_SRS.md` FR-IAT-42·44·46 — 사슬 탭과 탭 이름
- `internal/webserver/hub/commands.go` `cmdActions` — `renameTab`·`renameWindow` 는 모든 브라우저에 방송한다

## 2. 현황 (Identified Issue)

### 2.1 증상

트리 `ccr#32` 의 탭 둘이 사슬 이름 대신 `claude`(전경 프로세스에서 파생한 이름)를 보인다.

| 탭 | 노드 | 경로 | rename 결과 | 지금 이름 |
|---|---|---|---|---|
| `8b0b47dd` | `…›80›91` | issue-tree 자식 | exit 0. 19초 뒤 자식의 `who-am-i` 는 `tab="Shell"` | `claude` |
| `3f5af7ad` | `…›35›80` | migration 멤버 갈래 | exit 0 | `claude` |

같은 부모가 띄운 `›89`·`›90` 은 이름이 남았다. 두 실패 모두 rename 직후 수십~수백 ms 안에 `PUT /api/workspace 409` 가 한 건 있었다(`server.log`).

### 2.2 원인

1. `newTab` 은 생성자 한 곳에서 돈다. 생성자는 새 탭(`Shell`)을 담아 저장한다.
2. 수십 ms 뒤 `renameTab` 이 구독 중인 브라우저 모두(실측 4)에 방송된다. 새 탭을 아직 모르는 브라우저는 무시한다.
3. 이름이 빠진 판을 가진 브라우저의 저장이 먼저 서버에 닿는다. 이름을 바꾼 브라우저의 저장은 409 를 받는다.
4. 409 를 받은 저장은 버려지고 다시 시도하지 않는다(FR-WSC-1). 이름이 사라진다.
5. `renameTab` 은 결과를 기다리지 않는다. dmctl 은 배달만 보고 exit 0 을 낸다.

### 2.3 좌표 방송의 위험

서버는 `--at` 의 uuid 를 좌표(`W16.P1.T6`)로 바꿔 방송한다. 워크스페이스가 낡은 브라우저에서는 같은 좌표가 **다른 탭**일 수 있다. 그 브라우저는 엉뚱한 탭의 이름을 바꾸고 저장할 수 있다. 브라우저의 `_resolveLocation` 은 이미 탭 uuid 를 받는다(`_findTabById`). 모르는 uuid 이면 아무것도 하지 않는다.

### 2.4 생성과 함께 이름 주기

`dmctl new-tab --name` 은 이름을 탭 객체에 담아 생성 저장에 함께 싣는다(`nameSource=manual`). 그 저장이 409 를 받아도 원격이 모르는 탭은 병합으로 남는다(FR-WSC-12·14). 그러므로 2.2 의 경쟁이 없다. `--at`·`--after` 와 함께 쓰는 것을 실측했다. `new-window` 의 첫 탭은 생성 때 이름을 받을 길이 없으므로 `rename-tab` 이 여전히 필요하다.

## 3. 요구사항 (Requirements)

### 3.1 묶음 S — uuid 방송 (FR-TND-1~3)

| ID | 요구 | 우선 |
|---|---|---|
| **FR-TND-1** | 서버는 `renameTab`·`renameWindow` 의 `args.location` 을 **받은 uuid 그대로** 방송해야 한다. 좌표로 바꾸지 않는다. | 필수 |
| **FR-TND-2** | FR-TND-1 의 액션도 알려진 탭 uuid 검사(FR-DMC-9)를 그대로 지나야 한다. 모르는 uuid·좌표는 종전대로 400 이다. | 필수 |
| **FR-TND-3** | FR-TND-1 의 액션의 응답 `location` 은 종전대로 좌표이고 `requestedLocation` 은 uuid 여야 한다. 로그 줄도 종전과 같다. 다른 액션의 변환은 바뀌지 않는다. | 필수 |

### 3.2 묶음 C — 반영 확인과 재전송 (FR-TND-10~17)

| ID | 요구 | 우선 |
|---|---|---|
| **FR-TND-10** | `rename-tab`·`rename-window` 는 배달에 성공한(종료 코드 0) 뒤 `/api/state` 를 읽어 반영을 확인해야 한다. | 필수 |
| **FR-TND-11** | 반영 조건은 다음과 같다. `rename-tab <이름>`: `id==--at` 인 탭의 `name==<이름>` 이고 `nameSource=="manual"`. `rename-tab --auto`: 그 탭의 `name=="Shell"` 이고 `nameSource!="manual"`. `rename-window <이름>`: `--at` 탭이 든 창의 `name==<이름>`. | 필수 |
| **FR-TND-12** | 확인 창 안에 반영되지 않으면 같은 명령을 다시 보내야 한다. 확인 창은 1500 ms, 확인 간격은 100 ms, 전송 상한은 3 이다. | 필수 |
| **FR-TND-13** | 전송 상한까지 반영되지 않으면 stderr 에 사유(탭 uuid · 기대 이름)를 쓰고 exit 1 이어야 한다. | 필수 |
| **FR-TND-14** | `/api/state` 응답에 `workspace` 가 없으면 판정하지 않고 exit 0 이어야 한다(모른다와 없다는 다르다 — `dmctlDelivery` 와 같은 규약). | 필수 |
| **FR-TND-15** | 워크스페이스는 있는데 그 탭이 없거나, `/api/state` 조회가 실패하면 반영되지 않은 것으로 본다. | 필수 |
| **FR-TND-16** | stdout 에는 첫 전송의 응답만 낸다. 재전송의 응답은 내지 않는다(호출자가 stdout 을 JSON 한 개로 읽는다). | 필수 |
| **FR-TND-17** | 재전송이 배달에 실패하면(HTTP 오류 · `delivered:0`) 그 종료 코드로 곧바로 끝나야 한다. | 필수 |

### 3.3 묶음 K — 스킬 문서 (FR-TND-20~23)

| ID | 요구 | 우선 |
|---|---|---|
| **FR-TND-20** | `migration.md` 일반 절차의 새 탭은 `dmctl new-tab -n --at <자기 탭 uuid> --name "<이어갈 일의 이름>"` 하나로 만들고 이름을 붙여야 한다. 따로 `rename-tab` 을 부르지 않는다. | 필수 |
| **FR-TND-21** | `migration.md` 멤버 갈래 M3 는 `dmctl new-tab -n --at <자기 탭 uuid> --after <자기 탭 uuid> --name "<지금 탭 이름>"` 이어야 한다. | 필수 |
| **FR-TND-22** | `issue-tree.md` 의 사슬 자식(·병렬 자식 중 첫째)은 `new-tab … --name "<자식 탭 이름>"` 으로 만들어야 한다. `rename-tab` 은 `new-window` 로 만든 자식에만 쓴다. | 필수 |
| **FR-TND-23** | 두 문서는 `rename-tab` 이 exit 1 이면 이름이 붙지 않았다는 뜻임을 적어야 한다. 그때는 한 번 더 부르고, 그래도 실패하면 사용자에게 보고하고 절차를 계속한다. | 필수 |

## 4. 검증 (Verification)

| ID | 대상 | 방법 |
|---|---|---|
| V-TND-1 | FR-TND-1·3 | `renameTab`·`renameWindow` 를 uuid 로 보내면 방송 `location` 이 uuid 이고, 응답 `location` 은 좌표다 (Go, httpapi) |
| V-TND-2 | FR-TND-2 | 모르는 uuid 의 `renameTab` 은 400 이고 방송하지 않는다 (Go, httpapi) |
| V-TND-3 | FR-TND-3 | `focus` 는 여전히 좌표로 방송한다 (기존 `TestHandleCommandPost_TranslatesUUIDLocation`) |
| V-TND-4 | FR-TND-10·11 | 첫 확인에서 반영되면 전송 1회, exit 0 (Go, runtimebin) |
| V-TND-5 | FR-TND-12·16 | 첫 전송 뒤 미반영, 둘째 전송 뒤 반영 → 전송 2회, exit 0, stdout 응답 1개 |
| V-TND-6 | FR-TND-13 | 끝내 미반영 → 전송 3회, exit 1, stderr 에 uuid 와 이름 |
| V-TND-7 | FR-TND-14 | `workspace` 없는 응답 → 전송 1회, exit 0 (기존 rename 시험이 그대로 통과) |
| V-TND-8 | FR-TND-11 | `--auto` 와 `rename-window` 의 반영 조건 |
| V-TND-9 | FR-TND-15 | 탭이 없는 워크스페이스 → 미반영으로 보고 재전송 |
| V-TND-10 | FR-TND-17 | 재전송이 `delivered:0` → exit 1, 더 보내지 않는다 |
| V-TND-11 | FR-TND-20~22 | 스킬 계약 시험(`skills_contract_test.go`)이 `--name` 을 요구한다 |

## 5. 결정 (Decisions)

| ID | 결정 | 이유 |
|---|---|---|
| D-TND-1 | 스킬 문서와 `rename-tab` 을 함께 고친다 | 문서만 고치면 `new-window` 의 첫 탭과 다른 rename 호출자에 결함이 남는다 |
| D-TND-2 | 보강은 dmctl 의 확인·재전송이다. 서버 권위 적용이나 브라우저 재적용은 하지 않는다 | 프로토콜과 브라우저를 바꾸지 않는다. 실패가 종료 코드로 드러난다 |
| D-TND-3 | 좌표 방송 문제도 이번에 고친다 | 낡은 브라우저가 엉뚱한 탭의 이름을 바꿀 수 있다. 브라우저는 이미 uuid 를 받는다 |

## 6. 비목표 (Non-goals)

- 409 정책(FR-WSC-1) 변경. 사용자 조작의 저장 손실 규칙은 그대로다
- `renameGroup` 의 확인. 그룹 이름은 이번 증상과 관계없다
- `moveTab`·`--after` 등 다른 순수 데이터 변경의 같은 경쟁 (R-TND-1)

## 7. 위험 (Risks)

| ID | 위험 | 수준 | 대응 |
|---|---|---|---|
| R-TND-1 | `new-tab --after` 의 자리 이동도 생성자의 다음 저장이다. 같은 409 경쟁으로 자리가 끝으로 밀릴 수 있다 | LOW | 이번 범위 밖. 증상이 보이면 따로 다룬다 |
| R-TND-2 | 실패할 때 rename 이 최대 약 4.5초 걸린다 | LOW | 정상 경로는 첫 확인(수백 ms)에서 끝난다 |
| R-TND-3 | 사용자가 확인 창 안에 같은 탭 이름을 다른 값으로 바꾸면 dmctl 이 그것을 덮는다 | LOW | 창이 짧다. 에이전트가 붙이는 이름이 목적이다 |

## 8. 변경 기록

| 날짜 | 내용 |
|---|---|
| 2026-11-08 | 최초 작성 |
