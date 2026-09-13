package toolclient

import (
	"errors"
	"testing"

	"dongminal/internal/shared/toolhub"
	"dongminal/internal/shared/toolipc"
)

// M8 D-A-16: 데몬의 오류 응답은 코드를 잃지 않는다 — `*toolipc.RPCError` 로
// 돌아오고, 상한 초과(CodeToolCap)는 `toolhub.ErrToolCap` 으로 되돌아온다. 종전에는
// 문자열("paned error: …")이라 데몬 모드의 `/api/tools` 가 429 대신 500 을 냈다.
func TestClientCreateToolCap(t *testing.T) {
	sockPath := startFakePaned(t, func(req toolipc.PanedRequest) interface{} {
		if req.Method == "create" {
			return toolipc.PanedError{ID: req.ID, Error: toolipc.PanedErrObj{Code: toolipc.CodeToolCap, Message: "cap"}}
		}
		return toolipc.PanedResponse{ID: req.ID, Result: map[string]interface{}{}}
	})
	pc, err := DialToolClient(sockPath)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer pc.Close()
	_, err = pc.Create("/tmp", 80, 24, toolhub.Placement{})
	if !errors.Is(err, toolhub.ErrToolCap) {
		t.Fatalf("errors.Is(ErrToolCap) 가 거짓이다: %v", err)
	}
}

func TestClientRPCErrCode(t *testing.T) {
	sockPath := startFakePaned(t, func(req toolipc.PanedRequest) interface{} {
		if req.Method == "kill" {
			return toolipc.PanedError{ID: req.ID, Error: toolipc.PanedErrObj{Code: toolipc.CodeServer, Message: "no such tool"}}
		}
		return toolipc.PanedResponse{ID: req.ID, Result: map[string]interface{}{}}
	})
	pc, err := DialToolClient(sockPath)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer pc.Close()
	err = pc.Delete("x")
	var rpc *toolipc.RPCError
	if !errors.As(err, &rpc) {
		t.Fatalf("*toolipc.RPCError 가 아니다: %T %v", err, err)
	}
	if rpc.Code != toolipc.CodeServer || rpc.Message != "no such tool" {
		t.Fatalf("code=%d msg=%q", rpc.Code, rpc.Message)
	}
}
