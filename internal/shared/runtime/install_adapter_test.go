package runtime

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"dongminal/internal/shared/agentadapter"
)

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
		for _, banned := range []string{"$HOME/.claude", "~/.claude", "$HOME/.codex", "~/.codex", "AGENTS.md"} {
			if strings.Contains(s, banned) {
				t.Errorf("%s: 사용자 영구 설정 경로가 등장했다: %q (FR-ADP-5)", rel, banned)
			}
		}
	}
}

// Install 이 사용자 홈에 아무것도 쓰지 않는다는 것을 실제 파일시스템으로 확인한다.
// 위 문자열 대조는 셸 래퍼만 보므로, 설치 경로 자체가 새는 경우를 놓친다.
func TestInstallWritesNothingOutsideItsBinDir(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	claudeDir := filepath.Join(home, ".claude")
	if err := os.MkdirAll(claudeDir, 0o755); err != nil {
		t.Fatal(err)
	}
	settings := filepath.Join(claudeDir, "settings.json")
	if err := os.WriteFile(settings, []byte(`{"hooks":{}}`), 0o644); err != nil {
		t.Fatal(err)
	}

	if err := Install(t.TempDir()); err != nil {
		t.Fatalf("Install: %v", err)
	}

	got, err := os.ReadFile(settings)
	if err != nil {
		t.Fatalf("사용자 설정이 사라졌다: %v", err)
	}
	if string(got) != `{"hooks":{}}` {
		t.Fatalf("사용자의 영구 설정이 수정됐다 (FR-ADP-5): %s", got)
	}
	entries, err := os.ReadDir(claudeDir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("~/.claude 에 파일이 생겼다: %d개", len(entries))
	}
}
