package cli

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"dongminal/internal/shared/platform"
)

// `G3-2`(PRODUCTION_ROADMAP §M3) — **되돌릴 길이 있다.**
//
// 세대는 `G4-1` 이 세웠고 손상 복원은 `G4-2` 가 기동에서 자동으로 한다. 없는 것은
// **사용자가 스스로 되돌리는 길**이다 — 상위 스키마로 올라갔다가 내려오거나,
// 판을 잘못 올려 화면이 깨졌을 때 쓴다.

func wsHome(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv(EnvHome, home)
	return home
}

func seedGen(t *testing.T, home string, n int, body string) {
	t.Helper()
	p := filepath.Join(home, "workspace.json")
	if n == 0 {
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	if err := os.WriteFile(p+".bak."+itoa(n), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

// 목록은 있는 세대만 보인다.
func TestRollbackListShowsGenerations(t *testing.T) {
	home := wsHome(t)
	seedGen(t, home, 0, `{"schemaVersion":2,"windows":[]}`)
	seedGen(t, home, 1, `{"schemaVersion":2,"windows":[{"id":"a"}]}`)

	var out bytes.Buffer
	if code := RunRollback(RollbackOpts{}, &out, &out); code != 0 {
		t.Fatalf("code=%d out=%s", code, out.String())
	}
	if !strings.Contains(out.String(), ".bak.1") {
		t.Fatalf("세대 목록에 .bak.1 이 없다:\n%s", out.String())
	}
	if strings.Contains(out.String(), ".bak.2") {
		t.Fatalf("없는 세대를 보였다:\n%s", out.String())
	}
}

// 되돌리면 그 세대가 현재 판이 되고, **직전 현재 판은 격리된다**.
func TestRollbackRestoresGeneration(t *testing.T) {
	home := wsHome(t)
	const want = `{"schemaVersion":2,"windows":[{"id":"a"}]}`
	seedGen(t, home, 0, `{"schemaVersion":2,"windows":[]}`)
	seedGen(t, home, 1, want)

	var out bytes.Buffer
	if code := RunRollback(RollbackOpts{Gen: 1}, &out, &out); code != 0 {
		t.Fatalf("code=%d out=%s", code, out.String())
	}
	got, err := os.ReadFile(filepath.Join(home, "workspace.json"))
	if err != nil || string(got) != want {
		t.Fatalf("현재 판=%q err=%v", got, err)
	}
	ents, _ := os.ReadDir(home)
	found := false
	for _, e := range ents {
		if strings.Contains(e.Name(), ".corrupt-") || strings.Contains(e.Name(), ".before-rollback-") {
			found = true
		}
	}
	if !found {
		t.Fatal("되돌리기 전의 판이 남지 않았다 — 되돌리기도 되돌릴 수 있어야 한다")
	}
}

// **서버가 돌고 있으면 거부한다.** 지금 되돌려도 도는 서버가 곧 자기 메모리로
// 덮어쓴다 — 성공처럼 보이고 아무 일도 일어나지 않는 것이 가장 나쁘다.
func TestRollbackRefusesWhileServerRuns(t *testing.T) {
	home := wsHome(t)
	seedGen(t, home, 0, `{"schemaVersion":2,"windows":[]}`)
	seedGen(t, home, 1, `{"schemaVersion":2,"windows":[]}`)
	tr := platform.Current().IPC
	ln, err := tr.Listen(tr.Endpoint(home))
	if err != nil {
		t.Skipf("소켓을 열 수 없다: %v", err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			c.Close()
		}
	}()

	var out bytes.Buffer
	if code := RunRollback(RollbackOpts{Gen: 1}, &out, &out); code == 0 {
		t.Fatalf("도는 인스턴스가 있는데 되돌렸다:\n%s", out.String())
	}
}

// 없는 세대를 고르면 거절한다.
func TestRollbackRejectsMissingGeneration(t *testing.T) {
	home := wsHome(t)
	seedGen(t, home, 0, `{"schemaVersion":2,"windows":[]}`)

	var out bytes.Buffer
	if code := RunRollback(RollbackOpts{Gen: 2}, &out, &out); code == 0 {
		t.Fatal("없는 세대로 되돌렸다")
	}
}
