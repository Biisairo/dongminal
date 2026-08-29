<!-- 이 파일은 전체가 새 세션의 첫 메시지다. 열어서 전체 선택 → 붙여넣기. -->

dongminal 저장소에서 크로스플랫폼 작업을 이어서 한다. 브랜치는 `crossplatform`
이고 **모두 커밋·푸시되어 있다** — 워킹 트리는 깨끗하다.

## 0. 가장 먼저

**`docs/internal/CROSS_PLATFORM_HANDOFF.md` 를 전부 읽어라.** 이 프롬프트는 그
문서의 착수 순서일 뿐이다.

```bash
git branch --show-current      # crossplatform 이어야 한다
git status --short             # 비어 있어야 한다
go build ./... && go vet ./...
```

## 1. 한 줄 상태

**CI 잡 넷이 전부 초록이다** (run 33280678938). 세 트랙이 끝났다 — ConPTY,
Windows 단위테스트(제품 결함 11건), 코드 감사. **남은 일은 e2e 통일 하나다.**

근거 문서 셋:
- `CROSS_PLATFORM_HANDOFF.md` — 전체 상태. §3 이 남은 일, §7 이 감사 결과
- `CROSS_PLATFORM_SRS.md` §11 — ConPTY 트랙 (§11.8 이 원인 확정)
- `WINDOWS_TEST_PARITY_SRS.md` — Windows 단위테스트 트랙 (§10 이 결과)

## 2. 이번 세션의 일 — e2e 를 한 벌로 통일한다

### 왜

**세 OS 가 서로 다른 것을 검사한다.**

| 대상 | 수단 | 어디서 | 무엇을 |
|---|---|---|---|
| macOS | `scripts/verify-isolated.sh` | **로컬에서 사람이 직접만** | 21항목 — ping·도구·**git 8종**·stats·settings·정적 자산 |
| Linux | `verify.yml` 인라인 bash | CI | doctor + 종단간 5단계 |
| Windows | `verify.yml` 인라인 PowerShell | CI | doctor + 종단간 5단계 |

darwin 의 git 8종·`/api/stats`·`/api/settings`·정적 자산 검사가 **Linux·Windows
에서 한 번도 돌지 않는다.** 반대로 CI 의 doctor 계층 검사는 darwin 에서 돌지
않는다. 그리고 Linux/Windows 종단간은 **스크립트가 두 벌**(bash/PowerShell)이라
한쪽만 고쳐진다 — 실제로 그런 적이 있다.

### 정해진 설계 (사용자 확인 완료 — 다시 묻지 마라)

- **검사 정의를 Go 한 벌로 옮긴다.** bash/PowerShell 두 벌이 사라진다
- **CI 는 linux + windows** 에서 그것을 돌린다 (지금과 같은 비용)
- **macOS 는 CI 에 넣지 않는다.** 개발자가 로컬에서 같은 것을 돈다.
  `verify-isolated.sh` 는 그 Go e2e 를 부르는 얇은 껍데기로 바꾸거나 대체
- **세 OS 가 같은 목록을 돈다.** 빠지는 항목은 **능력 질의로 명시적으로 건너뛰고
  그 사실이 출력에 남게** 한다 — `internal/shared/testpath` 의
  `PermChecked()`·`ForegroundGroups()`·`POSIXShell()` 과 같은 규칙 (FR-WTP-30~32)

### 착수 전에 읽을 것

- `scripts/verify-isolated.sh` — 21항목의 실체. **격리 가드를 반드시 옮겨라**
  (포트 58146 이면 중단, 홈이 격리 홈이 아니면 중단). 그 가드가 없어서 운영
  인스턴스를 죽인 사고가 실제로 있었다 — 스크립트 머리말에 적혀 있다
- `.github/workflows/verify.yml` 의 `windows-runtime`(69~127행)과 `linux-runtime`
  두 인라인 블록 — 종단간 5단계의 실체
- `internal/ctl/cli/doctor.go` — 계층별 진단의 선례. 새 e2e 가 이것과 겹치는지
  갈라지는지 **먼저 정하라**

### 규약

**규모가 중·대다. CLAUDE.md 대로 스펙(IEEE 29148)을 먼저 쓴다.**
기존 스펙들의 형식을 따라라 (`docs/internal/*_SRS.md`).

## 3. 다시 파지 마라 — 이미 끝난 것

- **ConPTY**: 원인은 `STARTF_USESTDHANDLES` 하나였다. 라이브러리 교체는 하지
  않았고 새 의존도 없다 (SRS §11.8)
- **경로 계열 결함 D1~D11**: 전수 감사까지 끝났다 (`WINDOWS_TEST_PARITY_SRS`
  §2.3~2.8). 슬래시를 박은 13곳 중 대부분은 정당했다(URL·git ref·map 키) —
  다시 훑지 마라
- **코드 감사**: 하드코딩·테스트 전용 프로덕션 코드·거짓 주석을 걷었다
  (HANDOFF §7). **§7.3 이 "손대지 않은 것" 목록**이다 — 거기 있는 것만 남았다

## 4. 검증

```bash
gofmt -l internal cmd
go build ./... && go vet ./...
GOOS=windows go vet ./...          # 테스트 파일까지 타입검사 — Windows 유일의 로컬 수단
go test ./internal/... ./cmd/... -count=1
scripts/check-cross.sh             # 5개 대상 build + vet
scripts/check-seams.sh             # OS 이음매
scripts/verify-isolated.sh         # darwin 실동작 21항목
```

**Windows·Linux 는 CI 로만 검증된다.** 푸시하면 `verify` 워크플로우가 돈다.

```bash
gh run list --repo Biisairo/dongminal --branch crossplatform --limit 1
JOB=$(gh run view <runId> --repo Biisairo/dongminal --json jobs \
      --jq '.jobs[]|select(.name=="test (windows-latest)")|.databaseId')
gh api "repos/Biisairo/dongminal/actions/jobs/$JOB/logs" | sed 's/^[0-9T:.Z-]* //'
```

`gh` 계정은 READ 권한뿐이라 **run 취소·재실행은 안 된다.** 로그 조회는 되고,
푸시는 SSH 로 나가므로 문제없다. 전체 실행은 5~8분이다.

## 5. 작업 규약

- 커밋 메시지에 AI 서명(`Co-Authored-By` 등)을 넣지 마라
- 커밋은 사용자 확인 후에. **푸시는 CI 검증에 필요하므로 해도 된다** — 브랜치는
  `crossplatform` 이고 `main` 은 건드리지 마라
- 심볼 탐색은 LSP → Serena 순. grep 은 텍스트·파일명 검색에만
- **서브에이전트에 프로세스·파일시스템을 만지는 일을 시킬 때는 격리 수단을 먼저
  지시하라.** 지난 세션에 수정 에이전트가 개발 호스트의 실제 pid 에
  SIGTERM/SIGKILL 을 보낸 사고가 있었다 (HANDOFF §7.4)
- **다른 에이전트의 보고를 그대로 믿지 마라.** 지난 세션에 오탐과 잘못된 절 번호
  인용이 있었다. 파일에서 직접 확인한 것만 사실로 다뤄라

## 6. 그 다음

e2e 통일이 끝나면 `main` 병합. 통일된 검사가 병합 전에 세 OS 를 한 번 훑는다.
