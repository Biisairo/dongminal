<!-- 이 파일은 전체가 새 세션의 첫 메시지다. 열어서 전체 선택 → 붙여넣기. -->

dongminal 저장소에서 크로스플랫폼 작업을 이어서 한다. 브랜치는 `crossplatform`
이고 **모두 커밋·푸시되어 있다** — 워킹 트리는 깨끗하다.

## 0. 가장 먼저

**`docs/internal/CROSS_PLATFORM_HANDOFF.md` 를 전부 읽어라.** 이 프롬프트는 그
문서의 착수 순서일 뿐이고, 무엇을 배제했고 무엇이 확정됐는지는 거기 있다.
근거 스펙은 `docs/internal/CROSS_PLATFORM_SRS.md` 이며 실기 기록은 그 §11 이다.

```bash
git branch --show-current      # crossplatform 이어야 한다
git status --short             # 비어 있어야 한다
go build ./... && go vet ./...
```

## 1. 한 줄 상태

OS 이음매 18종을 `internal/shared/platform` 의 인터페이스 8종 뒤로 보냈다.
**darwin·linux·WSL 은 종단간까지 통과**하고 **Windows 만 남았다.** 원인은 직접
구현한 ConPTY 하나로 좁혀져 있다.

## 2. 이번 세션의 첫 작업 — 사용자가 이미 결정했다

**ConPTY 를 검증된 라이브러리로 교체한다.** 직접 구현이 CI 6사이클에도 수렴하지
않아 사용자가 결정했다 (D-2 번복).

바꿀 파일은 **`internal/shared/platform/pty_windows.go` 하나**다. `PTY`/`Terminal`
인터페이스가 이미 서 있어 그 밖으로는 번지지 않는다.

후보: `github.com/UserExistsError/conpty`, `github.com/aymanbagabas/go-pty`.

지켜야 할 것 둘:

- `pty.go` 의 `Terminal` 인터페이스 계약 (Read/Write/Close/Resize/Size/
  ForegroundPGID/PID/Wait/Terminate/Kill). Windows 의 `ForegroundPGID` 는
  `(0,false)` 다
- 환경은 반드시 `dedupEnv(spec.Env, envKeyFolded)` 를 통과시켜라. 빠뜨리면
  `PATH` 에서 `binDir` 이 밀려나 `dmctl` 이 안 잡힌다 (SRS §11.2 ①)

**SRS 도 함께 고쳐라** — NFR-XP-2 와 §9 D-2 가 번복된다. 사유는 §11 의 실측이다.

## 3. 무엇이 이미 아닌 것으로 밝혀졌는지

다시 파지 마라. 전부 실기 또는 원본 대조로 배제했다 (HANDOFF §2.1).

- Go 의 Windows AF_UNIX 지원, Windows 훅 임베드, WinAPI 시그니처·상수,
  구조체 크기(CI 실측 112/104/8), 도구 생성 크기, **콘솔의 유무**,
  **셸·프롬프트·입력 타이밍**

확정된 사실 하나만 기억하면 된다 — 셸이 없는 `cmd /c echo` 조차 ConPTY 로
**16바이트(`\x1b[?9001h\x1b[?1004h`)**, 즉 인사말만 오고 화면이 한 번도 그려지지
않는다.

## 4. 검증

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

`gh` 계정은 READ 권한뿐이라 run 취소는 안 된다. 로그 조회는 되고, 푸시는 SSH 로
나가므로 문제없다. windows-runtime 잡은 보통 2~3분이다.

성공 기준: `doctor` 의 「의사 터미널」에서 **[단순 명령]이 먼저 통과**해야 한다 —
그것이 배관의 최소 증명이다. 그 다음 [맨 셸]·[훅 얹은 셸]·[도구]·[콘솔 없는
프로세스], 그리고 「종단간」 단계.

## 5. 그 다음

- Windows 통과 후 `main` 병합
- SRS §10.4 의 "검증되지 않은 채 인도되는 것" 목록을 CI 가 덮는 만큼 줄인다
- 기존 결함 2건 (이번 트랙과 무관, HEAD 에서 재현 확인)
  - `web` 의 `TestAssetVersionBumpedWithAssets` — `assets.lock` 한 줄 불일치
  - `TestApiToolDelete_ClearsAttention` — `SaveAll` 이 테스트 종료 후 `TempDir` 에
    쓰는 경합으로 간헐 실패

## 6. 작업 규약

- 커밋 메시지에 AI 서명(`Co-Authored-By` 등)을 넣지 마라
- 커밋은 사용자 확인 후에. **푸시는 CI 검증에 필요하므로 해도 된다** — 브랜치는
  `crossplatform` 이고 `main` 은 건드리지 마라
- 심볼 탐색은 LSP → Serena 순. grep 은 텍스트·파일명 검색에만
