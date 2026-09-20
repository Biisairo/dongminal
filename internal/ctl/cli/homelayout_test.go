package cli

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// M5 `G4-3`·`G3-4` — 홈의 구성은 **한 곳**에서 선언된다.
//
// `backup` 이 담을 것과 `uninstall` 이 지울 것은 같은 물음의 두 답이다
// ("무엇이 이 제품의 것인가"). 두 벌로 적으면 한쪽만 고쳐지고, 그때 백업은
// 담지 않은 것을 제거는 지운다 — **되돌릴 수 없는 손실**이다.

func TestHomeLayoutCoversKnownFiles(t *testing.T) {
	names := map[string]bool{}
	for _, e := range homeLayout() {
		if names[e.Name] {
			t.Errorf("항목이 두 번 나온다: %s", e.Name)
		}
		names[e.Name] = true
		if e.What == "" {
			t.Errorf("%s 에 설명이 없다 — 목록이 안내이기도 하다", e.Name)
		}
	}
	// 이 저장소가 이미 아는 이름들은 전부 표에 있어야 한다.
	for _, n := range rollbackTargets {
		if !names[n] {
			t.Errorf("되돌릴 수 있는 %s 가 홈 구성표에 없다", n)
		}
	}
	for _, n := range homeLogs {
		if !names[n] {
			t.Errorf("로그 %s 가 홈 구성표에 없다", n)
		}
	}
}

// 백업은 **되살릴 수 있는 것만** 담는다. 소켓·pid·로그는 다음 기동이 다시
// 만드는 것이라 담아도 뜻이 없고, 소켓은 zip 에 담기지도 않는다.
func TestBackupExcludesEphemeral(t *testing.T) {
	for _, e := range homeLayout() {
		if !e.Backup {
			continue
		}
		if e.Ephemeral {
			t.Errorf("%s 는 다시 만들어지는 것인데 백업 대상이다", e.Name)
		}
	}
	// 소켓·pid·로그가 실제로 빠졌는지 이름으로 확인한다 (DoD 의 문구).
	for _, n := range []string{daemonSockFile, daemonPIDFile, "server.log", "daemon.log"} {
		if inBackup(n) {
			t.Errorf("%s 가 백업에 담긴다", n)
		}
	}
	for _, n := range []string{"workspace.json", "settings.json", "access.json"} {
		if !inBackup(n) {
			t.Errorf("%s 가 백업에서 빠졌다", n)
		}
	}
}

func inBackup(name string) bool {
	for _, e := range homeLayout() {
		if e.Name == name {
			return e.Backup
		}
	}
	return false
}

// `uninstall --dry-run` 은 **지우지 않는다.** 목록만 낸다.
func TestUninstallDryRunTouchesNothing(t *testing.T) {
	home := t.TempDir()
	for _, n := range []string{"workspace.json", "settings.json", "server.log"} {
		if err := os.WriteFile(filepath.Join(home, n), []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	isolateEnv(t, home)

	var out, errw bytes.Buffer
	o, err := ParseUninstall([]string{"--dry-run"})
	if err != nil {
		t.Fatal(err)
	}
	if code := RunUninstall(o, &out, &errw); code != 0 {
		t.Fatalf("exit %d: %s", code, errw.String())
	}
	if !strings.Contains(out.String(), "workspace.json") {
		t.Errorf("목록에 workspace.json 이 없다:\n%s%s", out.String(), errw.String())
	}
	for _, n := range []string{"workspace.json", "settings.json", "server.log"} {
		if _, err := os.Stat(filepath.Join(home, n)); err != nil {
			t.Errorf("--dry-run 이 %s 를 지웠다", n)
		}
	}
}

// `--dry-run` 없이 부르면 **확인을 요구한다.** 되돌릴 수 없는 동작이다.
func TestUninstallRequiresConfirmation(t *testing.T) {
	home := t.TempDir()
	// **되살릴 수 있는 것과 다시 만들어지는 것을 둘 다 둔다.** 앞의 것은
	// `--purge` 없이는 계획에 들지 않으므로, 그것만 두면 "지울 것이 없다" 로
	// 끝나고 이 검사는 아무것도 재지 못한다.
	for _, n := range []string{"workspace.json", "server.log"} {
		if err := os.WriteFile(filepath.Join(home, n), []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	isolateEnv(t, home)
	var out, errw bytes.Buffer
	o, _ := ParseUninstall(nil)
	if code := RunUninstall(o, &out, &errw); code == 0 {
		t.Error("확인 없이 성공으로 끝났다")
	}
	for _, n := range []string{"workspace.json", "server.log"} {
		if _, err := os.Stat(filepath.Join(home, n)); err != nil {
			t.Errorf("확인 없이 %s 를 지웠다", n)
		}
	}
	if !strings.Contains(out.String()+errw.String(), "--yes") {
		t.Errorf("되돌리는 길을 안내하지 않았다:\n%s%s", out.String(), errw.String())
	}
}

// STRUCTURE_CLEANUP_SRS 묶음 C · TC-STR-12.
//
// **`Backup` 은 뜻이 둘인 필드다.** `backup` 에게는 "zip 에 담는가" 이고
// `uninstall` 에게는 **"보존하는가"** 다 (`uninstallPlan` 이 `e.Backup && !purge`
// 로 거른다). 뜻이 둘이면 되돌릴 수 없는 쪽을 따라야 한다 — `git-worktrees` 는
// 사용자가 Git 창에서 만든 worktree 이고 거기에는 커밋하지 않은 작업이 산다.
func TestUserWorktreesSurvivePlainUninstall(t *testing.T) {
	home := t.TempDir()
	if err := os.MkdirAll(filepath.Join(home, "git-worktrees", "feature-x"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, "ext"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}

	plain := uninstallPlan(home, false)
	for _, it := range plain {
		if it.entry.Name == "git-worktrees" {
			t.Error("맨 uninstall 이 사용자 worktree 를 지운다")
		}
	}
	// `--purge` 는 지운다 — 그때는 사용자가 명시적으로 요구한 것이다.
	var purged bool
	for _, it := range uninstallPlan(home, true) {
		if it.entry.Name == "git-worktrees" {
			purged = true
		}
	}
	if !purged {
		t.Error("--purge 가 사용자 worktree 를 남긴다 — '전부 지웠습니다' 가 거짓이 된다")
	}
	// 다시 받을 수 있는 것은 맨 uninstall 이 가져간다. 종전에는 표에 없어서
	// **아무도 지우지 않았고**, 그 자리에 언어 서버 수백 MB 가 남았다.
	var extPlanned bool
	for _, it := range plain {
		if it.entry.Name == "ext" {
			extPlanned = true
		}
	}
	if !extPlanned {
		t.Error("ext 가 계획에 없다 — uninstall 이 '전부 지웠습니다' 하고 남긴다")
	}
}

// 표가 **전수**인지는 `scripts/check-home-layout.sh` 가 코드에서 파생해 센다.
// 여기서는 그 검사가 찾아낸 열하나가 실제로 들어왔는지만 잠근다 — 표에서
// 지워지면 게이트보다 이 검사가 먼저 말한다.
func TestHomeLayoutHasDerivedEntries(t *testing.T) {
	names := map[string]bool{}
	for _, e := range homeLayout() {
		names[e.Name] = true
	}
	for _, n := range []string{
		"git-worktrees", "panes.json", "worktrees", "ext", "cache",
		toolHomeDir, "doctor", "doctor-tools", "doctor-probe.txt", "verify-too-large.bin",
	} {
		if !names[n] {
			t.Errorf("홈에 쓰는 %s 가 표에 없다 (FR-STR-30)", n)
		}
	}
}
