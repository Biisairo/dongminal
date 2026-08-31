# 고치는 사람을 위한 안내 — 빌드·검사·배포

받아서 쓰는 사람에게는 필요 없다. 자기 OS 바이너리 하나면 끝이고, 그 길은
[README](../../README.md) 와 [getting-started](../external/getting-started.md) 에 있다.

이 문서는 **README 가 사용자 문서가 되면서 옮겨 온 것**이다
(README_REWRITE_SRS FR-RDM-9). 내용은 그대로다.

---

## 지원 플랫폼

macOS · Linux · **WSL** · **Windows 10 1809+** (native).

OS 마다 달라지는 것은 전부 `internal/shared/platform` 뒤에 있다 — PTY,
프로세스 제어·그룹, 프로세스 조회, 셸 선택과 훅, 로컬 IPC 종단, 경로 규약,
브라우저 실행. **그 패키지 밖에는 OS 분기가 한 줄도 없다.** 그 규칙을 강제하는
것이 `scripts/check-seams.sh` 다.

Windows 최소 버전이 1809 인 이유는 ConPTY(`CreatePseudoConsole`)다 — Windows 에서
PTY 의미론을 얻는 유일한 공식 경로이며 그 버전에서 도입됐다.

### 소스에서 빌드

받아서 쓰는 사람에게는 필요 없다 — 위 [설치](#설치)면 끝이다. 이 절은 고치는
사람을 위한 것이다. Go 1.24+ 가 필요하다.

Go 는 교차 컴파일이 기본이라 별도 툴체인이 필요 없다. 맥에서 윈도우·리눅스
바이너리가 그대로 나온다.

```bash
scripts/build.sh                        # 호스트용 하나 → ./dongminal
scripts/build.sh --os windows           # 윈도우용 → dist/dongminal-windows-amd64.exe
scripts/build.sh --os linux --arch arm64
scripts/build.sh --all                  # 배포 대상 5종 → dist/
VERSION=v1.0.3 scripts/build.sh --all   # 판을 새겨서 (릴리스가 쓰는 형태)
```

`VERSION` 을 주지 않으면 `dongminal version` 이 `dev` 를 낸다. 소스 빌드와 릴리스
산출물을 구별하기 위해서다.

대상은 darwin/arm64 · darwin/amd64 · linux/amd64 · linux/arm64 · windows/amd64 다.
WSL 은 별도 대상이 아니다 — `linux/amd64` 를 그대로 쓴다.

**cgo 주의.** 이 저장소의 cgo 는 하나뿐이다 — `sysstat` 의 mach 호출(macOS 의
CPU 사용률·메모리 사용량). linux·windows 는 그 지표를 `/proc` 과 WinAPI 로 읽으므로
cgo 가 필요 없고 정적 바이너리로 나온다.

문제는 go 가 GOOS/GOARCH 가 호스트와 다르면 `CGO_ENABLED` 를 자동으로 0 으로
내린다는 점이다. arm64 맥에서 `GOOS=darwin GOARCH=amd64 go build` 를 직접 부르면
**그 바이너리만 CPU·메모리 지표를 잃는다.** `build.sh` 가 darwin 대상에 한해
cgo 를 다시 켜므로, 손으로 `go build` 하지 말고 스크립트를 쓴다.

darwin 이 아닌 호스트에서 darwin 대상을 빌드하면 cgo 를 켤 수 없다. 그때는
건너뛰지 않고 지표가 빠진 채로 빌드하며 화면에 경고를 남긴다.

### 검사

```bash
scripts/check-cross.sh     # 5개 대상 build + vet (테스트 파일까지 타입 검사)
scripts/check-seams.sh     # OS 의존 호출이 platform 밖에 없는지
scripts/verify-isolated.sh # 격리 인스턴스를 띄워 종단간 22항목 (dongminal verify)
```

종단간 검사의 정의는 **Go 한 벌**이다 (`internal/ctl/cli/verify.go`). 세 OS 가 같은
목록을 돌고, CI 의 Linux·Windows 도 같은 것을 부른다 — 검사를 셸 스크립트로 두 벌
적던 것을 접었다. 설계는
[docs/internal/E2E_UNIFICATION_SRS.md](docs/internal/E2E_UNIFICATION_SRS.md).

### 배포

태그 `v*` 를 밀면 `.github/workflows/release.yml` 이 세 OS 에서 게이트(단위 테스트 ·
`doctor` · `verify`)를 돌리고, 다섯 대상을 빌드해 GitHub Releases 에 첨부한다.
바이너리는 저장소에 커밋하지 않는다 — 이유와 설계는
[docs/internal/RELEASE_SRS.md](docs/internal/RELEASE_SRS.md).

설계와 이음매 목록은 [docs/internal/CROSS_PLATFORM_SRS.md](docs/internal/CROSS_PLATFORM_SRS.md).

세 OS 모두 **실기에서 검증된다.** CI(`.github/workflows/verify.yml`)가 매 푸시마다
Linux·Windows 에서 단위 테스트 · `doctor` · `verify` 를 돌리고, macOS 는 개발자가
로컬에서 같은 것을 돈다. WinAPI 호출(ConPTY·Job Object·toolhelp)도 실제 Windows
러너에서 실행된다.

## 테스트

Go 테스트는 의존이 없다:

```bash
go test ./...            # 호스트(darwin·linux)
scripts/check-cross.sh   # 5개 대상 build + vet — 테스트 파일까지 타입 검사된다
```

e2e(Playwright)는 npm 이 필요하다. **빌드에는 필요 없다** — 프론트엔드는 번들러가
없고 `web/vendor/xterm.js` 가 저장소에 있어 `go build` 하나로 끝난다:

```bash
npm ci                    # Playwright 설치 (e2e 전용)
npx playwright install     # 브라우저 바이너리
npx playwright test        # 전량 (약 5분)
npx playwright test e2e/git-panel.spec.ts   # 스펙 하나
```

e2e 는 `go run ./cmd/dongminal start --foreground` 로 포트 58147 에 서버를 직접
띄우고 임시 홈을 쓴다 (`playwright.config.ts`). 운영 인스턴스와 겹치지 않는다.

수동으로 실동작을 확인할 때도 **운영 인스턴스를 건드리지 않는 경로**를 쓴다:

```bash
./dongminal start --isolated    # 임시 홈 + 빈 포트. 기존 서버를 죽이지 않는다
```

`dongminal stop` 은 홈이 아니라 **포트**로 대상을 찾는다. `--port` 없이 부르면
기본 포트(58146)의 인스턴스를 정지시키므로, 격리 인스턴스를 접을 때는 `start` 가
출력한 정지 명령(`--port`·`--home` 이 채워진 형태)을 그대로 쓴다.

종단간은 `dongminal verify` 다. 격리 인스턴스를 **스스로** 띄워 22항목을 훑고
치운다:

```bash
./dongminal verify           # 또는 scripts/verify-isolated.sh (빌드까지 함께)
```

검사 범위는 데몬 기동·`paned.sock`·`/api/ping`, 도구 생성(PTY+IPC 왕복)·조회·busy
RPC·출력 조회·**입력→출력 왕복**, 워크스페이스·설정·상태 조회, git 읽기 표면 8종과
없는 git 경로의 404, `index.html` 이 실제로 로드하는 `<script>` 전량 200, 구 평면
경로(`/js/app.js`) 404 다.

`verify` 는 `--port`·`--home` 을 **받지 않는다.** 언제나 임시 홈과 빈 포트에서 돌고,
`stop` 대신 자기가 띄운 PID 와 격리 홈의 `paned.pid` 만 직접 끝낸다 — 운영
인스턴스를 건드릴 방법이 없다. 홈이 격리 홈이 아니거나 포트가 58146 이면 아무것도
띄우지 않고 중단한다.

git 검사 대상은 **실제 리포**여야 한다 — 비-git 디렉터리는 `ErrNotRepo` 로 정당하게
404 라서 라우팅 누락과 구별되지 않는다. 저장소가 아니면 그 항목들은 이유와 함께
건너뛴다.

## 기술 스택

- **백엔드**: Go 1.24+, `creack/pty`, `gorilla/websocket`, `go:embed`
- **프론트엔드**: xterm.js v5 (fit, search, web-links, unicode11 addons)
- **선택 의존성**: `claude` CLI (에이전트 오케스트레이션 시)

## TODO

- focused browser 자동 동기화 — **범위가 줄었다.** 창 포커스 소유권이 서버 권위로 옮겨져(FR-XDF-*) 기기 간에도 동기화되고, 이제 *마지막으로 포커스한* 브라우저의 창 크기가 적용된다 (예전엔 마지막으로 *새로고침한* 브라우저였다). 남은 결손: 소유자가 OS 포커스를 잃은 채 소유권을 유지하면 아무도 리사이즈를 보내지 않아 크기가 그 시점에 고정된다
- 주의 알림: 서버 호스트(브라우저 없는 원격 머신)용 OS 알림/웹훅·모바일 푸시 — 현재는 접속한 브라우저에만 표시됨
- 데스크톱 래핑 (tauri, electron 등)
- mobile mode: Ctrl+C/D/Z 단발 버튼, 키 커스터마이즈, modifier sticky/lock 시각 강화 (RFC §8)
