package cli

import (
	"os"
	"path/filepath"
	"testing"
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
