// Package serverconf 는 서버 기동값을 **네 계층**에서 정한다
// (CONFIG_MANAGEMENT_SRS 묶음 F·P).
//
//	플래그 > 환경변수 > 파일(<home>/server.json) > 기본값
//
// 종전에는 계층이 둘(플래그·환경변수)이었다. 기계마다 다른 기동값을 고정하려면
// 셸 프로필이나 래퍼 스크립트가 필요했고, 그것은 dongminal 이 관리하지 않는 자리다.
//
// **출처를 값과 함께 들고 다닌다** (FR-CFG-7). 안 듣는 설정을 쫓는 사람이 묻는
// 것은 "값이 무엇인가" 가 아니라 **"그 값이 어디서 왔는가"** 이기 때문이다.
package serverconf

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"

	"dongminal/internal/shared/dmenv"
)

// FileName 은 파일 계층이 사는 자리다. `<home>` 아래이며 다른 상태 파일과 같다.
const FileName = "server.json"

// Source 는 값이 어느 계층에서 왔는지다.
type Source string

const (
	SourceFlag    Source = "flag"
	SourceEnv     Source = "env"
	SourceFile    Source = "file"
	SourceDefault Source = "default"
)

// DefaultLogLevel 은 `logLevel` 의 기본이다.
const DefaultLogLevel = "info"

// Value 는 실효값과 그 출처다.
type Value struct {
	Value  string `json:"value"`
	Source Source `json:"source"`
	// Env 는 이 값이 환경변수에서 왔을 때 그 변수 이름이다. 오류 문구가
	// **어느 변수**인지 말할 수 있어야 한다 (FR-CFG-19).
	Env string `json:"env,omitempty"`
}

// Inputs 는 해석에 필요한 재료다. `Getenv` 를 받는 것은 검사가 프로세스 환경을
// 건드리지 않고 표를 돌기 위해서다.
type Inputs struct {
	Home         string
	FlagHost     string
	FlagPort     string
	FlagLogLevel string
	FlagLogFile  string
	Getenv       func(string) string
	// DefaultLogFile 은 OS 마다 다르므로 부르는 쪽이 준다 (FR-XPA-2).
	DefaultLogFile string
}

// Resolved 는 네 계층을 지난 결과다.
type Resolved struct {
	Host     Value    `json:"host"`
	Port     Value    `json:"port"`
	LogLevel Value    `json:"logLevel"`
	LogFile  Value    `json:"logFile"`
	Warnings []string `json:"warnings,omitempty"`

	portErr error
}

// file 은 파일 계층의 모양이다 (FR-CFG-12). 기동값만 담는다 — 브라우저 블롭을
// 여기로 옮기면 D-CFG-1 을 뒷문으로 뒤집는 셈이 된다 (D-CFG-5).
type file struct {
	Host     *string `json:"host"`
	Port     *string `json:"port"`
	LogLevel *string `json:"logLevel"`
	LogFile  *string `json:"logFile"`
}

// knownKeys 는 파일이 아는 키다. 밖의 키는 경고이지 실패가 아니다 (D-CFG-4).
var knownKeys = map[string]bool{"host": true, "port": true, "logLevel": true, "logFile": true}

// Resolve 는 네 계층을 지나 실효값을 정한다.
//
// **파일이 깨져도 기동을 막지 않는다** (FR-CFG-15 / D-CFG-3). 설정 파일 하나가
// 서버를 못 뜨게 만들면 사용자는 그것을 고칠 화면에 닿을 수 없다. `access.json`
// 은 반대로 fail-closed 인데(FR-RQG-21), 그쪽은 **경계**이고 이쪽은 **편의**라
// 답이 갈린다 — 둘을 같은 규칙으로 묶으면 한쪽이 반드시 틀린다.
func Resolve(in Inputs) Resolved {
	getenv := in.Getenv
	if getenv == nil {
		getenv = os.Getenv
	}
	f, warns := readFile(in.Home)

	var r Resolved
	r.Warnings = warns
	r.Host = pick(in.FlagHost, []envRef{{dmenv.EnvHost, getenv(dmenv.EnvHost)}}, f.Host, dmenv.DefaultHost)
	r.Port = pick(in.FlagPort,
		[]envRef{{"PORT", getenv("PORT")}, {dmenv.EnvPort, getenv(dmenv.EnvPort)}},
		f.Port, dmenv.DefaultPort)
	r.LogLevel = pick(in.FlagLogLevel, []envRef{{EnvLogLevel, getenv(EnvLogLevel)}}, f.LogLevel, DefaultLogLevel)
	r.LogFile = pick(in.FlagLogFile, []envRef{{EnvLogFile, getenv(EnvLogFile)}}, f.LogFile, in.DefaultLogFile)

	r.portErr = checkPort(r.Port)
	return r
}

// EnvLogLevel·EnvLogFile 은 로그 계층의 환경변수다.
const (
	EnvLogLevel = "DONGMINAL_LOG_LEVEL"
	EnvLogFile  = "DONGMINAL_LOG"
)

type envRef struct{ name, val string }

// pick 은 한 값의 네 계층을 지난다. **빈 문자열은 "정하지 않음" 이다**
// (FR-CFG-13) — 다음 계층으로 넘어간다.
func pick(flag string, envs []envRef, fileVal *string, def string) Value {
	if flag != "" {
		return Value{Value: flag, Source: SourceFlag}
	}
	for _, e := range envs {
		if e.val != "" {
			return Value{Value: e.val, Source: SourceEnv, Env: e.name}
		}
	}
	if fileVal != nil && *fileVal != "" {
		return Value{Value: *fileVal, Source: SourceFile}
	}
	return Value{Value: def, Source: SourceDefault}
}

// readFile 은 파일 계층을 읽는다. 없으면 조용하고(FR-CFG-14), 깨졌으면 경고만 낸다.
func readFile(home string) (file, []string) {
	var f file
	if home == "" {
		return f, nil
	}
	data, err := os.ReadFile(filepath.Join(home, FileName))
	if err != nil {
		if os.IsNotExist(err) {
			return f, nil // 없는 것이 정상이다
		}
		return f, []string{fmt.Sprintf("%s 를 읽지 못했습니다: %v (무시하고 진행합니다)", FileName, err)}
	}
	if err := json.Unmarshal(data, &f); err != nil {
		return file{}, []string{fmt.Sprintf("%s 가 깨졌습니다: %v (무시하고 진행합니다)", FileName, err)}
	}
	var warns []string
	var raw map[string]json.RawMessage
	if json.Unmarshal(data, &raw) == nil {
		var unknown []string
		for k := range raw {
			if !knownKeys[k] {
				unknown = append(unknown, k)
			}
		}
		sort.Strings(unknown)
		for _, k := range unknown {
			warns = append(warns, fmt.Sprintf("%s: 알 수 없는 키 %q (무시합니다)", FileName, k))
		}
	}
	return f, warns
}

// checkPort 는 포트를 `net.Listen` **전에** 본다 (FR-CFG-19).
//
// 종전에는 `PORT=abc` 가 해석을 통과해 `net.Listen("tcp","127.0.0.1:abc")` 에서
// 실패했다. 사용자가 보는 것은 주소 해석 오류였고 **어느 변수가 잘못됐는지가
// 없었다.**
func checkPort(v Value) error {
	n, err := strconv.Atoi(v.Value)
	if err != nil {
		return fmt.Errorf("포트가 숫자가 아닙니다: %s (출처: %s)", describe(v), v.Source)
	}
	if n < 1 || n > 65535 {
		return fmt.Errorf("포트가 범위(1~65535) 밖입니다: %s (출처: %s)", describe(v), v.Source)
	}
	return nil
}

// describe 는 "어느 변수의 어떤 값" 을 사람이 읽는 말로 만든다.
func describe(v Value) string {
	if v.Env != "" {
		return fmt.Sprintf("%s=%s", v.Env, v.Value)
	}
	return strconv.Quote(v.Value)
}

// Err 는 기동을 막아야 하는 사유다. 없으면 nil.
//
// **경고와 다르다.** 경고(`Warnings`)는 무시하고 진행하지만 이것은 진행하지
// 않는다 — 포트가 틀리면 뜰 수 없고, 그 사실은 `net.Listen` 이 아니라 여기서
// 말해야 한다.
func (r Resolved) Err() error { return r.portErr }

// ErrNoHome 은 홈 없이 해석을 부른 경우다. 외부에서 판별할 수 있게 둔다.
var ErrNoHome = errors.New("DONGMINAL_HOME 이 없습니다")
