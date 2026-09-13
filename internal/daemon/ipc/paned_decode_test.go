package ipc

import (
	"encoding/json"
	"errors"
	"fmt"
	"testing"

	"dongminal/internal/shared/toolhub"
	"dongminal/internal/shared/toolipc"
)

// M8 D-A-16 (GO-22): 파라미터 해석은 한 벌이다 — 잘못된 JSON 은 CodeInvalidParams.
func TestDecodeParams_InvalidIsInvalidParams(t *testing.T) {
	type p struct {
		ID string `json:"id"`
	}
	req := &toolipc.PanedRequest{ID: 7, Params: json.RawMessage(`{"id":`)}
	if _, perr := decodeParams[p](req); perr == nil || perr.Error.Code != toolipc.CodeInvalidParams || perr.ID != 7 {
		t.Fatalf("perr=%+v", perr)
	}
	req = &toolipc.PanedRequest{ID: 8, Params: json.RawMessage(`{"id":"a"}`)}
	got, perr := decodeParams[p](req)
	if perr != nil || got.ID != "a" {
		t.Fatalf("got=%+v perr=%+v", got, perr)
	}
}

// 상한 초과는 코드로 건넌다 — 문자열이 아니라. 그 밖의 생성 실패는 CodeInternal.
func TestCreateError_ToolCapHasItsOwnCode(t *testing.T) {
	req := &toolipc.PanedRequest{ID: 1}
	if e := createError(req, fmt.Errorf("wrap: %w", toolhub.ErrToolCap)); e.Error.Code != toolipc.CodeToolCap {
		t.Fatalf("code=%d want %d", e.Error.Code, toolipc.CodeToolCap)
	}
	if e := createError(req, errors.New("boom")); e.Error.Code != toolipc.CodeInternal {
		t.Fatalf("code=%d want %d", e.Error.Code, toolipc.CodeInternal)
	}
}
