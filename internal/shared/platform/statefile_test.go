package platform

import (
	"os"
	"path/filepath"
	"testing"
)

// STATE_FILE_DURABILITY_SRS 묶음 B — 백업 세대 (V-SFD-1~4).
//
// 쓰기는 이미 원자적이다(`WriteFileAtomic` 이 fsync+rename 한다). 이 묶음이
// 더하는 것은 **원자성이 아니라 되돌아갈 곳**이다.

func readOrEmpty(t *testing.T, p string) string {
	t.Helper()
	b, err := os.ReadFile(p)
	if err != nil {
		return ""
	}
	return string(b)
}

// V-SFD-1: 두 번 쓰면 `.bak.1` 에 **직전 내용**이 있다.
func TestStateFileKeepsPreviousGeneration(t *testing.T) {
	d := t.TempDir()
	p := filepath.Join(d, "workspace.json")

	if err := WriteStateFile(p, []byte("v1"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := WriteStateFile(p, []byte("v2"), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := readOrEmpty(t, p); got != "v2" {
		t.Fatalf("본문=%q want v2", got)
	}
	if got := readOrEmpty(t, p+".bak.1"); got != "v1" {
		t.Fatalf(".bak.1=%q want v1 — 직전 내용이 남지 않는다", got)
	}
}

// V-SFD-2: 세대는 **셋**이고 그보다 오래된 것은 남지 않는다 (FR-SFD-2).
func TestStateFileRotatesThreeGenerations(t *testing.T) {
	d := t.TempDir()
	p := filepath.Join(d, "s.json")
	for _, v := range []string{"v1", "v2", "v3", "v4", "v5"} {
		if err := WriteStateFile(p, []byte(v), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	// 현재=v5, 직전 셋=v4·v3·v2. v1 은 밀려났다.
	want := map[string]string{p: "v5", p + ".bak.1": "v4", p + ".bak.2": "v3", p + ".bak.3": "v2"}
	for path, w := range want {
		if got := readOrEmpty(t, path); got != w {
			t.Errorf("%s=%q want %q", filepath.Base(path), got, w)
		}
	}
	if _, err := os.Stat(p + ".bak.4"); err == nil {
		t.Error(".bak.4 가 있다 — 세대는 셋이다")
	}
}

// V-SFD-3: 대상이 없으면 세대를 만들지 않는다 (FR-SFD-6).
//
// 첫 쓰기에 빈 `.bak` 을 만들면 그것이 나중에 "복원할 것이 있다" 는 **거짓
// 신호**가 된다.
func TestStateFileFirstWriteMakesNoGeneration(t *testing.T) {
	d := t.TempDir()
	p := filepath.Join(d, "s.json")
	if err := WriteStateFile(p, []byte("v1"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(p + ".bak.1"); err == nil {
		t.Fatal("첫 쓰기가 세대를 만들었다 — 되돌릴 것이 없었다")
	}
}

// V-SFD-4: **세대 생성이 실패해도 본 쓰기는 성공한다** (FR-SFD-4).
//
// 세대는 여유이지 조건이 아니다. 백업을 못 만든다고 저장을 막으면 디스크가 찬
// 순간 제품이 멈춘다.
func TestStateFileWriteSurvivesRotationFailure(t *testing.T) {
	d := t.TempDir()
	p := filepath.Join(d, "s.json")
	if err := WriteStateFile(p, []byte("v1"), 0o644); err != nil {
		t.Fatal(err)
	}
	// `.bak.1` 자리를 **디렉터리**로 막아 회전을 실패시킨다.
	if err := os.Mkdir(p+".bak.1", 0o755); err != nil {
		t.Fatal(err)
	}
	if err := WriteStateFile(p, []byte("v2"), 0o644); err != nil {
		t.Fatalf("세대를 못 만들었다고 저장이 막혔다 (FR-SFD-4): %v", err)
	}
	if got := readOrEmpty(t, p); got != "v2" {
		t.Fatalf("본문=%q want v2", got)
	}
}

// `G4-6`(PRODUCTION_ROADMAP §M3) — **보존 정책은 한 자리에서 정한다.**
//
// 세대(`.bak.N`)·격리본(`.corrupt-<ts>`)·되돌리기 직전 판
// (`.before-rollback-<ts>`)이 홈에 쌓인다. 셋의 수명이 다르고, 그 차이가
// **의도된 것**임을 여기 적는다.

func TestRetentionPolicyIsExplicit(t *testing.T) {
	// 세대는 **회전한다** — 상한이 있다. 이미 V-SFD-2 가 잰다.
	if StateFileGenerations != 3 {
		t.Errorf("StateFileGenerations=%d want 3 (사용자 결정)", StateFileGenerations)
	}
	// 격리본과 되돌리기 직전 판은 **회전하지 않는다.** 둘 다 사건의 증거이고,
	// 사건은 드물다 — 드문 것을 자동으로 지우면 정작 물어볼 때 없다.
	//
	// 이 검사는 값을 재는 것이 아니라 **결정을 고정한다.** 누군가 "일관성" 을
	// 이유로 격리본에도 회전을 붙이려 하면 여기서 그 결정을 다시 만난다.
	if RetainQuarantined != true {
		t.Error("격리본을 자동으로 지우도록 바뀌었다 — 사용자 결정(2026-09-11)에 어긋난다")
	}
}
