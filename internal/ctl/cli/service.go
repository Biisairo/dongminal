package cli

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"dongminal/internal/shared/dmenv"
	"dongminal/internal/shared/platform"
	"dongminal/internal/shared/serverconf"
)

// `dongminal service install` — 감독자에게 넣을 정의를 써 준다 (M5 `SEC-23`).
//
// 웹서버 프로세스를 감독하는 것이 없었다. 죽으면 아무도 되살리지 않고, 사용자가
// 그 사실을 아는 방법은 브라우저가 붙지 않는 것뿐이다 — 그때 이미 세션은 끊긴 뒤다.
//
// **우리가 감독자를 만들지 않는다.** OS 마다 이미 있고(launchd·systemd), 그것들은
// 부팅·로그인·크래시를 우리보다 잘 안다. 우리가 할 일은 **그것에 넣을 정의를
// 정확히 써 주는 것**이다 — 경로·환경변수·재시작 정책이 이 제품의 실제 계약과
// 맞아야 하고, 그 셋은 우리만 안다.
//
// **설치하지 않는다.** 파일을 쓰고 다음 걸음을 안내한다. 사용자의 감독자 설정에
// 우리가 손을 넣으면, 그것을 되돌리는 길도 우리가 져야 한다.

// ServiceOpts 는 `dongminal service` 의 옵션이다.
type ServiceOpts struct {
	Common
	Sub string
	Out string

	// osKind·exe 는 검사가 바꿔 끼우는 자리다. 비면 실행 환경에서 읽는다 —
	// 세 OS 의 정의를 한 기계에서 확인할 수 있어야 한다.
	osKind platform.OSKind
	exe    string
}

// ParseService 는 `service install [--out <파일>] [--home …]` 이다.
func ParseService(args []string) (ServiceOpts, error) {
	var o ServiceOpts
	for i := 0; i < len(args); i++ {
		a := args[i]
		switch {
		case a == "-h" || a == "--help":
			return ServiceOpts{}, ErrHelp
		case a == "--out" || strings.HasPrefix(a, "--out="):
			v, adv, err := flagValue(args, i, "--out")
			if err != nil {
				return ServiceOpts{}, err
			}
			o.Out = v
			i += adv
		case strings.HasPrefix(a, "-"):
			took, err := o.Common.take(args, &i)
			if err != nil {
				return ServiceOpts{}, err
			}
			if !took {
				return ServiceOpts{}, unknownFlag("service", a)
			}
		case o.Sub == "":
			o.Sub = a
		default:
			return ServiceOpts{}, fmt.Errorf("service: 인자가 너무 많습니다: %s", a)
		}
	}
	if o.Sub != "install" {
		return ServiceOpts{}, fmt.Errorf("service: 하위 명령은 install 입니다")
	}
	return o, nil
}

// RunService 는 `dongminal service install` 이다.
func RunService(o ServiceOpts, stdout, stderr io.Writer) int {
	home, err := o.ResolveHome()
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	kind := o.osKind
	if kind == "" {
		kind = platform.Current().OS
	}
	exe := o.exe
	if exe == "" {
		exe, err = os.Executable()
		if err != nil {
			fmt.Fprintf(stderr, "실행 파일의 자리를 알 수 없습니다: %v\n", err)
			return 1
		}
	}
	conf := serverconf.Resolve(serverconf.Inputs{Home: home, DefaultLogFile: defaultLogFile()})

	var body, hint string
	switch kind {
	case platform.Darwin:
		body, hint = launchdPlist(exe, home, conf), darwinHint(o.Out)
	case platform.Linux, platform.WSL:
		body, hint = systemdUnit(exe, home, conf), linuxHint(o.Out)
	default:
		// **조용히 빈 파일을 쓰지 않는다.** 그것이 가장 나쁘다 — 사용자는
		// 감독이 걸린 줄 알고, 죽으면 아무 일도 일어나지 않는다.
		fmt.Fprintf(stderr, "감독자 정의를 만들 수 없습니다: %s 는 아직 지원하지 않습니다.\n", kind)
		fmt.Fprintln(stderr, "Windows 에서는 작업 스케줄러의 '로그온 시 시작' 으로 같은 일을 할 수 있습니다.")
		fmt.Fprintln(stderr, "  프로그램: "+exe)
		fmt.Fprintln(stderr, "  인수:     start --foreground")
		return 1
	}

	if o.Out == "" {
		// 파일을 주지 않았으면 화면에 낸다. 사용자가 보고 옮길 수 있다.
		fmt.Fprint(stdout, body)
		fmt.Fprintln(stdout)
		fmt.Fprint(stdout, hint)
		return 0
	}
	if err := os.MkdirAll(filepath.Dir(o.Out), 0o755); err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	if err := os.WriteFile(o.Out, []byte(body), 0o644); err != nil {
		fmt.Fprintf(stderr, "쓰지 못했습니다: %v\n", err)
		return 1
	}
	fmt.Fprintf(stdout, "✅ %s\n\n", o.Out)
	fmt.Fprint(stdout, hint)
	return 0
}

// serviceLabel 은 감독자가 쓰는 이름이다.
const serviceLabel = "com.dongminal.server"

// launchdPlist 는 macOS 의 정의다.
//
// `KeepAlive` 가 감독의 본체다 — 그것이 없으면 "로그인할 때 한 번 띄운다" 이지
// 감독이 아니다. `RunAtLoad` 는 그 첫 기동이다.
func launchdPlist(exe, home string, conf serverconf.Resolved) string {
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- dongminal 웹서버 감독 (M5 SEC-23).
     "dongminal service install" 이 만들었습니다. 경로·환경변수를 고쳤으면
     이 파일도 함께 고치세요 — 이 파일은 다시 생성되지 않습니다. -->
<plist version="1.0">
<dict>
  <key>Label</key><string>` + serviceLabel + `</string>
  <key>ProgramArguments</key>
  <array>
    <string>` + xmlEsc(exe) + `</string>
    <string>start</string>
    <string>--foreground</string>
  </array>
  <!-- 감독의 본체. 이것이 없으면 "로그인할 때 한 번 띄운다" 이지 감독이 아니다. -->
  <key>KeepAlive</key><true/>
  <key>RunAtLoad</key><true/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>` + dmenv.EnvHome + `</key><string>` + xmlEsc(home) + `</string>
    <key>` + dmenv.EnvHost + `</key><string>` + xmlEsc(conf.Host.Value) + `</string>
    <key>PORT</key><string>` + xmlEsc(conf.Port.Value) + `</string>
    <key>` + serverconf.EnvLogLevel + `</key><string>` + xmlEsc(conf.LogLevel.Value) + `</string>
  </dict>
  <key>StandardOutPath</key><string>` + xmlEsc(conf.LogFile.Value) + `</string>
  <key>StandardErrorPath</key><string>` + xmlEsc(conf.LogFile.Value) + `</string>
</dict>
</plist>
`
}

// systemdUnit 은 Linux·WSL 의 정의다.
//
// **user unit 이다.** 시스템 단위가 아닌 이유는 이 제품이 사용자의 홈과 세션에
// 매여 있기 때문이다 — 도구 셸이 사용자의 rc 를 읽고, 홈이 0700 이며, git
// 자격증명이 그 사용자의 것이다.
func systemdUnit(exe, home string, conf serverconf.Resolved) string {
	return `# dongminal 웹서버 감독 (M5 SEC-23).
# "dongminal service install" 이 만들었습니다. 경로·환경변수를 고쳤으면
# 이 파일도 함께 고치세요 — 이 파일은 다시 생성되지 않습니다.
#
# **user unit 입니다.** 시스템 단위가 아닌 이유는 이 제품이 사용자의 홈과 세션에
# 매여 있기 때문입니다 — 도구 셸이 사용자의 rc 를 읽고, 홈이 0700 이며, git
# 자격증명이 그 사용자의 것입니다.
[Unit]
Description=dongminal — 브라우저에서 쓰는 터미널 워크스페이스
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=` + exe + ` start --foreground
Environment=` + dmenv.EnvHome + `=` + home + `
Environment=` + dmenv.EnvHost + `=` + conf.Host.Value + `
Environment=PORT=` + conf.Port.Value + `
Environment=` + serverconf.EnvLogLevel + `=` + conf.LogLevel.Value + `
# 감독의 본체. 종료 코드를 가리지 않는 이유는, 우리가 "정상 종료" 로 세는 것이
# 사용자가 직접 내린 경우뿐이고 그때는 systemctl 로 내리기 때문입니다.
Restart=always
RestartSec=3
# 죽고 되살아나기를 반복하면 멎는다 — 되살릴수록 나빠지는 상태가 있고
# (포트 점유·디스크 가득), 그때 무한 재시작은 로그만 채웁니다.
StartLimitIntervalSec=120
StartLimitBurst=5

[Install]
WantedBy=default.target
`
}

func darwinHint(out string) string {
	target := out
	if target == "" {
		target = "~/Library/LaunchAgents/" + serviceLabel + ".plist"
	}
	return `다음 걸음 (이 명령이 대신 하지 않습니다):

  cp ` + target + ` ~/Library/LaunchAgents/` + serviceLabel + `.plist
  launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/` + serviceLabel + `.plist
  launchctl print gui/$(id -u)/` + serviceLabel + `

  내리려면: launchctl bootout gui/$(id -u)/` + serviceLabel + `

확인: 서버를 강제로 죽인 뒤(kill -9) 몇 초 안에 되살아나는지 보세요.
`
}

func linuxHint(out string) string {
	target := out
	if target == "" {
		target = "~/.config/systemd/user/dongminal.service"
	}
	return `다음 걸음 (이 명령이 대신 하지 않습니다):

  mkdir -p ~/.config/systemd/user
  cp ` + target + ` ~/.config/systemd/user/dongminal.service
  systemctl --user daemon-reload
  systemctl --user enable --now dongminal
  systemctl --user status dongminal

  로그아웃해도 살아 있게 하려면: sudo loginctl enable-linger $USER
  내리려면: systemctl --user disable --now dongminal

확인: 서버를 강제로 죽인 뒤(kill -9) 몇 초 안에 되살아나는지 보세요.
`
}

// xmlEsc 는 plist 에 들어갈 값을 이스케이프한다. 경로에 `&` 가 있으면 plist 가
// 통째로 깨지고, 그 실패는 launchctl 이 로드할 때에야 보인다.
func xmlEsc(s string) string {
	r := strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", `"`, "&quot;")
	return r.Replace(s)
}
