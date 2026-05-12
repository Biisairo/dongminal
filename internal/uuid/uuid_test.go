package uuid

import (
	"bytes"
	"encoding/hex"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestGenerate_VersionAndVariant(t *testing.T) {
	g := New()
	u, err := g.Generate()
	if err != nil {
		t.Fatalf("Generate: %v", err)
	}
	if u.Version() != 7 {
		t.Errorf("version = %d, want 7", u.Version())
	}
	if u[8]&0xC0 != 0x80 {
		t.Errorf("variant bits = %08b, want 10xxxxxx", u[8])
	}
}

func TestString_Format(t *testing.T) {
	g := New()
	u, _ := g.Generate()
	s := u.String()
	if len(s) != 36 {
		t.Fatalf("len = %d, want 36 (%q)", len(s), s)
	}
	for _, i := range []int{8, 13, 18, 23} {
		if s[i] != '-' {
			t.Errorf("char at %d = %q, want '-'", i, s[i])
		}
	}
	if _, err := hex.DecodeString(strings.ReplaceAll(s, "-", "")); err != nil {
		t.Errorf("non-hex content: %v", err)
	}
}

func TestParse_Roundtrip(t *testing.T) {
	g := New()
	u, _ := g.Generate()
	s := u.String()
	parsed, err := Parse(s)
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if parsed != u {
		t.Errorf("roundtrip mismatch: got %s, want %s", parsed, u)
	}
}

func TestShortCode(t *testing.T) {
	g := New()
	u, _ := g.Generate()
	sc := u.ShortCode()
	if len(sc) != 8 {
		t.Errorf("short code len = %d, want 8", len(sc))
	}
	if _, err := hex.DecodeString(sc); err != nil {
		t.Errorf("short code not hex: %v", err)
	}
	if sc != u.String()[:8] {
		t.Errorf("short code = %s, want prefix of %s", sc, u.String())
	}
}

// TC-UID-6: 동일 ms 에 100 개 생성 → bit-wise 단조 증가 보장.
func TestMonotonic_SameMs(t *testing.T) {
	fixed := time.UnixMilli(1700000000000)
	g := newWithClock(func() time.Time { return fixed })

	uuids := make([]UUID, 100)
	for i := range uuids {
		u, err := g.Generate()
		if err != nil {
			t.Fatalf("Generate[%d]: %v", i, err)
		}
		uuids[i] = u
	}
	for i := 1; i < len(uuids); i++ {
		if bytes.Compare(uuids[i-1][:], uuids[i][:]) >= 0 {
			t.Errorf("not monotonic at i=%d: %s >= %s", i, uuids[i-1], uuids[i])
		}
	}
}

func TestMonotonic_AcrossMs(t *testing.T) {
	ts := time.UnixMilli(1700000000000)
	step := false
	g := newWithClock(func() time.Time {
		if step {
			return ts.Add(10 * time.Millisecond)
		}
		return ts
	})
	u1, _ := g.Generate()
	step = true
	u2, _ := g.Generate()
	if bytes.Compare(u1[:], u2[:]) >= 0 {
		t.Errorf("not monotonic across ms: %s >= %s", u1, u2)
	}
}

func TestMonotonic_ClockBackwards(t *testing.T) {
	ts := time.UnixMilli(1700000000000)
	back := false
	g := newWithClock(func() time.Time {
		if back {
			return ts.Add(-100 * time.Millisecond)
		}
		return ts
	})
	u1, _ := g.Generate()
	back = true
	u2, _ := g.Generate()
	if bytes.Compare(u1[:], u2[:]) >= 0 {
		t.Errorf("not monotonic with backwards clock: %s >= %s", u1, u2)
	}
}

func TestCounterExhaustion(t *testing.T) {
	fixed := time.UnixMilli(1700000000000)
	g := newWithClock(func() time.Time { return fixed })

	const n = 4097
	uuids := make([]UUID, n)
	for i := range uuids {
		u, err := g.Generate()
		if err != nil {
			t.Fatalf("Generate[%d]: %v", i, err)
		}
		uuids[i] = u
	}
	for i := 1; i < len(uuids); i++ {
		if bytes.Compare(uuids[i-1][:], uuids[i][:]) >= 0 {
			t.Errorf("not monotonic at i=%d after counter exhaustion", i)
		}
	}
}

// TC-UID-7: race — 동시 생성 시 중복·경합 없음.
func TestConcurrent_NoDuplicate(t *testing.T) {
	g := New()
	const goroutines = 10
	const perG = 1000

	var wg sync.WaitGroup
	results := make([][]UUID, goroutines)
	for gi := 0; gi < goroutines; gi++ {
		gi := gi
		results[gi] = make([]UUID, perG)
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := 0; i < perG; i++ {
				u, err := g.Generate()
				if err != nil {
					t.Errorf("Generate: %v", err)
					return
				}
				results[gi][i] = u
			}
		}()
	}
	wg.Wait()

	seen := make(map[UUID]bool, goroutines*perG)
	for _, batch := range results {
		for _, u := range batch {
			if seen[u] {
				t.Errorf("duplicate UUID: %s", u)
			}
			seen[u] = true
		}
	}
}

func TestParse_Invalid(t *testing.T) {
	cases := []string{
		"",
		"not-a-uuid",
		strings.Repeat("0", 36),
		"00000000-0000-0000-0000-00000000000z",
		"00000000_0000_0000_0000_000000000000",
		"0000-00000000-0000-0000-000000000000",
	}
	for _, c := range cases {
		if _, err := Parse(c); err == nil {
			t.Errorf("expected error for %q", c)
		}
	}
}

func TestParse_NilUUID(t *testing.T) {
	s := "00000000-0000-0000-0000-000000000000"
	u, err := Parse(s)
	if err != nil {
		t.Fatalf("Parse nil: %v", err)
	}
	if u != (UUID{}) {
		t.Errorf("parsed nil UUID not zero")
	}
	if u.String() != s {
		t.Errorf("nil UUID round-trip mismatch: %s", u.String())
	}
}
