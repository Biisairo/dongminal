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
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"

	"dongminal/internal/runtimebin"
)

//go:embed all:shellhooks
var shellhookFS embed.FS

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
	for _, name := range helperNames() {
		dst := filepath.Join(binDir, name)
		if err := installHelper(self, dst); err != nil {
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
func installAgentPlugin(binDir string) error {
	dir := AgentPluginDir(binDir)
	if err := unpackEmbedded(agentPluginFS, "agentplugin", dir); err != nil {
		return err
	}
	return installAgentPluginHooks(binDir, dir)
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
					"command": filepath.Join(binDir, "dmctl") + " agent-context",
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
	dmctl := filepath.Join(binDir, "dmctl")
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

func installHelper(self, dst string) error {
	if existing, err := os.Readlink(dst); err == nil && existing == self {
		return nil
	}
	if err := os.Remove(dst); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err := os.Symlink(self, dst); err == nil {
		return nil
	}
	return copyFile(self, dst, 0o755)
}

func copyFile(src, dst string, mode os.FileMode) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, mode)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

func installShellHooks(binDir string) error {
	return unpackEmbedded(shellhookFS, "shellhooks", binDir)
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
