<!-- 이 파일은 전체가 새 세션의 첫 메시지다. 열어서 전체 선택 → 붙여넣기. -->

dongminal 저장소에서 크로스플랫폼 작업을 이어서 한다. 브랜치는 `crossplatform` 이다.

## 0. 가장 먼저

**`docs/internal/CROSS_PLATFORM_HANDOFF.md` 를 전부 읽어라.** 이 프롬프트는 그
문서의 착수 순서일 뿐이다.

```bash
git branch --show-current      # crossplatform 이어야 한다
git status --short             # 비어 있어야 한다
go build ./... && go vet ./...
```

## 1. 한 줄 상태

**네 트랙이 끝났다** — ConPTY, Windows 단위테스트(제품 결함 11건), 코드 감사,
e2e 통일. **남은 일은 `main` 병합이다.**

근거 문서 넷:
- `CROSS_PLATFORM_HANDOFF.md` — 전체 상태. §7 이 감사 결과, §7.3 이 "손대지 않은 것"
- `CROSS_PLATFORM_SRS.md` §11 — ConPTY 트랙 (§11.8 이 원인 확정)
- `WINDOWS_TEST_PARITY_SRS.md` — Windows 단위테스트 트랙 (§10 이 결과)
- `E2E_UNIFICATION_SRS.md` — e2e 통일 트랙 (§9 가 결과)

## 2. 이번 세션의 일 — `main` 병합

병합 전에 세 대상을 한 번 훑는다. 이제 그것이 **한 명령**이다.

```bash
gofmt -l internal cmd
go build ./... && go vet ./...
GOOS=windows go vet ./...          # 테스트 파일까지 타입검사 — Windows 유일의 로컬 수단
go test ./internal/... ./cmd/... -count=1
scripts/check-cross.sh             # 5개 대상 build + vet
scripts/check-seams.sh             # OS 이음매
scripts/verify-isolated.sh         # darwin 실동작 — dongminal verify 22항목
```

**Windows·Linux 는 CI 로만 검증된다.** 푸시하면 `verify` 워크플로우가 돈다 (5~8분).

```bash
gh run list --repo Biisairo/dongminal --branch crossplatform --limit 1
JOB=$(gh run view <runId> --repo Biisairo/dongminal --json jobs \
      --jq '.jobs[]|select(.name=="windows-runtime")|.databaseId')
gh api "repos/Biisairo/dongminal/actions/jobs/$JOB/logs" | sed 's/^[0-9T:.Z-]* //'
```

`gh` 계정은 READ 권한뿐이라 **run 취소·재실행은 안 된다.** 로그 조회는 되고,
푸시는 SSH 로 나가므로 문제없다.

## 3. 다시 파지 마라 — 이미 끝난 것

- **ConPTY**: 원인은 `STARTF_USESTDHANDLES` 하나였다. 라이브러리 교체는 하지
  않았고 새 의존도 없다 (SRS §11.8)
- **경로 계열 결함 D1~D11**: 전수 감사까지 끝났다 (`WINDOWS_TEST_PARITY_SRS`
  §2.3~2.8). 슬래시를 박은 13곳 중 대부분은 정당했다(URL·git ref·map 키)
- **코드 감사**: HANDOFF §7. **§7.3 이 "손대지 않은 것" 목록**이다
- **e2e 하네스**: 검사 정의는 `internal/ctl/cli/verify.go` **한 곳**이다. CI 나
  `verify-isolated.sh` 에 검사를 다시 적지 마라 — 그것이 이 트랙이 접은 문제다

## 4. e2e 를 건드릴 일이 생기면

- 검사를 더할 자리는 `verifyChecks()` 의 표다. 항목 수·이름을 붙드는 골든
  테스트(`TestVerifyChecks_Golden`)를 함께 고쳐야 한다 — 그것이 자물쇠다
- **대상별 갈래를 만들지 마라.** OS 차이는 `platform` 인터페이스 아래로 밀어
  넣는다 (FR-E2S-0). 검사에 갈래가 필요해 보이면 인터페이스가 덜 흡수한 것이다
- 건너뜀의 근거는 **호스트 환경**이지 OS 가 아니다. `TestVerifyChecks_NoOSDrivenSkips`
  가 그것을 붙든다
- `verify` 는 `--port`·`--home` 을 **거부한다.** 격리 가드를 무르게 하지 마라 —
  그 가드가 없어서 운영 인스턴스를 죽인 사고가 있었다

## 5. 작업 규약

- 커밋 메시지에 AI 서명(`Co-Authored-By` 등)을 넣지 마라
- 커밋은 사용자 확인 후에. **푸시는 CI 검증에 필요하므로 해도 된다**
- 심볼 탐색은 LSP → Serena 순. grep 은 텍스트·파일명 검색에만
- **서브에이전트에 프로세스·파일시스템을 만지는 일을 시킬 때는 격리 수단을 먼저
  지시하라.** 지난 세션에 수정 에이전트가 개발 호스트의 실제 pid 에
  SIGTERM/SIGKILL 을 보낸 사고가 있었다 (HANDOFF §7.4)
- **다른 에이전트의 보고를 그대로 믿지 마라.** 파일에서 직접 확인한 것만 사실로
  다뤄라
