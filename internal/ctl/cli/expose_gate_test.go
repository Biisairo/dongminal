package cli

import (
	"os"
	"path/filepath"
	"testing"

	"dongminal/internal/shared/dmenv"
)

// REQUEST_GATE_SRS §4.4 — 노출 게이트 (TC-RQG-22~25).
//
// `--expose` 로 띄우고 허용 목록을 켜지 않으면 같은 Wi-Fi 의 누구나 셸을 얻는다.
// 인증이 아직 없는 동안 그 상태를 기본으로 둘 수 없다.

func writeACL(t *testing.T, home, body string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(home, "access.json"), []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestExposeACL_MissingFileBlocks(t *testing.T) {
	if got := exposeACLBlocked(t.TempDir()); got == "" {
		t.Fatalf("목록이 없는데 통과했다")
	}
}

func TestExposeACL_DisabledBlocks(t *testing.T) {
	home := t.TempDir()
	writeACL(t, home, `{"enabled":false,"entries":[{"value":"1.2.3.4","enabled":true}]}`)
	if got := exposeACLBlocked(home); got == "" {
		t.Fatalf("목록이 꺼져 있는데 통과했다")
	}
}

// 켜져 있는데 항목이 없으면 아무도 못 들어온다 — 그것은 "켰다" 가 아니다.
func TestExposeACL_EnabledButEmptyBlocks(t *testing.T) {
	home := t.TempDir()
	writeACL(t, home, `{"enabled":true,"entries":[]}`)
	if got := exposeACLBlocked(home); got == "" {
		t.Fatalf("항목이 없는데 통과했다")
	}
}

// 꺼진 항목만 있는 것도 같다 (FR-ACL-17).
func TestExposeACL_OnlyDisabledEntriesBlocks(t *testing.T) {
	home := t.TempDir()
	writeACL(t, home, `{"enabled":true,"entries":[{"value":"1.2.3.4","enabled":false}]}`)
	if got := exposeACLBlocked(home); got == "" {
		t.Fatalf("꺼진 항목뿐인데 통과했다")
	}
}

func TestExposeACL_EnabledWithEntryPasses(t *testing.T) {
	home := t.TempDir()
	writeACL(t, home, `{"enabled":true,"entries":[{"value":"192.168.0.0/24","enabled":true}]}`)
	if got := exposeACLBlocked(home); got != "" {
		t.Fatalf("제대로 켜 두었는데 막혔다: %s", got)
	}
}

// 깨진 파일은 **막는다.** 노출 상태에서 읽기 실패로 통과시키면 그 실패가 곧
// 우회 경로가 된다.
func TestExposeACL_CorruptBlocks(t *testing.T) {
	home := t.TempDir()
	writeACL(t, home, `{not json`)
	if got := exposeACLBlocked(home); got == "" {
		t.Fatalf("깨진 목록인데 통과했다")
	}
}

// 사유가 셋으로 갈린다 — 무엇을 고쳐야 하는지가 다르기 때문이다.
func TestExposeACL_ReasonsDiffer(t *testing.T) {
	off, empty := t.TempDir(), t.TempDir()
	writeACL(t, off, `{"enabled":false,"entries":[]}`)
	writeACL(t, empty, `{"enabled":true,"entries":[]}`)
	if exposeACLBlocked(off) == exposeACLBlocked(empty) {
		t.Fatalf("꺼진 것과 비어 있는 것의 사유가 같다 — 사용자가 토글만 다시 본다")
	}
}

// TLS-2 — **게이트가 무는 호스트와 표시가 같은 판정을 딛는다.**
//
// 종전에는 갈라져 있었다. 게이트는 `host != DefaultHost` 라 `::1` 바인드까지
// 허용 목록을 요구했고(밖에서 닿지 않는 주소인데 문을 잠그라고 했다), 표시는
// `0.0.0.0`/`::` 만 보아 `DONGMINAL_HOST=192.168.1.5` 를 `local-only` 로
// 거짓 표시했다 — **게이트는 물면서 화면은 안전하다고 말하는** 조합이다.
func TestExposeGateHostsMatchLabel(t *testing.T) {
	for _, tc := range []struct {
		host    string
		gated   bool
		exposed string
	}{
		{DefaultHost, false, "local-only"},
		{"::1", false, "local-only"}, // 종전에는 게이트가 물었다
		{"localhost", false, "local-only"},
		{ExposeHost, true, "exposed"},
		{"::", true, "exposed"},
		{"192.168.1.5", true, "exposed"}, // 종전에는 local-only 로 표시됐다
	} {
		if got := dmenv.IsExposedHost(tc.host); got != tc.gated {
			t.Errorf("%s: 게이트 판정 = %v, want %v", tc.host, got, tc.gated)
		}
		if got := dmenv.ExposureLabel(tc.host); got != tc.exposed {
			t.Errorf("%s: 표시 = %q, want %q", tc.host, got, tc.exposed)
		}
	}
}
