package edge

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// EDGE_PAIRING_SRS — 저장소와 초대 (TC-EPR-6·8, FR-EPR-6).

func fpOf(prefix string) string { return prefix + strings.Repeat("0", 64-len(prefix)) }

// TC-EPR-8: 옛 파일의 pending-out 은 버리고 짝은 받는다. 같은 이름 둘도 받는다.
func TestLoadDropsLegacyPending(t *testing.T) {
	path := filepath.Join(t.TempDir(), "edges.json")
	raw := `{"enabled":true,"port":58147,"bind":"0.0.0.0","name":"me","edges":[
	 {"name":"p","addr":"10.0.0.1","port":1,"fp":"` + fpOf("aa") + `","state":""},
	 {"name":"p","addr":"10.0.0.2","port":1,"fp":"` + fpOf("bb") + `","state":""},
	 {"name":"q","addr":"10.0.0.3","port":1,"fp":"` + fpOf("cc") + `","state":"pending-out","expires":"2099-01-01T00:00:00Z"}]}`
	if err := os.WriteFile(path, []byte(raw), 0o600); err != nil {
		t.Fatal(err)
	}
	s := OpenStore(path, "h")
	got := s.Config().Edges
	if len(got) != 2 || !s.IsEdge(fpOf("aa")) || !s.IsEdge(fpOf("bb")) || s.IsEdge(fpOf("cc")) {
		t.Fatalf("edges = %+v", got)
	}
}

// FR-EPR-31: 표시 이름은 겹쳐도 된다. 주소 없는 간선도 받는다 (FR-EPR-2).
func TestAddEdgeNamesMayRepeat(t *testing.T) {
	s := OpenStore(filepath.Join(t.TempDir(), "edges.json"), "h")
	if err := s.AddEdge(Edge{Name: "same", Addr: "10.0.0.1", Port: 1, Fingerprint: fpOf("aa")}); err != nil {
		t.Fatal(err)
	}
	if err := s.AddEdge(Edge{Name: "same", Fingerprint: fpOf("bb")}); err != nil {
		t.Fatalf("주소 없는 간선·같은 이름: %v", err)
	}
	if len(s.Config().Edges) != 2 {
		t.Fatal("간선 둘이 아니다")
	}
}

// TC-EPR-6: 지문 전체·앞자리(8자리 이상, 하나로 정해질 때)로 찾는다.
func TestResolveByPrefix(t *testing.T) {
	s := OpenStore(filepath.Join(t.TempDir(), "edges.json"), "h")
	for _, p := range []string{"12345678aa", "12345678bb", "abcdef01"} {
		if err := s.AddEdge(Edge{Name: "n", Addr: "10.0.0.1", Port: 1, Fingerprint: fpOf(p)}); err != nil {
			t.Fatal(err)
		}
	}
	if e, err := s.Resolve("abcdef01"); err != nil || e.Fingerprint != fpOf("abcdef01") {
		t.Fatalf("앞자리 = %+v %v", e, err)
	}
	if e, err := s.Resolve(fpOf("12345678aa")); err != nil || e.Fingerprint != fpOf("12345678aa") {
		t.Fatalf("전체 = %+v %v", e, err)
	}
	if _, err := s.Resolve("12345678"); !errors.Is(err, ErrAmbiguous) {
		t.Fatalf("겹치는 앞자리 = %v", err)
	}
	if _, err := s.Resolve("abc"); !errors.Is(err, ErrEdgeNotFound) {
		t.Fatalf("8자리 미만 = %v", err)
	}
	if _, err := s.Resolve("ffffffff"); !errors.Is(err, ErrEdgeNotFound) {
		t.Fatalf("없는 지문 = %v", err)
	}
	if err := s.SetAddress(fpOf("abcdef01"), "10.0.0.9", 2); err != nil {
		t.Fatal(err)
	}
	if err := s.Remove(fpOf("abcdef01")); err != nil || s.IsEdge(fpOf("abcdef01")) {
		t.Fatalf("지우기 = %v", err)
	}
}

// FR-EPR-6: 쓴 토큰은 쓴 지문만 초대 만료까지 다시 쓸 수 있다.
func TestRedeemRetrySameFingerprint(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	p := NewPairing(func() time.Time { return now })
	tok, _ := p.NewInvite()
	if err := p.Redeem("wrong", fpOf("aa")); !errors.Is(err, ErrBadToken) {
		t.Fatalf("틀린 토큰 = %v", err)
	}
	if err := p.Redeem(tok, fpOf("aa")); err != nil {
		t.Fatal(err)
	}
	if p.HasInvite() {
		t.Fatal("쓴 초대가 살아 있다")
	}
	if err := p.Redeem(tok, fpOf("aa")); err != nil {
		t.Fatalf("같은 지문 다시 시도 = %v", err)
	}
	if err := p.Redeem(tok, fpOf("bb")); !errors.Is(err, ErrNoInvite) {
		t.Fatalf("다른 지문 = %v", err)
	}
	now = now.Add(InviteTTL + time.Second)
	if err := p.Redeem(tok, fpOf("aa")); !errors.Is(err, ErrNoInvite) {
		t.Fatalf("만료 뒤 = %v", err)
	}
}

// 보안 검토: 지운 간선은 쓴 토큰으로 다시 맺지 못한다. 새 초대도 다시 시도 기억을 지운다.
func TestRedeemRetryRevoked(t *testing.T) {
	p := NewPairing(time.Now)
	tok, _ := p.NewInvite()
	if err := p.Redeem(tok, fpOf("aa")); err != nil {
		t.Fatal(err)
	}
	p.Revoke(fpOf("bb"))
	if err := p.Redeem(tok, fpOf("aa")); err != nil {
		t.Fatalf("다른 지문을 지웠는데 다시 시도가 막혔다: %v", err)
	}
	p.Revoke(fpOf("aa"))
	if err := p.Redeem(tok, fpOf("aa")); !errors.Is(err, ErrNoInvite) {
		t.Fatalf("지운 뒤 다시 시도 = %v", err)
	}
	tok2, _ := p.NewInvite()
	if err := p.Redeem(tok2, fpOf("aa")); err != nil {
		t.Fatal(err)
	}
	p.NewInvite()
	if err := p.Redeem(tok2, fpOf("aa")); !errors.Is(err, ErrBadToken) {
		t.Fatalf("새 초대 뒤 옛 토큰 다시 시도 = %v", err)
	}
}
