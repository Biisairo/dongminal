package toolhub

import (
	"errors"
	"fmt"
	"os/exec"
	"time"

	"dongminal/internal/shared/dmlog"
	"dongminal/internal/shared/platform"

	"github.com/gorilla/websocket"
)

// kill transitions the tool to exited exactly once: it marks exited under
// cmu, fans out a final OpExit to the clients that were registered at that
// moment (outside cmu), then tears down the PTY/process and stream.
//
// terminateWait 는 프로세스에 정중한 종료(SIGTERM)를 청하고 grace 안에 끝나기를
// 기다린다 (FR-BGK-7). 강제 종료는 하지 않는다 — 그것은 kill() 의 몫이다. 유예는
// 상한이지 대기 시간이 아니다: 먼저 끝나면 그 자리에서 돌아온다. 프로세스가 없는
// 합성 Tool 에서는 할 일이 없고, 무엇보다 매달리지 않는다 (done 이 nil 이다).
func (p *Tool) terminateWait(grace time.Duration) {
	pid := p.CmdProcessPID()
	if pid <= 0 {
		return
	}
	if err := platform.Current().Process.Terminate(pid); err != nil {
		return
	}
	timer := time.NewTimer(grace)
	defer timer.Stop()
	select {
	case <-p.Wait():
	case <-timer.C:
	}
}

// terminateGrace 는 정중한 종료 요청(Terminate)과 강제 종료(Kill) 사이의 유예다
// (M8 `GO-40`). HTTP Delete 가 이 길을 동기로 지나므로 짧다 — 백그라운드 도구의
// 3초 유예는 위층(`httpapi` 의 `toolKillGrace`)이 따로 든다 (FR-BGK-7).
const terminateGrace = 50 * time.Millisecond

// kill is race-free by design:
//   - sync.Once guarantees the body executes at most once, even when the
//     readPTY goroutine calls kill() on EOF while an external caller (API
//     handler, watchdog) concurrently calls kill().
//   - The once.Do body is self-contained: it snapshots the client list
//     under cmu, broadcasts outside cmu (avoiding deadlock with addClient),
//     then tears down resources (ptmx, cmd, stream). No call from inside
//     the once body re-enters kill() or readPTY.
//   - Closing p.done inside once.Do safely unblocks any Wait() readers;
//     the close is also idempotent under the Once guard.
//   - The onExit callback is NOT invoked here — it was moved to readPTY
//     (which is the sole caller after EOF) to avoid re-entrancy issues.
func (p *Tool) kill() {
	p.once.Do(func() {
		// Phase 1: atomic mark + snapshot under cmu.
		p.cmu.Lock()
		p.exited = true
		snap := make([]*SafeConn, len(p.cls))
		copy(snap, p.cls)
		p.cmu.Unlock()

		// Phase 2: final OpExit broadcast outside cmu. Errors are ignored —
		// the tool is dying anyway and clients will close on their side.
		exitMsg := []byte{OpExit}
		for _, c := range snap {
			_ = c.WriteMsg(websocket.BinaryMessage, exitMsg)
		}

		// Phase 3: tear down PTY/process/stream.
		pid := p.CmdProcessPID()
		dmlog.Infof(nil, "[tool %s] killing pid=%d", p.ID, pid)
		// NewDetachedTool 로 만든 Tool 은 done 이 nil 이다 (PTY 도 프로세스도 없는
		// 합성 Tool — 데몬 모드의 원격 도구 대리와 테스트가 쓴다). 무조건 닫으면
		// close(nil chan) 으로 패닉한다. 아래 ptmx·cmd·stream 이 이미 같은 방어를
		// 하고 있었고 이 줄만 빠져 있었다.
		if p.done != nil {
			close(p.done)
		}
		if p.term != nil {
			p.tmu.Lock()
			p.termClosed = true
			p.term.Close()
			p.tmu.Unlock()
			// 순서와 유예는 종전과 같다 — 정중히 요청, 유예, 강제 종료, 수확.
			// 유예는 채널로 기다린다 (M8 `GO-12`): 프로세스가 먼저 끝나면 그 자리에서
			// 수확하고, 유예가 다 되면 강제 종료한 뒤 수확한다. HTTP Delete 경로가
			// 이 함수를 동기로 지나므로 죽은 프로세스 앞에서 자지 않는다.
			p.term.Terminate()
			waited := make(chan error, 1)
			go func() { waited <- p.term.Wait() }()
			grace := time.NewTimer(terminateGrace)
			var werr error
			select {
			case werr = <-waited:
				grace.Stop()
			case <-grace.C:
				p.term.Kill()
				werr = <-waited
			}
			if werr != nil {
				dmlog.Infof(nil, "[tool %s] wait: %v", p.ID, werr)
				var ee *exec.ExitError
				if errors.As(werr, &ee) {
					p.exitCode.Store(int32(ee.ExitCode()))
				} else {
					p.exitCode.Store(-1)
				}
			}
		}
		if p.stream != nil {
			p.stream.Close()
		}
		// tool 종료 → 활동 카드 제거(셸 exit/Ctrl+C 등, SessionEnd hook 없이도).
		if p.activity.Load() != nil {
			p.SetActivity("ended", "", "")
		}
		// FR-ATL-1·2 (NFR-PAN-8): 주의도 같은 자리에서 내린다. 활동만 정리하고
		// 주의를 남겨 두었던 것이, 닫은 탭의 알람이 배지에 남던 원인이다.
		// disarm 까지 하는 이유는 Attend 와 같다 — 죽은 도구가 idle 로 다시
		// 깨어나면 안 된다. FR-ATF-7: 상태를 버리는 자리가 재무장 잠금도 함께
		// 버린다.
		p.attnArmed.Store(false)
		p.attnRearmLocked.Store(false)
		p.clearAttention()
	})
}

// Write sends data to the PTY master. Safe to call from any goroutine.
func (p *Tool) Write(data []byte) error {
	if p.term == nil {
		return fmt.Errorf("tool %s: 터미널이 없다", p.ID)
	}
	_, err := p.term.Write(data)
	return err
}

// Resize is the exported wrapper around the unexported resize for
// ToolManager delegation. It calls pty.Setsize on the PTY master.
func (p *Tool) Resize(cols, rows uint16) error {
	return p.resize(cols, rows)
}

func (p *Tool) resize(c, r uint16) error {
	if p.term == nil {
		return fmt.Errorf("tool %s: 터미널이 없다", p.ID)
	}
	p.tmu.Lock()
	defer p.tmu.Unlock()
	// 이미 닫힌 터미널의 크기를 고치는 것은 오류이지 경쟁이 아니다. 사라지는
	// 도구에 늦게 도착한 요청은 정상적으로 일어난다 — 거절하고 끝낸다.
	if p.termClosed {
		return fmt.Errorf("tool %s: 터미널이 닫혔다", p.ID)
	}
	err := p.term.Resize(c, r)
	if err != nil {
		dmlog.Errorf(nil, "[tool %s] resize error cols=%d rows=%d: %v", p.ID, c, r, err)
	}
	return err
}
