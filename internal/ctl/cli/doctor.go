package cli

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"dongminal/internal/shared/platform"
	"dongminal/internal/shared/runtime"
)

// doctor 는 플랫폼 계층을 **실제로 돌려 본다**. 서버가 쓰는 바로 그 코드
// 경로를 같은 순서로 밟으므로, 여기서 통과하면 그 계층은 이 호스트에서
// 동작한다는 뜻이고 실패하면 실패 지점과 OS 오류가 그대로 나온다.
//
// 이것이 필요한 이유는 계층이 겹겹이라서다. "터미널이 안 뜬다" 는 증상은
// 셸 탐색·헬퍼 설치·의사 터미널 기동·IPC 중 어디서든 날 수 있는데, 서버
// 로그만으로는 그 넷을 가르기 어렵다.

const (
	// doctorProbeTimeout 은 왕복 하나를 기다리는 상한이다. 셸이 프롬프트를
	// 그리기까지의 시간이라 넉넉히 준다.
	doctorProbeTimeout = 10 * time.Second
	// doctorProbeCols/Rows 는 검사용 터미널 크기다. 0 을 주면 Windows 의
	// CreatePseudoConsole 이 E_INVALIDARG 로 실패한다.
	doctorProbeCols = 80
	doctorProbeRows = 24
)

type doctorReport struct {
	out  io.Writer
	fail int
}

func (r *doctorReport) ok(format string, a ...any) {
	fmt.Fprintf(r.out, "  ✅ "+format+"\n", a...)
}

func (r *doctorReport) info(format string, a ...any) {
	fmt.Fprintf(r.out, "  ·  "+format+"\n", a...)
}

func (r *doctorReport) bad(format string, a ...any) {
	fmt.Fprintf(r.out, "  ❌ "+format+"\n", a...)
	r.fail++
}

func (r *doctorReport) section(title string) {
	fmt.Fprintf(r.out, "\n▶ %s\n", title)
}

// RunDoctor 는 `dongminal doctor` 다.
func RunDoctor(o DoctorOpts, stdout, stderr io.Writer) int {
	home, err := o.ResolveHome()
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	p := platform.Current()
	r := &doctorReport{out: stdout}

	fmt.Fprintf(stdout, "dongminal doctor — platform=%s\n", p.OS)

	doctorEnvironment(r, p, home)
	binDir := filepath.Join(home, "bin")
	doctorInstall(r, p, home, binDir)
	doctorShell(r, p, binDir)
	doctorTerminal(r, p, binDir, home)
	doctorIPC(r, p, home)
	doctorProcess(r, p)

	fmt.Fprintln(stdout, "\n────────────────────────────────────────")
	if r.fail > 0 {
		fmt.Fprintf(stdout, "실패 %d건. 위의 ❌ 줄이 원인입니다.\n", r.fail)
		return 1
	}
	fmt.Fprintln(stdout, "전부 통과. 이 호스트에서 플랫폼 계층은 정상입니다.")
	return 0
}

func doctorEnvironment(r *doctorReport, p platform.Platform, home string) {
	r.section("환경")
	r.info("DONGMINAL_HOME = %s", home)
	r.info("로그 기본 경로  = %s", p.Paths.DefaultLogFile())
	r.info("실행 확장자     = %q", p.Paths.ExeSuffix())
	// 홈은 start 가 만든다. doctor 는 홈이 없는 상태에서도 돌 수 있어야
	// 하므로 여기서도 만든다 — 없는 것은 실패가 아니다.
	if err := os.MkdirAll(home, 0o755); err != nil {
		r.bad("홈을 만들지 못했습니다: %v", err)
		return
	}
	if fi, err := os.Stat(home); err != nil {
		r.bad("홈을 읽을 수 없습니다: %v", err)
	} else if !fi.IsDir() {
		r.bad("홈이 디렉터리가 아닙니다: %s", home)
	} else {
		r.ok("홈 존재")
	}
}

// doctorInstall 은 헬퍼와 셸 훅을 실제로 설치해 본다. 훅이 없으면 셸이 없는
// 스크립트를 받아 즉시 죽고, 그것이 "터미널이 비어 보이는" 증상이 된다.
func doctorInstall(r *doctorReport, p platform.Platform, home, binDir string) {
	r.section("헬퍼·셸 훅 설치")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		r.bad("bin 디렉터리를 만들지 못했습니다: %v", err)
		return
	}
	if err := runtime.Install(binDir); err != nil {
		r.bad("설치 실패: %v", err)
		return
	}
	r.ok("설치 완료: %s", binDir)

	// 셸이 실제로 참조할 훅 파일이 그 자리에 있는지 본다.
	spec := p.Shell.Shell(binDir)
	for _, arg := range spec.Args {
		path, ok := doctorHookPath(arg)
		if !ok {
			continue
		}
		if _, err := os.Stat(path); err != nil {
			r.bad("셸이 참조할 훅이 없습니다: %s (%v)", path, err)
		} else {
			r.ok("훅 존재: %s", path)
		}
	}
	for _, kv := range spec.Env {
		k, v, ok := strings.Cut(kv, "=")
		if !ok || (k != "BASH_ENV" && k != "ZDOTDIR") {
			continue
		}
		if _, err := os.Stat(v); err != nil {
			r.bad("%s 가 가리키는 곳이 없습니다: %s (%v)", k, v, err)
		} else {
			r.ok("%s = %s", k, v)
		}
	}
}

// doctorHookPath 는 셸 인자에서 훅 스크립트 경로를 뽑는다. Windows 인자는
// 경로 그 자체가 아니라 `. '<경로>'` 형태의 닷소싱 명령이다 (dotSource).
func doctorHookPath(arg string) (string, bool) {
	s := strings.TrimSpace(arg)
	if rest, ok := strings.CutPrefix(s, ". '"); ok {
		s = strings.TrimSuffix(rest, "'")
		s = strings.ReplaceAll(s, "''", "'")
	}
	low := strings.ToLower(s)
	if !strings.HasSuffix(low, ".ps1") && !strings.HasSuffix(low, ".sh") {
		return "", false
	}
	return s, true
}

func doctorShell(r *doctorReport, p platform.Platform, binDir string) {
	r.section("셸 선택")
	spec := p.Shell.Shell(binDir)
	if spec.Path == "" {
		r.bad("셸을 고르지 못했습니다")
		return
	}
	r.info("실행 파일 = %s", spec.Path)
	r.info("인자      = %v", spec.Args)
	r.info("훅 트리   = shellhooks/%s", p.Shell.HookRoot())
	if _, err := os.Stat(spec.Path); err != nil {
		r.bad("셸이 그 경로에 없습니다: %v", err)
		return
	}
	r.ok("셸 확인")
}

// doctorTerminal 이 이 검사의 핵심이다. 의사 터미널을 실제로 띄우고 명령
// 하나를 왕복시킨다 — 서버가 도구를 만들 때 하는 일과 같다.
//
// 두 번 한다: 훅 없는 **맨 셸**과 훅을 얹은 셸. 맨 셸이 되고 훅 셸이 안 되면
// 범인은 훅이고, 둘 다 안 되면 의사 터미널이다. 이 둘을 가르지 못하면 원인을
// 한 단계도 좁힐 수 없다.
func doctorTerminal(r *doctorReport, p platform.Platform, binDir, home string) {
	r.section("의사 터미널 (PTY/ConPTY)")
	spec := p.Shell.Shell(binDir)

	bare := doctorProbeTerminal(r, p, "맨 셸", platform.ShellSpec{Path: spec.Path}, home)
	if len(spec.Args) == 0 && len(spec.Env) == 0 {
		return // 훅이 없는 구성이면 같은 것을 두 번 할 이유가 없다
	}
	hooked := doctorProbeTerminal(r, p, "훅 얹은 셸", spec, home)

	if bare && !hooked {
		r.bad("맨 셸은 되는데 훅을 얹으면 안 됩니다 — 원인은 셸 훅입니다")
		for _, a := range spec.Args {
			r.info("훅 인자: %s", a)
		}
	}
}

// doctorProbeTerminal 은 명세 하나로 터미널을 띄워 왕복시킨다.
func doctorProbeTerminal(r *doctorReport, p platform.Platform, label string, spec platform.ShellSpec, home string) bool {
	env := append(os.Environ(), "TERM=xterm-256color", "DONGMINAL_HOME="+home)
	env = append(env, spec.Env...)

	term, err := p.PTY.Start(platform.ProcSpec{
		Path: spec.Path,
		Args: append([]string{spec.Path}, spec.Args...),
		Env:  env,
		Dir:  home,
	}, doctorProbeCols, doctorProbeRows)
	if err != nil {
		r.bad("[%s] 터미널 기동 실패: %v", label, err)
		return false
	}
	defer func() {
		term.Kill()
		term.Close()
	}()
	r.ok("[%s] 기동 pid=%d", label, term.PID())

	if c, rows, err := term.Size(); err != nil {
		r.bad("[%s] 크기 조회 실패: %v", label, err)
	} else if c == 0 || rows == 0 {
		r.bad("[%s] 크기가 0입니다 (%dx%d)", label, c, rows)
	}
	if err := term.Resize(100, 30); err != nil {
		r.bad("[%s] 크기 변경 실패: %v", label, err)
	}

	// echo 는 sh·bash·zsh·PowerShell·cmd 가 모두 아는 몇 안 되는 명령이다.
	const marker = "dongminal-doctor-ok"
	got, err := doctorRoundTrip(term, "echo "+marker+"\r\n", marker, doctorProbeTimeout)
	switch {
	case err != nil:
		r.bad("[%s] 출력을 읽지 못했습니다: %v", label, err)
		r.info("그때까지 받은 것: %q", doctorTrim(got))
		return false
	case !strings.Contains(got, marker):
		r.bad("[%s] 명령이 왕복하지 않았습니다", label)
		r.info("받은 것: %q", doctorTrim(got))
		return false
	}
	r.ok("[%s] 입출력 왕복", label)
	return true
}

// doctorRoundTrip 은 input 을 쓰고 want 가 보일 때까지 읽는다. 읽기가 막힐
// 수 있으므로 goroutine 으로 돌리고 상한을 건다.
func doctorRoundTrip(term platform.Terminal, input, want string, limit time.Duration) (string, error) {
	type result struct {
		data string
		err  error
	}
	done := make(chan result, 1)
	var seen strings.Builder

	go func() {
		buf := make([]byte, 4096)
		for {
			n, err := term.Read(buf)
			if n > 0 {
				seen.Write(buf[:n])
				if strings.Contains(seen.String(), want) {
					done <- result{seen.String(), nil}
					return
				}
			}
			if err != nil {
				done <- result{seen.String(), err}
				return
			}
		}
	}()

	// 셸이 프롬프트를 그릴 틈을 준 뒤 명령을 넣는다. 너무 이르면 셸이
	// 입력을 버린다.
	time.Sleep(300 * time.Millisecond)
	if _, err := term.Write([]byte(input)); err != nil {
		return seen.String(), fmt.Errorf("입력 쓰기: %w", err)
	}

	select {
	case res := <-done:
		return res.data, res.err
	case <-time.After(limit):
		return seen.String(), fmt.Errorf("%s 안에 응답이 없습니다", limit)
	}
}

// doctorTrim 은 화면에 실을 만큼만 남긴다. 제어 문자는 그대로 두면 터미널을
// 망가뜨리므로 %q 로 감싸는 것은 호출자의 몫이다.
func doctorTrim(s string) string {
	const max = 300
	s = strings.TrimSpace(s)
	if len(s) > max {
		return s[:max] + "…"
	}
	return s
}

func doctorIPC(r *doctorReport, p platform.Platform, home string) {
	r.section("로컬 IPC 종단")
	ep := p.IPC.Endpoint(filepath.Join(home, "doctor"))
	if err := os.MkdirAll(filepath.Dir(ep), 0o755); err != nil {
		r.bad("검사용 디렉터리를 만들지 못했습니다: %v", err)
		return
	}
	defer os.RemoveAll(filepath.Dir(ep))

	_ = p.IPC.Remove(ep)
	ln, err := p.IPC.Listen(ep)
	if err != nil {
		r.bad("종단 개설 실패: %v", err)
		r.info("경로: %s", ep)
		return
	}
	defer ln.Close()
	r.ok("종단 개설 %s", ep)

	if !p.IPC.Exists(ep) {
		r.bad("개설한 종단을 존재 판정이 보지 못합니다 — 데몬을 못 찾게 됩니다")
	} else {
		r.ok("존재 판정")
	}

	echoed := make(chan error, 1)
	go func() {
		c, err := ln.Accept()
		if err != nil {
			echoed <- err
			return
		}
		defer c.Close()
		buf := make([]byte, 8)
		n, err := c.Read(buf)
		if err != nil {
			echoed <- err
			return
		}
		_, err = c.Write(buf[:n])
		echoed <- err
	}()

	conn, err := p.IPC.Dial(ep, 3*time.Second)
	if err != nil {
		r.bad("종단 접속 실패: %v", err)
		return
	}
	defer conn.Close()
	if _, err := conn.Write([]byte("ping")); err != nil {
		r.bad("종단 쓰기 실패: %v", err)
		return
	}
	buf := make([]byte, 4)
	_ = conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	if _, err := conn.Read(buf); err != nil {
		r.bad("종단 읽기 실패: %v", err)
		return
	}
	if string(buf) != "ping" {
		r.bad("왕복 내용이 다릅니다: %q", buf)
		return
	}
	if err := <-echoed; err != nil {
		r.bad("종단 응답 실패: %v", err)
		return
	}
	r.ok("접속·왕복")
}

// doctorProcess 는 자식을 하나 띄워 그룹 제어와 생존 판정을 확인한다.
// git 원격 작업의 취소가 이 경로를 딛는다.
func doctorProcess(r *doctorReport, p platform.Platform) {
	r.section("프로세스 제어")
	if !p.Process.Alive(os.Getpid()) {
		r.bad("자기 자신이 살아 있지 않다고 합니다 — 생존 판정이 깨졌습니다")
	} else {
		r.ok("생존 판정")
	}
	r.info("종료 신호 = %v", p.Process.ShutdownSignals())

	if pid, ok := p.Info.ParentPID(os.Getpid()); ok {
		r.ok("부모 조회 ppid=%d", pid)
	} else {
		r.bad("부모를 조회하지 못했습니다 — dmctl who-am-i 가 도구를 못 찾습니다")
	}
	if names := p.Info.Names([]int{os.Getpid()}); names[os.Getpid()] != "" {
		r.ok("프로세스 이름 조회 = %s", names[os.Getpid()])
	} else {
		r.bad("프로세스 이름을 조회하지 못했습니다 — 탭 이름이 비게 됩니다")
	}
}
