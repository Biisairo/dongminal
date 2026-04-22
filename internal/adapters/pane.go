// Package adapters는 internal/{server,workspace} 의 구체 타입을
// internal/mcptool 인터페이스로 브리지하는 어댑터들을 모은다.
// main 패키지에서 쓰이던 wiring 코드를 한 곳으로 정리한다.
package adapters

import (
	"fmt"
	"time"

	"dongminal/internal/mcptool"
	"dongminal/internal/server"

	"github.com/creack/pty"
)

// Pane은 server.PaneManager 를 mcptool.PaneReader 로 어댑트한다.
type Pane struct{ PM *server.PaneManager }

func (a Pane) List() []mcptool.PaneInfo {
	panes := a.PM.Snapshot()
	out := make([]mcptool.PaneInfo, 0, len(panes))
	for _, p := range panes {
		out = append(out, mcptool.PaneInfo{ID: p.ID, Name: p.Name, ShellPID: p.CmdProcessPID()})
	}
	return out
}

func (a Pane) Has(id string) bool { return a.PM.Get(id) != nil }

func (a Pane) Snapshot(id string) ([]byte, int64, bool) {
	p := a.PM.Get(id)
	if p == nil || p.Stream() == nil {
		return nil, 0, false
	}
	data, stats := p.Stream().Snapshot()
	return data, stats.TotalBytesDrop, true
}

func (a Pane) Size(id string) string {
	p := a.PM.Get(id)
	if p == nil || p.PTMX() == nil {
		return "?"
	}
	rows, cols, err := pty.Getsize(p.PTMX())
	if err != nil {
		return "?"
	}
	return fmt.Sprintf("%dx%d", cols, rows)
}

func (a Pane) SendPaste(id string, text []byte, submit bool) error {
	p := a.PM.Get(id)
	if p == nil || p.PTMX() == nil {
		return fmt.Errorf("pane 없음: %s", id)
	}
	var paste []byte
	paste = append(paste, 0x1b, '[', '2', '0', '0', '~')
	paste = append(paste, text...)
	paste = append(paste, 0x1b, '[', '2', '0', '1', '~')
	if _, err := p.PTMX().Write(paste); err != nil {
		return fmt.Errorf("ptmx write (paste): %w", err)
	}
	if submit {
		time.Sleep(120 * time.Millisecond)
		if _, err := p.PTMX().Write([]byte{'\r'}); err != nil {
			return fmt.Errorf("ptmx write (submit): %w", err)
		}
	}
	return nil
}
