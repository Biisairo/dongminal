package cli

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"dongminal/internal/shared/platform"
)

// doctor 의 프로브 — 의사 터미널 왕복과 콘솔 없는 자식. 진단 표(doctor.go)가
// 부른다 (M8 GO-20, D-A-10).

// doctorProbePlainCommand 는 **입력 없이** 한 줄을 출력하고 끝나는 명령을
// 의사 터미널에 띄운다. 셸·프롬프트·입력 타이밍이 모두 빠지므로, 실패하면
// 원인은 의사 터미널의 배관 그 자체다.
func doctorProbePlainCommand(r *checkReport, p platform.Platform, home string) {
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

	// 읽기는 goroutine 에 맡긴다. 자식이 끝나도 의사 콘솔이 파이프를 열어
	// 두는 플랫폼(Windows)에서는 Read 가 돌아오지 않아, 그냥 반복하면 상한을
	// 검사할 기회조차 없다.
	got, rerr := doctorRoundTrip(term, "", marker, doctorProbeTimeout)
	if strings.Contains(got, marker) {
		r.ok("[단순 명령] 출력이 의사 터미널로 나옵니다")
		return
	}
	r.bad("[단순 명령] 출력이 의사 터미널로 나오지 않습니다 (받은 %d바이트) — 배관 문제입니다", len(got))
	if rerr != nil {
		r.info("읽기: %v", rerr)
	}
	r.info("받은 것: %q", doctorTrim(got))
}

// doctorProbeTerminal 은 명세 하나로 터미널을 띄워 왕복시킨다.
func doctorProbeTerminal(r *checkReport, p platform.Platform, label string, spec platform.ShellSpec, home string) bool {
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
	// 입력이 없으면 기다릴 이유가 없다 — 바로 결과를 기다린다.
	ready := time.Now().Add(doctorReadyWait)
	for input != "" && time.Now().Before(ready) {
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

	// input 이 비면 쓸 것이 없다 — 스스로 출력하고 끝나는 명령을 볼 때다.
	if input != "" {
		if _, err := term.Write([]byte(input)); err != nil {
			got, _, _ := snapshot()
			return got, fmt.Errorf("입력 쓰기: %w", err)
		}
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

// doctorDetached 는 자기 자신을 **서버와 같은 방식으로** 띄워 의사 터미널을
// 확인한다.
//
// doctor 는 콘솔이 있는 상태로 돌지만 서버는 Process.Detach 로 떠서 콘솔이
// 없다. Windows 의 의사 터미널이 그 차이에 영향을 받는지는 여기서만 드러난다 —
// doctor 가 통과하는데 실제 터미널이 비는 상황의 유일하게 남는 변수다.
func doctorDetached(r *checkReport, p platform.Platform, home string) {
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
