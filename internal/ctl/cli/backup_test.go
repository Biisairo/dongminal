package cli

import (
	"archive/zip"
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// M5 `G4-3` — 홈 전체 `backup`/`restore`.

func seedHome(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	for _, n := range []string{"workspace.json", "settings.json", "access.json", "server.log", daemonSockFile} {
		if err := os.WriteFile(filepath.Join(home, n), []byte("body-"+n), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.MkdirAll(filepath.Join(home, "notes"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, "notes", "a.md"), []byte("메모"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(home, "bin"), 0o700); err != nil {
		t.Fatal(err)
	}
	return home
}

func backupEntryNames(t *testing.T, path string) map[string]bool {
	t.Helper()
	r, err := zip.OpenReader(path)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	out := map[string]bool{}
	for _, f := range r.File {
		out[f.Name] = true
	}
	return out
}

// **소켓·pid·로그는 담기지 않는다** (DoD). 다음 기동이 다시 만드는 것이고,
// 소켓은 zip 에 담기지도 않는다.
func TestBackupExcludesEphemeralFiles(t *testing.T) {
	home := seedHome(t)
	isolateEnv(t, home)
	out := filepath.Join(t.TempDir(), "b.zip")

	var so, se bytes.Buffer
	o, err := ParseBackup([]string{"--out", out})
	if err != nil {
		t.Fatal(err)
	}
	if code := RunBackup(o, &so, &se); code != 0 {
		t.Fatalf("exit %d: %s", code, se.String())
	}
	names := backupEntryNames(t, out)
	for _, n := range []string{"workspace.json", "settings.json", "access.json", "notes/a.md"} {
		if !names[n] {
			t.Errorf("%s 가 백업에 없다: %v", n, names)
		}
	}
	for _, n := range []string{"server.log", daemonSockFile} {
		if names[n] {
			t.Errorf("%s 가 백업에 담겼다", n)
		}
	}
}

// 복원은 담긴 것을 되돌린다. **담기지 않은 것은 건드리지 않는다** — 복원이
// 로그를 지우면 사고 직후의 증거가 사라진다.
func TestRestorePutsFilesBack(t *testing.T) {
	home := seedHome(t)
	isolateEnv(t, home)
	zipPath := filepath.Join(t.TempDir(), "b.zip")

	var so, se bytes.Buffer
	o, _ := ParseBackup([]string{"--out", zipPath})
	if code := RunBackup(o, &so, &se); code != 0 {
		t.Fatalf("백업 실패: %s", se.String())
	}

	// 홈을 망가뜨린다.
	if err := os.WriteFile(filepath.Join(home, "workspace.json"), []byte("망가짐"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(home, "settings.json")); err != nil {
		t.Fatal(err)
	}

	so.Reset()
	se.Reset()
	ro, err := ParseRestore([]string{zipPath, "--yes"})
	if err != nil {
		t.Fatal(err)
	}
	if code := RunRestore(ro, &so, &se); code != 0 {
		t.Fatalf("복원 실패 exit %d: %s", code, se.String())
	}
	for _, n := range []string{"workspace.json", "settings.json", "access.json"} {
		got, err := os.ReadFile(filepath.Join(home, n))
		if err != nil {
			t.Errorf("%s 가 돌아오지 않았다: %v", n, err)
			continue
		}
		if string(got) != "body-"+n {
			t.Errorf("%s = %q", n, got)
		}
	}
	if got, err := os.ReadFile(filepath.Join(home, "notes", "a.md")); err != nil || string(got) != "메모" {
		t.Errorf("notes/a.md = %q %v", got, err)
	}
	// 담기지 않았던 것은 그대로다.
	if _, err := os.Stat(filepath.Join(home, "server.log")); err != nil {
		t.Error("복원이 로그를 지웠다 — 사고 직후의 증거다")
	}
}

// 복원은 **되돌릴 수 없다.** 확인 없이는 하지 않는다.
func TestRestoreRequiresConfirmation(t *testing.T) {
	home := seedHome(t)
	isolateEnv(t, home)
	zipPath := filepath.Join(t.TempDir(), "b.zip")
	var so, se bytes.Buffer
	o, _ := ParseBackup([]string{"--out", zipPath})
	RunBackup(o, &so, &se)

	if err := os.WriteFile(filepath.Join(home, "workspace.json"), []byte("지금 값"), 0o600); err != nil {
		t.Fatal(err)
	}
	so.Reset()
	se.Reset()
	ro, _ := ParseRestore([]string{zipPath})
	if code := RunRestore(ro, &so, &se); code == 0 {
		t.Error("확인 없이 복원했다")
	}
	got, _ := os.ReadFile(filepath.Join(home, "workspace.json"))
	if string(got) != "지금 값" {
		t.Errorf("확인 없이 덮었다: %q", got)
	}
	if !strings.Contains(so.String()+se.String(), "--yes") {
		t.Error("되돌리는 길을 안내하지 않았다")
	}
}

// zip 밖으로 나가는 경로는 거부한다 — 복원이 홈 밖의 파일을 덮으면 그것은
// 복원이 아니라 임의 쓰기다 (zip slip).
func TestRestoreRejectsPathEscape(t *testing.T) {
	home := t.TempDir()
	isolateEnv(t, home)
	zipPath := filepath.Join(t.TempDir(), "evil.zip")
	f, err := os.Create(zipPath)
	if err != nil {
		t.Fatal(err)
	}
	zw := zip.NewWriter(f)
	for _, name := range []string{"../escaped.json", "/abs.json", "notes/../../out.json"} {
		w, err := zw.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		w.Write([]byte("x"))
	}
	zw.Close()
	f.Close()

	var so, se bytes.Buffer
	ro, _ := ParseRestore([]string{zipPath, "--yes"})
	RunRestore(ro, &so, &se)

	outside := filepath.Join(filepath.Dir(home), "escaped.json")
	if _, err := os.Stat(outside); err == nil {
		t.Fatal("홈 밖에 파일이 생겼다 — zip slip")
	}
	if !strings.Contains(so.String()+se.String(), "건너뜀") {
		t.Errorf("건너뛴 사실을 알리지 않았다:\n%s%s", so.String(), se.String())
	}
}
