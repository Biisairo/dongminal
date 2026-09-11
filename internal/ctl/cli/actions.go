package cli

import (
	"errors"
	"fmt"
	"io"
)

// 액션 하나의 **전부**가 한 자리에 있다 (DEEPENING_REFACTOR_SRS 묶음 F).
//
// 이전에는 액션 하나가 네 곳에 흩어져 있었다:
//
//	Dispatch()       이름 → 파서 + 실행기 (case 8개, 전부 동형)
//	Help()           이름 → 한 줄 설명 (손으로 적은 목록)
//	Usage()          이름 → 사용법 전문 (case 8개)
//	UnknownAction()  Help() 를 다시 부른다
//
// 액션을 하나 더하려면 네 자리를 고쳐야 했고, 빠뜨리면 **조용히** 어긋난다 —
// `Help()` 에 없는 액션은 존재를 알 수 없고, `Usage()` 에 없는 액션은
// `--help` 가 전체 도움말로 떨어진다. 컴파일러가 그것을 잡아 주지 않는다.
//
// 이제 행 하나가 액션 하나이며, 세 함수가 모두 이 표에서 나온다.
type action struct {
	// name 은 argv[1] 이다.
	name string
	// brief 는 `Help()` 의 액션 목록 한 줄이다.
	brief string
	// usage 는 `<action> --help` 의 전문이다. 함수인 이유는 본문이
	// `commonFlags`·`defaultLogFile()` 을 엮기 때문이다.
	usage func() string
	// run 은 파싱과 실행을 함께 감싼다. 시그니처가 다른 둘(`RunStart` 은 serve,
	// `RunWindow` 은 openFrameless 를 받는다)을 클로저가 흡수한다 — 그래서 표가
	// 그 둘 때문에 넓어지지 않는다.
	run func(rest []string, serve Serve, stdout, stderr io.Writer) int
}

// actionsOf 는 액션 표다. 함수로 두는 이유는 `usage` 가 `defaultLogFile()` 을
// 부르므로 패키지 초기화 순서에 매이지 않게 하는 것이다.
func actionsOf() []action {
	return []action{
		{"start", "서버를 띄운다 (필요하면 dongminald 도 함께)", usageStart,
			func(rest []string, serve Serve, out, errw io.Writer) int {
				o, err := ParseStart(rest)
				if code, done := settle("start", err, out, errw); done {
					return code
				}
				return RunStart(o, serve, out, errw)
			}},
		{"stop", "서버를 정지한다", usageStop,
			func(rest []string, _ Serve, out, errw io.Writer) int {
				o, err := ParseStop(rest)
				if code, done := settle("stop", err, out, errw); done {
					return code
				}
				return RunStop(o, out, errw)
			}},
		{"migrate", "워크스페이스 데이터를 최신 스키마로 변환한다 (1회성)", usageMigrate,
			func(rest []string, _ Serve, out, errw io.Writer) int {
				o, err := ParseMigrate(rest)
				if code, done := settle("migrate", err, out, errw); done {
					return code
				}
				return RunMigrate(o, out, errw)
			}},
		{"rollback", "workspace.json 을 백업 세대로 되돌린다 (G3-2)", usageRollback,
			func(rest []string, _ Serve, out, errw io.Writer) int {
				o, err := ParseRollback(rest)
				if code, done := settle("rollback", err, out, errw); done {
					return code
				}
				return RunRollback(o, out, errw)
			}},
		{"window", "돌고 있는 서버에 frameless window 를 연다 (서버를 띄우지 않는다)", usageWindow,
			func(rest []string, _ Serve, out, errw io.Writer) int {
				o, err := ParseWindow(rest)
				if code, done := settle("window", err, out, errw); done {
					return code
				}
				return RunWindow(o, openFrameless, out, errw)
			}},
		{"backup", "홈 전체를 zip 하나로 담는다 (G4-3)", usageBackup,
			func(rest []string, _ Serve, out, errw io.Writer) int {
				o, err := ParseBackup(rest)
				if code, done := settle("backup", err, out, errw); done {
					return code
				}
				return RunBackup(o, out, errw)
			}},
		{"restore", "backup 으로 담은 zip 을 홈에 되돌린다 (G4-3)", usageRestore,
			func(rest []string, _ Serve, out, errw io.Writer) int {
				o, err := ParseRestore(rest)
				if code, done := settle("restore", err, out, errw); done {
					return code
				}
				return RunRestore(o, out, errw)
			}},
		{"uninstall", "무엇을 지울지 보이고, --yes 가 있을 때만 지운다 (G3-4)", usageUninstall,
			func(rest []string, _ Serve, out, errw io.Writer) int {
				o, err := ParseUninstall(rest)
				if code, done := settle("uninstall", err, out, errw); done {
					return code
				}
				return RunUninstall(o, out, errw)
			}},
		{"service", "이 OS 의 감독자(launchd·systemd)에 넣을 정의를 만든다 (SEC-23)", usageService,
			func(rest []string, _ Serve, out, errw io.Writer) int {
				o, err := ParseService(rest)
				if code, done := settle("service", err, out, errw); done {
					return code
				}
				return RunService(o, out, errw)
			}},
		{"update", "최신 판이 있는지 확인한다 (--check 를 줄 때만 나간다, G3-3)", usageUpdate,
			func(rest []string, _ Serve, out, errw io.Writer) int {
				o, err := ParseUpdate(rest)
				if code, done := settle("update", err, out, errw); done {
					return code
				}
				return RunUpdate(o, out, errw)
			}},
		{"config", "설정의 실효값과 출처를 보이고, 설정 파일을 대조한다 (G5-1)", usageConfig,
			func(rest []string, _ Serve, out, errw io.Writer) int {
				o, err := ParseConfig(rest)
				if code, done := settle("config", err, out, errw); done {
					return code
				}
				return RunConfig(o, out, errw)
			}},
		{"health", "서버와 dongminald 의 상태를 확인한다", usageHealth,
			func(rest []string, _ Serve, out, errw io.Writer) int {
				o, err := ParseHealth(rest)
				if code, done := settle("health", err, out, errw); done {
					return code
				}
				return RunHealth(o, out, errw)
			}},
		{"doctor", "이 호스트에서 플랫폼 계층이 동작하는지 확인한다", usageDoctor,
			func(rest []string, _ Serve, out, errw io.Writer) int {
				o, err := ParseDoctor(rest)
				if code, done := settle("doctor", err, out, errw); done {
					return code
				}
				return RunDoctor(o, out, errw)
			}},
		{"verify", "격리 인스턴스를 띄워 종단간 표면을 훑는다 (개발·CI)", usageVerify,
			func(rest []string, _ Serve, out, errw io.Writer) int {
				o, err := ParseVerify(rest)
				if code, done := settle("verify", err, out, errw); done {
					return code
				}
				return RunVerify(o, out, errw)
			}},
		// version 은 파서가 없다 — 옵션이 없기 때문이다. `--version` 별칭은
		// Dispatch 가 처리한다.
		{"version", "판·대상·go 런타임을 찍는다 (--version 도 동일)", nil,
			func(_ []string, _ Serve, out, _ io.Writer) int { return RunVersion(out) }},
	}
}

// lookupAction 은 이름으로 액션을 찾는다.
func lookupAction(name string) (action, bool) {
	for _, a := range actionsOf() {
		if a.name == name {
			return a, true
		}
	}
	return action{}, false
}

// Dispatch는 액션을 해석해 실행한다 (FR-CLI-1..7).
//
// args 는 프로그램 이름을 뺀 인자다. serve 는 `start --foreground` 가 쓰는
// 서버 실행 콜백이다.
func Dispatch(args []string, serve Serve, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		fmt.Fprint(stdout, Help())
		return 0
	}
	name, rest := args[0], args[1:]
	switch name {
	case "-h", "--help", "help":
		fmt.Fprint(stdout, Help())
		return 0
	case "--version":
		// 액션 이름이 아니라 플래그 모양의 별칭이다 (FR-CLI-4).
		name = "version"
	}
	a, ok := lookupAction(name)
	if !ok {
		fmt.Fprint(stderr, UnknownAction(name))
		return 2
	}
	return a.run(rest, serve, stdout, stderr)
}

// settle은 파서의 결과를 종료 코드로 바꾼다. done 이 true 면 액션을 실행하지
// 않는다 — help 요청이거나 옵션 오류다 (FR-CLI-6/7).
func settle(action string, err error, stdout, stderr io.Writer) (int, bool) {
	switch {
	case err == nil:
		return 0, false
	case errors.Is(err, ErrHelp):
		fmt.Fprint(stdout, Usage(action))
		return 0, true
	default:
		fmt.Fprintln(stderr, err)
		return 2, true
	}
}
