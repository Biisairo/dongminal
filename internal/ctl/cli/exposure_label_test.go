package cli

import (
	"os"
	"path/filepath"
	"testing"

	"dongminal/internal/shared/dmenv"
)

// 노출 판정과 그 표시 (TLS-2).
//
// **게이트는 M9 에서 사라졌다** (FR-M9-1 / D-M9-1) — 여기 있던 `exposeACLBlocked`
// 의 검사 일곱은 그와 함께 지웠다. 남은 것은 "어떤 호스트가 노출인가" 하나이며,
// 그것은 게이트가 아니라 **화면의 표시**(`dmenv.ExposureLabel`)가 딛는 판정이다.

// writeACL 은 FR-M9-1 의 검사(`expose_start_test.go`)가 허용 목록 파일을 놓는 자리다.
func writeACL(t *testing.T, home, body string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(home, "access.json"), []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
}

// TLS-2 — **노출 판정과 표시가 같은 자리를 딛는다.**
//
// 종전에는 갈라져 있었다. 표시가 `0.0.0.0`/`::` 만 보아
// `DONGMINAL_HOST=192.168.1.5` 를 `local-only` 로 **거짓 표시**했다. 판정이 한 벌이어야
// 화면이 거짓말을 하지 않는다 — 지금은 `dmenv.IsExposedHost` 가 그 한 벌이다.
func TestExposureLabelMatchesHostJudgement(t *testing.T) {
	for _, tc := range []struct {
		host        string
		exposedHost bool
		exposed     string
	}{
		{dmenv.DefaultHost, false, "local-only"},
		{"::1", false, "local-only"},
		{"localhost", false, "local-only"},
		{ExposeHost, true, "exposed"},
		{"::", true, "exposed"},
		{"192.168.1.5", true, "exposed"}, // 종전에는 local-only 로 표시됐다
	} {
		if got := dmenv.IsExposedHost(tc.host); got != tc.exposedHost {
			t.Errorf("%s: 노출 판정 = %v, want %v", tc.host, got, tc.exposedHost)
		}
		if got := dmenv.ExposureLabel(tc.host); got != tc.exposed {
			t.Errorf("%s: 표시 = %q, want %q", tc.host, got, tc.exposed)
		}
	}
}
