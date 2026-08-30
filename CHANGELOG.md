# 변경 이력

형식은 [Keep a Changelog](https://keepachangelog.com/ko/1.1.0/) 를 따르고,
판 번호는 [유의적 버전](https://semver.org/lang/ko/) 을 따릅니다.

## [1.0.0] — 2026-08-30

첫 정식 배포입니다. 이제 [Releases](https://github.com/Biisairo/dongminal/releases)
에서 자기 OS 바이너리 하나를 받아 바로 실행할 수 있습니다 — Go 도 다른 의존도
필요 없습니다.

### 추가

- **바이너리 배포.** 태그 `v*` 를 밀면 다섯 대상(macOS arm64·amd64, Linux
  amd64·arm64, Windows amd64)이 빌드되어 릴리스에 첨부됩니다. `SHA256SUMS` 동봉
- **`dongminal version`** (`--version`) — 판·대상·go 런타임을 찍습니다. 릴리스
  산출물이 아니면 `dev` 로 나옵니다
- **Windows 10 1809+ 네이티브 지원.** ConPTY 로 PTY 의미론을 얻습니다. WSL 은
  `linux-amd64` 를 그대로 씁니다
- **`dongminal doctor`** — 플랫폼 계층을 계층별로 실제 실행하는 진단. 터미널이
  뜨지 않을 때 어느 계층에서 막혔는지 그대로 보여 줍니다
- **`dongminal verify`** — 격리 인스턴스를 띄워 종단간 22항목을 훑는 검증.
  세 OS 가 같은 목록을 돕니다 (개발·CI 용)
- 파일 전송

### 변경

- **OS 이음매를 인터페이스 뒤로.** PTY, 프로세스 제어·그룹·조회, 셸 선택과 훅,
  로컬 IPC, 경로 규약, 브라우저 실행이 `internal/shared/platform` 안으로 들어갔고
  그 패키지 밖에는 OS 분기가 한 줄도 없습니다
- git 기록의 자격증명 마스킹이 `https://user:***@h` 에서 `https://***@h` 로
  바뀌었습니다. `user` 자리가 토큰인 형태가 흔하고 구분할 수 없기 때문입니다
- `a/b` 같은 원격 이름을 `fetch`·`tag` 에서도 실행 전에 거부합니다. 종전에는
  엄격한 검사가 `push` 에만 걸려 있었습니다
- `stop` 이 대상을 죽이지 못하면 실패로 보고하고 pidfile 을 보존합니다. 살아 있는
  데몬의 pidfile 을 지우면 고아가 되기 때문입니다

### 수정

- **Windows 에서 터미널이 비어 있던 결함.** `CreateProcess` 에
  `STARTF_USESTDHANDLES` 를 세우지 않아 자식이 부모 콘솔을 물려받았고, 의사
  콘솔이 아니라 그쪽에 글자를 그리고 있었습니다
- Windows 에서 파일 전송이 통째로 막혀 있던 결함
- 경로 구분자·줄 끝 전제에서 비롯된 결함 다수
- 셸이 스스로 끝나도 탭이 닫히지 않던 결함
- `migrate` 가 대상이 없는데도 `settings.json` 을 재작성하던 결함

[1.0.0]: https://github.com/Biisairo/dongminal/releases/tag/v1.0.0
