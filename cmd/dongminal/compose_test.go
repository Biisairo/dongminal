package main

import (
	"testing"

	"dongminal/internal/shared/toolhub"
)

// FR-OPT-9-5 (HTTP-23): 합성 루트의 조각들.

// 어댑터 둘은 같은 허브를 싣는다 (DIRECT_MODE_REMOVAL_SRS FR-DMR-12).
func TestNewToolAdapters_UseHub(t *testing.T) {
	var h toolhub.ToolHub = hubOnly{}
	pa, rc := newToolAdapters(h)
	if pa.Hub != h || rc.Hub != h {
		t.Fatalf("hub: %+v %+v", pa, rc)
	}
}

// hubOnly 는 시험용 ToolHub 다 (ToolClient 자리). 메서드는 부르지 않는다.
type hubOnly struct{ toolhub.ToolHub }

// 런타임이 없으면(placer nil) 샌드박스를 싣지도 회수하지도 않는다.
func TestAttachSandbox_NilIsNoop(t *testing.T) {
	var bd builtDeps
	attachSandbox(&bd, nil)
	if bd.deps.Sandbox != nil {
		t.Fatal("nil placer 가 Sandbox 로 실렸다")
	}
}
