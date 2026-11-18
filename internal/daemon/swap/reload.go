package swap

import (
	"fmt"
	"os"
	"runtime"
	"strconv"
	"time"

	"dongminal/internal/daemon/ipc"
	"dongminal/internal/shared/dmlog"
	"dongminal/internal/shared/handover"
	"dongminal/internal/shared/platform"
	"dongminal/internal/shared/toolhub"
)

// PreflightWithin 은 사전 확인의 시한이다 (FR-DSK-12).
const PreflightWithin = 5 * time.Second

// Deps 는 교체기가 기대는 것이다. Exec·Preflight 는 시험이 갈아 끼운다.
type Deps struct {
	Home      string
	Tools     *toolhub.ToolManager
	Server    *ipc.PanedServer
	Env       Env
	Preflight func(exe string) error
	// Exec 는 프로세스를 exe 로 갈아 끼운다. 성공하면 돌아오지 않는다.
	Exec func(exe string, argv, env []string) error
}

// Reloader 는 보고 소켓의 교체 요청을 처리한다 (FR-DSK-11~13).
type Reloader struct {
	d    Deps
	gate Gate
}

// New 는 교체기를 만든다. 비운 Preflight 는 실제 사전 확인이다.
func New(d Deps) *Reloader {
	if d.Preflight == nil {
		d.Preflight = func(exe string) error { return Preflight(exe, PreflightWithin) }
	}
	return &Reloader{d: d}
}

// prepared 는 commit 직전까지 마친 교체다. 실패하면 rollback 이 모두 되돌린다.
type prepared struct {
	r      *Reloader
	exe    string
	state  *os.File
	paned  *os.File
	report *os.File
	fds    []uintptr
}

// Reload 는 검사·사전 확인·멈춤·담기·쓰기를 마치고 commit 을 돌려준다 (FR-DSK-13 1~5).
// 실패하면 아무것도 바뀌지 않는다.
func (r *Reloader) Reload(req handover.ReloadRequest) (func(), error) {
	if !r.gate.Enter() {
		return nil, refuse(handover.ReasonBusy, "다른 교체가 진행 중입니다")
	}
	if err := Validate(req, r.d.Env); err != nil {
		r.gate.Leave()
		return nil, err
	}
	if err := r.d.Preflight(r.d.Env.SelfExe); err != nil {
		r.gate.Leave()
		return nil, err
	}
	// 검사를 통과한 요청 경로가 아니라 고정된 자기 경로를 실행한다.
	p, err := r.prepare(r.d.Env.SelfExe)
	if err != nil {
		r.gate.Leave()
		return nil, err
	}
	return p.commit, nil
}

func (r *Reloader) prepare(exe string) (*prepared, error) {
	if !r.d.Tools.FreezeAll() {
		return nil, refuse(handover.ReasonState, "도구를 멈추지 못했습니다")
	}
	p := &prepared{r: r, exe: exe}
	fail := func(format string, args ...any) (*prepared, error) {
		p.release()
		r.d.Tools.ThawAll()
		return nil, refuse(handover.ReasonState, format, args...)
	}
	// 인계 상태를 잃어도 셸을 pid 로 알아보도록 tools.json 을 지금 쓴다 (FR-DSK-27).
	r.d.Tools.SaveAll()
	tools, err := r.d.Tools.ExportHandover()
	if err != nil {
		return fail("%v", err)
	}
	if p.paned, p.report, err = r.d.Server.ListenerFiles(); err != nil {
		return fail("%v", err)
	}
	st := State{
		Version: handover.Version, Tools: tools, Global: r.d.Server.ExportGlobal(),
		PanedFD: p.paned.Fd(), ReportFD: p.report.Fd(),
	}
	if p.state, err = WriteState(r.d.Home, st); err != nil {
		return fail("%v", err)
	}
	for _, t := range tools {
		p.fds = append(p.fds, t.FD)
	}
	p.fds = append(p.fds, p.paned.Fd(), p.report.Fd(), p.state.Fd())
	return p, nil
}

// commit 은 넘길 fd 의 close-on-exec 를 지우고 exec 한다 (FR-DSK-13 5·7). 성공하면 돌아오지
// 않는다. 실패하면 모두 되돌린다 — 보고 연결에는 이미 성공을 답했으므로 `start` 가 확인으로
// 알아챈다 (FR-DSK-17).
func (p *prepared) commit() {
	r := p.r
	for _, fd := range p.fds {
		if err := platform.SetCloseOnExec(fd, false); err != nil {
			p.rollback(fmt.Errorf("fd %d close-on-exec 해제: %w", fd, err))
			return
		}
	}
	argv := []string{p.exe, "d", handover.ArgFD, strconv.Itoa(int(p.state.Fd()))}
	dmlog.Infof(nil, "dongminald 교체 exec %s (도구 %d개)", p.exe, len(p.fds)-3)
	err := r.d.Exec(p.exe, argv, os.Environ())
	runtime.KeepAlive(p)
	p.rollback(fmt.Errorf("exec: %w", err))
}

func (p *prepared) rollback(cause error) {
	dmlog.Errorf(nil, "dongminald 교체 실패 — 되돌린다: %v", cause)
	for _, fd := range p.fds {
		_ = platform.SetCloseOnExec(fd, true)
	}
	p.release()
	p.r.d.Tools.ThawAll()
	p.r.gate.Leave()
}

// release 는 교체를 위해 연 파일을 닫는다. 도구 fd 는 도구의 것이므로 닫지 않는다.
func (p *prepared) release() {
	for _, f := range []*os.File{p.state, p.paned, p.report} {
		if f != nil {
			f.Close()
		}
	}
}
