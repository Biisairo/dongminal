package runtime

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"dongminal/internal/shared/testpath"
)

// SKILL_INJECTION_SRS 묶음 C·D 검증 (V-C1, V-C2, V-D1).

// FR-INJ-1/2: 플러그인 루트가 Claude Code 가 요구하는 레이아웃으로 전개되는지.
// `all:` 없는 go:embed 는 .claude-plugin/ 을 빼먹으므로 그 회귀를 여기서 잡는다.
func TestInstallAgentPlugin_Layout(t *testing.T) {
	dir := t.TempDir()
	if err := Install(dir); err != nil {
		t.Fatalf("Install: %v", err)
	}
	plugin := AgentPluginDir(dir)

	want := map[string]os.FileMode{
		".claude-plugin/plugin.json":         0o644,
		"skills/team/SKILL.md":               0o644,
		"skills/workflow/SKILL.md":           0o644,
		"skills/team/scripts/plan_layout.py": 0o755,
		"hooks/hooks.json":                   0o644,
	}
	for rel, wantMode := range want {
		info, err := os.Stat(filepath.Join(plugin, rel))
		if err != nil {
			t.Errorf("missing %s: %v", rel, err)
			continue
		}
		// 존재는 어느 OS 에서나 본다. 권한 비트는 NTFS 에 없으므로 그때만
		// 건너뛴다 (FR-WTP-31).
		if !testpath.PermChecked() {
			continue
		}
		if got := info.Mode().Perm(); got != wantMode {
			t.Errorf("%s: mode=%o want=%o", rel, got, wantMode)
		}
	}
}

// FR-INJ-1: 매니페스트의 name 이 스킬 호출명의 네임스페이스가 된다
// (/dongminal:team). 이 값이 바뀌면 스킬 본문의 상호 참조가 전부 깨진다.
func TestInstallAgentPlugin_ManifestName(t *testing.T) {
	dir := t.TempDir()
	if err := Install(dir); err != nil {
		t.Fatalf("Install: %v", err)
	}
	blob, err := os.ReadFile(filepath.Join(AgentPluginDir(dir), ".claude-plugin/plugin.json"))
	if err != nil {
		t.Fatalf("read plugin.json: %v", err)
	}
	var manifest struct {
		Name string `json:"name"`
	}
	if err := json.Unmarshal(blob, &manifest); err != nil {
		t.Fatalf("plugin.json is not valid JSON: %v", err)
	}
	if manifest.Name != "dongminal" {
		t.Fatalf("plugin name=%q want dongminal (스킬 호출명 /dongminal:team 의 근거)", manifest.Name)
	}
}

// FR-SK-1: 스킬 frontmatter 의 name 이 호출명을 결정한다.
func TestInstallAgentPlugin_SkillNames(t *testing.T) {
	dir := t.TempDir()
	if err := Install(dir); err != nil {
		t.Fatalf("Install: %v", err)
	}
	for rel, wantName := range map[string]string{
		"skills/team/SKILL.md":     "name: team",
		"skills/workflow/SKILL.md": "name: workflow",
	} {
		blob, err := os.ReadFile(filepath.Join(AgentPluginDir(dir), rel))
		if err != nil {
			t.Fatalf("read %s: %v", rel, err)
		}
		if !strings.Contains(string(blob), wantName) {
			t.Errorf("%s frontmatter 에 %q 없음", rel, wantName)
		}
	}
}

// FR-CTX-2: SessionStart 훅이 dmctl 을 절대 경로로 호출해야 한다. PATH 앞쪽의 낡은
// dmctl 은 agent-context 를 모른다.
func TestInstallAgentPlugin_Hooks(t *testing.T) {
	dir := t.TempDir()
	if err := Install(dir); err != nil {
		t.Fatalf("Install: %v", err)
	}
	blob, err := os.ReadFile(filepath.Join(AgentPluginDir(dir), "hooks/hooks.json"))
	if err != nil {
		t.Fatalf("read hooks.json: %v", err)
	}
	var parsed struct {
		Hooks map[string]any `json:"hooks"`
	}
	if err := json.Unmarshal(blob, &parsed); err != nil {
		t.Fatalf("hooks.json is not valid JSON: %v", err)
	}
	if _, ok := parsed.Hooks["SessionStart"]; !ok {
		t.Fatalf("hooks.json must wire SessionStart, got: %v", parsed.Hooks)
	}
	want := dmctlPath(dir) + " agent-context"
	if !strings.Contains(string(blob), testpath.JSONInner(want)) {
		t.Fatalf("hooks.json should invoke %q, got:\n%s", want, blob)
	}
}

// FR-CTX-4: 플러그인 훅과 --settings 훅은 서로 다른 파일에 있어야 한다. 한쪽이
// 다른 쪽을 덮어써 활동 보고나 컨텍스트 주입이 사라지면 안 된다.
func TestInstallAgentPlugin_HooksCoexistWithSettings(t *testing.T) {
	dir := t.TempDir()
	if err := Install(dir); err != nil {
		t.Fatalf("Install: %v", err)
	}
	pluginHooks, err := os.ReadFile(filepath.Join(AgentPluginDir(dir), "hooks/hooks.json"))
	if err != nil {
		t.Fatalf("read plugin hooks: %v", err)
	}
	settings, err := os.ReadFile(filepath.Join(dir, "agent-hooks/claude.json"))
	if err != nil {
		t.Fatalf("read settings hooks: %v", err)
	}
	if strings.Contains(string(pluginHooks), "activity claude") {
		t.Error("플러그인 훅이 활동 보고를 중복 등록했다 — --settings 의 몫이다")
	}
	if strings.Contains(string(settings), "agent-context") {
		t.Error("--settings 훅이 컨텍스트 주입을 중복 등록했다 — 플러그인의 몫이다")
	}
}

// FR-INJ-4/5: 셸 래퍼가 두 주입을 독립적으로 판단해야 한다. 한쪽 산출물이 없어도
// FR-INJ-3: 재설치가 전개물을 갱신해야 한다 (바이너리 갱신 시 스킬도 따라간다).
func TestInstallAgentPlugin_Overwrites(t *testing.T) {
	dir := t.TempDir()
	if err := Install(dir); err != nil {
		t.Fatalf("Install #1: %v", err)
	}
	skill := filepath.Join(AgentPluginDir(dir), "skills/team/SKILL.md")
	if err := os.WriteFile(skill, []byte("stale"), 0o644); err != nil {
		t.Fatalf("write stale: %v", err)
	}
	if err := Install(dir); err != nil {
		t.Fatalf("Install #2: %v", err)
	}
	blob, err := os.ReadFile(skill)
	if err != nil {
		t.Fatalf("read skill: %v", err)
	}
	if string(blob) == "stale" {
		t.Fatal("재설치가 전개물을 갱신하지 않았다")
	}
}

// FR-INJ-3: 설치는 임베드 트리의 **거울**이다. 임베드에서 사라진 파일은 설치
// 트리에서도 사라져야 한다 — 옛 세션이 그 경로를 그대로 실행할 수 있기 때문이다.
// 실측(2026-08-25): b3dc910 에서 지운 build_prompt.py·references/prompt.md 가
// 설치 트리에 남아 있었다.
func TestInstallAgentPlugin_PrunesStaleAssets(t *testing.T) {
	dir := t.TempDir()
	if err := Install(dir); err != nil {
		t.Fatalf("Install: %v", err)
	}
	plugin := AgentPluginDir(dir)

	stale := []string{
		"skills/team/scripts/build_prompt.py",
		"skills/team/references/prompt.md",
		"skills/gone/SKILL.md",
	}
	for _, rel := range stale {
		p := filepath.Join(plugin, rel)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatalf("mkdir: %v", err)
		}
		if err := os.WriteFile(p, []byte("옛 자산"), 0o755); err != nil {
			t.Fatalf("write: %v", err)
		}
	}

	if err := Install(dir); err != nil {
		t.Fatalf("재설치: %v", err)
	}

	for _, rel := range stale {
		if _, err := os.Stat(filepath.Join(plugin, rel)); !os.IsNotExist(err) {
			t.Errorf("스테일 자산이 남았다: %s (err=%v)", rel, err)
		}
	}
	if _, err := os.Stat(filepath.Join(plugin, "skills/gone")); !os.IsNotExist(err) {
		t.Errorf("비게 된 디렉터리가 남았다: skills/gone")
	}
	// 반증: 임베드된 자산과 설치 시 **생성**되는 훅 설정은 살아 있어야 한다.
	for _, rel := range []string{
		"skills/team/SKILL.md",
		"skills/team/scripts/plan_layout.py",
		".claude-plugin/plugin.json",
		"hooks/hooks.json",
	} {
		if _, err := os.Stat(filepath.Join(plugin, rel)); err != nil {
			t.Errorf("정리가 정상 자산을 지웠다: %s: %v", rel, err)
		}
	}
}

// 정리 범위는 플러그인 트리 안이다. bin/ 에는 helper symlink·shell hook·
// agent-hooks 처럼 임베드 트리에 없는 것들이 정상적으로 함께 산다.
func TestInstall_DoesNotPruneBinDir(t *testing.T) {
	dir := t.TempDir()
	if err := Install(dir); err != nil {
		t.Fatalf("Install: %v", err)
	}
	mine := filepath.Join(dir, "user-file.txt")
	if err := os.WriteFile(mine, []byte("사용자 파일"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	if err := Install(dir); err != nil {
		t.Fatalf("재설치: %v", err)
	}
	for _, rel := range []string{"user-file.txt", "agent-hooks/claude.json", helperFile("dmctl")} {
		if _, err := os.Lstat(filepath.Join(dir, rel)); err != nil {
			t.Errorf("bin/ 의 %s 가 사라졌다: %v", rel, err)
		}
	}
}
