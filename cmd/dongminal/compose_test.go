package main

import (
	"testing"

	"dongminal/internal/shared/toolhub"
)

// FR-OPT-9-5 (HTTP-23): 합성 루트의 조각들.

// 직접 모드는 구체 ToolManager 를, 데몬 모드는 허브를 어댑터에 싣는다 — 단언은 한 번.
func TestNewToolAdapters_ByMode(t *testing.T) {
	pm := toolhub.NewToolManager("", nil)
	t.Cleanup(pm.StopSaving)
	pa, rc := newToolAdapters(pm)
	if pa.PM != pm || rc.PM != pm || pa.Hub != nil || rc.Hub != nil {
		t.Fatalf("direct: %+v %+v", pa, rc)
	}
	var h toolhub.ToolHub = hubOnly{pm}
	pa, rc = newToolAdapters(h)
	if pa.PM != nil || rc.PM != nil || pa.Hub != h || rc.Hub != h {
		t.Fatalf("hub: %+v %+v", pa, rc)
	}
}

// hubOnly 는 *ToolManager 가 아닌 ToolHub 다 (데몬 모드의 ToolClient 자리).
type hubOnly struct{ toolhub.ToolHub }

// 런타임이 없으면(placer nil) 샌드박스를 싣지도 회수하지도 않는다.
func TestAttachSandbox_NilIsNoop(t *testing.T) {
	var bd builtDeps
	attachSandbox(&bd, nil)
	if bd.deps.Sandbox != nil {
		t.Fatal("nil placer 가 Sandbox 로 실렸다")
	}
}
