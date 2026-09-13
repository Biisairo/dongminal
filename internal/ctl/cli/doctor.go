package cli

import (
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"strings"
	"time"

	"dongminal/internal/shared/dmenv"
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

// RunDoctor 는 `dongminal doctor` 다.
func RunDoctor(o DoctorOpts, stdout, stderr io.Writer) int {
	home, err := o.ResolveHome()
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	p := platform.Current()

	// `G2-3`: 번들 모드. 진단을 **대체하지 않고** 따로 선다 — 사람이 읽는 진단과
	// 신고에 붙이는 번들은 담는 것도 형식도 다르다.
	if o.Bundle != "" {
		return RunDoctorBundle(o, stdout, stderr)
	}

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

	r := &checkReport{out: stdout}
	fmt.Fprintf(stdout, "dongminal doctor — platform=%s\n", p.OS)

	// HELPER_INSTALL_SRS FR-HLI-5: **운영 홈의 bin 에 설치하지 않는다.**
	// 종전에는 검사를 위해 거기에 실제로 설치했고, 그 경로로 사고가 났다
	// (§2.5) — `go run` 으로 부르면 사라질 경로를 가리키는 링크가 운영 홈에
	// 남는다. 계층이 도는지는 임시 자리에서 물어도 답이 같다.
	probeBin, cleanup, err := doctorProbeBin()
	if err != nil {
		r.bad("검사용 임시 bin 을 만들지 못했습니다: %v", err)
		probeBin = filepath.Join(home, "bin")
	}
	defer cleanup()
	for _, c := range doctorChecks(p, home, probeBin) {
		c.run(r)
	}

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

// doctorCheck 는 진단 항목 하나다. name 은 표의 이름이고 run 이 보고서에 적는다.
type doctorCheck struct {
	name string
	run  func(*checkReport)
}

// doctorChecks 는 진단의 표다 (M8 D-A-11). **순서가 계약이다** — 설치가 헬퍼·
// 셸·터미널의 전제이고, 터미널이 뜨는지를 본 뒤에야 콘솔 없는 자식·IPC 를 묻는다.
// probeBin 은 설치 계층을 시험할 임시 자리(FR-HLI-5)이고, 운영 홈의 bin 은
// 검사만 한다(FR-HLI-8).
func doctorChecks(p platform.Platform, home, probeBin string) []doctorCheck {
	return []doctorCheck{
		{"환경", func(r *checkReport) { doctorEnvironment(r, p, home) }},
		{"설치", func(r *checkReport) { doctorInstall(r, p, home, probeBin) }},
		{"설치된 헬퍼", func(r *checkReport) { doctorHelpers(r, filepath.Join(home, "bin")) }},
		{"셸", func(r *checkReport) { doctorShell(r, p, probeBin) }},
		{"터미널", func(r *checkReport) { doctorTerminal(r, p, probeBin, home) }},
		{"도구", func(r *checkReport) { doctorTool(r, home) }},
		{"콘솔 없는 자식", func(r *checkReport) { doctorDetached(r, p, home) }},
		{"IPC", func(r *checkReport) { doctorIPC(r, p, home) }},
		{"프로세스", func(r *checkReport) { doctorProcess(r, p) }},
	}
}

func doctorEnvironment(r *checkReport, p platform.Platform, home string) {
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

// doctorProbeBin 은 설치 계층을 시험할 임시 자리다. 끝나면 지운다 —
// 진단은 자국을 남기지 않는다 (FR-HLI-5).
func doctorProbeBin() (string, func(), error) {
	dir, err := os.MkdirTemp("", "dongminal-doctor-")
	if err != nil {
		return "", func() {}, err
	}
	return filepath.Join(dir, "bin"), func() { _ = os.RemoveAll(dir) }, nil
}

// doctorHelpers 는 **운영 홈**에 설치된 헬퍼가 실제로 실행 가능한지 본다
// (FR-HLI-8). 고치지 않는다 — 고치는 것은 기동의 몫이고, 진단이 대상을 바꾸면
// 무엇이 원래 상태였는지 알 수 없게 된다 (D-4).
func doctorHelpers(r *checkReport, binDir string) {
	r.section("설치된 헬퍼 (" + binDir + ")")
	st := runtime.InspectHelpers(binDir)
	// FR-HLI-11: 설치된 적 없는 홈은 고장이 아니다. doctor 는 더 이상 이 자리에
	// 설치하지 않으므로(FR-HLI-5), 없는 것을 실패로 세면 새 기계의 진단이 언제나
	// 실패한다.
	if !st.Installed {
		r.info("%s", runtime.HelperNotInstalled)
		return
	}
	if len(st.Problems) == 0 {
		r.ok("헬퍼 전부 실행 가능")
		return
	}
	for _, b := range st.Problems {
		r.bad("%s — %s", b.Path, b.Reason)
	}
	r.info("%s", runtime.HelperFixHint)
}

// doctorInstall 은 헬퍼와 셸 훅을 실제로 설치해 본다. 훅이 없으면 셸이 없는
// 스크립트를 받아 즉시 죽고, 그것이 "터미널이 비어 보이는" 증상이 된다.
func doctorInstall(r *checkReport, p platform.Platform, home, binDir string) {
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
	// 환경변수로 거는 셸은 zsh 뿐이다. bash 는 인자(`--rcfile`)로 걸리며 위
	// 루프가 이미 그것을 본다 (HOST_PARITY_SRS FR-HPR-7).
	for _, kv := range spec.Env {
		k, v, ok := strings.Cut(kv, "=")
		if !ok || k != "ZDOTDIR" {
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

func doctorShell(r *checkReport, p platform.Platform, binDir string) {
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
func doctorTerminal(r *checkReport, p platform.Platform, binDir, home string) {
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

func doctorIPC(r *checkReport, p platform.Platform, home string) {
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
func doctorProcess(r *checkReport, p platform.Platform) {
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
func doctorTool(r *checkReport, home string) {
	r.section("도구 (toolhub)")

	// StartTool 은 DONGMINAL_HOME 아래 bin 을 셸 환경에 심는다.
	os.Setenv(dmenv.EnvHome, home)

	// ToolManager 를 쓰는 이유는 이것이 서버가 부르는 바로 그 경로이기
	// 때문이다 (httpapi 의 도구 생성 → ToolManager.Create).
	dataDir := filepath.Join(home, "doctor-tools")
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		r.bad("검사용 디렉터리를 만들지 못했습니다: %v", err)
		return
	}
	defer os.RemoveAll(dataDir)

	m := toolhub.NewToolManager(dataDir, nil)
	tool, err := m.Create(home, doctorProbeCols, doctorProbeRows, toolhub.Placement{})
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
