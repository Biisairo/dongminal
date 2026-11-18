// Package adapters는 internal/webserver/httpapi·internal/shared/workspace 의 구체
// 타입을 internal/webserver/seam/toolaccess 인터페이스로 브리지하는 어댑터들을 모은다.
// main 패키지에서 쓰이던 wiring 코드를 한 곳으로 정리한다.
package adapters

import (
	"dongminal/internal/shared/toolhub"

	"fmt"

	"dongminal/internal/webserver/seam/toolaccess"
)

// Tool은 toolhub.ToolManager 를 toolaccess.ToolReader 로 어댑트한다.
// PM이 nil이면 (daemon mode) ToolHub 를 사용한다.
type Tool struct {
	PM  *toolhub.ToolManager
	Hub toolhub.ToolHub
}

// pmSnapshot 은 직접 모드의 도구 목록이다. 데몬 모드는 List 가 hub 목록으로 먼저
// 답하므로 여기 오지 않는다.
func (a Tool) pmSnapshot() []*toolhub.Tool {
	if a.PM == nil {
		return nil
	}
	return a.PM.Snapshot()
}

func (a Tool) List() []toolaccess.ToolInfo {
	// 데몬 모드: 셸 PID 는 hub 목록 응답에 실린 값이다 — 이 프로세스에는 도구의
	// 프로세스 핸들이 없으므로 whoami 의 PID 대조(FR-16)가 이 값에 기댄다.
	if a.PM == nil && a.Hub != nil {
		infos := a.Hub.List()
		out := make([]toolaccess.ToolInfo, 0, len(infos))
		for _, t := range infos {
			// 데몬 모드: 전경 조회는 PTY 를 가진 데몬이 하고, 결과는 목록
			// 응답에 실려 온다 (FR-TAN-7). 여기서 tcgetpgrp 를 부를 수는
			// 없다 — Size() 가 PTMX 대신 List 를 쓰는 것과 같은 사정이다.
			out = append(out, toolaccess.ToolInfo{
				ID: t.ID, Name: t.Name, ShellPID: t.PID, ForegroundName: t.FgName,
			})
		}
		return out
	}
	var fg map[string]string
	if a.PM != nil {
		fg = a.PM.ForegroundNames()
	}
	tools := a.pmSnapshot()
	out := make([]toolaccess.ToolInfo, 0, len(tools))
	for _, p := range tools {
		out = append(out, toolaccess.ToolInfo{
			ID: p.ID, Name: p.Name, ShellPID: p.CmdProcessPID(), ForegroundName: fg[p.ID],
		})
	}
	return out
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
		if p == nil {
			return "?"
		}
		cols, rows, ok := p.Size()
		if !ok {
			return "?"
		}
		return fmt.Sprintf("%dx%d", cols, rows)
	}
	// Daemon mode: ToolHub doesn't expose the terminal; use List for cols/rows.
	if a.Hub != nil {
		for _, t := range a.Hub.List() {
			if t.ID == id && t.Cols > 0 && t.Rows > 0 {
				return fmt.Sprintf("%dx%d", t.Cols, t.Rows)
			}
		}
	}
	return "?"
}

// SendPaste 는 감싸기·제출 판단을 **도구가 사는 곳**에 맡긴다.
//
// 종전에는 이 함수 안에 감싸기가 두 벌 적혀 있었다 — direct 갈래와 daemon 갈래.
// 게다가 셸이 bracketed paste 모드를 켰는지 보지 않고 **언제나** 감쌌으므로,
// 그 모드를 모르는 셸(macOS 가 싣는 bash 3.2)에서는 마커가 글자 그대로 명령줄에
// 들어가 명령이 깨졌다 (BRACKETED_PASTE_SRS §1.1).
//
// 판단은 PTY 출력을 읽는 쪽만 할 수 있다. 그래서 여기서는 위임만 한다 (FR-BPW-1).
func (a Tool) SendPaste(id string, text []byte, submit bool) error {
	if a.PM != nil {
		return a.PM.SendPaste(id, text, submit)
	}
	if a.Hub != nil {
		return a.Hub.SendPaste(id, text, submit)
	}
	return fmt.Errorf("tool 없음: %s", id)
}
