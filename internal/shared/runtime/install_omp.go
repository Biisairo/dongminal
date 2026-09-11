package runtime

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"dongminal/internal/helper/runtimebin"
	"dongminal/internal/shared/agentadapter"
)

// OMP_AGENT_SUPPORT_SRS 묶음 B·C — omp 의 활동 shim 과 멤버 오버레이.
//
// **claude 와 형태가 다르다.** claude 는 훅 정의를 JSON 으로 주고 에이전트가 그
// 명령을 실행한다. omp 의 훅은 in-process 모듈이므로 우리가 **모듈 파일**을 주고,
// 그 안에서 `dmctl activity omp` 를 띄운다 (SRS §2.2).

// ompShimFile 은 활동 보고 훅의 파일명이다. `omp --hook <이 파일>` 로 붙는다.
const ompShimFile = "omp-activity.mjs"

// installOmpAssets 는 활동 shim 과 멤버 오버레이를 쓴다 (FR-OMP-10·20).
func installOmpAssets(binDir string) error {
	dir := runtimebin.AgentHooksDirIn(binDir)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	shim := filepath.Join(dir, ompShimFile)
	if err := os.WriteFile(shim, []byte(ompShimSource(dmctlPath(binDir))), 0o644); err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, agentadapter.OmpMemberConfigFile),
		[]byte(ompMemberOverlay), 0o644)
}

// ompMemberOverlay 는 **`dmctl` 만** 사전 허용하는 오버레이다 (FR-OMP-20·23).
//
// `bash.patterns` 는 순서 있는 규칙이고 와일드카드는 `*` 하나만 지원한다(실측:
// `config/settings-schema.ts:3578`). 그래서 규칙은 `dmctl` 로 시작하는 명령
// 하나뿐이며, `tools.approvalMode` 는 **건드리지 않는다** — 그것을 낮추는 것은
// 멤버에게 사용자가 주지 않은 권한을 주는 일이고 이미 기각된 결정이다.
const ompMemberOverlay = `# dongminal: Run 멤버가 보고·질문을 할 수 있게 dmctl 만 사전 허용한다.
# 이 파일은 --config 로 **그 실행에만** 얹힌다 (OMP_AGENT_SUPPORT_SRS FR-OMP-20).
# 승인 모드 자체는 건드리지 않는다 (FR-OMP-23).
bash:
  patterns:
    - match: "dmctl *"
      approval: allow
    - match: "dmctl"
      approval: allow
`

// ompShimSource 는 훅 모듈의 본문이다.
//
// 세 가지를 지킨다:
//
//   - `dmctl` 은 **절대 경로**다. PATH 앞의 낡은 dmctl 은 `activity` 를 모른다
//     (claude 훅이 같은 이유로 절대 경로를 쓴다)
//   - **에이전트를 막지 않는다** (FR-OMP-13). 모든 실패를 삼키고 예외를 훅
//     바깥으로 던지지 않는다. 관측이 도구 사용을 막으면 그것은 관측이 아니다
//   - 형식은 `parseOmpHook` 이 읽는 것과 **같은 문서**를 근거로 한다 (FR-OMP-12)
func ompShimSource(dmctl string) string {
	// 경로는 JSON 문자열로 넣는다 — Windows 의 역슬래시가 이스케이프를 요구한다.
	return fmt.Sprintf(`// dongminal 활동 보고 훅 (OMP_AGENT_SUPPORT_SRS 묶음 B).
// 설치가 만든 파일이다 — 손으로 고치면 다음 기동에서 덮인다.
import { spawn } from "node:child_process";

const DMCTL = %s;

// 보고는 **한 방향**이다. 실패해도 에이전트를 막지 않는다 (FR-OMP-13).
function report(payload) {
  try {
    const p = spawn(DMCTL, ["activity", "omp"], { stdio: ["pipe", "ignore", "ignore"] });
    p.on("error", () => {});
    p.stdin.on("error", () => {});
    p.stdin.end(JSON.stringify(payload) + "\n");
  } catch {
    /* 관측이 도구 사용을 막지 않는다 */
  }
}

function ident(ctx) {
  try {
    const sm = ctx && ctx.sessionManager;
    if (!sm) return {};
    return { sessionId: sm.getSessionId() || "", transcript: sm.getSessionFile() || "" };
  } catch {
    return {};
  }
}

// 툴 인자에서 가장 말이 되는 것 하나를 고른다 — claudeToolDetail 과 같은 규약이다.
function detailOf(name, input) {
  try {
    if (!input) return "";
    if (name === "bash") return String(input.command || "");
    if (name === "read" || name === "edit" || name === "write" || name === "notebook") {
      return String(input.path || input.file_path || "");
    }
    if (name === "grep" || name === "glob") return String(input.pattern || "");
    return "";
  } catch {
    return "";
  }
}

export default function (pi) {
  pi.on("session_start", (_e, ctx) => report({ event: "session_start", ...ident(ctx) }));
  pi.on("session_shutdown", (_e, ctx) => report({ event: "session_shutdown", ...ident(ctx) }));
  pi.on("agent_start", (_e, ctx) => report({ event: "agent_start", ...ident(ctx) }));
  pi.on("agent_end", (_e, ctx) => report({ event: "agent_end", ...ident(ctx) }));
  pi.on("turn_start", (_e, ctx) => report({ event: "turn_start", ...ident(ctx) }));
  pi.on("turn_end", (_e, ctx) => report({ event: "turn_end", ...ident(ctx) }));
  pi.on("tool_call", (e, ctx) => report({
    event: "tool_call",
    tool: (e && e.toolName) || "",
    detail: detailOf(e && e.toolName, e && e.input),
    ...ident(ctx),
  }));
  pi.on("tool_result", (e, ctx) => report({
    event: "tool_result",
    tool: (e && e.toolName) || "",
    ...ident(ctx),
  }));
  // 압축은 계기가 둘이고 우리 어휘로는 하나다 (FR-OMP-7).
  pi.on("auto_compaction_start", (_e, ctx) => report({ event: "compaction", ...ident(ctx) }));
  pi.on("session_compact", (_e, ctx) => report({ event: "compaction", ...ident(ctx) }));
}
`, jsonString(dmctl))
}

// jsonString 은 경로를 JS 문자열 리터럴로 만든다. 역슬래시와 따옴표만 다룬다 —
// 경로에 제어문자가 들어오는 경우는 이 저장소의 설치 경로에 없다.
func jsonString(s string) string {
	return `"` + strings.NewReplacer(`\`, `\\`, `"`, `\"`).Replace(s) + `"`
}
