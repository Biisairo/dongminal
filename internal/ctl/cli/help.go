package cli

import "fmt"

const commonFlags = `  --port <n>        포트 (기본: $PORT, 없으면 ` + DefaultPort + `)
  --home <path>     DONGMINAL_HOME (기본: $DONGMINAL_HOME, 없으면 ~/.dongminal)`

// Help는 무인자·-h·--help 실행 시의 출력이다 (FR-CLI-1..3).
func Help() string {
	return `dongminal — 브라우저에서 쓰는 터미널 워크스페이스

사용법:
  dongminal <action> [옵션]

액션:
  start      서버를 띄운다 (필요하면 dongminald 도 함께)
  stop       서버를 정지한다
  migrate    워크스페이스 데이터를 최신 스키마로 변환한다 (1회성)
  health     서버와 dongminald 의 상태를 확인한다
  doctor     이 호스트에서 플랫폼 계층이 동작하는지 확인한다
  verify     격리 인스턴스를 띄워 종단간 표면을 훑는다 (개발·CI)

액션별 옵션은 다음으로 본다:
  dongminal <action> --help

빌드는 ./scripts/build.sh 가 한다.
`
}

// Usage는 액션별 사용법이다 (FR-CLI-6/7).
func Usage(action string) string {
	switch action {
	case "start":
		return `사용법: dongminal start [옵션]

서버를 띄운다. 기본은 배경 모드 — 준비를 확인한 뒤 프롬프트를 돌려준다.

옵션:
  --expose          0.0.0.0 에 바인드한다 (사내망 다른 기기에서 접근 가능)
  --restart-daemon  dongminald 도 재시작한다 (터미널 세션을 잃는다)
                    도구 안에서 쓰면 대리 프로세스가 이어서 수행하고
                    출력은 $DONGMINAL_HOME/restart.log 에 남는다
  --isolated        임시 홈 + 비어 있는 포트로 띄운다. 운영 인스턴스를 건드리지 않는다
  --open            준비되면 frameless window(Chrome --app)를 연다
  --foreground      터미널을 점유하며 실행한다 (^C 로 정지)
` + commonFlags + `

로그: $DONGMINAL_LOG (기본: ` + defaultLogFile() + `) — 배경 모드에서만
`
	case "stop":
		return `사용법: dongminal stop [옵션]

옵션:
  --all             dongminald 까지 정지한다 (기본은 서버만 — 세션 유지)
` + commonFlags + `
`
	case "doctor":
		return `사용법: dongminal doctor [옵션]

이 호스트에서 플랫폼 계층이 실제로 동작하는지 확인한다. 서버가 쓰는 것과 같은
경로를 같은 순서로 밟는다 — 헬퍼·셸 훅 설치, 셸 선택, 의사 터미널 기동과 명령
왕복, 로컬 IPC 종단 왕복, 프로세스 제어.

터미널이 뜨지 않거나 비어 보일 때 먼저 이것을 돌린다. 어느 계층에서 무슨
오류로 막혔는지 나온다.

종료 코드: 0 정상 / 1 이상 있음

옵션:
` + commonFlags + `
`
	case "verify":
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
	case "health":
		return `사용법: dongminal health [옵션]

서버 HTTP 응답과 dongminald 소켓·pid 를 확인한다.
종료 코드: 0 정상 / 1 이상 있음

옵션:
` + commonFlags + `
`
	case "migrate":
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
	return Help()
}

// UnknownAction은 알 수 없는 첫 인자에 대한 안내다 (FR-CLI-5).
func UnknownAction(name string) string {
	return fmt.Sprintf("알 수 없는 액션: %s\n\n%s", name, Help())
}
