package agentadapter

import (
	"encoding/json"
	"os"
	"path/filepath"
)

/*
claude 의 설치물 (AGENT_ADAPTER_COMPLETION_SRS FR-AAC-1·6).

`runtime.installAgentHooks` 와 `runtime.installAgentPluginHooks` 에서 **무동작
이동**했다. 놓이는 파일의 자리와 내용은 종전과 같다 (NFR-AAC-3) — 기존 설치
테스트가 그 사실을 고정한다.

옮긴 이유는 이 둘이 **claude 의 훅 규약**이기 때문이다. 훅 이름 아홉과 플러그인의
`hooks/hooks.json` 형식은 claude 가 정한 것이지 dongminal 이 정한 것이 아니다.
*/

// claudeHookEvents 는 활동 보고를 걸 훅 이름들이다.
//
// **`notify` 배선은 없다** (AGENT_EVENT_ABSTRACTION_SRS FR-AEV-20). `Stop` 과
// `Notification` 도 활동 훅만 받으며, 알람은 그 활동 이벤트에서 파생한다
// (FR-AEV-10) — 두 명령을 걸면 도착 순서가 보장되지 않아 판정이 뒤집힌다.
var claudeHookEvents = []string{
	"SessionStart",
	"SessionEnd",
	"UserPromptSubmit",
	"PreToolUse",
	"PostToolUse",
	"PreCompact",
	"SubagentStop",
	"Stop",
	"Notification",
}

// claudeHooksFile 은 활동 훅 설정의 파일명이다. 셸 래퍼가 이 이름으로 찾는다.
const claudeHooksFile = "claude.json"

// installClaudeAssets 는 활동 훅 설정과 플러그인의 SessionStart 훅을 쓴다.
//
// 훅 명령이 `dmctl` 을 **절대경로로** 부르는 이유는 PATH 앞쪽의 낡은 dmctl 이
// `activity` 를 모르기 때문이다 — 인용 규칙은 `InstallSpec.HookCommand` 한 자리가
// 진다 (FR-AAC-3).
func installClaudeAssets(s InstallSpec) error {
	if err := writeClaudeActivityHooks(s); err != nil {
		return err
	}
	return writeClaudePluginHooks(s)
}

func writeClaudeActivityHooks(s InstallSpec) error {
	hook := map[string]any{"type": "command", "command": s.HookCommand("activity", claudeID)}
	event := []any{map[string]any{"matcher": "", "hooks": []any{hook}}}
	hooks := map[string]any{}
	for _, ev := range claudeHookEvents {
		hooks[ev] = event
	}
	blob, err := json.MarshalIndent(map[string]any{"hooks": hooks}, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(s.Dir, claudeHooksFile), blob, 0o644)
}

// writeClaudePluginHooks 는 세션 스코프 플러그인의 SessionStart 훅이다
// (SKILL_INJECTION_SRS FR-INJ-1 · FR-CTX-2).
//
// 플러그인 트리를 전개하고 거울로 유지하는 것은 `runtime` 의 일이다 — 그것은
// dongminal 의 자산 관리이지 claude 의 형식이 아니다. 여기서는 **훅 파일 하나**만
// 쓴다.
//
// `PluginDir` 이 비어 있으면 이 규약을 쓰지 않는 배선이다. 조용히 지난다.
func writeClaudePluginHooks(s InstallSpec) error {
	if s.PluginDir == "" {
		return nil
	}
	hooksDir := filepath.Join(s.PluginDir, "hooks")
	if err := os.MkdirAll(hooksDir, 0o755); err != nil {
		return err
	}
	settings := map[string]any{
		"hooks": map[string]any{
			"SessionStart": []any{map[string]any{
				"matcher": "",
				"hooks": []any{map[string]any{
					"type":    "command",
					"command": s.HookCommand("agent-context"),
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
