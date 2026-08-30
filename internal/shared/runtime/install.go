// Package runtime는 dongminal 이 런타임에 배포하는 헬퍼들을 설치한다.
//
// helper CLI (dmctl, edit, download, detach) 는 multi-call 방식으로 dongminal
// 바이너리 자체가 처리하므로, $DONGMINAL_HOME/bin/<name> 은 dongminal 실행
// 파일을 가리키는 symlink (지원되지 않는 환경에선 복사) 로 만든다.
//
// shell hook (bash-hook.sh, zdotdir/.zshrc) 은 shell 문법이 필수이므로
// 임베드된 파일을 그대로 풀어둔다.
package runtime

import (
	"embed"
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"path"
	"path/filepath"

	"dongminal/internal/helper/runtimebin"
	"dongminal/internal/shared/platform"
)

//go:embed all:shellhooks
var shellhookFS embed.FS

// shellHookRoot 는 임베드 트리에서 훅이 사는 곳이다. 그 아래가 OS 별로 갈린다.
const shellHookRoot = "shellhooks"

// agentplugin 은 Claude Code 플러그인 루트다. `all:` 접두사가 없으면 점으로 시작하는
// .claude-plugin/ 이 임베드에서 빠진다 (SKILL_INJECTION_SRS FR-INJ-2).
//
//go:embed all:agentplugin
var agentPluginFS embed.FS

// helperNames는 multi-call 로 등록된 helper 명. runtimebin 과 동기화 유지.
func helperNames() []string { return runtimebin.HelperNames() }

// Install은 helper symlink + shell hook 파일을 binDir 에 설치한다.
// selfExe 가 비어있으면 os.Executable() 결과를 사용한다.
func Install(binDir string) error {
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		return fmt.Errorf("mkdir %s: %w", binDir, err)
	}
	if err := installShellHooks(binDir); err != nil {
		return err
	}
	self, err := os.Executable()
	if err != nil {
		return fmt.Errorf("os.Executable: %w", err)
	}
	if resolved, err := filepath.EvalSymlinks(self); err == nil {
		self = resolved
	}
	paths := platform.Current().Paths
	for _, name := range helperNames() {
		// 확장자는 설치 시점에만 붙인다. helperNames() 는 multi-call 디스패치가
		// 보는 이름이며 그쪽에는 확장자가 없다 (FR-XPA-3).
		dst := filepath.Join(binDir, name+paths.ExeSuffix())
		if err := paths.LinkOrCopy(self, dst); err != nil {
			return fmt.Errorf("install helper %s: %w", name, err)
		}
	}
	if err := installAgentHooks(binDir); err != nil {
		return fmt.Errorf("install agent hooks: %w", err)
	}
	if err := installAgentPlugin(binDir); err != nil {
		return fmt.Errorf("install agent plugin: %w", err)
	}
	return nil
}

// AgentPluginDir는 세션 스코프로 주입되는 Claude Code 플러그인의 경로다. 셸 래퍼가
// `claude --plugin-dir <이 경로>` 로 붙인다 (SKILL_INJECTION_SRS FR-INJ-4).
func AgentPluginDir(binDir string) string { return filepath.Join(binDir, "agent-plugin") }

// installAgentPlugin은 임베드된 플러그인(스킬 + 매니페스트)을 전개하고, 그 안에
// SessionStart 훅을 생성한다 (FR-INJ-1, FR-CTX-2).
//
// 이 플러그인은 사용자의 ~/.claude 에 설치되지 않는다. dongminal 이 띄운 PTY 의
// claude() 래퍼만 --plugin-dir 로 참조하므로, 주입 범위가 그 세션으로 한정된다.
//
// 전개 뒤에는 임베드 트리에 없는 것을 지운다. 설치 트리는 임베드 트리의
// **거울**이어야 한다 — 삭제된 스킬 자산이 남아 있으면 그 경로를 그대로 쓰는
// 옛 세션이 사라진 스크립트를 실행한다 (실측 2026-08-25: b3dc910 에서 지운
// build_prompt.py 가 설치 트리에 남아 있었다).
func installAgentPlugin(binDir string) error {
	dir := AgentPluginDir(binDir)
	if err := unpackEmbedded(agentPluginFS, "agentplugin", dir); err != nil {
		return err
	}
	if err := installAgentPluginHooks(binDir, dir); err != nil {
		return err
	}
	return pruneToEmbedded(agentPluginFS, "agentplugin", dir, generatedPluginPaths)
}

// generatedPluginPaths 는 임베드가 아니라 설치가 **만드는** 것들이다. 거울
// 비교에서 제외하지 않으면 방금 쓴 파일을 곧바로 지운다.
var generatedPluginPaths = []string{"hooks", "hooks/hooks.json"}

// pruneToEmbedded 는 dst 아래에서 임베드 트리(src/root)에도 keep 목록에도 없는
// 파일과 디렉터리를 지운다. 정리 범위는 dst 서브트리로 한정된다 — bin/ 에는
// helper symlink 나 agent-hooks 처럼 임베드에 없는 정상 자산이 함께 산다.
func pruneToEmbedded(src embed.FS, root, dst string, keep []string) error {
	want := map[string]bool{}
	for _, k := range keep {
		// keep 은 fs 형태(언제나 슬래시)로 적혀 있고, 아래에서 채우는 키는
		// filepath.Rel 이 만드는 OS 형태다. 두 형태를 섞으면 Windows 에서
		// "hooks/hooks.json" 이 "hooks\hooks.json" 과 달라 keep 에 걸리지
		// 않고, **설치할 때마다 방금 만든 hooks.json 을 지운다** (FR-WTP-2).
		// 한 조각짜리("hooks")는 두 형태가 같아 살아남으므로, 디렉터리만 남고
		// 안이 비는 모양으로 나타났다.
		want[filepath.FromSlash(k)] = true
	}
	if err := fs.WalkDir(src, root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(root, p)
		if rel != "." {
			want[rel] = true
		}
		return nil
	}); err != nil {
		return err
	}

	var extra []string
	if err := filepath.WalkDir(dst, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, relErr := filepath.Rel(dst, p)
		if relErr != nil || rel == "." {
			return nil
		}
		if !want[rel] {
			extra = append(extra, p)
			if d.IsDir() {
				return fs.SkipDir
			}
		}
		return nil
	}); err != nil {
		return err
	}
	for _, p := range extra {
		if err := os.RemoveAll(p); err != nil {
			return fmt.Errorf("prune %s: %w", p, err)
		}
	}
	return nil
}

// dmctlPath 는 훅이 부를 헬퍼의 **실제 파일 경로**다
// (WINDOWS_TEST_PARITY_SRS D6, FR-WTP-6).
//
// 설치는 헬퍼를 `name+ExeSuffix()` 로 깐다(위 installHelpers). 훅에 적는 경로가
// 확장자를 빼먹으면 Windows 에서 `...\bin\dmctl` 을 가리키는데 실재하는 것은
// `dmctl.exe` 다. cmd 의 PATHEXT 해석이 이것을 가려 줄 수는 있으나, 그것은
// 훅을 무엇이 실행하느냐에 달린 우연이다 — 같은 이름을 두 곳에서 다르게
// 만들지 않는다.
func dmctlPath(binDir string) string {
	return filepath.Join(binDir, "dmctl"+platform.Current().Paths.ExeSuffix())
}

// installAgentPluginHooks writes the plugin's SessionStart hook. dmctl is
// referenced by absolute path for the same reason installAgentHooks does it —
// a stale dmctl earlier in PATH would not understand `agent-context`.
func installAgentPluginHooks(binDir, pluginDir string) error {
	hooksDir := filepath.Join(pluginDir, "hooks")
	if err := os.MkdirAll(hooksDir, 0o755); err != nil {
		return err
	}
	settings := map[string]any{
		"hooks": map[string]any{
			"SessionStart": []any{map[string]any{
				"matcher": "",
				"hooks": []any{map[string]any{
					"type":    "command",
					"command": dmctlPath(binDir) + " agent-context",
				}},
			}},
		},
	}
	blob, err := json.MarshalIndent(settings, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(hooksDir, "hooks.json"), blob, 0o644)
}

// installAgentHooks writes the Claude Code hooks settings file used by the
// transparent `claude` wrapper (PANE_ATTENTION_NOTIFY_SRS FR-PAN-19). The hook
// commands reference dmctl by absolute path so they resolve to THIS instance's
// helper regardless of PATH ordering (a stale dmctl earlier in PATH would not
// understand `notify`).
func installAgentHooks(binDir string) error {
	dir := filepath.Join(binDir, "agent-hooks")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	dmctl := dmctlPath(binDir)
	notifyHook := func(label string) map[string]any {
		return map[string]any{"type": "command", "command": dmctl + " notify " + label}
	}
	activityHook := map[string]any{"type": "command", "command": dmctl + " activity claude"}
	event := func(hooks ...any) any {
		return []any{map[string]any{"matcher": "", "hooks": hooks}}
	}
	settings := map[string]any{
		"hooks": map[string]any{
			"SessionStart":     event(activityHook),
			"SessionEnd":       event(activityHook),
			"UserPromptSubmit": event(activityHook),
			"PreToolUse":       event(activityHook),
			"PostToolUse":      event(activityHook),
			"PreCompact":       event(activityHook),
			"SubagentStop":     event(activityHook),
			"Stop":             event(notifyHook("done"), activityHook),
			"Notification":     event(notifyHook("waiting"), activityHook),
		},
	}
	blob, err := json.MarshalIndent(settings, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, "claude.json"), blob, 0o644)
}

// installShellHooks 는 **이 OS 의** 훅만 푼다. 모든 OS 의 훅을 다 풀면 쓰이지도
// 않는 파일이 binDir 에 쌓이고, 어느 것이 살아 있는지 알 수 없게 된다
// (CROSS_PLATFORM_SRS FR-XSH-4).
//
// 푸는 위치는 종전과 같다 — <binDir>/bash-hook.sh 는 그대로다. 바뀐 것은
// 임베드 트리의 소스 자리뿐이라, 살아 있는 도구의 BASH_ENV 가 깨지지 않는다.
func installShellHooks(binDir string) error {
	root := path.Join(shellHookRoot, platform.Current().Shell.HookRoot())
	return unpackEmbedded(shellhookFS, root, binDir)
}

// unpackEmbedded는 embedded FS 의 root 서브트리를 dst 아래로 전개한다. 매 호출마다
// 덮어쓰므로 바이너리가 갱신되면 전개물도 함께 갱신된다. 실행 가능해야 하는
// 확장자(.sh, .py)만 0755 이고 나머지는 0644 다 (FR-INJ-3).
func unpackEmbedded(src embed.FS, root, dst string) error {
	return fs.WalkDir(src, root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(root, p)
		if rel == "." {
			return nil
		}
		target := filepath.Join(dst, rel)
		if d.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		data, err := src.ReadFile(p)
		if err != nil {
			return err
		}
		mode := os.FileMode(0o644)
		switch filepath.Ext(rel) {
		case ".sh", ".py":
			mode = 0o755
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return err
		}
		return os.WriteFile(target, data, mode)
	})
}
