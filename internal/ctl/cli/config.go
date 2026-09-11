package cli

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"dongminal/internal/shared/serverconf"
	"dongminal/internal/shared/settingsschema"
)

// `dongminal config` — 설정을 **보고 대조하는** 자리 (CONFIG_MANAGEMENT_SRS 묶음 C).
//
// 두 파일을 함께 다룬다. `server.json` 은 서버가 뜨기 위해 읽는 값이고,
// `settings.json` 은 브라우저의 블롭이다. **서버는 블롭을 런타임에 해석하지
// 않는다**(D-CFG-1) — 여기서 읽는 것은 사람이 부를 때만 도는 진단이며 요청
// 경로에 없다. 그 구분이 §2.4 의 판정 전부다.

// ConfigOpts 는 `dongminal config` 의 옵션이다.
type ConfigOpts struct {
	Common
	// Sub 는 `show` 또는 `validate` 다.
	Sub  string
	JSON bool
}

var configSubs = []string{"show", "validate"}

// ParseConfig 는 `config <show|validate> [--json] [--home …]` 를 읽는다.
func ParseConfig(args []string) (ConfigOpts, error) {
	var o ConfigOpts
	for i := 0; i < len(args); i++ {
		a := args[i]
		switch {
		case a == "-h" || a == "--help":
			return ConfigOpts{}, ErrHelp
		case a == "--json":
			o.JSON = true
		case strings.HasPrefix(a, "-"):
			took, err := o.Common.take(args, &i)
			if err != nil {
				return ConfigOpts{}, err
			}
			if !took {
				return ConfigOpts{}, unknownFlag("config", a)
			}
		case o.Sub == "":
			o.Sub = a
		default:
			return ConfigOpts{}, fmt.Errorf("config: 인자가 너무 많습니다: %s", a)
		}
	}
	if o.Sub == "" {
		return ConfigOpts{}, fmt.Errorf("config: 하위 명령이 필요합니다 (%s)", strings.Join(configSubs, "|"))
	}
	if o.Sub != "show" && o.Sub != "validate" {
		return ConfigOpts{}, fmt.Errorf("config: 알 수 없는 하위 명령 %q (%s)", o.Sub, strings.Join(configSubs, "|"))
	}
	return o, nil
}

// configReport 는 두 하위 명령이 함께 쓰는 재료다. 모으는 일과 내는 일을 가르면
// `--json` 이 사람이 읽는 표와 같은 사실을 낸다 (FR-CFG-11).
type configReport struct {
	Home     string                   `json:"home"`
	Server   serverconf.Resolved      `json:"server"`
	Settings []settingsschema.Problem `json:"settingsProblems,omitempty"`
	Unknown  []string                 `json:"settingsUnknownKeys,omitempty"`
	Schema   []settingsschema.Spec    `json:"schema,omitempty"`
	Warnings []string                 `json:"warnings,omitempty"`
	Errors   []string                 `json:"errors,omitempty"`
}

// RunConfig 는 `dongminal config` 다.
func RunConfig(o ConfigOpts, stdout, stderr io.Writer) int {
	home, err := o.ResolveHome()
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	rep := configReport{Home: home}
	rep.Server = serverconf.Resolve(serverconf.Inputs{
		Home:           home,
		FlagPort:       o.Port,
		DefaultLogFile: defaultLogFile(),
	})
	rep.Warnings = append(rep.Warnings, rep.Server.Warnings...)
	if err := rep.Server.Err(); err != nil {
		rep.Errors = append(rep.Errors, err.Error())
	}

	specs, schemaErr := settingsschema.Load()
	if schemaErr != nil {
		// 표를 읽지 못하면 블롭을 댈 기준이 없다. **경고가 아니라 오류다** —
		// 이것은 사용자의 설정이 아니라 빌드의 결함이다.
		rep.Errors = append(rep.Errors, schemaErr.Error())
	} else {
		rep.Schema = specs
		if blob, err := os.ReadFile(filepath.Join(home, "settings.json")); err == nil {
			probs, unknown, err := settingsschema.Validate(specs, blob)
			if err != nil {
				rep.Errors = append(rep.Errors, "settings.json: "+err.Error())
			} else {
				rep.Settings = probs
				rep.Unknown = unknown
			}
		} else if !os.IsNotExist(err) {
			rep.Warnings = append(rep.Warnings, "settings.json 을 읽지 못했습니다: "+err.Error())
		}
	}

	if o.JSON {
		return emitConfigJSON(o, rep, stdout, stderr)
	}
	return emitConfigText(o, rep, stdout, stderr)
}

func emitConfigJSON(o ConfigOpts, rep configReport, stdout, stderr io.Writer) int {
	if o.Sub == "show" {
		rep.Schema = nil // show 의 관심은 실효값이다
	}
	enc := json.NewEncoder(stdout)
	enc.SetIndent("", "  ")
	if err := enc.Encode(rep); err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	return configExit(o, rep)
}

func emitConfigText(o ConfigOpts, rep configReport, stdout, stderr io.Writer) int {
	fmt.Fprintf(stdout, "홈: %s\n\n", rep.Home)
	if o.Sub == "show" {
		// **출처가 값보다 중요하다** (FR-CFG-7) — 안 듣는 설정을 쫓는 사람이
		// 묻는 것은 "값이 무엇인가" 가 아니라 "그 값이 어디서 왔는가" 다.
		fmt.Fprintln(stdout, "서버 기동값 (플래그 > 환경변수 > 파일 > 기본값)")
		fmt.Fprintf(stdout, "  %-10s %-28s %s\n", "키", "값", "출처")
		for _, row := range []struct {
			name string
			v    serverconf.Value
		}{
			{"host", rep.Server.Host},
			{"port", rep.Server.Port},
			{"logLevel", rep.Server.LogLevel},
			{"logFile", rep.Server.LogFile},
		} {
			src := string(row.v.Source)
			if row.v.Env != "" {
				src += " (" + row.v.Env + ")"
			}
			fmt.Fprintf(stdout, "  %-10s %-28s %s\n", row.name, row.v.Value, src)
		}
		fmt.Fprintln(stdout)
	}

	if o.Sub == "validate" {
		fmt.Fprintf(stdout, "서버 기동값: %s\n", statusWord(len(rep.Errors) == 0))
		n := len(rep.Settings)
		fmt.Fprintf(stdout, "설정 블롭(settings.json): 불일치 %d건\n", n)
		// **첫 오류에서 멈추지 않는다** (FR-CFG-8) — 고치고 다시 돌리는 왕복을
		// 키 수만큼 시키지 않는다.
		for _, p := range rep.Settings {
			fmt.Fprintf(stdout, "  ✗ %s\n", p)
		}
		if len(rep.Unknown) > 0 {
			sort.Strings(rep.Unknown)
			// D-CFG-4: 경고이지 실패가 아니다. 판이 앞선 브라우저가 쓴 키가
			// 빨갛게 뜨면 사용자가 멀쩡한 설정을 지운다.
			fmt.Fprintf(stdout, "  ℹ 알 수 없는 키 %d개 (실패가 아닙니다): %s\n",
				len(rep.Unknown), strings.Join(rep.Unknown, ", "))
		}
		fmt.Fprintln(stdout)
	}

	for _, w := range rep.Warnings {
		fmt.Fprintf(stdout, "⚠ %s\n", w)
	}
	for _, e := range rep.Errors {
		fmt.Fprintf(stderr, "✗ %s\n", e)
	}
	return configExit(o, rep)
}

func statusWord(ok bool) string {
	if ok {
		return "정상"
	}
	return "오류"
}

// configExit 는 종료 코드다.
//
// `show` 는 **보여 주는 명령**이라 값이 틀려도 0 이다 — 틀린 값을 보려고 부르는
// 것이 그 명령이다. 판정은 `validate` 의 일이다 (FR-CFG-9).
func configExit(o ConfigOpts, rep configReport) int {
	if o.Sub != "validate" {
		return 0
	}
	if len(rep.Errors) > 0 || len(rep.Settings) > 0 {
		return 1
	}
	return 0
}

// exposeFlagHost 는 `--expose` 를 호스트의 **플래그 계층**으로 옮긴다.
//
// 플래그로 다루는 이유는 우선순위 때문이다 (FR-CFG-13). `--expose` 를 치고도
// `server.json` 의 `host` 가 이기면 사용자는 자기가 방금 준 명령이 무시되는 것을
// 본다. 주지 않았으면 빈 문자열이고 그것은 "정하지 않음" 이라 다음 계층으로 간다.
func exposeFlagHost(o StartOpts) string {
	if o.Expose {
		return ExposeHost
	}
	return ""
}
