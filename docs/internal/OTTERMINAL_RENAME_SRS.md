# SRS: 프로젝트 이름 변경 — dongminal → otterminal

> **문서 상태**: 승인·구현중
> **남은 것**: Windows 실행 확인(CI). macOS 검증(게이트·단위·e2e 전량)은 끝났다
>
> 근거: 2026-11-24 사용자 요청과 인터뷰 결정 D-1~D-5

---

## 1. 소개

### 1.1 목적

이 문서는 프로젝트 이름을 `dongminal`에서 `otterminal`(otter + terminal)로 바꾸는 작업의 요구사항을 정한다. 이 작업에는 이미 설치된 환경을 이어받는 일과 새 브랜드 에셋(수달 SVG)을 적용하는 일이 함께 들어 있다.

### 1.2 범위

- 대상: 이 저장소의 현행 코드(Rust·웹·e2e·스크립트), CI 워크플로우, 현행 문서, 빌드·릴리즈 산출물 이름, 실행 중 쓰는 이름(데이터 폴더·환경 변수·소켓·프로세스·에이전트 메시지 표식·에이전트 플러그인·MCP 서버 이름).
- 비대상: 2.4절 비목표를 따른다.

### 1.3 용어

| 용어 | 뜻 |
|---|---|
| 옛 이름 | `dongminal`과 그 약칭 `dm`(`dmctl`, `dm_*`, `DM_*`, `dongminald` 등) |
| 새 이름 | `otterminal`과 그 약칭 `otter`(`otterctl`, `otter_*`, `OTTER_*`, `otterminald` 등) |
| 옛 홈 | `~/.dongminal` |
| 새 홈 | `~/.otterminal` |
| 옛 판 | 옛 이름으로 빌드된 실행 파일(Go 판 포함) |
| 기록 문서 | `CHANGELOG.md`의 지난 항목, `docs/internal/archive/` 아래 문서, Go 판 동등성 golden 데이터 |

### 1.4 사용자 결정

| # | 결정 | 날짜 |
|---|---|---|
| D-1 | 범위는 사람에게 보이는 이름과 내부 약칭 `dm`을 모두 포함한다 | 2026-11-24 |
| D-2 | 약칭은 `otter`다. 제어 명령은 `otterctl`이다. `otctl`은 macOS 기본 도구(`/usr/sbin/otctl`, OpenThread)와 이름이 겹치므로 쓰지 않는다 | 2026-11-24 |
| D-3 | 옛 홈은 처음 실행할 때 자동으로 이전한다. 옛 환경 변수와 옛 메시지 표식은 읽지 않는다 | 2026-11-24 |
| D-4 | 기록 문서는 그 당시 이름 그대로 둔다 | 2026-11-24 |
| D-5 | 홈 이전 방법: 폴더 이름을 바꾸고 옛 자리에 새 홈을 가리키는 심볼릭 링크를 남긴다 | 2026-11-24 |
| D-6 | 에셋 배치: README=`otter-02`, 앱 아이콘=`otter-01`, 파비콘=`otter-15`, 부팅=`otter-04`, 접근 거부=`otter-10` | 2026-11-24 |
| D-8 | Go 대 Rust 차분 실행기 `rust/parity`는 폐기한다. 워크스페이스에서 빼고 `docs/internal/archive/rust-port/parity/`로 옮긴다. 같은 성격의 혼합 실행 도구 `rust/interop`도 함께 옮긴다 | 2026-11-24 |
| D-7 | 파비콘은 주의 상태에 따라 색이 바뀐다(waiting=빨강, done=초록, 그 밖=노랑). Display 설정으로 끌 수 있고 기본은 켬이다 | 2026-11-24 |

## 2. 전체 설명

### 2.1 배경

옛 홈은 약 25GB이고 그중 24GB가 git worktree다. 각 저장소의 `.git/worktrees/*`와 홈 안의 JSON 파일은 옛 홈의 절대 경로를 가진다. 그래서 복사하는 방법은 쓸 수 없고, 옮기기만 하면 연결이 끊긴다. D-5의 링크를 남기면 옛 절대 경로가 계속 통한다.

운영 인스턴스(Go 판, 저장소 루트의 `./dongminal`)가 옛 홈을 쓰며 돌고 있다. 이 작업은 운영 인스턴스를 바꾸지 않는다.

### 2.2 이름 대응 규칙

| 옛 | 새 |
|---|---|
| `dongminal` / `Dongminal` / `DONGMINAL` | `otterminal` / `Otterminal` / `OTTERMINAL` |
| `dongminald` | `otterminald` |
| `dmctl` / `Dmctl` / `DMCTL` | `otterctl` / `Otterctl` / `OTTERCTL` |
| 약칭 `dm`이 단어 하나로 쓰인 식별자(`dm_*`, `dm-*`, `DM_*`, `dmenv`, `dmlog`, `dmServer` 등) | `otter_*`, `otter-*`, `OTTER_*`, `otterenv`, `otterlog`, `otterServer` 등 |

- `dm`이 다른 단어의 일부일 때(`admin` 등)는 바꾸지 않는다.
- 요구사항 ID(`FR-DMA-*` 등)는 바꾸지 않는다. 기록 문서와 코드 주석이 같은 ID로 서로를 가리키기 때문이다.
- 현행 문서 안에서 기록 문서를 가리키는 경로(`archive/...`)는 기록 문서의 파일 이름이 그대로이므로 바꾸지 않는다.
- 저장소 폴더의 절대 경로(`~/personal/dongminal`)는 A-3에 따라 바꾸지 않는다.
- SRS 파일 이름 중 옛 이름을 가진 현행 문서는 새 이름으로 바꾼다. 기록 문서의 파일 이름은 바꾸지 않는다.

### 2.3 가정

- A-1 (중요): Claude Code 연동은 실행 인자(`--settings`, `--plugin-dir`)로만 주입되고, 플러그인은 홈의 `bin` 아래에 생성된다(`rust/crates/shared/agentadapter/src/claude.rs:30`, `rust/crates/shared/runtime/src/lib.rs:58`). 그래서 `~/.claude` 아래 사용자 설정을 이전할 필요가 없다. 구현 중에 홈 밖에 영구로 쓰는 연동 파일이 발견되면 멈추고 사용자에게 알린다.
- A-2: GitHub 저장소 이름 변경(`Biisairo/dongminal` → `Biisairo/otterminal`)은 사용자가 직접 한다. GitHub는 옛 이름 요청을 새 이름으로 넘겨 주므로 옛 판의 최신 판 확인은 계속 동작한다.
- A-3: 로컬 저장소 폴더 이름(`~/personal/dongminal`) 변경은 사용자가 운영 전환 때 정한다.

### 2.4 비목표

- 기록 문서 수정(D-4). 단, `CHANGELOG.md`에 이름 변경 항목은 새로 추가한다.
- 옛 환경 변수와 옛 메시지 표식의 호환(D-3). 새 판과 옛 판은 서로 메시지를 주고받지 못한다.
- 운영 전환. 운영 인스턴스와 저장소 루트의 `./dongminal` 바이너리는 건드리지 않는다.
- git 이력의 과거 커밋 메시지와 태그(`go-final-v1.3.7` 등) 변경.
- GitHub 저장소 이름과 로컬 저장소 폴더 이름 변경(A-2, A-3).

## 3. 요구사항

### 3.1 이름 변경

- **FR-REN-1** 현행 코드, 시험, 스크립트, CI 워크플로우, 현행 문서에 나오는 옛 이름은 2.2절 규칙에 따라 새 이름으로 바뀌어야 한다.
- **FR-REN-2** 파일과 디렉터리 이름 중 옛 이름을 가진 것(`rust/crates/cmd/dongminal`, `runtimebin/src/dmctl/`, `rust/crates/shared/dmenv` 등)은 새 이름으로 옮겨야 한다. 옮길 때 git이 이동으로 인식할 수 있도록 `git mv`를 쓴다.
- **FR-REN-3** 빌드 산출물 이름은 `otterminal`과 `otterminal-<os>-<arch>[.exe]`여야 한다. 데몬 프로세스 이름은 `otterminald`여야 한다.
- **FR-REN-4** 도구 셸에 설치되는 제어 명령은 `otterctl`이어야 한다. `dmctl`은 설치하지 않는다.
- **FR-REN-5** 환경 변수는 `OTTERMINAL_*`만 읽어야 한다. `DONGMINAL_*`는 읽지 않는다.
- **FR-REN-6** 에이전트 메시지 표식은 `OTTERMINAL-AGENT-MSG`와 `OTTERMINAL-PEER-MSG`여야 한다.
- **FR-REN-7** 에이전트 플러그인 이름(`/otterminal:issue-tree` 등), MCP 서버 이름, 에이전트에게 주입하는 안내문은 새 이름을 써야 한다.
- **FR-REN-8** 웹 화면의 제목, 문구(i18n 포함), PWA manifest 이름은 `otterminal`이어야 한다.
- **FR-REN-9** 최신 판 확인이 가리키는 저장소는 `Biisairo/otterminal`이어야 한다.
- **FR-REN-10** Go 판 동등성 시험은 golden 데이터를 고치지 않고, 비교하기 직전에 기대값의 옛 이름을 새 이름으로 바꿔 읽어야 한다(D-4).
- **FR-REN-12** `rust/parity`를 Cargo 워크스페이스에서 빼고 `docs/internal/archive/rust-port/parity/`로, `rust/interop`을 `docs/internal/archive/rust-port/interop/`로 옮겨야 한다(D-8). 이것을 부르는 스크립트·문서 참조도 정리한다.
- **FR-REN-11** 옛 이름 잔존 검사 게이트를 `make gates`에 더해야 한다. 이 게이트는 허용 목록(기록 문서, golden 데이터, 홈 이전 코드, 이 SRS, `CHANGELOG.md`의 지난 항목) 밖에서 옛 이름이 하나라도 나오면 실패한다.

### 3.2 홈 이전

- **FR-MIG-1** 홈을 정할 때 `OTTERMINAL_HOME`이 비어 있고, 새 홈이 없고, 옛 홈이 실제 디렉터리(링크가 아님)로 있으면 이전을 시도해야 한다.
- **FR-MIG-2** 이전은 옛 홈의 이름을 새 홈으로 바꾸는 한 번의 `rename`이고, 바로 이어서 옛 홈 자리에 새 홈을 가리키는 심볼릭 링크를 만들어야 한다(D-5). 파일을 복사하지 않는다.
- **FR-MIG-3** 옛 판이 옛 홈을 쓰며 돌고 있으면 이전하지 않아야 한다. 이때 오류 메시지로 옛 판을 먼저 멈추라고 알리고 0이 아닌 코드로 끝나야 한다. 판단 근거는 옛 홈의 pid 파일(`paned.pid` 등)이 가리키는 프로세스의 생존과 소켓 연결 가능 여부다.
- **FR-MIG-4** 새 홈이 이미 있으면 옛 홈을 건드리지 않고 새 홈을 써야 한다.
- **FR-MIG-5** 옛 홈이 링크이거나 없으면 아무것도 하지 않아야 한다.
- **FR-MIG-6** `rename`이 실패하면 아무것도 바꾸지 않은 상태로 오류를 알려야 한다. 링크 생성만 실패하면 새 홈으로 계속 실행하고 경고를 로그에 남겨야 한다.
- **FR-MIG-7** 옮겼으면 그 결과(링크를 만들지 못했으면 그 이유 포함)를 표준 오류에 한 줄로 알려야 한다. 아무것도 바꾸지 않았으면 알리지 않는다. 이전은 서버 로그가 열리기 전에 일어나므로 표준 오류에 쓴다.
- **FR-MIG-8** Windows에서는 심볼릭 링크 대신 디렉터리 정션을 만든다. 정션 생성이 실패하면 FR-MIG-6의 링크 실패와 같이 처리한다.
- **FR-MIG-9** 홈 안의 생성 산출물(`bin/dmctl`, 에이전트 플러그인, 셸 훅)은 새 판이 기동할 때 새 이름으로 다시 만든다. 옛 이름의 산출물(`bin/dmctl`)은 지운다.
- **FR-MIG-10** 브라우저 저장소(localStorage)의 옛 키(`dm.` 접두)는 페이지를 처음 열 때 새 키(`otter.` 접두)로 옮겨야 한다. 새 키가 이미 있으면 새 값을 지키고 옛 키만 지운다. 테마·언어를 읽는 머리 스크립트보다 먼저 돈다.
- **FR-MIG-11** Run이 만드는 worktree 브랜치의 접두사는 `otter/`다. 이미 있는 `dmn/` 브랜치는 그대로 둔다. 접두사는 만들 때만 쓰고 해석에는 쓰지 않으므로 옛 브랜치도 계속 동작한다.

### 3.3 브랜드 에셋

- **FR-AST-1** 사용자가 준 SVG 13개(`otter-01`, `02`, `04`, `10`, `13`, `14`, `14-green`, `14-orange`, `14-red`, `14-yellow`, `15`, `16`, `face`)를 원본 그대로 `web/assets/brand/`에 저장해야 한다.
- **FR-AST-2** 아래 자리는 지정한 에셋을 써야 한다(D-6).

  | 자리 | 에셋 |
  |---|---|
  | README 맨 위 배너 | `otter-02` |
  | PWA 아이콘(192·512), Apple touch 아이콘(180) | `otter-01` |
  | 파비콘(SVG, 32·16 PNG) 기본 | `otter-15` |
  | 부팅 화면 로고 | `otter-04` |
  | 접근 거부 페이지 로고 | `otter-10` |

- **FR-AST-3** PNG는 SVG에서 만든다. 만드는 스크립트를 `scripts/`에 두어 다시 만들 수 있게 한다.
- **FR-AST-4** 나머지 에셋(`otter-13`, `otter-14`, `otter-14-orange`, `otter-16`, `otter-face`)은 저장만 한다.

### 3.4 주의 상태 파비콘

- **FR-FAV-1** 설정 `attnFavicon`(불리언, 기본값 `true`, 위치 Display)이 켜져 있으면, 파비콘은 주의 상태 집합(`app._attn`)에서 가장 급한 이유에 해당하는 에셋을 보여야 한다(D-7).

  | 순위 | 주의 이유 | 에셋 |
  |---|---|---|
  | 1 | `waiting` | `otter-14-red` |
  | 2 | `done` | `otter-14-green` |
  | 3 | 그 밖의 모든 이유(`idle`, `signaled` 등) | `otter-14-yellow` |
  | — | 주의 없음 | `otter-15` |

- **FR-FAV-2** 주의 상태가 바뀌어 탭 제목을 다시 쓸 때(`_applyPageTitle`) 파비콘도 같은 자리에서 함께 갱신해야 한다. 같은 에셋이면 DOM을 다시 쓰지 않는다.
- **FR-FAV-3** 설정이 꺼져 있으면 주의 상태와 상관없이 `otter-15`를 보여야 한다. 설정을 바꾸면 즉시 반영해야 한다.
- **FR-FAV-4** 설정 항목은 기존 설정 체계(`settings-schema.js`, 서버 검증, 설정 문서 대조 게이트)를 따라야 한다.

### 3.5 동작 변경 기록

| 항목 | 이전 동작 | 새 동작 | 이유 |
|---|---|---|---|
| 데이터 폴더 | `~/.dongminal` | `~/.otterminal` (옛 자리는 링크) | 이름 변경, D-5 |
| 환경 변수 | `DONGMINAL_*` | `OTTERMINAL_*`, 옛 이름은 무시 | D-3 |
| 제어 명령 | `dmctl` | `otterctl` | D-2 |
| 메시지 표식 | `DONGMINAL-*-MSG` | `OTTERMINAL-*-MSG`, 옛 판과 통신 불가 | D-3 |
| 브라우저 저장소 키 | `dm.*` | `otter.*` (옛 키는 처음 열 때 옮김) | FR-MIG-10 |
| Run 브랜치 접두사 | `dmn/` | `otter/` (옛 브랜치는 그대로) | FR-MIG-11 |
| 부팅 로고·접근 거부 페이지 로고 | 초록 타일 로고 | 수달 그림 | D-6 |
| 산출물 | `dongminal-<os>-<arch>` | `otterminal-<os>-<arch>` | 이름 변경 |
| 파비콘 | 늘 같은 아이콘 | 주의 상태에 따라 색이 바뀜(설정으로 끔) | D-7 |

## 4. 검증

| 요구사항 | 방법 |
|---|---|
| FR-REN-1~2, 11 | 잔존 검사 게이트 통과. 그리고 `cargo build`, `make gates`, `make test`, `npm run unit` 통과 |
| FR-REN-3~9 | 기존 단위 시험과 e2e를 새 이름으로 바꾼 뒤 전량 통과(로컬 macOS, 운영과 떨어뜨린 임시 홈) |
| FR-REN-10 | 동등성 시험 통과 |
| FR-MIG-1~7 | 새 단위 시험: 정상 이전 · 새 홈 이미 있음 · 옛 홈이 링크 · 옛 홈 없음 · 옛 판 실행 중 · rename 실패 · 링크 실패. 임시 디렉터리에서만 돈다 |
| FR-MIG-8 | Windows 대상 타입 검사(`cross-check.sh`)와 CI |
| FR-MIG-9 | 단위 시험: 기동 뒤 `bin/otterctl`이 있고 `bin/dmctl`은 없다 |
| FR-MIG-10 | `node --test` 단위 시험: 옮김 · 새 키 우선 · 옛 키 없음 · 저장소 접근 실패 · 로드 순서 |
| FR-MIG-11 | 브랜치 이름 파생 단위 시험 |
| FR-AST-1~4 | 파일 존재 시험, `index.html`·manifest·접근 거부 페이지 참조 시험, 화면 확인 |
| FR-FAV-1~3 | `node --test` 단위 시험: 이유별 에셋 선택 · 순위(여러 이유 섞임) · 주의 없음 · 설정 끔 · 같은 에셋이면 DOM 미갱신. e2e: 주의 발생 시 `link[rel=icon]` 주소 변경 |
| FR-FAV-4 | 설정 문서 대조 게이트와 서버 설정 검증 시험 통과 |

## 5. 미결 항목

없음. (OQ-1 에셋 배치는 D-6으로 닫았다.)
