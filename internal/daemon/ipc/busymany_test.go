package ipc

import (
	"encoding/json"
	"testing"

	"dongminal/internal/shared/toolhub"
	"dongminal/internal/shared/toolipc"
)

// OPTIMIZE_REFACTOR_SRS FR-OPT-2-4 — busy 일괄 조회.

func TestBusyManyFeature(t *testing.T) {
	if !toolipc.HasFeature(toolipc.DaemonFeatures, toolipc.FeatureBusyMany) {
		t.Fatalf("DaemonFeatures=%v — busymany 가 없다", toolipc.DaemonFeatures)
	}
}

// 없는 도구는 busy 와 같이 false 다. 키는 사전순으로 나간다(map 부호화).
func TestBusyManyWire(t *testing.T) {
	cases := []struct{ params, want string }{
		{`{"ids":["y","x"]}`, `{"id":1,"result":{"busy":{"x":false,"y":false}}}`},
		{`{"ids":[]}`, `{"id":1,"result":{"busy":{}}}`},
		{`{}`, `{"id":1,"result":{"busy":{}}}`},
	}
	for _, c := range cases {
		got := wireOf(t, func(pc *panedConn) {
			pc.dispatch(&toolipc.PanedRequest{ID: 1, Method: toolipc.MethodBusyMany, Params: json.RawMessage(c.params)})
		})
		if got != c.want+"\n" {
			t.Errorf("busymany %s\n got %s\nwant %s", c.params, got, c.want)
		}
	}
}

// 살아 있는 도구의 답은 busy 한 건씩 물은 것과 같다.
func TestBusyManyMatchesBusy(t *testing.T) {
	pm := toolhub.NewToolManager(toolTempDir(t), nil)
	t.Cleanup(pm.StopSaving)
	tl, err := pm.Create("/tmp", 80, 24, toolhub.Placement{})
	if err != nil {
		t.Skipf("PTY 생성 불가(환경): %v", err)
	}
	defer pm.Delete(tl.ID)
	pc := newTestConn(pm)
	params, _ := json.Marshal(toolipc.BusyManyParams{IDs: []string{tl.ID, "gone"}})
	res, ok := pc.busyMany(&toolipc.PanedRequest{ID: 1, Params: params}).(toolipc.PanedResponse)
	if !ok {
		t.Fatalf("응답 모양이 아니다: %#v", res)
	}
	got := res.Result.(toolipc.BusyManyResult).Busy
	if got[tl.ID] != pm.Busy(tl.ID) || got["gone"] || len(got) != 2 {
		t.Fatalf("busymany=%v busy(%s)=%v", got, tl.ID, pm.Busy(tl.ID))
	}
}
