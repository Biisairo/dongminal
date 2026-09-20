// Package cli는 dongminal 바이너리의 액션 디스패치와 옵션 해석을 담당한다
// (CLI_CONSOLIDATION_SRS 묶음 A·B·C).
//
// 부수효과가 있는 경로(프로세스 종료·detach·브라우저 실행)와 순수 해석
// (플래그 파싱·우선순위·빈 포트 선택)을 파일 단위로 나눠 둔다. 테스트가
// 무는 것은 후자다.
package cli

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"dongminal/internal/shared/dmenv"
	"dongminal/internal/shared/platform"
	"dongminal/internal/shared/serverconf"
)

// ErrHelp는 -h/--help 가 주어졌을 때 파서가 돌려주는 센티널이다. 액션의
// 부수효과는 일어나지 않는다 (FR-CLI-6).
var ErrHelp = errors.New("help requested")

const (
	EnvPort = "PORT"
	EnvHome = dmenv.EnvHome
	EnvHost = dmenv.EnvHost
	EnvLog  = "DONGMINAL_LOG"

	// EnvRestartRunner는 이 실행이 위임된 재시작 대리임을 알린다 — 대리가
	// 다시 위임하지 않게 하는 표시다 (FR-ACT-3b).
	EnvRestartRunner = "DONGMINAL_RESTART_RUNNER"
	// EnvToolID는 도구의 셸에 심기는 도구 식별자다(toolhub.StartTool). 이
	// 값이 있으면 지금 dongminal 도구 안에서 돌고 있다는 뜻이다 (FR-ACT-3a).
	//
	// 이름과 기본 엔드포인트는 dmenv 가 갖는다 — 심는 쪽(toolhub)과 읽는
	// 쪽(runtimebin)이 이 패키지를 import 할 수 없기 때문이다.
	EnvToolID = dmenv.EnvToolID

	DefaultPort = dmenv.DefaultPort
	DefaultHost = dmenv.DefaultHost

	ExposeHost = "0.0.0.0"
)

// logFileName 은 홈 아래 서버 로그의 이름이다. `homeLogs` 와 `homeLayout()` 이
// 같은 이름을 쓴다.
const logFileName = "server.log"

// defaultLogFile 은 배경 모드 기동이 출력을 남길 자리다 (04-secops P1-6).
//
// **홈이 있으면 그 아래다.** 종전에는 POSIX 에서 `/tmp/dongminal.log` 였는데,
// 그 이동이 `prepareServerCmd` **안에만** 있었다 — `serverconf.Inputs.DefaultLogFile`
// 로 흘러드는 값은 여전히 옛 것이라 답이 **셋**이 됐고, 그래서
// `config show`·`doctor`·`start --help` 가 **없는 파일**을 안내했다.
// `config show` 의 존재 이유가 FR-CFG-7 *"값이 아니라 출처를 말한다"* 인데
// 출처는 맞고 값이 틀렸다 — 안 듣는 설정을 쫓는 사람이 정확히 그 화면에서
// 잘못된 경로로 간다 (FR-STR-33).
//
// 홈을 모르는 부름(`usageStart`)은 빈 문자열을 준다. 그때만 `platform` 의
// 자리로 물러선다 — OS 마다 다르기 때문이다 (CROSS_PLATFORM_SRS FR-XPA-2).
func defaultLogFile(home string) string {
	if home != "" {
		return filepath.Join(home, logFileName)
	}
	return platform.Current().Paths.DefaultLogFile()
}

// Actions는 help 에 나열되는 액션 이름이다. 내부 진입점 `d`(데몬)는 여기
// 없다 — 사용자가 직접 부를 것이 아니다 (FR-CLI-8).
var Actions = []string{"start", "stop", "migrate", "health", "doctor", "verify"}

// Common은 모든 액션이 공유하는 옵션이다 (FR-CLI-9).
type Common struct {
	Port string // "" = 미지정
	Home string // "" = 미지정
}

// take는 args[*i] 가 공통 옵션이면 소비하고 true 를 돌려준다. `--port 8080`
// 과 `--port=8080` 을 모두 받는다.
func (c *Common) take(args []string, i *int) (bool, error) {
	a := args[*i]
	name, inline, hasInline := strings.Cut(a, "=")
	var dst *string
	switch name {
	case "--port":
		dst = &c.Port
	case "--home":
		dst = &c.Home
	default:
		return false, nil
	}
	if hasInline {
		if inline == "" {
			return false, fmt.Errorf("%s 에 값이 없습니다", name)
		}
		*dst = inline
	} else {
		if *i+1 >= len(args) {
			return false, fmt.Errorf("%s 에 값이 없습니다", name)
		}
		*i++
		*dst = args[*i]
	}
	if name == "--port" {
		if n, err := strconv.Atoi(*dst); err != nil || n < 1 || n > 65535 {
			return false, fmt.Errorf("--port 값이 포트 번호가 아닙니다: %s", *dst)
		}
	}
	return true, nil
}

// ResolvePort는 플래그 > 환경변수 > 기본값 순으로 포트를 정한다 (FR-CLI-9).
func (c Common) ResolvePort() string {
	if c.Port != "" {
		return c.Port
	}
	if v := os.Getenv(EnvPort); v != "" {
		return v
	}
	return DefaultPort
}

// ResolveHome은 플래그 > 환경변수 > 기본값 순으로 홈을 정한다 (FR-CLI-9).
// 기본값 계산에 실패하면 오류를 돌려준다 — 홈 없이 진행할 수 있는 액션은
// 하나도 없다.
func (c Common) ResolveHome() (string, error) {
	if c.Home != "" {
		return expandTilde(c.Home), nil
	}
	if v := os.Getenv(EnvHome); v != "" {
		return expandTilde(v), nil
	}
	userHome, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("홈 디렉터리 확인 실패: %w", err)
	}
	return filepath.Join(userHome, dmenv.DefaultHomeDir), nil
}

// Target 은 이 명령이 **겨누는 서버**다.
//
// 계층은 `start` 와 같다 (FR-CFG-13: 플래그 > 환경변수 > 파일 > 기본값).
// 종전에는 겨누는 명령 넷이 `ResolvePort` 의 3계층에 머물러 `server.json` 을
// 보지 못했다. `server.json` 에 `{"port":"9000"}` 한 줄을 적으면 그 순간 갈렸다:
//
//	start    9000  정상
//	health  58146  "응답 없음" (서버는 멀쩡하다)
//	window  58146  "서버가 떠 있지 않습니다"
//	stop    58146  **그 포트의 다른 프로세스를 죽인다** (killPort 는 가리지 않는다)
//	migrate 58146  서버가 도는데도 "정지됨" 으로 보고 변환을 강행한다
//
// 뒤의 둘이 특히 나쁘다 — `stop` 은 TERM→KILL 을 보내고, `migrate` 의 포트 점유
// 검사는 안전장치인데 엉뚱한 포트를 봐서 **무력화된다.**
//
// `window.go` 의 주석이 이미 불변식을 적고 있었다 (FR-WIN-2): *"대상 주소를
// `start` 와 같은 규칙으로 정한다. 두 곳이 다르면 띄운 자리와 여는 자리가
// 어긋난다."* 주석은 다음 사람을 막지 못한다 — 이 타입이 막는다.
type Target struct {
	Home string
	// Host 는 DialHost 를 지난 값이다 — 그대로 두드릴 수 있다. 미지정
	// 주소(`0.0.0.0`·`::`)는 바인드 대상이지 접속 대상이 아니다.
	Host string
	Port string
	// URL 은 `dmenv.BaseURL(Host, Port)` 다. IPv6 의 대괄호가 여기서 붙는다.
	URL string
	// Warnings 는 `serverconf` 가 낸 것을 **버리지 않고** 나른다. 설정 파일이
	// 조용히 무시되는 것이 이 묶음이 고치는 결함과 같은 모양이다 (FR-CFG-15).
	Warnings []string
}

// ResolveTarget 은 겨누는 명령이 쓰는 단일 해석이다 (FR-STR-22).
//
// 오류는 **두드리기 전에** 돌려준다 — 잘못된 포트로 ping 하면 "응답 없음" 이
// 되고, 그 문구에는 어느 값이 잘못됐는지가 없다 (FR-CFG-19 가 `start` 에서
// 같은 이유로 `net.Listen` 앞에 검사를 세웠다).
func (c Common) ResolveTarget() (Target, error) {
	home, err := c.ResolveHome()
	if err != nil {
		return Target{}, err
	}
	conf := serverconf.Resolve(serverconf.Inputs{Home: home, FlagPort: c.Port})
	if err := conf.Err(); err != nil {
		return Target{}, err
	}
	host, port := conf.Host.Value, conf.Port.Value
	return Target{
		Home:     home,
		Host:     dmenv.DialHost(host),
		Port:     port,
		URL:      dmenv.BaseURL(host, port),
		Warnings: conf.Warnings,
	}, nil
}

// warn 은 해석 경고를 찍는다. **막지 않는다** (FR-CFG-15 / D-CFG-3) — 설정 파일
// 하나가 명령을 못 돌게 만들면 사용자는 그것을 고칠 자리에 닿을 수 없다.
func (t Target) warn(stderr io.Writer) {
	for _, w := range t.Warnings {
		fmt.Fprintf(stderr, "⚠ %s\n", w)
	}
}

// expandTilde는 선행 `~/` 만 $HOME 으로 편다. 기존 스크립트의 _load_env 와
// 같은 범위다 — 값 안의 다른 변수 참조는 펴지 않는다.
func expandTilde(p string) string {
	if p == "~" || strings.HasPrefix(p, "~/") {
		if h, err := os.UserHomeDir(); err == nil {
			return filepath.Join(h, strings.TrimPrefix(strings.TrimPrefix(p, "~"), "/"))
		}
	}
	return p
}

// StartOpts는 `dongminal start` 의 옵션이다.
type StartOpts struct {
	Common
	Expose        bool
	RestartDaemon bool
	Isolated      bool
	Foreground    bool
}

// StopOpts는 `dongminal stop` 의 옵션이다.
type StopOpts struct {
	Common
	All bool
}

// DoctorOpts는 `dongminal doctor` 의 옵션이다.
type DoctorOpts struct {
	Common
	// ProbePTY 는 내부용이다. 값이 있으면 의사 터미널 검사만 수행하고 결과를
	// 그 파일에 적은 뒤 끝낸다 — doctor 가 자기 자신을 **콘솔 없는 자식**으로
	// 띄워 서버와 같은 조건을 재현할 때 쓴다 (FR-XDG-2).
	ProbePTY string
	// Bundle 은 진단 번들을 쓸 자리다 (`G2-3`). 비면 종전의 doctor 다 —
	// 번들은 **더하는 기능**이지 기존 진단을 대체하지 않는다.
	Bundle string
}

// HealthOpts는 `dongminal health` 의 옵션이다.
type HealthOpts struct {
	Common
	// DaemonOnly 는 데몬의 낡음만 묻는다 (DAEMON_STALENESS_SRS FR-DFP-7).
	// `scripts/build.sh` 가 빌드 직후 부르는 자리라 HTTP 대기를 지나지 않는다 —
	// 그때 서버는 떠 있지 않은 것이 보통이고, 빌드 끝에 3초를 태울 이유가 없다.
	DaemonOnly bool
}

// WindowOpts는 `dongminal window` 의 옵션이다. 겨눌 서버를 정하는 것이 전부이고,
// 그 규칙은 `start` 와 같다 (WINDOW_COMMAND_SRS FR-WIN-2).
type WindowOpts struct {
	Common
}

// VerifyOpts는 `dongminal verify` 의 옵션이다.
//
// Common 을 품지 않는 것이 요구사항이다 (E2E_UNIFICATION_SRS FR-E2C-2/3). verify 는
// 격리 전용이고, 홈·포트를 겨눌 수단이 있으면 운영 인스턴스를 죽이는 갈래가
// 생긴다 — 실제로 그 사고가 났다 (scripts/verify-isolated.sh 머리말).
type VerifyOpts struct {
	// Repo 는 git 표면 검사의 대상이다. 비면 현재 작업 디렉터리다.
	Repo string
}

// MigrateOpts는 `dongminal migrate` 의 옵션이다.
type MigrateOpts struct {
	Common
	DryRun bool
}

func unknownFlag(action, a string) error {
	return fmt.Errorf("알 수 없는 옵션: %s\n\n%s", a, Usage(action))
}

func ParseStart(args []string) (StartOpts, error) {
	var o StartOpts
	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "--expose":
			o.Expose = true
		case "--restart-daemon":
			o.RestartDaemon = true
		case "--isolated":
			o.Isolated = true
		case "--foreground":
			o.Foreground = true
		case "-h", "--help":
			return StartOpts{}, ErrHelp
		default:
			ok, err := o.Common.take(args, &i)
			if err != nil {
				return StartOpts{}, err
			}
			if !ok {
				return StartOpts{}, unknownFlag("start", args[i])
			}
		}
	}
	return o, nil
}

func ParseStop(args []string) (StopOpts, error) {
	var o StopOpts
	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "--all":
			o.All = true
		case "-h", "--help":
			return StopOpts{}, ErrHelp
		default:
			ok, err := o.Common.take(args, &i)
			if err != nil {
				return StopOpts{}, err
			}
			if !ok {
				return StopOpts{}, unknownFlag("stop", args[i])
			}
		}
	}
	return o, nil
}

func ParseDoctor(args []string) (DoctorOpts, error) {
	var o DoctorOpts
	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "--probe-pty":
			if i+1 >= len(args) {
				return DoctorOpts{}, fmt.Errorf("--probe-pty 에 값이 없습니다")
			}
			i++
			o.ProbePTY = args[i]
		case "--bundle":
			// `G2-3`: 진단 번들을 쓸 자리. 종전의 doctor 는 그대로 돈다.
			if i+1 >= len(args) {
				return DoctorOpts{}, fmt.Errorf("--bundle 에 파일 경로가 없습니다")
			}
			i++
			o.Bundle = args[i]
		case "-h", "--help":
			return DoctorOpts{}, ErrHelp
		default:
			ok, err := o.Common.take(args, &i)
			if err != nil {
				return DoctorOpts{}, err
			}
			if !ok {
				return DoctorOpts{}, unknownFlag("doctor", args[i])
			}
		}
	}
	return o, nil
}

func ParseVerify(args []string) (VerifyOpts, error) {
	var o VerifyOpts
	for i := 0; i < len(args); i++ {
		name, inline, hasInline := strings.Cut(args[i], "=")
		switch name {
		case "--repo":
			if hasInline {
				o.Repo = inline
				continue
			}
			if i+1 >= len(args) {
				return VerifyOpts{}, fmt.Errorf("--repo 에 값이 없습니다")
			}
			i++
			o.Repo = args[i]
		case "-h", "--help":
			return VerifyOpts{}, ErrHelp
		case "--port", "--home":
			// 받아서 무시하지 않고 거부한다. 겨눌 방법 자체를 두지 않는 것이
			// 사고를 막는 가장 단순한 형태다 (FR-E2C-3).
			return VerifyOpts{}, fmt.Errorf(
				"verify 는 %s 를 받지 않습니다 — 언제나 격리 인스턴스에서만 돕니다", name)
		default:
			return VerifyOpts{}, unknownFlag("verify", args[i])
		}
	}
	return o, nil
}

func ParseHealth(args []string) (HealthOpts, error) {
	var o HealthOpts
	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "-h", "--help":
			return HealthOpts{}, ErrHelp
		case "--daemon":
			o.DaemonOnly = true
		default:
			ok, err := o.Common.take(args, &i)
			if err != nil {
				return HealthOpts{}, err
			}
			if !ok {
				return HealthOpts{}, unknownFlag("health", args[i])
			}
		}
	}
	return o, nil
}

func ParseWindow(args []string) (WindowOpts, error) {
	var o WindowOpts
	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "-h", "--help":
			return WindowOpts{}, ErrHelp
		default:
			ok, err := o.Common.take(args, &i)
			if err != nil {
				return WindowOpts{}, err
			}
			if !ok {
				return WindowOpts{}, unknownFlag("window", args[i])
			}
		}
	}
	return o, nil
}

func ParseMigrate(args []string) (MigrateOpts, error) {
	var o MigrateOpts
	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "--dry-run", "-n":
			o.DryRun = true
		case "-h", "--help":
			return MigrateOpts{}, ErrHelp
		default:
			ok, err := o.Common.take(args, &i)
			if err != nil {
				return MigrateOpts{}, err
			}
			if !ok {
				return MigrateOpts{}, unknownFlag("migrate", args[i])
			}
		}
	}
	return o, nil
}
