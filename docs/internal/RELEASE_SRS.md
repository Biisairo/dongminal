# SRS: 바이너리 배포 — GitHub Releases · v1.0.0 — IEEE 29148

## 1. 개요 (Introduction)

### 1.1 목적 (Purpose)

지금 dongminal 을 쓰려면 **저장소를 클론하고 Go 툴체인으로 직접 빌드해야 한다.**
`README` 와 `getting-started` 모두 `git clone` → `scripts/build.sh` 로 시작한다.

그런데 이 프로그램은 **의존이 없는 단일 정적 바이너리**다. 프론트엔드(xterm.js)와
런타임 헬퍼까지 `go:embed` 로 들어가 있어, 파일 하나를 받아 실행하면 끝난다. 받는
사람에게 Go 를 요구할 이유가 없다.

이 문서는 **태그를 밀면 다섯 대상의 바이너리가 GitHub Releases 에 올라가고, 받는
사람은 자기 OS 것 하나만 내려받아 바로 실행하는** 배포 경로를 정의한다. 첫 릴리스는
**v1.0.0** 이다.

### 1.2 범위 (Scope)

**대상 안**

- 릴리스 워크플로우 (`.github/workflows/release.yml`) — 태그 `v*` 에 반응
- 빌드 대상 5종과 그 **cgo 정책**(§2.2 가 이 설계를 좌우한다)
- 바이너리에 버전을 새기고 `dongminal version` 으로 확인
- `SHA256SUMS` 동봉
- 릴리스 전 게이트 — 세 OS 에서 `doctor` + `verify`
- 사용자 대면 문서 전량을 "받아서 실행" 기준으로 갱신

**대상 밖** — §5.

### 1.3 정의 (Definitions)

| 용어 | 뜻 |
|---|---|
| **릴리스 애셋** | GitHub Releases 에 첨부되는 파일. **git object 가 아니다** — 저장소 히스토리에 들어가지 않고 개별 URL 로 하나씩 받는다 |
| **대상(target)** | `GOOS/GOARCH` 짝. 이 저장소는 5종이다 |
| **게이트** | 릴리스를 내보내기 전에 통과해야 하는 검사 |

### 1.4 참고 (References)

- `scripts/build.sh` — 빌드 규칙의 단일 출처. 특히 cgo 정책
- `E2E_UNIFICATION_SRS.md` — `dongminal verify`. 릴리스 게이트가 이것을 쓴다
- `CROSS_PLATFORM_SRS.md` — 지원 플랫폼과 Windows 최소 버전(1809, ConPTY)
- `README.md`, `docs/external/*` — 갱신 대상

---

## 2. 현황과 제약 (Identified Issue)

### 2.1 왜 저장소에 커밋하지 않는가

바이너리를 `dist/` 에 커밋하는 방안을 실측으로 검토하고 **버렸다.**

| 항목 | 실측 |
|---|---|
| 대상 1종 | 13~14MB |
| 5종 합계 | **69MB** |
| 현재 `.git` 전체 | 88MB |

git 은 모든 판을 영구히 보관하고, **바이너리는 델타 압축이 사실상 먹지 않는다.**
배포 열 번이면 클론이 700MB 를 넘고, 그 시점에는 히스토리를 다시 쓰지 않는 한
되돌릴 수 없다. 받는 사람도 자기 OS 것 하나가 아니라 다섯 개를 전부 받게 된다.

릴리스 애셋은 정확히 이 문제를 피하려고 있는 기능이다 — 저장소 밖에 놓이고,
필요한 하나만 URL 로 받는다.

### 2.2 cgo 가 설계를 좌우한다 (핵심 제약)

이 저장소의 cgo 는 하나뿐이다 — `sysstat` 의 mach 호출(macOS 의 CPU 사용률·메모리
사용량). linux·windows 는 그 지표를 `/proc` 과 WinAPI 로 읽으므로 cgo 가 필요 없다.

함정은 **go 가 `GOOS`/`GOARCH` 가 호스트와 다르면 `CGO_ENABLED` 를 자동으로 0 으로
내린다**는 점이다. 리눅스 러너에서 darwin 대상을 빌드하면 컴파일은 성공하지만
**CPU·메모리 지표가 빠진 바이너리가 조용히 나간다.** `build.sh` 가 그 경우 경고를
남기지만, 경고는 릴리스를 막지 못한다.

따라서 **darwin 대상은 macOS 러너에서 빌드해야 한다.** 이것이 워크플로우를 러너별로
가르는 유일한 이유다.

### 2.3 버전을 확인할 수단이 없다

바이너리에 버전 표기가 없다. 배포를 시작하면 "받은 것이 무엇인지" 를 물을 수 없다는
뜻이고, 결함 보고에서 판을 특정할 수 없다.

---

## 3. 요구사항 (Requirements)

### 3.1 묶음 A — 버전 (FR-RVN)

**FR-RVN-1** 바이너리에 버전을 새긴다. 주입 지점은 하나다.

```
-ldflags "-X dongminal/internal/ctl/cli.Version=<태그>"
```

**FR-RVN-2** 새기지 않고 빌드하면 값은 `dev` 다. **소스에서 직접 빌드한 것과 릴리스
산출물이 구별되어야 한다** — 결함 보고에서 그 둘을 섞으면 재현이 불가능해진다.

**FR-RVN-3** `dongminal version` 과 `dongminal --version` 이 버전을 낸다. 함께 찍는
것은 `GOOS/GOARCH` 와 go 런타임 판이다 — 어느 대상을 받았는지가 곧 질문이 된다.

**FR-RVN-4** `build.sh` 는 환경변수 `VERSION` 을 받아 FR-RVN-1 로 넘긴다. 비면 주입
하지 않는다(= `dev`).

### 3.2 묶음 B — 릴리스 워크플로우 (FR-RWF)

**FR-RWF-1** `v` 로 시작하는 태그를 밀면 릴리스가 만들어진다. 수동 실행
(`workflow_dispatch`)도 받는다.

**FR-RWF-2** 애셋은 다음 5종이며 이름에 대상이 드러난다. `build.sh` 의 `distPath` 와
같은 규칙이다 — windows 만 `.exe` 다.

    dongminal-darwin-arm64
    dongminal-darwin-amd64
    dongminal-linux-amd64
    dongminal-linux-arm64
    dongminal-windows-amd64.exe

**FR-RWF-3** **darwin 대상은 macOS 러너에서 빌드한다** (§2.2). 나머지는 리눅스
러너에서 `CGO_ENABLED=0` 정적 빌드다.

**FR-RWF-4** 빌드는 반드시 `scripts/build.sh` 를 거친다. 워크플로우가 `go build` 를
직접 부르지 않는다 — cgo 정책과 이름 규칙이 두 벌이 되면 한쪽만 고쳐진다.

**FR-RWF-5** darwin 빌드가 cgo 없이 이루어지면 **릴리스를 중단한다.** `build.sh` 는
경고만 남기므로 워크플로우가 그 경고를 실패로 승격시킨다. 지표가 빠진 배포본이
조용히 나가는 것을 막는다 (§2.2).

**FR-RWF-6** `SHA256SUMS` 를 만들어 함께 첨부한다.

**FR-RWF-7** 릴리스 본문에 대상별 설치 한 줄을 싣는다. 받는 사람이 페이지를 벗어나지
않고 명령을 복사할 수 있어야 한다.

**FR-RWF-8** 저장소에 바이너리를 **커밋하지 않는다.** `/dist/` 는 `.gitignore` 에
남는다 (§2.1).

### 3.3 묶음 C — 릴리스 게이트 (FR-RGT)

**FR-RGT-1** 애셋을 올리기 전에 **세 OS 에서** 다음이 통과해야 한다.

    go build ./... · go vet ./... · go test ./internal/... ./cmd/...
    dongminal doctor      — 플랫폼 계층
    dongminal verify      — 종단간 22항목

**FR-RGT-2** 게이트에 **macOS 를 포함한다.** 상시 CI 에 macOS 를 넣지 않는다는 결정
(E2E_UNIFICATION_SRS FR-E2I-5)은 **매 푸시**에 대한 것이다. 릴리스는 드물고, darwin
바이너리를 실제로 배포하는 순간이므로 그 하나는 확인하고 내보낸다.

**FR-RGT-3** 게이트가 실패하면 릴리스를 만들지 않는다. 애셋이 하나도 올라가지 않아야
한다 — 절반만 올라간 릴리스가 가장 나쁘다.

### 3.4 묶음 D — 문서 (FR-RDC)

**FR-RDC-1** 사용자 대면 문서의 **첫 설치 경로는 다운로드**다. 소스 빌드는 그 다음에
온다. 지금은 순서가 반대다.

**FR-RDC-2** `Go 1.21+` 를 **요구사항에서 뺀다.** 받아서 쓰는 사람에게 Go 는 필요
없다. 소스 빌드 절에만 남긴다.

**FR-RDC-3** 지원 플랫폼 표기를 실제와 맞춘다. `getting-started.md` 는 아직
"macOS 또는 Linux" 라고 적고 있으나 **Windows 10 1809+ 가 지원된다.**

**FR-RDC-4** 갱신 대상은 다음이다.

| 문서 | 무엇을 |
|---|---|
| `README.md` | 빠른 시작을 다운로드부터. 설치 절 신설 |
| `docs/external/getting-started.md` | 요구사항·설치 절 전면. Windows 포함 |
| `docs/external/README.md` | 새 문서로 가는 길 |
| `docs/internal/architecture.md` | 릴리스 워크플로우의 존재 |
| `CHANGELOG.md` | 신설. v1.0.0 |

**FR-RDC-5** 설치 안내는 **대상별로 실제 도는 명령**이어야 한다. macOS 의 quarantine
(`com.apple.quarantine`)처럼 받는 사람이 실제로 부딪히는 것을 적는다 — 적지 않으면
"열 수 없음" 대화상자에서 멈춘다.

### 3.5 비기능 (NFR)

**NFR-REL-1** 새 외부 의존을 만들지 않는다. 워크플로우는 GitHub 이 제공하는 것
(`actions/checkout`·`setup-go`·`upload-artifact`·`download-artifact`)과 `gh` CLI 만
쓴다. 서드파티 릴리스 액션을 쓰지 않는다.

**NFR-REL-2** 릴리스 한 회는 **20분 이내**에 끝난다.

**NFR-REL-3** 워크플로우는 `contents: write` 만 요구한다.

### 3.6 제약 (Constraints)

**C-1** darwin 대상은 macOS 러너가 필요하다 (§2.2).

**C-2** macOS 러너는 리눅스보다 과금 배수가 크다. 그래서 상시 CI 가 아니라 **릴리스
때만** 쓴다.

**C-3** 서명·공증(notarization)을 하지 않는다 — Apple Developer 계정이 없다. 받는
사람이 quarantine 을 직접 풀어야 하며, 그 사실을 문서가 알린다 (FR-RDC-5).

---

## 4. 검증 (Verification)

| 요구 | 검증 방법 |
|---|---|
| FR-RVN-1~3 | 단위테스트 — 기본값이 `dev` 인지, `version` 액션이 대상·런타임을 함께 내는지 |
| FR-RVN-4 | `VERSION=v9.9.9 scripts/build.sh` → `./dongminal version` 이 그 값을 내는지 |
| FR-RWF-2 | 릴리스 페이지의 애셋 이름 5종 |
| FR-RWF-3,5 | macOS 러너 로그에 cgo 경고가 없어야 한다. 있으면 잡이 실패한다 |
| FR-RWF-4 | 워크플로우에 `go build` 직접 호출이 없는지 |
| FR-RWF-6 | `SHA256SUMS` 로 내려받은 파일을 실제 대조 |
| FR-RGT-1~3 | 워크플로우 실행 — 게이트 잡이 셋 다 통과해야 build 가 돈다 |
| FR-RDC-1~5 | 문서 검토 + 실제 다운로드 실행 |

---

## 5. 비목표 (Non-Goals)

1. **바이너리를 저장소에 커밋하는 것** — §2.1 에서 실측으로 버렸다
2. **코드 서명·공증** — C-3
3. **패키지 매니저 배포** (Homebrew·winget·apt) — 별도 트랙
4. **linux/arm64 의 실동작 검증** — 러너가 없다. 빌드만 한다
5. **자동 버전 증가·릴리스 노트 생성** — 태그는 사람이 민다
6. **windows/arm64·linux/386** 등 대상 확대

---

## 6. 구현 계획 (Implementation Plan)

1. **버전** — `cli.Version`, `version` 액션, `build.sh` 의 `VERSION` (FR-RVN)
2. **워크플로우** — 게이트 → 빌드 → 발행 세 잡 (FR-RWF·FR-RGT)
3. **문서** — README·getting-started·external README·architecture·CHANGELOG (FR-RDC)
4. **첫 릴리스** — `main` 병합 후 `v1.0.0` 태그

---

## 7. 리스크 (Risks)

| | 리스크 | 대응 |
|---|---|---|
| **R-1** | darwin 이 cgo 없이 빌드되어 지표가 빠진 채 배포된다 | FR-RWF-5 — 경고를 실패로 승격 |
| **R-2** | 게이트가 절반만 통과한 채 애셋이 올라간다 | FR-RGT-3 — 발행 잡이 게이트 전량에 의존 |
| **R-3** | macOS 사용자가 quarantine 에서 막혀 "깨졌다" 고 판단한다 | FR-RDC-5 — 해제 명령을 설치 안내에 명시 |
| **R-4** | 태그를 소스와 다른 상태에서 밀어 버전이 어긋난다 | 태그 문자열을 그대로 새기므로 `version` 출력이 곧 태그다 |
| **R-5** | 릴리스 게이트의 macOS `verify` 가 처음 도는 것이라 실패할 수 있다 | darwin 로컬에서 22/22 확인됨. 러너 환경 차이는 첫 릴리스가 답한다 |

---

## 8. 구현 결과 (Implementation Outcome)

### 8.1 스펙 대비 정정

**정정 1 — 버전 출력이 OS 이음매 규칙에 걸렸다.**
초안의 `RunVersion` 은 `runtime.GOOS`·`runtime.GOARCH` 를 직접 찍었다.
`scripts/check-seams.sh` 가 이를 잡았다 — `runtime.GOOS` 는 `platform` 밖에 있으면
안 된다 (CROSS_PLATFORM_SRS FR-XPL-5). **표시용이라는 이유로 예외를 두지 않는다.**

`platform.BuildTarget()` 을 신설해 그 아래로 밀어 넣었다. `OSKind` 로 대신하지
않은 것은 뜻이 다르기 때문이다.

| | OSKind | BuildTarget |
|---|---|---|
| 답하는 물음 | 지금 어디서 도는가 | 무엇을 받았는가 |
| WSL | `wsl` 로 구분 | `linux/amd64` (애셋이 그것이다) |
| 쓰임 | 표시·기록 | 판 확인·결함 보고 |

테스트도 `platform.BuildTarget()` 을 기대값으로 쓴다 — 테스트가 `runtime.GOOS` 를
직접 만지면 그 자체로 같은 위반이다.

### 8.2 확인한 것

- `VERSION=v1.0.0 scripts/build.sh` → `dongminal v1.0.0 darwin/arm64 go1.25.4`
- `VERSION` 없이 빌드하면 `dev`
- 릴리스 본문 생성을 로컬에서 재현 — 코드 펜스·백슬래시·태그 치환이 정확히 렌더된다
- `go run ./cmd/dongminal verify` 가 22/22 — 게이트가 `go run` 경로에서 성립한다

### 8.3 아직 답이 없는 것

- **릴리스 워크플로우는 첫 태그가 답한다.** 태그를 밀기 전에는 돌지 않는다
- macOS 러너의 `verify` 는 처음 도는 것이다 (R-5). darwin 로컬은 22/22 다
- `linux/arm64` 는 러너가 없어 빌드만 하고 실행은 검증되지 않는다 (§5-4)
