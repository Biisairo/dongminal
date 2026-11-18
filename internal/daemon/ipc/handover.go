package ipc

import (
	"encoding/json"
	"errors"
	"net"
	"os"
	"strconv"

	"dongminal/internal/shared/dmlog"
)

// 데몬 교체의 소켓·기록 인계 (DAEMON_SESSION_KEEP_SRS FR-DSK-14·23·24).

// fileListener 는 리스너를 fd 로 꺼낼 수 있다는 뜻이다 (*net.UnixListener).
type fileListener interface {
	File() (*os.File, error)
}

// ListenerFiles 는 paned.sock·보고 소켓 리스너의 복제 fd 다. exec 로 넘긴다.
func (ps *PanedServer) ListenerFiles() (paned, report *os.File, err error) {
	ps.mu.Lock()
	pl, rl := ps.listener, ps.reportLn
	ps.mu.Unlock()
	pfl, ok1 := pl.(fileListener)
	rfl, ok2 := rl.(fileListener)
	if !ok1 || !ok2 {
		return nil, nil, errors.New("리스너를 fd 로 꺼낼 수 없다")
	}
	if paned, err = pfl.File(); err != nil {
		return nil, nil, err
	}
	if report, err = rfl.File(); err != nil {
		paned.Close()
		return nil, nil, err
	}
	return paned, report, nil
}

// ListenInherited 는 넘겨받은 두 리스너로 Listen·ListenReports 를 대신한다. 소켓 파일은
// 다시 만들지 않는다 — 교체 동안에도 같은 소켓이 연결을 받는다 (FR-DSK-24). pidfile 과
// 데몬 지문은 Listen 과 같이 쓴다 (FR-DSK-25).
func (ps *PanedServer) ListenInherited(paned, report net.Listener, reportPath string) {
	ps.mu.Lock()
	ps.listener = paned
	ps.reportLn, ps.reportPath = report, reportPath
	ps.mu.Unlock()
	if ps.pidPath != "" {
		if err := os.WriteFile(ps.pidPath, []byte(strconv.Itoa(os.Getpid())+"\n"), 0o600); err != nil {
			dmlog.Errorf(nil, "paned: pidfile 쓰기 실패 %s: %v", ps.pidPath, err)
		}
	}
	ps.recordDaemonBuild()
}

// ExportGlobal 은 데몬 전체 기록이다.
func (ps *PanedServer) ExportGlobal() map[string]json.RawMessage { return ps.records.snapshot() }

// ImportGlobal 은 넘겨받은 데몬 전체 기록을 되넣는다.
func (ps *PanedServer) ImportGlobal(m map[string]json.RawMessage) {
	for kind, v := range m {
		ps.records.set(kind, v)
	}
}
