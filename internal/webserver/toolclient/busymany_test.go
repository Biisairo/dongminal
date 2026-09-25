package toolclient

import (
	"encoding/json"
	"fmt"
	"testing"

	"dongminal/internal/shared/toolipc"
)

// OPTIMIZE_REFACTOR_SRS FR-OPT-2-4 — busy 일괄 조회. 도구 N개: busy RPC N번 → busymany 1번.

func busyManyFake(t *testing.T, features []string, fail bool) (*ToolClient, <-chan string) {
	t.Helper()
	sock, lines := rawFake(t, map[string]any{"version": toolipc.ProtocolVersion, "features": features}, func(req toolipc.PanedRequest) any {
		if fail {
			return toolipc.PanedError{ID: req.ID, Error: toolipc.PanedErrObj{Code: toolipc.CodeServer, Message: "boom"}}
		}
		switch req.Method {
		case toolipc.MethodBusyMany:
			var p toolipc.BusyManyParams
			_ = json.Unmarshal(req.Params, &p)
			m := map[string]bool{}
			for _, id := range p.IDs {
				m[id] = id == "b"
			}
			return toolipc.PanedResponse{ID: req.ID, Result: toolipc.BusyManyResult{Busy: m}}
		case toolipc.MethodBusy:
			var p toolipc.IDParams
			_ = json.Unmarshal(req.Params, &p)
			return toolipc.PanedResponse{ID: req.ID, Result: toolipc.BusyResult{Busy: p.ID == "b"}}
		}
		return toolipc.PanedResponse{ID: req.ID, Result: struct{}{}}
	})
	pc := dialFake(t, sock)
	nextLine(t, lines) // hello
	return pc, lines
}

func TestBusyManyOneRPC(t *testing.T) {
	pc, lines := busyManyFake(t, []string{toolipc.FeatureBusyMany}, false)
	got, ok := pc.BusyMany([]string{"a", "b", "c"})
	if !ok || len(got) != 3 || got["a"] || !got["b"] || got["c"] {
		t.Fatalf("BusyMany=%v ok=%v", got, ok)
	}
	if l, want := nextLine(t, lines), `{"id":1,"method":"busymany","params":{"ids":["a","b","c"]}}`; l != want {
		t.Fatalf("요청\n got %s\nwant %s", l, want)
	}
	noLine(t, lines)
}

// 교차 판: 새 서버 · 옛 데몬. busymany 를 말하지 않으면 busy 를 하나씩 보낸다.
func TestBusyManyLegacyDaemon(t *testing.T) {
	pc, lines := busyManyFake(t, nil, false)
	got, ok := pc.BusyMany([]string{"a", "b"})
	if !ok || len(got) != 2 || got["a"] || !got["b"] {
		t.Fatalf("BusyMany=%v ok=%v", got, ok)
	}
	for i, id := range []string{"a", "b"} {
		if l, want := nextLine(t, lines), fmt.Sprintf(`{"id":%d,"method":"busy","params":{"id":"%s"}}`, i+1, id); l != want {
			t.Fatalf("옛 데몬 요청\n got %s\nwant %s", l, want)
		}
	}
	noLine(t, lines)
}

// RPC 오류는 "모른다" 다 — "바쁘지 않음" 으로 읽지 않는다 (IPC-M2).
func TestBusyManyErrorIsUnknown(t *testing.T) {
	for _, f := range [][]string{{toolipc.FeatureBusyMany}, nil} {
		pc, _ := busyManyFake(t, f, true)
		if got, ok := pc.BusyMany([]string{"a"}); ok {
			t.Fatalf("features=%v: 오류가 ok 로 돌아왔다: %v", f, got)
		}
	}
}

func TestBusyManyEmptyNoRPC(t *testing.T) {
	pc, lines := busyManyFake(t, []string{toolipc.FeatureBusyMany}, false)
	if got, ok := pc.BusyMany(nil); !ok || len(got) != 0 {
		t.Fatalf("BusyMany(nil)=%v ok=%v", got, ok)
	}
	noLine(t, lines)
}
