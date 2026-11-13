//go:build !windows

package runtime

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"dongminal/internal/shared/agentadapter"
	"dongminal/internal/shared/dmenv"
	"dongminal/internal/shared/testpath"
)

// POSIX 전용 검사 (WINDOWS_TEST_PARITY_SRS FR-WTP-30·31).
//
// installShellHooks 는 **이 OS 의 훅만** 푼다 (FR-XSH-4). Windows 에서는
// powershell-hook.ps1 이 깔리고 bash-hook.sh·zdotdir/.zshrc 는 아예 없다 —
// 없는 파일을 찾는 검사가 Windows 에서 돌던 것이 잘못이었다.
//
// FR-WTP-32 — 이 조건에서 Windows 가 잃는 보증: bash/zsh 훅의 전개와 그 권한,
// 그리고 정책 주입 선언이 그 래퍼와 일치하는지. 임베드·전개 자체는 OS 무관하게
// install_shellhooks_test.go 가 본다.

// shellWrappers reads the installed wrappers that actually inject policy.
func shellWrappers(t *testing.T) map[string]string {
	t.Helper()
	dir := t.TempDir()
	if err := Install(dir); err != nil {
		t.Fatalf("Install: %v", err)
	}
	out := map[string]string{}
	for _, rel := range []string{"bash-hook.sh", "zdotdir/.zshrc"} {
		blob, err := os.ReadFile(filepath.Join(dir, rel))
		if err != nil {
			t.Fatalf("read %s: %v", rel, err)
		}
		out[rel] = string(blob)
	}
	return out
}

func TestInstallShellHooks(t *testing.T) {
	dir := t.TempDir()
	if err := Install(dir); err != nil {
		t.Fatalf("Install: %v", err)
	}
	want := map[string]os.FileMode{
		"bash-hook.sh":            0o755,
		"zdotdir/.zshrc":          0o644,
		"agent-hooks/claude.json": 0o644,
	}
	for rel, wantMode := range want {
		info, err := os.Stat(filepath.Join(dir, rel))
		if err != nil {
			t.Errorf("missing %s: %v", rel, err)
			continue
		}
		if got := info.Mode().Perm(); got != wantMode {
			t.Errorf("%s: mode=%o want=%o", rel, got, wantMode)
		}
	}
	// The installed claude hooks file must be valid JSON (claude --settings
	// rejects malformed input, which would break the wrapper).
	blob, err := os.ReadFile(filepath.Join(dir, "agent-hooks/claude.json"))
	if err != nil {
		t.Fatalf("read claude.json: %v", err)
	}
	var parsed any
	if err := json.Unmarshal(blob, &parsed); err != nil {
		t.Fatalf("claude.json is not valid JSON: %v", err)
	}
	// Hook commands must reference dmctl by absolute path (PATH-independent),
	// 그리고 그 경로는 인용된다 (HOST_PARITY_SRS FR-HPR-4).
	// 재는 것은 **절대 경로로 부르는가**이다. 종전에는 `notify` 로 쟀는데 그
	// 배선이 사라졌으므로(FR-AEV-20) 같은 뜻을 `activity` 로 잰다.
	wantCmd := (agentadapter.InstallSpec{Dmctl: filepath.Join(dir, "dmctl")}).HookCommand("activity")
	if !strings.Contains(string(blob), testpath.JSONInner(wantCmd)) {
		t.Fatalf("claude.json should invoke %q, got:\n%s", wantCmd, blob)
	}
}

// FR-ADP-1: 레지스트리의 policyInjection 선언과 실제 주입기(셸 래퍼)가 어긋나면
// 여기서 걸린다. 이 대조가 없으면 선언은 아무도 읽지 않는 산문이 된다 — 코드에
// 없고 스킬 산문에만 있던 예전 상태로 되돌아가는 것이다.
func TestPolicyInjectionDeclarationMatchesShellWrappers(t *testing.T) {
	wrappers := shellWrappers(t)
	for _, id := range agentadapter.IDs() {
		ad, err := agentadapter.Get(id)
		if err != nil {
			t.Fatal(err)
		}
		for rel, s := range wrappers {
			// CLAUDE_ACCOUNTS_SRS D-CAC-24: shim 이 주입하는 에이전트는 셸 함수가 없어야 한다.
			// 주입 인자의 대조는 shim 쪽 시험(runtimebin TC-CAC-20)이 한다.
			if ad.PolicyInjection.Shim {
				if strings.Contains(s, ad.DetectCmd+"()") {
					t.Errorf("%s: %q 셸 함수가 남았다 — shim 이 주입한다", rel, ad.DetectCmd)
				}
				continue
			}
			if !strings.Contains(s, ad.DetectCmd+"()") {
				t.Errorf("%s: %q 래퍼 함수가 없다 — 선언과 주입기가 어긋났다", rel, ad.DetectCmd)
				continue
			}
			for _, flag := range ad.PolicyInjection.Flags {
				if !strings.Contains(s, flag) {
					t.Errorf("%s: %q 가 선언한 %q 를 래퍼가 붙이지 않는다", rel, id, flag)
				}
			}
			// 투명 위임이어야 한다 — 래퍼가 실제 바이너리를 부르지 않으면 자기재귀다.
			if !strings.Contains(s, "command "+ad.DetectCmd) {
				t.Errorf("%s: %q 래퍼가 실제 바이너리를 위임 호출하지 않는다", rel, id)
			}
		}
	}
}

// TC-ADP-3 / FR-ADP-5: 정책 주입은 세션 스코프다. 주입 산출물은 전부
// $DONGMINAL_HOME 아래에 있어야 하고, 사용자의 영구 설정 경로가 셸 래퍼에
// 등장해서는 안 된다 — 참조 구현이 영구 설정에 쓰는 대가로 떠안은 설치 잠금·
// 소유자 신원·드리프트 검출 기계를 우리는 지지 않기로 했다.
func TestPolicyInjectionNeverTouchesUserPermanentSettings(t *testing.T) {
	for rel, s := range shellWrappers(t) {
		if !strings.Contains(s, "DONGMINAL_HOME") {
			t.Errorf("%s: 주입 산출물이 DONGMINAL_HOME 아래가 아니다", rel)
		}
		// omp 도 같은 규약이다 (OMP_AGENT_SUPPORT_SRS NFR-OMP-1) — 특히
		// `~/.omp/agent/hooks/` 는 omp 의 **자동 탐색** 디렉터리이므로 거기에
		// 파일을 두는 것이 곧 "사용자의 설치에 파일을 추가하는 일" 이다.
		for _, banned := range []string{
			"$HOME/.claude", "~/.claude", "$HOME/.codex", "~/.codex", "AGENTS.md",
			"$HOME/.omp", "~/.omp", ".omp/agent",
		} {
			if strings.Contains(s, banned) {
				t.Errorf("%s: 사용자 영구 설정 경로가 등장했다: %q (FR-ADP-5)", rel, banned)
			}
		}
	}
}

// CLAUDE_ACCOUNTS_SRS TC-CAC-20: 설치가 `agent-shims/claude` 를 깔고, 없어지면 점검이 알린다.
func TestInstallPlacesClaudeShim(t *testing.T) {
	dir := t.TempDir()
	if err := Install(dir); err != nil {
		t.Fatalf("Install: %v", err)
	}
	shim := filepath.Join(dmenv.AgentShimsDirIn(dir), "claude")
	st, err := os.Stat(shim)
	if err != nil || !st.Mode().IsRegular() || st.Mode().Perm()&0o111 == 0 {
		t.Fatalf("shim: %v %v", st, err)
	}
	if hs := InspectHelpers(dir); len(hs.Problems) != 0 {
		t.Fatalf("problems after install: %+v", hs.Problems)
	}
	if err := os.Remove(shim); err != nil {
		t.Fatal(err)
	}
	if hs := InspectHelpers(dir); len(hs.Problems) != 1 || hs.Problems[0].Name != "claude" {
		t.Fatalf("missing shim not reported: %+v", hs.Problems)
	}
	if err := EnsureInstalled(dir); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(shim); err != nil {
		t.Fatalf("EnsureInstalled did not restore shim: %v", err)
	}
}

// FR-CAC-83: 사용자 rc 뒤에 shim 폴더를 PATH 맨 앞에 넣고, 프롬프트마다 다시 맨 앞으로 옮긴다(중복 없이).
func TestShellHooksPutShimsFirst(t *testing.T) {
	// 훅은 `$DONGMINAL_HOME/bin` 을 본다 — 실제 배치와 같은 이름이어야 한다.
	bin := filepath.Join(t.TempDir(), "bin")
	if err := installShellHooks(bin); err != nil {
		t.Fatal(err)
	}
	shims := dmenv.AgentShimsDirIn(bin)
	home := t.TempDir()
	rc := "export PATH=/rc/first:$PATH\n"
	for _, f := range []string{".bashrc", ".zshrc"} {
		if err := os.WriteFile(filepath.Join(home, f), []byte(rc), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	// 로드 직후 맨 앞, 사용자가 앞에 넣은 뒤 프롬프트 훅을 한 번 돌리면 다시 맨 앞, 한 번만.
	script := `echo "$PATH"; PATH="/user/late:$PATH"; _dm_shim_front; _dm_shim_front; echo "$PATH"`
	type shellCase struct {
		name string
		argv []string
		env  []string
	}
	cases := []shellCase{
		{"bash", []string{"--rcfile", filepath.Join(bin, "bash-hook.sh"), "-i", "-c", script}, nil},
		{"zsh", []string{"-i", "-c", script}, []string{"ZDOTDIR=" + filepath.Join(bin, "zdotdir")}},
	}
	for _, c := range cases {
		sh, err := exec.LookPath(c.name)
		if err != nil {
			continue
		}
		cmd := exec.Command(sh, c.argv...)
		cmd.Env = append(append(os.Environ(), "HOME="+home, "DONGMINAL_HOME="+filepath.Dir(bin)), c.env...)
		out, err := cmd.Output()
		if err != nil {
			t.Fatalf("%s: %v\n%s", c.name, err, out)
		}
		lines := strings.Split(strings.TrimSpace(string(out)), "\n")
		if len(lines) < 2 {
			t.Fatalf("%s: %q", c.name, out)
		}
		for _, l := range lines[len(lines)-2:] {
			parts := strings.Split(l, ":")
			if parts[0] != shims {
				t.Errorf("%s: shim 폴더가 맨 앞이 아니다: %s", c.name, l)
			}
			if n := strings.Count(":"+l+":", ":"+shims+":"); n != 1 {
				t.Errorf("%s: shim 폴더가 %d 번 있다: %s", c.name, n, l)
			}
		}
		if !strings.Contains(lines[len(lines)-2], "/rc/first") {
			t.Errorf("%s: 사용자 rc 를 읽지 않았다: %s", c.name, lines[len(lines)-2])
		}
	}
}
