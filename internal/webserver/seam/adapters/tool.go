// Package adapters는 internal/webserver/httpapi·internal/shared/workspace 의 구체
// 타입을 internal/webserver/seam/toolaccess 인터페이스로 브리지하는 어댑터들을 모은다.
// main 패키지에서 쓰이던 wiring 코드를 한 곳으로 정리한다.
package adapters

import (
	"dongminal/internal/shared/toolhub"

	"fmt"

	"dongminal/internal/webserver/seam/toolaccess"
)

// Tool은 도구 허브(데몬)를 toolaccess.ToolReader 로 어댑트한다. 도구는 데몬에 있다
// (DIRECT_MODE_REMOVAL_SRS FR-DMR-12).
type Tool struct {
	Hub toolhub.ToolHub
}

func (a Tool) List() []toolaccess.ToolInfo {
	if a.Hub == nil {
		return nil
	}
	// 셸 PID 는 hub 목록 응답에 실린 값이다 — 이 프로세스에는 도구의 프로세스 핸들이
	// 없으므로 whoami 의 PID 대조(FR-16)가 이 값에 기댄다. 전경 조회도 PTY 를 가진
	// 데몬이 하고, 결과는 목록 응답에 실려 온다 (FR-TAN-7).
	infos := a.Hub.List()
	out := make([]toolaccess.ToolInfo, 0, len(infos))
	for _, t := range infos {
		out = append(out, toolaccess.ToolInfo{
			ID: t.ID, Name: t.Name, ShellPID: t.PID, ForegroundName: t.FgName,
		})
	}
	return out
}

func (a Tool) Has(id string) bool {
	return a.Hub != nil && a.Hub.Get(id) != nil
}

func (a Tool) Snapshot(id string) ([]byte, int64, bool) {
	if a.Hub == nil {
		return nil, 0, false
	}
	snap, err := a.Hub.SnapshotTool(id)
	if err != nil {
		return nil, 0, false
	}
	return snap.Data, snap.TotalBytesDrop, true
}

// Size 는 목록의 cols/rows 다 — 허브는 터미널을 내놓지 않는다.
func (a Tool) Size(id string) string {
	if a.Hub != nil {
		for _, t := range a.Hub.List() {
			if t.ID == id && t.Cols > 0 && t.Rows > 0 {
				return fmt.Sprintf("%dx%d", t.Cols, t.Rows)
			}
		}
	}
	return "?"
}

// SendPaste 는 감싸기·제출 판단을 **도구가 사는 곳**(데몬)에 맡긴다.
//
// 셸이 bracketed paste 모드를 켰는지는 PTY 출력을 읽는 쪽만 안다. 언제나 감싸면 그 모드를
// 모르는 셸(macOS 가 싣는 bash 3.2)에서 마커가 글자 그대로 명령줄에 들어간다
// (BRACKETED_PASTE_SRS §1.1, FR-BPW-1).
func (a Tool) SendPaste(id string, text []byte, submit bool) error {
	if a.Hub == nil {
		return fmt.Errorf("tool 없음: %s", id)
	}
	return a.Hub.SendPaste(id, text, submit)
}
