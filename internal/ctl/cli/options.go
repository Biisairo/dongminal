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
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"dongminal/internal/shared/platform"
)

// ErrHelp는 -h/--help 가 주어졌을 때 파서가 돌려주는 센티널이다. 액션의
// 부수효과는 일어나지 않는다 (FR-CLI-6).
var ErrHelp = errors.New("help requested")

const (
	EnvPort = "PORT"
	EnvHome = "DONGMINAL_HOME"
	EnvHost = "DONGMINAL_HOST"
	EnvLog  = "DONGMINAL_LOG"

	// EnvRestartRunner는 이 실행이 위임된 재시작 대리임을 알린다 — 대리가
	// 다시 위임하지 않게 하는 표시다 (FR-ACT-3b).
	EnvRestartRunner = "DONGMINAL_RESTART_RUNNER"
	// EnvToolID는 도구의 셸에 심기는 도구 식별자다(toolhub.StartTool). 이
	// 값이 있으면 지금 dongminal 도구 안에서 돌고 있다는 뜻이다 (FR-ACT-3a).
	EnvToolID = "DONGMINAL_TOOL_ID"

	DefaultPort = "58146"
	DefaultHost = "127.0.0.1"

	ExposeHost = "0.0.0.0"
)

// defaultLogFile 은 배경 모드 기동이 출력을 남길 자리다. 상수가 아니라 함수인
// 것은 이 값이 OS 마다 다르기 때문이다 — POSIX 는 /tmp/dongminal.log 로 종전과
// 같고, Windows 는 %LOCALAPPDATA% 아래다 (CROSS_PLATFORM_SRS FR-XPA-2).
func defaultLogFile() string { return platform.Current().Paths.DefaultLogFile() }

// Actions는 help 에 나열되는 액션 이름이다. 내부 진입점 `d`(데몬)는 여기
// 없다 — 사용자가 직접 부를 것이 아니다 (FR-CLI-8).
var Actions = []string{"start", "stop", "migrate", "health", "doctor"}

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
	return filepath.Join(userHome, ".dongminal"), nil
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
	Open          bool
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
}

// HealthOpts는 `dongminal health` 의 옵션이다.
type HealthOpts struct {
	Common
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
		case "--open":
			o.Open = true
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

func ParseHealth(args []string) (HealthOpts, error) {
	var o HealthOpts
	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "-h", "--help":
			return HealthOpts{}, ErrHelp
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
