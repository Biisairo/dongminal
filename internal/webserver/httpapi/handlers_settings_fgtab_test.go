package httpapi

import "testing"

// parseFgTabNames 는 SETTINGS_SCHEMA 기본(켬)을 따른다 — dmctl fgTabNamesEnabled 와 같은 표.
func TestParseFgTabNamesDefaults(t *testing.T) {
	for _, tc := range []struct {
		blob string
		want bool
	}{
		{`{"fgTabNames":null}`, true},
		{`{}`, true},
		{``, true},
		{`{"fgTabNames":false}`, false},
		{`{"fgTabNames":"no"}`, true},
	} {
		if got := parseFgTabNames([]byte(tc.blob)); got != tc.want {
			t.Errorf("%q: got %v want %v", tc.blob, got, tc.want)
		}
	}
}

// parsePageTitle 은 앞뒤 공백을 걷는다 (TELEGRAM_BRIDGE_SRS D-TGB-17).
func TestParsePageTitle(t *testing.T) {
	for _, tc := range []struct{ blob, want string }{
		{`{"pageTitle":" macmini-office "}`, "macmini-office"},
		{`{}`, ""},
		{``, ""},
		{`{"pageTitle":7}`, ""},
	} {
		if got := parsePageTitle([]byte(tc.blob)); got != tc.want {
			t.Errorf("%q: got %q want %q", tc.blob, got, tc.want)
		}
	}
}
