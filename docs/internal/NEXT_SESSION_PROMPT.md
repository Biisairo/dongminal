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

## 2. 남은 일 — 둘

### ① `test (windows-latest)` 잡이 한 번도 통과한 적이 없다

이 트랙과 **무관한 선재 결함**이다. e8d6636 로 CI 가 들어온 이래 실행 8회 전부
failure 또는 cancelled 다. 약 250개 테스트가 깨지고 두 패키지
(`git/store`·`gitapi`)는 600초 타임아웃까지 간다.

원인은 POSIX 를 전제한 테스트가 Windows 에서 도는 것이다 — 실행 권한 비트
(`TestCopyExecutable`), `/proc` 표를 쓰는 `TestLinux*`, 셸 래퍼 문자열,
`git` 동작 차이 등.

FR-XBD-4 는 "Windows 보증 범위는 build·vet 과 플랫폼 독립 테스트" 라고 적었다.
그 경계가 **코드에는 있는데 워크플로우에는 없다.** 방향은 둘이다 (SRS §10.4 R-4).

1. POSIX 전제 테스트에 `//go:build !windows` 를 달아 경계를 코드로 굳힌다
2. `test` 매트릭스에서 windows 를 빼고, Windows 는 `windows-runtime` 잡
   (build·vet + doctor + 종단간)으로만 보증한다

①이 FR-XBD-4 의 뜻에 맞지만 250건을 하나씩 판정해야 한다. **어느 쪽으로 갈지는
사용자에게 물어라** — 보증 범위를 줄이는 결정이라 대신 정할 일이 아니다.

### ② `main` 병합

Windows 가 통과했으므로 막는 것은 없다. 다만 지금 병합하면 `main` 의 CI 도 빨간
잡을 하나 안고 간다 — ①을 먼저 처리할지는 사용자 결정이다.

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
