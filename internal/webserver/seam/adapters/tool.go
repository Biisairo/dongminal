// Package adapters는 internal/webserver/httpapi·internal/shared/workspace 의 구체
// 타입을 internal/webserver/seam/toolaccess 인터페이스로 브리지하는 어댑터들을 모은다.
// main 패키지에서 쓰이던 wiring 코드를 한 곳으로 정리한다.
package adapters

import (
	"dongminal/internal/shared/toolhub"

	"fmt"
	"time"

	"dongminal/internal/webserver/seam/toolaccess"

	"github.com/creack/pty"
)

// Tool은 toolhub.ToolManager 를 toolaccess.ToolReader 로 어댑트한다.
// PM이 nil이면 (daemon mode) ToolHub 를 사용한다.
type Tool struct {
	PM  *toolhub.ToolManager
	Hub toolhub.ToolHub
}

func (a Tool) listPanes() []*toolhub.Tool {
	if a.PM != nil {
		return a.PM.Snapshot()
	}
	// ToolHub doesn't have Snapshot; build from List
	var out []*toolhub.Tool
	if a.Hub != nil {
		for _, m := range a.Hub.List() {
			id, _ := m["id"].(string)
			name, _ := m["name"].(string)
			out = append(out, &toolhub.Tool{ID: id, Name: name})
		}
	}
	return out
}

func (a Tool) List() []toolaccess.ToolInfo {
	// Daemon mode: read the shell PID directly from the hub's list payload.
	// Synthetic Tools built in listPanes() have no os/exec handle, so
	// CmdProcessPID() would return 0 and break whoami PID matching (FR-16).
	if a.PM == nil && a.Hub != nil {
		maps := a.Hub.List()
		out := make([]toolaccess.ToolInfo, 0, len(maps))
		for _, m := range maps {
			id, _ := m["id"].(string)
			name, _ := m["name"].(string)
			// 데몬 모드: 전경 조회는 PTY 를 가진 데몬이 하고, 결과는 목록
			// 응답에 실려 온다 (FR-TAN-7). 여기서 tcgetpgrp 를 부를 수는
			// 없다 — Size() 가 PTMX 대신 List 를 쓰는 것과 같은 사정이다.
			fg, _ := m["fgName"].(string)
			out = append(out, toolaccess.ToolInfo{
				ID: id, Name: name, ShellPID: mapInt(m["pid"]), ForegroundName: fg,
			})
		}
		return out
	}
	var fg map[string]string
	if a.PM != nil {
		fg = a.PM.ForegroundNames()
	}
	tools := a.listPanes()
	out := make([]toolaccess.ToolInfo, 0, len(tools))
	for _, p := range tools {
		out = append(out, toolaccess.ToolInfo{
			ID: p.ID, Name: p.Name, ShellPID: p.CmdProcessPID(), ForegroundName: fg[p.ID],
		})
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

func (a Tool) Has(id string) bool {
	if a.PM != nil {
		return a.PM.Get(id) != nil
	}
	if a.Hub != nil {
		return a.Hub.Get(id) != nil
	}
	return false
}

func (a Tool) Snapshot(id string) ([]byte, int64, bool) {
	if a.PM != nil {
		p := a.PM.Get(id)
		if p == nil || p.Stream() == nil {
			return nil, 0, false
		}
		data, stats := p.Stream().Snapshot()
		return data, stats.TotalBytesDrop, true
	}
	if a.Hub != nil {
		snap, err := a.Hub.SnapshotTool(id)
		if err != nil {
			return nil, 0, false
		}
		return snap.Data, snap.TotalBytesDrop, true
	}
	return nil, 0, false
}

func (a Tool) Size(id string) string {
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
	// Daemon mode: ToolHub doesn't expose PTMX; use List for cols/rows.
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

func (a Tool) SendPaste(id string, text []byte, submit bool) error {
	if a.PM != nil {
		p := a.PM.Get(id)
		if p == nil || p.PTMX() == nil {
			return fmt.Errorf("tool 없음: %s", id)
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
	// Daemon mode: use ToolHub.Write
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
	return fmt.Errorf("tool 없음: %s", id)
}
