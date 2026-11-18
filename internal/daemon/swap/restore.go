package swap

import (
	"net"
	"os"

	"dongminal/internal/daemon/ipc"
	"dongminal/internal/shared/dmlog"
	"dongminal/internal/shared/toolhub"
)

// Restore 는 인계 상태의 도구와 데몬 전체 기록을 되살린다 (FR-DSK-20~23). 되살리지 못한
// 도구를 돌려준다 — 그 도구의 셸은 되찾기(FR-DSK-27)가 맡는다.
func Restore(pm *toolhub.ToolManager, ps *ipc.PanedServer, st State) (failed []toolhub.HandoverTool) {
	for _, t := range st.Tools {
		if err := pm.AdoptHandover(t); err != nil {
			dmlog.Errorf(nil, "인계 도구를 되살리지 못했다: %v", err)
			failed = append(failed, t)
		}
	}
	ps.ImportGlobal(st.Global)
	dmlog.Infof(nil, "인계 상태로 되살림: 도구 %d개, 실패 %d개", len(st.Tools)-len(failed), len(failed))
	return failed
}

// InheritListeners 는 인계 상태의 두 리스너 fd 로 리스너를 만든다 (FR-DSK-24). 하나라도
// 실패하면 둘 다 닫는다 — 호출자는 일반 Listen 으로 돌아간다.
func InheritListeners(st State) (paned, report net.Listener, err error) {
	if paned, err = net.FileListener(os.NewFile(st.PanedFD, "paned-listener")); err != nil {
		return nil, nil, err
	}
	if report, err = net.FileListener(os.NewFile(st.ReportFD, "report-listener")); err != nil {
		paned.Close()
		return nil, nil, err
	}
	return paned, report, nil
}
