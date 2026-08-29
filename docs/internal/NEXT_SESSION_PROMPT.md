<!-- 이 파일은 전체가 새 세션의 첫 메시지다. 열어서 전체 선택 → 붙여넣기. -->

dongminal 저장소에서 크로스플랫폼 작업을 이어서 한다. 브랜치는 `crossplatform`
이고 **모두 커밋·푸시되어 있다** — 워킹 트리는 깨끗하다.

## 0. 가장 먼저

**`docs/internal/CROSS_PLATFORM_HANDOFF.md` 를 전부 읽어라.** 이 프롬프트는 그
문서의 착수 순서일 뿐이다. 근거 스펙은 `docs/internal/CROSS_PLATFORM_SRS.md` 이며
실기 기록은 그 §11 이다.

```bash
git branch --show-current      # crossplatform 이어야 한다
git status --short             # 비어 있어야 한다
go build ./... && go vet ./...
```

## 1. 한 줄 상태

OS 이음매 18종을 `internal/shared/platform` 의 인터페이스 8종 뒤로 보냈다.
**darwin·linux·WSL·Windows 네 대상 모두 종단간까지 CI 에서 통과한다.**

Windows ConPTY 는 해결됐다(SRS §11.8). 빠진 것은 `STARTF_USESTDHANDLES` 한 줄
이었고, **라이브러리 교체는 하지 않았다** — §11.7 의 그 결정은 실행 전에 뒤집혔다.
새 의존도 `go` 지시자 변경도 없다. 다시 파지 마라.

**CI 잡 넷이 전부 초록이다.**

## 2. 남은 일 — `main` 병합뿐

CI 잡 넷이 전부 초록이다 (run 33263400171). 막는 것은 없다.

두 번째 트랙(Windows 단위테스트)은 `WINDOWS_TEST_PARITY_SRS.md` 에 있다. 그
잡은 도입 이래 한 번도 통과한 적이 없었고, 실패 356줄을 전수로 파 내려가
**제품 결함 11건**이 나왔다 — 요약은 그 §10.2 다. 다시 파지 마라.

열어 둔 위험은 그 스펙 §10.4 의 R-5·R-6 이다. **증거가 나올 때까지 손대지
않는다** — 추측으로 추상화를 세우지 않는 것이 이 트랙의 방침이었고, 그 방침이
D1~D11 을 찾아낸 방법이기도 하다.

## 3. 검증

darwin 에서:

```bash
scripts/check-cross.sh     # 5개 대상 build + vet
scripts/check-seams.sh     # OS 의존 호출이 platform 밖에 없는지
go test ./internal/... ./cmd/...
scripts/verify-isolated.sh # 실동작 21항목
```

**Windows 는 CI 로만 검증된다.** 푸시하면 `.github/workflows/verify.yml` 이 돈다.

```bash
gh run list --repo Biisairo/dongminal --branch crossplatform --limit 1
JOB=$(gh run view <runId> --repo Biisairo/dongminal --json jobs \
      --jq '.jobs[]|select(.name=="windows-runtime")|.databaseId')
gh api "repos/Biisairo/dongminal/actions/jobs/$JOB/logs" | sed 's/^[0-9T:.Z-]* //'
```

`gh` 계정은 READ 권한뿐이라 run 취소·재실행은 안 된다. 로그 조회는 되고, 푸시는
SSH 로 나가므로 문제없다. windows-runtime 잡은 보통 2~3분이다.

`windows-runtime` 이 통과 상태를 유지하는지 보는 기준은 `doctor` 의 「의사
터미널」에서 **[단순 명령]** 이다 — 그것이 ConPTY 배관의 최소 증명이다.

## 4. 알려진 간헐 실패 (내 변경과 무관, HEAD 에서 재현 확인)

- `web` 의 `TestAssetVersionBumpedWithAssets` — `assets.lock` 한 줄 불일치
- `TestApiToolDelete_ClearsAttention` · `TestToolClientForegroundNameOverIPC` —
  `SaveAll` 이 테스트 종료 후 `TempDir` 에 쓰는 경합. 후자가 run 33257794325 의
  `test (ubuntu-latest)` 를 떨어뜨렸다 (로컬 5회 반복 통과)

## 5. 작업 규약

- 커밋 메시지에 AI 서명(`Co-Authored-By` 등)을 넣지 마라
- 커밋은 사용자 확인 후에. **푸시는 CI 검증에 필요하므로 해도 된다** — 브랜치는
  `crossplatform` 이고 `main` 은 건드리지 마라
- 심볼 탐색은 LSP → Serena 순. grep 은 텍스트·파일명 검색에만
