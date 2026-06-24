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
// PM이 nil이면 (daemon mode) PaneHub 를 사용한다.
type Pane struct {
	PM  *server.PaneManager
	Hub server.PaneHub
}

func (a Pane) getPane(id string) *server.Pane {
	if a.PM != nil {
		return a.PM.Get(id)
	}
	if a.Hub != nil {
		return a.Hub.Get(id)
	}
	return nil
}

func (a Pane) listPanes() []*server.Pane {
	if a.PM != nil {
		return a.PM.Snapshot()
	}
	// PaneHub doesn't have Snapshot; build from List
	var out []*server.Pane
	if a.Hub != nil {
		for _, m := range a.Hub.List() {
			id, _ := m["id"].(string)
			name, _ := m["name"].(string)
			out = append(out, &server.Pane{ID: id, Name: name})
		}
	}
	return out
}

func (a Pane) List() []mcptool.PaneInfo {
	// Daemon mode: read the shell PID directly from the hub's list payload.
	// Synthetic Panes built in listPanes() have no os/exec handle, so
	// CmdProcessPID() would return 0 and break whoami PID matching (FR-16).
	if a.PM == nil && a.Hub != nil {
		maps := a.Hub.List()
		out := make([]mcptool.PaneInfo, 0, len(maps))
		for _, m := range maps {
			id, _ := m["id"].(string)
			name, _ := m["name"].(string)
			out = append(out, mcptool.PaneInfo{ID: id, Name: name, ShellPID: mapInt(m["pid"])})
		}
		return out
	}
	panes := a.listPanes()
	out := make([]mcptool.PaneInfo, 0, len(panes))
	for _, p := range panes {
		out = append(out, mcptool.PaneInfo{ID: p.ID, Name: p.Name, ShellPID: p.CmdProcessPID()})
	}
	return out
}

// mapInt coerces a JSON-decoded numeric (float64) or native int to int.
func mapInt(v interface{}) int {
	switch n := v.(type) {
	case int:
		return n
	case int64:
		return int(n)
	case float64:
		return int(n)
	}
	return 0
}

func (a Pane) Has(id string) bool {
	if a.PM != nil {
		return a.PM.Get(id) != nil
	}
	if a.Hub != nil {
		return a.Hub.Get(id) != nil
	}
	return false
}

func (a Pane) Snapshot(id string) ([]byte, int64, bool) {
	if a.PM != nil {
		p := a.PM.Get(id)
		if p == nil || p.Stream() == nil {
			return nil, 0, false
		}
		data, stats := p.Stream().Snapshot()
		return data, stats.TotalBytesDrop, true
	}
	if a.Hub != nil {
		snap, err := a.Hub.SnapshotPane(id)
		if err != nil {
			return nil, 0, false
		}
		return snap.Data, snap.TotalBytesDrop, true
	}
	return nil, 0, false
}

func (a Pane) Size(id string) string {
	if a.PM != nil {
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
	// Daemon mode: PaneHub doesn't expose PTMX; use List for cols/rows.
	// JSON numbers decode as float64, so coerce via mapInt.
	if a.Hub != nil {
		for _, m := range a.Hub.List() {
			if mid, _ := m["id"].(string); mid == id {
				cols := mapInt(m["sizeCols"])
				rows := mapInt(m["sizeRows"])
				if cols > 0 && rows > 0 {
					return fmt.Sprintf("%dx%d", cols, rows)
				}
			}
		}
	}
	return "?"
}

func (a Pane) SendPaste(id string, text []byte, submit bool) error {
	if a.PM != nil {
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
	// Daemon mode: use PaneHub.Write
	if a.Hub != nil {
		var paste []byte
		paste = append(paste, 0x1b, '[', '2', '0', '0', '~')
		paste = append(paste, text...)
		paste = append(paste, 0x1b, '[', '2', '0', '1', '~')
		if err := a.Hub.Write(id, paste); err != nil {
			return fmt.Errorf("write (paste): %w", err)
		}
		if submit {
			time.Sleep(120 * time.Millisecond)
			if err := a.Hub.Write(id, []byte{'\r'}); err != nil {
				return fmt.Errorf("write (submit): %w", err)
			}
		}
		return nil
	}
	return fmt.Errorf("pane 없음: %s", id)
}
