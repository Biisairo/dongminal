package edge

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"dongminal/internal/shared/dmenv"
)

// PROFILE_NAME_SRS FR-PFN-4: 지문 앞 8자리 → uint32 → %10000 → 네 자리.
func TestTag(t *testing.T) {
	cases := map[string]string{
		"00001a2b" + strings.Repeat("0", 56): "6699",
		strings.Repeat("0", 64):              "0000",
		"ffffffff" + strings.Repeat("a", 56): "7295", // 4294967295 % 10000
		"0000270f" + strings.Repeat("b", 56): "9999",
		"00002710" + strings.Repeat("b", 56): "0000",
		"ABCDEF01" + strings.Repeat("c", 56): "0001", // 대문자도 같은 값: 2882400001 % 10000
	}
	for fp, want := range cases {
		if got := Tag(fp); got != want {
			t.Errorf("Tag(%q) = %q, 기대 %q", fp[:8], got, want)
		}
	}
	for _, bad := range []string{"", "abc", "zzzzzzzz" + strings.Repeat("0", 56)} {
		if got := Tag(bad); got != "" {
			t.Errorf("Tag(%q) = %q, 기대 빈 값", bad, got)
		}
	}
}

// FR-PFN-6: 핸들은 `이름#번호`, 지문이 없으면 이름만.
func TestHandle(t *testing.T) {
	fp := "00001a2b" + strings.Repeat("0", 56)
	if got := Handle("동민", fp); got != "동민#6699" {
		t.Errorf("Handle = %q", got)
	}
	if got := Handle("동민", ""); got != "동민" {
		t.Errorf("지문 없는 Handle = %q", got)
	}
}

// FR-PFN-3: 옛 규칙의 이름은 읽을 때 새 규칙으로 고치고, 다음 저장 때 쓴다.
func TestOpenStoreNormalizesLegacyName(t *testing.T) {
	path := filepath.Join(t.TempDir(), dmenv.EdgesFile)
	if err := os.WriteFile(path, []byte(`{"enabled":false,"port":58147,"bind":"0.0.0.0","name":"Mac.local","edges":[]}`), 0o600); err != nil {
		t.Fatal(err)
	}
	s := OpenStore(path, "host-a")
	if got := s.Config().Name; got != "Mac-local" {
		t.Fatalf("name = %q, 기대 Mac-local", got)
	}
	if err := s.Save(s.Config()); err != nil {
		t.Fatalf("고친 이름으로 저장하지 못했다: %v", err)
	}
	if got := OpenStore(path, "x").Config().Name; got != "Mac-local" {
		t.Fatalf("다시 읽은 name = %q", got)
	}
}

// FR-PFN-1·11: SetName 은 이름만 바꾸고, 틀리면 아무것도 바꾸지 않는다.
func TestStoreSetName(t *testing.T) {
	s := newTestStore(t)
	c := s.Config()
	c.Port = 60002
	if err := s.Save(c); err != nil {
		t.Fatal(err)
	}
	if err := s.SetName("동민"); err != nil {
		t.Fatalf("SetName: %v", err)
	}
	got := s.Config()
	if got.Name != "동민" || got.Port != 60002 {
		t.Fatalf("이름만 바뀌지 않았다: %+v", got)
	}
	if err := s.SetName("동 민"); !errors.Is(err, ErrInvalidName) {
		t.Fatalf("틀린 이름 = %v, 기대 ErrInvalidName", err)
	}
	if s.Config().Name != "동민" {
		t.Fatal("거절한 이름이 남았다")
	}
}

// FR-PFN-31: 노드 설정 저장에 이름이 없으면 기존 이름을 유지한다.
func TestStoreSetNodeKeepsNameWhenEmpty(t *testing.T) {
	s := newTestStore(t)
	if err := s.SetName("동민"); err != nil {
		t.Fatal(err)
	}
	if err := s.SetNode(Config{Port: 60003, Bind: DefaultBind}); err != nil {
		t.Fatalf("SetNode: %v", err)
	}
	if got := s.Config(); got.Name != "동민" || got.Port != 60003 {
		t.Fatalf("이름을 지웠거나 포트를 못 바꿨다: %+v", got)
	}
}

// FR-PFN-24: 핸들로도 간선을 찾는다. 이름은 대소문자를 가리지 않는다.
func TestResolveByHandle(t *testing.T) {
	s := newTestStore(t)
	fpA := "00001a2b" + strings.Repeat("1", 56) // 6699
	fpB := "00001a2c" + strings.Repeat("2", 56) // 6700
	fpC := "00011d4b" + strings.Repeat("3", 56) // 73035 → 3035
	c := s.Config()
	c.Edges = []Edge{
		{Name: "Office", Fingerprint: fpA},
		{Name: "Office", Fingerprint: fpB},
		{Name: "집", Fingerprint: fpC},
	}
	if err := s.Save(c); err != nil {
		t.Fatal(err)
	}
	for q, want := range map[string]string{"office#6699": fpA, "Office#6700": fpB, "집#3035": fpC} {
		e, err := s.Resolve(q)
		if err != nil || e.Fingerprint != want {
			t.Errorf("Resolve(%q) = %v, %v", q, e.Fingerprint, err)
		}
	}
	for _, q := range []string{"office#1234", "nobody#6699", "#6699", "office#"} {
		if _, err := s.Resolve(q); !errors.Is(err, ErrEdgeNotFound) {
			t.Errorf("Resolve(%q) = %v, 기대 ErrEdgeNotFound", q, err)
		}
	}
	// 지문 앞자리로 찾기는 그대로다.
	if e, err := s.Resolve(fpC[:8]); err != nil || e.Fingerprint != fpC {
		t.Errorf("지문 앞자리 찾기가 깨졌다: %v", err)
	}
}

// A-1: 이름과 번호가 모두 같은 간선이 둘이면 모호하다.
func TestResolveByHandleAmbiguous(t *testing.T) {
	s := newTestStore(t)
	fp1 := "00001a2b" + strings.Repeat("1", 56) // 6699
	fp2 := "0000413b" + strings.Repeat("2", 56) // 16699 → 6699
	c := s.Config()
	c.Edges = []Edge{{Name: "pc", Fingerprint: fp1}, {Name: "PC", Fingerprint: fp2}}
	if err := s.Save(c); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Resolve("pc#6699"); !errors.Is(err, ErrAmbiguous) {
		t.Fatalf("Resolve = %v, 기대 ErrAmbiguous", err)
	}
}
