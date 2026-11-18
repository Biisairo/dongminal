package edgenode

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"dongminal/internal/shared/edge"
)

// PROFILE_NAME_SRS §3.2: profile 은 이름·번호·핸들·지문을 답하고 ETag 를 싣는다.
func TestNodeProfileGet(t *testing.T) {
	n := newTestNode(t, "node-a")
	r := n.do(t, "profile", nil)
	if r.Status != http.StatusOK || r.ETag == "" {
		t.Fatalf("profile %d etag=%q", r.Status, r.ETag)
	}
	m := body(t, r)
	fp := n.Identity().Fingerprint
	tag := edge.Tag(fp)
	if m["name"] != "node-a" || m["tag"] != tag || m["handle"] != "node-a#"+tag || m["fingerprint"] != fp {
		t.Fatalf("profile = %v", m)
	}
}

// FR-PFN-11·13: profile_name 은 이름만 바꾸고, 틀리면 400, 낡으면 409 다.
func TestNodeProfileSetName(t *testing.T) {
	n := newTestNode(t, "node-a")
	g := n.do(t, "profile", nil)
	port := n.Config().Port
	raw, _ := json.Marshal(map[string]string{"name": "동민"})
	r := n.Do(context.Background(), Request{Op: "profile_name", Args: raw, IfMatch: g.ETag})
	if r.Status != http.StatusOK {
		t.Fatalf("profile_name %d %s %s", r.Status, r.Code, r.Message)
	}
	if m := body(t, r); m["name"] != "동민" || m["handle"] != "동민#"+edge.Tag(n.Identity().Fingerprint) {
		t.Fatalf("답 = %v", m)
	}
	if c := n.Config(); c.Name != "동민" || c.Port != port {
		t.Fatalf("이름만 바뀌지 않았다: %+v", c)
	}
	stale := n.Do(context.Background(), Request{Op: "profile_name", Args: raw, IfMatch: g.ETag})
	if stale.Status != http.StatusConflict || stale.Code != CodeStaleRev {
		t.Fatalf("stale %d %s", stale.Status, stale.Code)
	}
	bad, _ := json.Marshal(map[string]string{"name": "동 민"})
	if r := n.Do(context.Background(), Request{Op: "profile_name", Args: bad}); r.Status != http.StatusBadRequest || r.Code != edge.CodeConfigInvalid {
		t.Fatalf("틀린 이름 %d %s", r.Status, r.Code)
	}
	if n.Config().Name != "동민" {
		t.Fatal("거절한 이름이 남았다")
	}
}

// FR-PFN-23: get 의 노드와 간선에 번호가 있다.
func TestNodeViewHasTags(t *testing.T) {
	a := newTestNode(t, "node-a")
	b := newTestNode(t, "node-b")
	pairNodes(t, a, b)
	var v struct {
		Node struct {
			Tag string `json:"tag"`
		} `json:"node"`
		Edges []struct {
			FP  string `json:"fp"`
			Tag string `json:"tag"`
		} `json:"edges"`
	}
	if err := json.Unmarshal(a.do(t, "get", nil).Body, &v); err != nil {
		t.Fatal(err)
	}
	if v.Node.Tag != edge.Tag(a.Identity().Fingerprint) || v.Node.Tag == "" {
		t.Fatalf("node tag = %q", v.Node.Tag)
	}
	if len(v.Edges) != 1 || v.Edges[0].Tag != edge.Tag(b.Identity().Fingerprint) {
		t.Fatalf("edges = %+v", v.Edges)
	}
}

// FR-PFN-22: 짝맞춤 응답에도 상대 번호가 있어 화면이 핸들로 알린다.
func TestNodeAddAnswersTag(t *testing.T) {
	a := newTestNode(t, "node-a")
	b := newTestNode(t, "node-b")
	code, _ := body(t, b.do(t, "invite", map[string]any{}))["code"].(string)
	add := a.do(t, "add", map[string]any{"code": code})
	if m := body(t, add); m["tag"] != edge.Tag(b.Identity().Fingerprint) || m["name"] != "node-b" {
		t.Fatalf("add = %v", m)
	}
}
