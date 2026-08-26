package run

import "testing"

func TestProjection_Valid(t *testing.T) {
	for _, p := range []Projection{DedicatedWindow, Background, Inline} {
		if !p.Valid() {
			t.Errorf("%q 가 유효하지 않다고 보고됨", p)
		}
	}
	for _, p := range []Projection{"", "window", "DEDICATED-WINDOW", "bg"} {
		if p.Valid() {
			t.Errorf("%q 가 유효하다고 보고됨", p)
		}
	}
}

func TestProjection_WireValues(t *testing.T) {
	// 문자열 값은 스펙(FR-EM-17)에 고정된 계약이다.
	want := map[Projection]string{
		DedicatedWindow: "dedicated-window",
		Background:      "background",
		Inline:          "inline",
	}
	for p, s := range want {
		if string(p) != s {
			t.Errorf("%v = %q, want %q", p, string(p), s)
		}
	}
}
