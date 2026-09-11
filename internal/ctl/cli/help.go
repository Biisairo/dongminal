package cli

import (
	"fmt"
	"strings"
)

const commonFlags = `  --port <n>        포트 (기본: $PORT, 없으면 ` + DefaultPort + `)
  --home <path>     DONGMINAL_HOME (기본: $DONGMINAL_HOME, 없으면 ~/.dongminal)`

// Help는 무인자·-h·--help 실행 시의 출력이다 (FR-CLI-1..3).
//
// **액션 목록을 손으로 적지 않는다** — 표에서 나온다. 손으로 적으면 액션을
// 더하고 목록을 빼먹었을 때 그 액션은 존재를 알릴 방법이 없어진다.
func Help() string {
	var b strings.Builder
	b.WriteString(`dongminal ` + Version + ` — 브라우저에서 쓰는 터미널 워크스페이스

사용법:
  dongminal <action> [옵션]

액션:
`)
	for _, a := range actionsOf() {
		fmt.Fprintf(&b, "  %-10s %s\n", a.name, a.brief)
	}
	b.WriteString(`
액션별 옵션은 다음으로 본다:
  dongminal <action> --help

빌드는 ./scripts/build.sh 가 한다.
`)
	return b.String()
}

// Usage는 액션별 사용법이다 (FR-CLI-6/7). 액션 표에서 나온다 — 표에 없는 이름은
// 전체 도움말로 떨어진다.
func Usage(action string) string {
	if a, ok := lookupAction(action); ok && a.usage != nil {
		return a.usage()
	}
	return Help()
}

func usageStart() string {
	return `사용법: dongminal start [옵션]

서버를 띄운다. 기본은 배경 모드 — 준비를 확인한 뒤 프롬프트를 돌려준다.

옵션:
  --expose          0.0.0.0 에 바인드한다 (사내망 다른 기기에서 접근 가능)
                    Settings ▸ Access 의 허용 목록을 먼저 켜야 뜬다
  --insecure-no-acl 허용 목록 없이 노출한다. 같은 망의 누구나 셸을 얻는다
  --restart-daemon  dongminald 도 재시작한다 (터미널 세션을 잃는다)
                    도구 안에서 쓰면 대리 프로세스가 이어서 수행하고
                    출력은 $DONGMINAL_HOME/restart.log 에 남는다
  --isolated        임시 홈 + 비어 있는 포트로 띄운다. 운영 인스턴스를 건드리지 않는다
  --foreground      터미널을 점유하며 실행한다 (^C 로 정지)
` + commonFlags + `

로그: $DONGMINAL_LOG (기본: ` + defaultLogFile() + `) — 배경 모드에서만
`
}

func usageWindow() string {
	return `사용법: dongminal window [옵션]

돌고 있는 서버에 frameless window(Chrome --app)를 연다.

서버를 띄우지 않는다 — 창만 연다. 서버가 떠 있지 않으면 열지 않고 알린다.
띄우는 것은 dongminal start 다.

옵션:
` + commonFlags + `
`
}

func usageStop() string {
	return `사용법: dongminal stop [옵션]

옵션:
  --all             dongminald 까지 정지한다 (기본은 서버만 — 세션 유지)
` + commonFlags + `
`
}

func usageDoctor() string {
	return `사용법: dongminal doctor [옵션]

이 호스트에서 플랫폼 계층이 실제로 동작하는지 확인한다. 서버가 쓰는 것과 같은
경로를 같은 순서로 밟는다 — 헬퍼·셸 훅 설치, 셸 선택, 의사 터미널 기동과 명령
왕복, 로컬 IPC 종단 왕복, 프로세스 제어.

터미널이 뜨지 않거나 비어 보일 때 먼저 이것을 돌린다. 어느 계층에서 무슨
오류로 막혔는지 나온다.

종료 코드: 0 정상 / 1 이상 있음

옵션:

  --bundle <파일>   신고에 붙일 진단 번들(zip)을 만든다 (G2-3).
                    판·OS·홈 파일 목록·로그 끝·설정을 담고, 자격증명은 마스킹한다.
                    붙이기 전에 한 번 열어 확인하는 것을 권한다.
` + commonFlags + `
`
}

func usageVerify() string {
	return `사용법: dongminal verify [옵션]

격리 인스턴스를 **스스로 띄워** 종단간 표면을 훑고 치운다. 세 OS 가 같은 목록을
돈다 — 기동 표면, 도구(PTY+IPC 왕복), 워크스페이스·설정, git 읽기 표면, 정적 자산.

doctor 와 겹치지 않는다. doctor 는 서버 **없이** 플랫폼 계층을 보고, verify 는
서버를 **데몬 모드로** 띄워 그 위의 표면을 본다.

--port·--home 을 받지 않는다. 언제나 임시 홈과 빈 포트에서 돌며, 운영 인스턴스를
건드릴 방법이 없다.

종료 코드: 0 실패 없음 / 1 실패 있음 (건너뜀은 실패가 아니다)

옵션:
  --repo <path>     git 표면 검사의 대상 저장소 (기본: 현재 디렉터리)
`
}

func usageHealth() string {
	return `사용법: dongminal health [옵션]

서버 HTTP 응답과 dongminald 소켓·pid 를 확인한다.
종료 코드: 0 정상 / 1 이상 있음

옵션:
` + commonFlags + `
`
}

func usageRollback() string {
	return `사용법: dongminal rollback [--file <이름>] [--gen <번호>] [--home <경로>]

  상태 파일을 백업 세대로 되돌린다 (G3-2·G4-4).

  --file 을 주지 않으면 workspace.json 이다. 되돌릴 수 있는 것은 세대를 남기는
  상태 파일뿐이다 — settings.json·access.json·runs.json·tools.json.
  설정 가져오기로 덮인 설정을 되돌리는 길이 여기다.

  --gen 없이 부르면 되돌릴 수 있는 세대를 보여 준다. 자동으로 고르지 않는 것은
  어느 세대가 맞는지 사용자만 알기 때문이다.

  되돌리기 전의 판은 지우지 않고 .before-rollback-<시각> 으로 남긴다 —
  세대를 잘못 골랐을 때 돌아올 자리다.

  돌고 있는 인스턴스가 있으면 거부한다. 지금 되돌려도 그 서버가 곧 자기
  메모리로 덮어쓰기 때문이다.
`
}

func usageMigrate() string {
	return `사용법: dongminal migrate [옵션]

워크스페이스 데이터를 최신 스키마로 변환한다. 멱등이다.
서버가 포트에서 응답하면 변환을 거부한다 — 먼저 dongminal stop --all.

옵션:
  --dry-run, -n     변환 내용만 출력하고 파일을 건드리지 않는다
` + commonFlags + `

백업: *.v1.bak       스키마 변환 직전 (v1 원본)
      *.preuuid.bak  식별자 재작성 직전
`
}

// UnknownAction은 알 수 없는 첫 인자에 대한 안내다 (FR-CLI-5).
func UnknownAction(name string) string {
	return fmt.Sprintf("알 수 없는 액션: %s\n\n%s", name, Help())
}
