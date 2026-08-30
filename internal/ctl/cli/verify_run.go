package cli

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"

	"dongminal/internal/shared/dmenv"
	"dongminal/internal/shared/platform"
)

// RunVerify 는 `dongminal verify` 다 (E2E_UNIFICATION_SRS FR-E2C-1).
//
// 순서가 안전의 일부다: **대상을 정하고 → 가드를 통과한 뒤에야** 무언가를 띄운다.
// 가드 전에는 아무 프로세스도 띄우지 않고 아무 디렉터리도 지우지 않는다 (FR-E2G-2).
func RunVerify(o VerifyOpts, stdout, stderr io.Writer) int {
	repo, err := verifyRepo(o.Repo)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}

	// 환경변수를 보지 않는다 — CI 가 다른 목적으로 DONGMINAL_HOME·PORT 를 세워
	// 두어도 검사는 격리 홈·빈 포트에서 돈다 (FR-E2C-4).
	home, port, err := resolveStartTarget(StartOpts{Isolated: true})
	if err != nil {
		fmt.Fprintf(stderr, "격리 대상 준비 실패: %v\n", err)
		return 1
	}
	if err := guardIsolated(home, port, userHomeDir()); err != nil {
		// 가드가 걸리면 대상을 비운 채 중단한다. 운영 인스턴스를 건드리느니
		// 검증을 못 하는 편이 낫다 (verify-isolated.sh 머리말).
		fmt.Fprintf(stderr, "❌ 격리 가드: %v\n", err)
		return 1
	}

	r := &checkReport{out: stdout}
	fmt.Fprintf(stdout, "dongminal verify — platform=%s\n", platform.Current().OS)

	r.section("격리 인스턴스 기동")
	host := dmenv.DefaultHost
	// 서버 로그도 격리 홈 안에 둔다 — 운영 인스턴스의 로그에 섞이지 않는다.
	cmd, logFile, serverLog, err := prepareServerCmd(home, host, port, filepath.Join(home, "server.log"))
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	defer logFile.Close()
	if err := cmd.Start(); err != nil {
		fmt.Fprintf(stderr, "기동 실패: %v\n", err)
		return 1
	}

	s := &verifySession{
		base: ServerURL(host, port),
		home: home,
		repo: repo,
		pid:  cmd.Process.Pid,
		caps: probeCaps(repo),
		http: newVerifyClient(),
	}
	// 무엇을 겨눴는지 로그만 보고 알 수 있어야 한다 (FR-E2R-6).
	r.info("대상 url=%s home=%s pid=%d repo=%s", s.base, s.home, s.pid, s.repo)
	defer cleanupVerify(home, port, s.pid, r)

	if !waitReady(s.base, verifyReadyTries, verifyReadyInterval) {
		r.bad("서버가 뜨지 않았다 — %s", s.base)
		return verifySummary(r, 0, stdout, home, serverLog)
	}
	r.ok("서버 준비됨")

	pass := runVerifyChecks(r, s)
	return verifySummary(r, pass, stdout, home, serverLog)
}

// runVerifyChecks 는 검사 표를 순서대로 돈다.
//
// **대상별 갈래가 하나도 없다** (FR-E2S-0/2). 건너뜀의 근거는 언제나 호스트 능력이나
// 선행 검사의 결과이지 OS 가 아니다.
func runVerifyChecks(r *checkReport, s *verifySession) int {
	pass := 0
	section := ""
	for _, c := range verifyChecks() {
		if c.Section != section {
			section = c.Section
			r.section(section)
		}
		if c.Need != nil {
			if ok, why := c.Need(s); !ok {
				r.skipped(c.Name, why)
				continue
			}
		}
		detail, err := c.Run(s)
		if err != nil {
			r.bad("%s — %v", c.Name, err)
			continue
		}
		if detail == "" {
			r.ok("%s", c.Name)
		} else {
			r.ok("%s — %s", c.Name, detail)
		}
		pass++
	}
	return pass
}

// verifySummary 는 요약을 찍고 종료 코드를 낸다. **건너뜀은 실패가 아니다**
// (FR-E2C-6).
func verifySummary(r *checkReport, pass int, stdout io.Writer, home, serverLog string) int {
	fmt.Fprintln(stdout, "\n────────────────────────────────────────")
	fmt.Fprintf(stdout, "통과 %d건 / 실패 %d건 / 건너뜀 %d건\n", pass, r.fail, r.skip)
	if r.fail == 0 {
		return 0
	}
	// 보고서가 길어 앞부분이 잘린 채 전달되는 일이 실제로 있었다 — 꼬리만 붙여도
	// 답이 실리도록 실패를 다시 모아 찍는다 (FR-E2R-3).
	fmt.Fprintln(stdout, "실패 항목:")
	for _, b := range r.bads {
		fmt.Fprintf(stdout, "  ❌ %s\n", b)
	}
	for _, l := range []struct{ name, path string }{
		{"데몬 로그", filepath.Join(home, "daemon.log")},
		{"서버 로그", serverLog},
	} {
		if t := tail(l.path, verifyLogTail); t != "" {
			fmt.Fprintf(stdout, "\n[%s] %s\n%s\n", l.name, l.path, t)
		}
	}
	return 1
}

// cleanupVerify 는 **우리가 띄운 것만** 치운다 (FR-E2G-3).
//
// killPort·`stop --all` 을 쓰지 않는다. stop 은 홈이 아니라 **포트**로 대상을
// 찾으므로, 그 경로를 쓰는 순간 기본 포트에서 도는 운영 인스턴스를 죽일 갈래가
// 생긴다 — 실제로 그 사고가 났다 (FR-E2G-4).
func cleanupVerify(home, port string, serverPID int, r *checkReport) {
	stopVerifyPID(serverPID)
	if dpid, alive := daemonPID(home); alive {
		stopVerifyPID(dpid)
	}
	// 지우기 **직전에** 이름 조건을 다시 확인한다 (FR-E2G-6).
	if err := guardIsolated(home, port, userHomeDir()); err != nil {
		r.info("격리 홈을 지우지 않았다 — %v", err)
		return
	}
	if err := os.RemoveAll(home); err != nil {
		// Windows 에서 핸들이 남아 실패할 수 있다. 검사 실패로 치지 않는다.
		r.info("격리 홈 삭제 실패 (무시): %v", err)
	}
}

// stopVerifyPID 는 정중히 요청하고, 유예 뒤에도 남아 있으면 끝낸다 (FR-E2G-5).
func stopVerifyPID(pid int) {
	p := procCtl()
	if pid <= 0 || !p.Alive(pid) {
		return
	}
	_ = p.Terminate(pid)
	deadline := time.Now().Add(verifyTermGrace)
	for time.Now().Before(deadline) {
		if !p.Alive(pid) {
			return
		}
		time.Sleep(verifyPollEvery)
	}
	_ = p.Kill(pid)
}

// verifyRepo 는 git 표면 검사의 대상을 절대경로로 정한다.
func verifyRepo(arg string) (string, error) {
	if arg == "" {
		wd, err := os.Getwd()
		if err != nil {
			return "", fmt.Errorf("현재 디렉터리 확인 실패: %w", err)
		}
		return wd, nil
	}
	abs, err := filepath.Abs(expandTilde(arg))
	if err != nil {
		return "", fmt.Errorf("--repo 경로 확인 실패: %w", err)
	}
	return abs, nil
}

// userHomeDir 는 가드가 "사용자 기본 홈" 을 알아보는 데 쓴다. 알아내지 못하면
// 빈 값이며, 그 조항만 건너뛴다.
func userHomeDir() string {
	h, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return h
}
