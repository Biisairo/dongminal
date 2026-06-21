// Package runtime는 dongminal 이 런타임에 배포하는 헬퍼들을 설치한다.
//
// helper CLI (dmctl, edit, download, mdview) 는 multi-call 방식으로 dongminal
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
	return nil
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
	cmd := func(label string) any {
		return []any{map[string]any{
			"matcher": "",
			"hooks":   []any{map[string]any{"type": "command", "command": dmctl + " notify " + label}},
		}}
	}
	settings := map[string]any{
		"hooks": map[string]any{
			"Stop":         cmd("done"),
			"Notification": cmd("waiting"),
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
	return fs.WalkDir(shellhookFS, "shellhooks", func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel("shellhooks", p)
		if rel == "." {
			return nil
		}
		dst := filepath.Join(binDir, rel)
		if d.IsDir() {
			return os.MkdirAll(dst, 0o755)
		}
		data, err := shellhookFS.ReadFile(p)
		if err != nil {
			return err
		}
		mode := os.FileMode(0o644)
		if filepath.Ext(rel) == ".sh" {
			mode = 0o755
		}
		if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
			return err
		}
		return os.WriteFile(dst, data, mode)
	})
}
