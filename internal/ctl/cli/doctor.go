package cli

import (
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"dongminal/internal/shared/platform"
	"dongminal/internal/shared/runtime"
	"dongminal/internal/shared/toolhub"
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
	// doctorDetachedWait 은 콘솔 없는 자식의 결과를 기다리는 상한이다. 자식이
	// 스스로 doctorProbeTimeout 을 걸고 결과를 쓰므로 그보다 넉넉해야 한다.
	doctorDetachedWait = doctorProbeTimeout + 30*time.Second
	// doctorReadyWait·doctorQuietFor 는 "셸이 프롬프트를 그렸다" 로 볼 조건이다.
	// 출력이 오고 이만큼 조용하면 준비된 것으로 본다.
	doctorReadyWait = 15 * time.Second
	doctorQuietFor  = 700 * time.Millisecond
)

type doctorReport struct {
	out  io.Writer
	fail int
	// bads 는 실패 줄을 모은다. 보고서가 길어 사용자가 앞부분을 잘라 붙이는
	// 일이 실제로 있었다 — 마지막에 다시 모아 찍으면 꼬리만 붙여도 답이 실린다.
	bads []string
}

func (r *doctorReport) ok(format string, a ...any) {
	fmt.Fprintf(r.out, "  ✅ "+format+"\n", a...)
}

func (r *doctorReport) info(format string, a ...any) {
	fmt.Fprintf(r.out, "  ·  "+format+"\n", a...)
}

func (r *doctorReport) bad(format string, a ...any) {
	line := fmt.Sprintf(format, a...)
	fmt.Fprintf(r.out, "  ❌ %s\n", line)
	r.bads = append(r.bads, line)
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

	// 내부 프로브 모드: 의사 터미널만 확인하고 결과를 파일에 적는다. 부모가
	// 이 프로세스를 **콘솔 없이** 띄웠으므로, 서버가 도구를 만드는 조건과
	// 같다 (doctorDetached).
	if o.ProbePTY != "" {
		return runPTYProbe(o.ProbePTY, p, home)
	}

	// toolhub 는 표준 로거로 찍는다. 보고서 사이에 섞이면 읽기 어려우므로
	// 모아 두었다가 실패했을 때만 마지막에 보여 준다.
	var captured strings.Builder
	prevOut, prevFlags := log.Writer(), log.Flags()
	log.SetOutput(&captured)
	defer func() { log.SetOutput(prevOut); log.SetFlags(prevFlags) }()

	r := &doctorReport{out: stdout}
	fmt.Fprintf(stdout, "dongminal doctor — platform=%s\n", p.OS)

	doctorEnvironment(r, p, home)
	binDir := filepath.Join(home, "bin")
	doctorInstall(r, p, home, binDir)
	doctorShell(r, p, binDir)
	doctorTerminal(r, p, binDir, home)
	doctorTool(r, home)
	doctorDetached(r, p, home)
	doctorIPC(r, p, home)
	doctorProcess(r, p)

	fmt.Fprintln(stdout, "\n────────────────────────────────────────")
	if r.fail == 0 {
		fmt.Fprintln(stdout, "전부 통과. 이 호스트에서 플랫폼 계층은 정상입니다.")
		return 0
	}
	fmt.Fprintf(stdout, "실패 %d건:\n", r.fail)
	for _, b := range r.bads {
		fmt.Fprintf(stdout, "  ❌ %s\n", b)
	}
	if logs := strings.TrimSpace(captured.String()); logs != "" {
		fmt.Fprintln(stdout, "\n[서버 로그]")
		fmt.Fprintln(stdout, logs)
	}
	return 1
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

	// 셸을 빼고 배관부터 본다. 입력도 프롬프트도 필요 없는 단순 명령이
	// ConPTY 로 흘러나오는지가 가장 아래 질문이다 — 이게 안 되면 셸·입력
	// 타이밍을 아무리 만져도 소용없다.
	doctorProbePlainCommand(r, p, home)

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

// doctorProbePlainCommand 는 **입력 없이** 한 줄을 출력하고 끝나는 명령을
// 의사 터미널에 띄운다. 셸·프롬프트·입력 타이밍이 모두 빠지므로, 실패하면
// 원인은 의사 터미널의 배관 그 자체다.
func doctorProbePlainCommand(r *doctorReport, p platform.Platform, home string) {
	const marker = "dongminal-plain-ok"
	spec := p.Shell.EchoCommand(marker)
	if len(spec) == 0 {
		return
	}
	term, err := p.PTY.Start(platform.ProcSpec{
		Path: spec[0], Args: spec, Env: os.Environ(), Dir: home,
	}, doctorProbeCols, doctorProbeRows)
	if err != nil {
		r.bad("[단순 명령] 기동 실패: %v", err)
		return
	}
	defer func() {
		term.Kill()
		term.Close()
	}()

	var seen strings.Builder
	deadline := time.Now().Add(doctorProbeTimeout)
	buf := make([]byte, 4096)
	for time.Now().Before(deadline) {
		n, rerr := term.Read(buf)
		if n > 0 {
			seen.Write(buf[:n])
			if strings.Contains(seen.String(), marker) {
				r.ok("[단순 명령] 출력이 의사 터미널로 나옵니다")
				return
			}
		}
		if rerr != nil {
			break
		}
	}
	r.bad("[단순 명령] 출력이 의사 터미널로 나오지 않습니다 (받은 %d바이트) — 배관 문제입니다", seen.Len())
	r.info("받은 것: %q", doctorTrim(seen.String()))
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
	got, err := doctorRoundTrip(term, "echo "+marker+"\r", marker, doctorProbeTimeout)
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

// doctorRoundTrip 은 셸이 준비되기를 기다린 뒤 input 을 쓰고, want 가 보일
// 때까지 읽는다.
//
// **기다림이 핵심이다.** 셸이 프롬프트를 그리기 전에 입력을 넣으면 그 입력은
// 버려진다. pwsh 는 PSReadLine 을 올리는 데 초 단위가 걸려 고정 대기로는 맞출
// 수 없다 — 실측에서 300ms 뒤에 넣은 입력이 통째로 사라졌다. 그래서 출력이
// 오고 **조용해지는 것**을 준비 신호로 삼는다.
func doctorRoundTrip(term platform.Terminal, input, want string, limit time.Duration) (string, error) {
	var mu sync.Mutex
	var seen strings.Builder
	lastAt := time.Now()

	found := make(chan struct{})
	readErr := make(chan error, 1)
	go func() {
		buf := make([]byte, 4096)
		for {
			n, err := term.Read(buf)
			if n > 0 {
				mu.Lock()
				seen.Write(buf[:n])
				lastAt = time.Now()
				hit := strings.Contains(seen.String(), want)
				mu.Unlock()
				if hit {
					close(found)
					return
				}
			}
			if err != nil {
				readErr <- err
				return
			}
		}
	}()

	snapshot := func() (string, int, time.Duration) {
		mu.Lock()
		defer mu.Unlock()
		return seen.String(), seen.Len(), time.Since(lastAt)
	}

	// 준비 대기: 출력이 한 번이라도 오고, 그 뒤 조용해지면 프롬프트가 선 것이다.
	ready := time.Now().Add(doctorReadyWait)
	for time.Now().Before(ready) {
		if _, n, quiet := snapshot(); n > 0 && quiet > doctorQuietFor {
			break
		}
		select {
		case err := <-readErr:
			got, _, _ := snapshot()
			return got, fmt.Errorf("셸이 준비되기 전에 끊겼다: %w", err)
		case <-time.After(100 * time.Millisecond):
		}
	}

	if _, err := term.Write([]byte(input)); err != nil {
		got, _, _ := snapshot()
		return got, fmt.Errorf("입력 쓰기: %w", err)
	}

	select {
	case <-found:
		got, _, _ := snapshot()
		return got, nil
	case err := <-readErr:
		got, _, _ := snapshot()
		return got, err
	case <-time.After(limit):
		got, _, _ := snapshot()
		return got, fmt.Errorf("%s 안에 응답이 없습니다", limit)
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

// ── 도구 계층 ────────────────────────────────────────

// doctorTool 은 **서버가 도구를 만들 때와 같은 경로**를 밟는다. doctorTerminal
// 은 생 PTY 만 보므로, 그 위의 환경 조립·훅 주입·출력 스트림에서 깨지면 잡지
// 못한다. 실제 터미널은 이 경로를 지난다.
func doctorTool(r *doctorReport, home string) {
	r.section("도구 (toolhub)")

	// StartTool 은 DONGMINAL_HOME 아래 bin 을 셸 환경에 심는다.
	os.Setenv("DONGMINAL_HOME", home)

	// ToolManager 를 쓰는 이유는 이것이 서버가 부르는 바로 그 경로이기
	// 때문이다 (httpapi 의 도구 생성 → ToolManager.Create).
	dataDir := filepath.Join(home, "doctor-tools")
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		r.bad("검사용 디렉터리를 만들지 못했습니다: %v", err)
		return
	}
	defer os.RemoveAll(dataDir)

	m := toolhub.NewToolManager(dataDir, nil)
	tool, err := m.Create(home, doctorProbeCols, doctorProbeRows)
	if err != nil {
		r.bad("도구 기동 실패: %v", err)
		return
	}
	defer m.Delete(tool.ID)
	r.ok("도구 기동 pid=%d", tool.CmdProcessPID())

	const marker = "dongminal-tool-ok"
	// 셸이 프롬프트를 그릴 때까지 기다린다 (doctorRoundTrip 의 사정과 같다).
	time.Sleep(3 * time.Second)
	if err := tool.Write([]byte("echo " + marker + "\r")); err != nil {
		r.bad("입력 실패: %v", err)
		return
	}

	deadline := time.Now().Add(doctorProbeTimeout)
	for time.Now().Before(deadline) {
		blob, _ := tool.Stream().Snapshot()
		if strings.Contains(string(blob), marker) {
			r.ok("입출력 왕복 (출력 %d바이트)", len(blob))
			return
		}
		if m.Get(tool.ID) == nil {
			r.bad("도구가 곧바로 사라졌습니다 — 셸이 뜨자마자 죽습니다")
			r.info("그때까지 받은 것: %q", doctorTrim(string(blob)))
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	blob, _ := tool.Stream().Snapshot()
	if len(blob) == 0 {
		r.bad("출력이 한 바이트도 오지 않았습니다 — 화면이 비는 증상 그대로입니다")
	} else {
		r.bad("표시를 못 봤습니다 (출력 %d바이트)", len(blob))
		r.info("받은 것: %q", doctorTrim(string(blob)))
	}
}

// ── 콘솔 없는 조건 ───────────────────────────────────

// doctorDetached 는 자기 자신을 **서버와 같은 방식으로** 띄워 의사 터미널을
// 확인한다.
//
// doctor 는 콘솔이 있는 상태로 돌지만 서버는 Process.Detach 로 떠서 콘솔이
// 없다. Windows 의 의사 터미널이 그 차이에 영향을 받는지는 여기서만 드러난다 —
// doctor 가 통과하는데 실제 터미널이 비는 상황의 유일하게 남는 변수다.
func doctorDetached(r *doctorReport, p platform.Platform, home string) {
	r.section("콘솔 없는 프로세스에서의 의사 터미널")

	exe, err := os.Executable()
	if err != nil {
		r.bad("실행 파일 경로 확인 실패: %v", err)
		return
	}
	out := filepath.Join(home, "doctor-probe.txt")
	_ = os.Remove(out)

	r.info("서버와 같은 방식으로 자식을 띄우고 최대 %s 기다립니다...", doctorDetachedWait)
	cmd := exec.Command(exe, "doctor", "--home", home, "--probe-pty", out)
	cmd.Env = os.Environ()
	// 서버·데몬과 똑같이 부모와 끊어 띄운다.
	p.Process.Detach(cmd)
	if err := cmd.Start(); err != nil {
		r.bad("프로브 기동 실패: %v", err)
		return
	}

	deadline := time.Now().Add(doctorDetachedWait)
	for time.Now().Before(deadline) {
		if blob, err := os.ReadFile(out); err == nil && len(blob) > 0 {
			_ = os.Remove(out)
			text := strings.TrimSpace(string(blob))
			if strings.HasPrefix(text, "OK") {
				r.ok("콘솔 없이도 동작합니다")
			} else {
				r.bad("콘솔 없는 프로세스에서 실패합니다 — 서버의 조건입니다")
				for _, line := range strings.Split(text, "\n") {
					if line != "" {
						r.info("%s", line)
					}
				}
			}
			return
		}
		time.Sleep(200 * time.Millisecond)
	}
	// 결과 파일조차 없으면 자식이 결과를 쓰기 전에 막힌 것이다. 콘솔 없는
	// 프로세스에서 의사 터미널의 읽기가 돌아오지 않는 경우가 여기 해당한다.
	_ = cmd.Process.Kill()
	r.bad("콘솔 없는 프로세스에서 %s 안에 결과가 나오지 않았습니다 — 서버의 조건입니다", doctorDetachedWait)
	r.info("프로브 출력 자리: %s", out)
}

// runPTYProbe 는 --probe-pty 모드다. 의사 터미널을 띄워 왕복시키고 결과를
// path 에 적는다. 콘솔이 없으므로 화면에 적을 자리가 없다 — 그래서 파일이다.
func runPTYProbe(path string, p platform.Platform, home string) int {
	var b strings.Builder
	spec := p.Shell.Shell(filepath.Join(home, "bin"))

	term, err := p.PTY.Start(platform.ProcSpec{
		Path: spec.Path,
		Args: append([]string{spec.Path}, spec.Args...),
		Env:  append(os.Environ(), spec.Env...),
		Dir:  home,
	}, doctorProbeCols, doctorProbeRows)
	if err != nil {
		fmt.Fprintf(&b, "FAIL 터미널 기동: %v\n", err)
		_ = os.WriteFile(path, []byte(b.String()), 0o644)
		return 1
	}
	defer func() {
		term.Kill()
		term.Close()
	}()

	const marker = "dongminal-detached-ok"
	got, rerr := doctorRoundTrip(term, "echo "+marker+"\r", marker, doctorProbeTimeout)
	switch {
	case rerr != nil:
		fmt.Fprintf(&b, "FAIL 출력 읽기: %v (받은 바이트 %d)\n", rerr, len(got))
		fmt.Fprintf(&b, "받은 것: %q\n", doctorTrim(got))
	case !strings.Contains(got, marker):
		fmt.Fprintf(&b, "FAIL 왕복 실패 (받은 바이트 %d)\n", len(got))
		fmt.Fprintf(&b, "받은 것: %q\n", doctorTrim(got))
	default:
		fmt.Fprintf(&b, "OK pid=%d 받은 바이트 %d\n", term.PID(), len(got))
	}
	_ = os.WriteFile(path, []byte(b.String()), 0o644)
	if strings.HasPrefix(b.String(), "OK") {
		return 0
	}
	return 1
}
