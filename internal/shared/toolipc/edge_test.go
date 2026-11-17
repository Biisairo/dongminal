package toolipc

import (
	"encoding/json"
	"testing"
)

// PEER_DAEMON_SRS §3.5a: 간선 와이어. 필드는 JSON 키 사전순이고 바이트를 고정한다.
func TestEdgeWireGolden(t *testing.T) {
	cases := []struct {
		name string
		v    any
		want string
	}{
		{"edge-params", EdgeParams{Args: json.RawMessage(`{"id":"p1"}`), IfMatch: "e1", Op: "approve"},
			`{"args":{"id":"p1"},"ifMatch":"e1","op":"approve"}`},
		{"edge-params-min", EdgeParams{Op: "get"}, `{"op":"get"}`},
		{"edge-result", EdgeResult{Body: json.RawMessage(`{"a":1}`), ETag: "t", Status: 200},
			`{"body":{"a":1},"etag":"t","status":200}`},
		{"edge-result-fail", EdgeResult{Code: "edge_unreachable", Message: "m", Status: 502},
			`{"code":"edge_unreachable","message":"m","status":502}`},
		{"edgeport-params", EdgePortParams{Addr: "0.0.0.0:58147", Listening: true},
			`{"addr":"0.0.0.0:58147","listening":true}`},
		{"edges-event", EdgesEvent{Event: EventEdges, Paired: "b"}, `{"event":"edges","paired":"b"}`},
	}
	for _, c := range cases {
		got, err := json.Marshal(c.v)
		if err != nil || string(got) != c.want {
			t.Errorf("%s: %s (%v), want %s", c.name, got, err, c.want)
		}
	}
	if !HasFeature(DaemonFeatures, FeatureEdge) || !HasFeature(ServerFeatures, FeatureEdge) {
		t.Fatal("양쪽이 edge 기능을 말하지 않는다")
	}
}
