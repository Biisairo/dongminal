package edge

import (
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// EDGE_MESH_SRS FR-EGM-21·25·31 — 저장소의 hello 반영·알림 대기, 지문에 묶인 초대.

func meshStore(t *testing.T) (*Store, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "edges.json")
	s := OpenStore(path, "host")
	fp := strings.Repeat("ab", 32)
	if err := s.AddEdge(Edge{Name: "old", Addr: "10.0.0.1", Port: 7001, Fingerprint: fp}); err != nil {
		t.Fatal(err)
	}
	return s, fp
}

func edgeOf(t *testing.T, s *Store, fp string) Edge {
	t.Helper()
	e, err := s.Resolve(fp)
	if err != nil {
		t.Fatal(err)
	}
	return e
}

// TC-EGM-5 (FR-EGM-21): 포트가 있으면 주소를 고친다. 바른 주소가 없으면 지금 주소, 그것도 없으면
// 출발지 IP 다. 포트가 없으면 이름만 고친다.
func TestApplyHello(t *testing.T) {
	s, fp := meshStore(t)
	changed, err := s.ApplyHello(fp, "new", "", 0, "192.168.0.9")
	if err != nil || !changed {
		t.Fatalf("이름 = %v %v", changed, err)
	}
	if e := edgeOf(t, s, fp); e.Name != "new" || e.Addr != "10.0.0.1" || e.Port != 7001 {
		t.Fatalf("포트 없는 hello 는 주소를 둔다: %+v", e)
	}
	if changed, _ := s.ApplyHello(fp, "new", "", 0, ""); changed {
		t.Fatal("같은 값이면 바뀌지 않는다")
	}
	if _, err := s.ApplyHello(fp, "new", "host.example", 7002, "192.168.0.9"); err != nil {
		t.Fatal(err)
	}
	if e := edgeOf(t, s, fp); e.Addr != "host.example" || e.Port != 7002 {
		t.Fatalf("바른 주소: %+v", e)
	}
	if _, err := s.ApplyHello(fp, "new", "bad addr", 7003, "192.168.0.9"); err != nil {
		t.Fatal(err)
	}
	if e := edgeOf(t, s, fp); e.Addr != "host.example" || e.Port != 7003 {
		t.Fatalf("틀린 주소면 지금 주소: %+v", e)
	}
	bare := strings.Repeat("ef", 32)
	if err := s.AddEdge(Edge{Name: "bare", Fingerprint: bare}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.ApplyHello(bare, "bare", "", 7004, "192.168.0.9"); err != nil {
		t.Fatal(err)
	}
	if e := edgeOf(t, s, bare); e.Addr != "192.168.0.9" || e.Port != 7004 {
		t.Fatalf("주소가 없으면 출발지: %+v", e)
	}
	if _, err := s.ApplyHello(bare, "bare", "", 7005, ""); err != nil {
		t.Fatal(err)
	}
	if e := edgeOf(t, s, bare); e.Addr != "192.168.0.9" || e.Port != 7005 {
		t.Fatalf("이미 주소가 있으면 그 주소에 포트만 고친다: %+v", e)
	}
	if _, err := s.ApplyHello(fp, "\x01bad", "", 70000, ""); err != nil {
		t.Fatal(err)
	}
	if e := edgeOf(t, s, fp); e.Port != 7003 || e.Name == "\x01bad" {
		t.Fatalf("틀린 포트는 버리고 이름은 고쳐 쓴다: %+v", e)
	}
	if _, err := s.ApplyHello(strings.Repeat("cd", 32), "x", "", 0, ""); err == nil {
		t.Fatal("간선이 아닌 지문은 오류다")
	}
}

// TC-EGM-6 (FR-EGM-25): 알림 대기는 저장되고 다시 열어도 남는다.
func TestPendingPersists(t *testing.T) {
	s, fp := meshStore(t)
	if err := s.SetPendingAll(); err != nil {
		t.Fatal(err)
	}
	if !edgeOf(t, s, fp).Pending {
		t.Fatal("알림 대기")
	}
	again := OpenStore(s.path, "host")
	if !edgeOf(t, again, fp).Pending {
		t.Fatal("다시 열어도 남는다")
	}
	changed, err := s.SetPending(fp, false)
	if err != nil || !changed {
		t.Fatalf("지우기 = %v %v", changed, err)
	}
	if changed, _ := s.SetPending(fp, false); changed {
		t.Fatal("이미 지운 것은 바뀌지 않는다")
	}
	if err := s.AddEdge(Edge{Name: "x", Fingerprint: fp}); err != nil {
		t.Fatal(err)
	}
	if edgeOf(t, s, fp).Pending {
		t.Fatal("다시 맺으면 알림 대기가 없다")
	}
}

// TC-EGM-9 (FR-EGM-31): 묶인 토큰은 그 지문만 쓴다. 사람 초대와 서로 밀어내지 않는다.
func TestBoundInvite(t *testing.T) {
	now := time.Now()
	p := NewPairing(func() time.Time { return now })
	a, b := strings.Repeat("aa", 32), strings.Repeat("bb", 32)
	tok, exp := p.NewBoundInvite(a)
	if !exp.Equal(now.Add(InviteTTL)) {
		t.Fatalf("만료 = %v", exp)
	}
	manual, _ := p.NewInvite()
	if err := p.Redeem(tok, b); err != ErrBadToken {
		t.Fatalf("다른 지문 = %v", err)
	}
	if err := p.Redeem(tok, a); err != nil {
		t.Fatalf("맞는 지문 = %v", err)
	}
	if err := p.Redeem(manual, b); err != nil {
		t.Fatalf("사람 초대는 남는다 = %v", err)
	}
	tok2, _ := p.NewBoundInvite(a)
	p.NewInvite()
	if err := p.Redeem(tok2, a); err != nil {
		t.Fatalf("새 사람 초대가 묶인 토큰을 지우지 않는다 = %v", err)
	}
	if err := p.Redeem(tok2, b); err == nil {
		t.Fatal("쓴 토큰은 다른 지문이 쓰지 못한다")
	}
	var first string
	for i := range maxBoundInvites + 1 {
		tk, _ := p.NewBoundInvite(a)
		if i == 0 {
			first = tk
		}
	}
	if err := p.Redeem(first, a); err == nil {
		t.Fatal("넘치면 가장 오래된 토큰을 버린다")
	}
	expired, _ := p.NewBoundInvite(a)
	now = now.Add(InviteTTL)
	if err := p.Redeem(expired, a); err == nil {
		t.Fatal("만료된 토큰")
	}
}
