package agentadapter

import (
	"encoding/json"
	"strings"
)

// claudeID 는 이 어댑터의 식별자다. 선언 밖에 두는 이유는 설치물이 훅 명령에 그
// 이름을 적어야 하는데, `claudeAdapter.ID` 를 되참조하면 초기화 순환이 되기
// 때문이다 — 값의 임자는 여전히 이 파일 하나다.
const claudeID = "claude"

// claudeAdapter 는 Claude Code 선언이다. **이것이 검증 대상이다** (D-D).
//
// 전 생명주기 훅을 주므로 준비완료를 화면에서 추론할 필요가 없다 —
// SessionStart → idle 이 사다리 1단계를 그 자리에서 성립시킨다.
var claudeAdapter = Adapter{
	ID:              claudeID,
	DetectCmd:       "claude",
	Launch:          []string{"claude"},
	ModelFlag:       "--model",
	PromptInjection: PromptArgv, // claude [options] [command] [prompt]
	ArgvSeparator:   "--",
	// 멤버가 보고·질문을 할 수 있게 dmctl 만 사전 허용한다. 그 외 명령은
	// 그대로 승인을 받는다 — 멤버에게 사용자가 주지 않은 권한을 주지 않는다.
	MemberArgs: []string{"--allowedTools", "Bash(dmctl:*)"},
	PolicyInjection: PolicyInjection{
		// 알림 훅은 --settings, 오케스트레이션 스킬은 --plugin-dir 로 붙는다.
		// 둘 다 per-invocation 이라 사용자의 ~/.claude 를 건드리지 않는다.
		Flags:         []string{"--settings", "--plugin-dir"},
		SessionScoped: true,
	},
	HookParse: parseClaudeHook,
	// AGENT_ADAPTER_COMPLETION_SRS FR-AAC-1·10·20: 설치물·전사본·창을 이 선언이
	// 함께 든다. 종전에는 셋이 runtime·dmctl·domain/run 에 흩어져 있었고, 어느
	// 쪽도 "누구의 것인가" 를 묻지 않았다.
	InstallAssets: installClaudeAssets,
	ParseUsage:    claudeParseUsage,
	ContextWindow: claudeContextWindow,
	// FR-AEV-2·3: claude 는 아홉을 **전부** 낸다. 이 저장소가 검증한 유일한
	// 에이전트이며, 다른 선언은 이것과의 차이로 읽힌다.
	Signals: Signals{
		Idle: true, Working: true, Waiting: true, Done: true, Ended: true,
		UserTurn: true, Compaction: true, ToolDetail: true, Session: true,
	},
	Readiness: Readiness{Hooks: true},
	// /exit 은 대화를 저장하고 정상 종료한다. SIGKILL 로 끊으면 이력이 남지 않는다.
	ExitCommand: "/exit",
}

// parseClaudeHook maps a Claude Code hook event (stdin JSON) to an activity
// report. Covers all lifecycle hooks (FR-AAP-7): PreToolUse/PostToolUse →
// working (+tool/detail), UserPromptSubmit → working (+prompt), SubagentStop/
// PreCompact → working, Notification → waiting, Stop → done, SessionEnd →
// ended (removes the card), SessionStart → idle (+source). Unknown ignored.
//
// 이 함수는 dmctl_activity.go 에서 여기로 **무동작 이동**했다 (FR-ADP-2).
// 매핑을 "개선"하지 않는다 — 회귀 검출기는 runtimebin/dmctl_activity_test.go 다.
//
// 묶음 C 가 더한 것은 **상태 매핑이 아니라 곁들이 값**이다 (FR-CBG-1):
// session_id·transcript_path 는 모든 이벤트에서 그대로 실리고, PreCompact 는
// working 을 유지한 채 Compacted 를 세운다. 활동 상태 어휘는 한 글자도 바뀌지
// 않는다 — 컨텍스트 관측이 activity 패널의 동작을 바꾸면 안 된다 (NFR-CBG-2).
func parseClaudeHook(data []byte) (Report, bool) {
	var ev struct {
		Event     string          `json:"hook_event_name"`
		ToolName  string          `json:"tool_name"`
		ToolInput json.RawMessage `json:"tool_input"`
		Prompt    string          `json:"prompt"`
		// FR-AEV-15: **알람에도 내용이 실린다.** `Notification` 의 본문이 곧
		// "무엇을 기다리는가" 다 — 권한 요청이면 어느 도구인지가 여기 있다.
		// 없는 필드는 빈 값이 되므로 종전 동작을 깨지 않는다.
		Message    string `json:"message"`
		Source     string `json:"source"`
		SessionID  string `json:"session_id"`
		Transcript string `json:"transcript_path"`
	}
	if err := json.Unmarshal(data, &ev); err != nil {
		return Report{}, false
	}
	var rep Report
	switch ev.Event {
	case "PreToolUse", "PostToolUse":
		rep = Report{State: "working", Tool: ev.ToolName, Detail: claudeToolDetail(ev.ToolName, ev.ToolInput)}
	case "SubagentStop":
		rep = Report{State: "working"}
	case "PreCompact":
		// 압축은 추정이 아니라 확정이다. 크기가 작아 보여도 정보는 이미
		// 유실됐으므로 소비자는 이 신호를 크기보다 우선한다 (FR-CBG-1).
		rep = Report{State: "working", Compacted: true}
	case "UserPromptSubmit":
		// FR-ATN-3: 턴의 출처를 말하는 훅은 이것 하나뿐이다. 다른 훅도
		// `working` 을 보고하지만 **왜** 시작되었는지는 말하지 않는다.
		//
		// **다만 이 훅은 사람이 친 것과 배경 알림을 구별하지 않는다**
		// (FR-ATN-3a, 2026-09-11 관측). 백그라운드 작업이 끝나 턴이 깨어날 때도
		// 같은 훅이 오고, 그때 `prompt` 에는 그 알림의 본문이 실린다 — 그것을
		// 사용자 턴으로 읽으면 **알림 하나가 `done` 알람 하나를 낳는다.**
		// §2.7 이 "배경 이벤트로 깨어난 턴의 종료는 사건이 아니다" 로 막으려던
		// 바로 그 자리다.
		rep = Report{State: "working", Detail: ev.Prompt, UserPrompt: !isBackgroundPrompt(ev.Prompt)}
	case "Notification":
		rep = Report{State: "waiting", Detail: ev.Message}
	case "Stop":
		rep = Report{State: "done"}
	case "SessionEnd":
		rep = Report{State: "ended"}
	case "SessionStart":
		rep = Report{State: "idle", Detail: ev.Source}
	default:
		return Report{}, false
	}
	rep.SessionID = ev.SessionID
	rep.Transcript = ev.Transcript
	return rep, true
}

// backgroundPromptMarks 는 **사람이 치지 않은 프롬프트**의 표식이다 (FR-ATN-3a).
//
// 배경 알림은 이 꼴로 온다 — 백그라운드 작업의 완료 통지와 시스템 알림이다.
// 사람이 친 프롬프트가 이 표식으로 시작하는 일은 없다.
var backgroundPromptMarks = []string{"<task-notification>", "<system-reminder>"}

// isBackgroundPrompt 는 프롬프트의 **모양**으로 배경 턴을 가른다.
//
// **휴리스틱이다.** 훅 payload 에는 출처를 말하는 필드가 없어서 우리가 볼 수 있는
// 것이 본문뿐이다. 표식이 바뀌면 이 판정은 조용히 무력해지므로, 틀리는 쪽을
// **울리는 쪽**으로 두었다 — 못 가르면 종전처럼 사용자 턴으로 읽는다. 알람이 한 번
// 더 우는 것이 울려야 할 때 울지 않는 것보다 낫다 (§1.7 의 판단과 같다).
func isBackgroundPrompt(prompt string) bool {
	p := strings.TrimSpace(prompt)
	for _, mark := range backgroundPromptMarks {
		if strings.HasPrefix(p, mark) {
			return true
		}
	}
	return false
}

// claudeToolDetail pulls the most informative argument out of a tool_input for
// display (FR-AAP-7). Unknown tools yield an empty detail.
func claudeToolDetail(tool string, input json.RawMessage) string {
	var m map[string]any
	if err := json.Unmarshal(input, &m); err != nil {
		return ""
	}
	pick := func(k string) string {
		if v, ok := m[k].(string); ok {
			return v
		}
		return ""
	}
	switch tool {
	case "Bash":
		return pick("command")
	case "Edit", "Write", "Read", "NotebookEdit":
		return pick("file_path")
	case "Grep", "Glob":
		return pick("pattern")
	}
	return ""
}

/*
전사본과 컨텍스트 창 (AGENT_ADAPTER_COMPLETION_SRS FR-AAC-10·20).

`dmctl_activity.parseUsageLine` 과 `run.WindowForModel` 에서 옮겼다. 둘 다 claude 의
**기록 형식**에 대한 지식이므로 이 파일이 임자다 — 옮기기 전에는 그것을 읽는 쪽이
어느 에이전트의 것인지 묻지도 않았다.
*/

// claudeWindowDefault 는 이 에이전트의 **기본** 창이다.
//
// 요즘 판의 기본이 1M 이므로 그것을 기본으로 두고, 다른 크기인 판만 따로 적는다
// (사용자 결정 2026-09-11). 뒤집기 전에는 200k 가 기본이고 1M 이 예외였는데,
// 그 전제가 낡아 1M 세션의 대부분이 200k 로 세어졌다 — 접수된 결함("1M 컨텍스트를
// 쓰는데 15%를 70%로 센다")의 뿌리다.
//
// `domain/run` 의 목록에도 같은 값이 있으나 **뜻이 다르다**: 그쪽은 "이 제품이 아는
// 단계" 로 넓히기(FR-CTX-6)가 딛는 사다리다.
const claudeWindowDefault = 1000000

// claudeModelWindows 는 **기본과 다른** 판들이다 (FR-CTX-5b).
//
// 비어 있다는 것은 "지금 아는 예외가 없다" 는 뜻이지 "확인하지 않았다" 가 아니다.
// 접두로 맞추는 이유는 판 번호(`-20260115`)나 표기(`[1m]`)가 뒤에 붙기 때문이다.
//
// 종전에 있던 `[1m]` 접미어 규칙은 **폐기됐다**. 접미어는 1M 의 조건이 아니라
// 예외 표기였고(`claude-opus-5` 는 접미어 없이도 1M 이다), 조건으로 읽으면 붙지
// 않은 대부분을 놓친다 — 실측에서 접미어가 붙은 기록은 35건인데 붙지 않은 opus-5
// 기록이 97045건이었다 (UX_BATCH6_SRS §2.7).
var claudeModelWindows []struct {
	prefix string
	window float64
}

// claudeContextWindow 는 모델 문자열이 말하는 창 크기다 (FR-CTX-5).
//
// 이 에이전트는 **언제나 답한다** — 기본이 있기 때문이다. 모델 이름을 얻지 못한
// 관측도 기본으로 답하며, 그것이 종전보다 옳다: 모름으로 두면 정책 기본값(200k)에서
// 출발해 관측이 넘을 때까지 잘못된 비율을 보인다.
//
// 답이 틀릴 수 있는 자리는 남아 있고, 그때는 넓히기가 받는다 (FR-CTX-6).
func claudeContextWindow(model string) (float64, bool) {
	m := strings.ToLower(strings.TrimSpace(model))
	for _, e := range claudeModelWindows {
		if strings.HasPrefix(m, e.prefix) {
			return e.window, true
		}
	}
	return claudeWindowDefault, true
}

// claudeParseUsage 는 전사본 JSONL 한 줄에서 사용량을 뽑는다 (FR-AAC-10).
//
// 세는 것은 `input + cache_creation + cache_read` 다. 이 셋의 합이 그 요청의 입력
// 컨텍스트이며, `output_tokens` 는 그 요청의 **답**이라 다음 요청의 입력에 들어가기
// 전까지는 컨텍스트가 아니다.
//
// usage 가 없으면 그 줄은 후보가 아니다 — 사용자 줄·요약 줄·메타 줄이 그렇다.
//
// **내용은 돌려주지 않는다.** 반환 타입이 숫자와 모델 이름뿐인 것이 NFR-4 의 첫
// 방벽이다 (FR-AAC-12).
func claudeParseUsage(line string) (Usage, bool) {
	line = strings.TrimSpace(line)
	if line == "" || !strings.Contains(line, `"usage"`) {
		return Usage{}, false
	}
	var rec struct {
		Message struct {
			Model string `json:"model"`
			Usage *struct {
				Input      int64 `json:"input_tokens"`
				CacheWrite int64 `json:"cache_creation_input_tokens"`
				CacheRead  int64 `json:"cache_read_input_tokens"`
			} `json:"usage"`
		} `json:"message"`
	}
	if err := json.Unmarshal([]byte(line), &rec); err != nil || rec.Message.Usage == nil {
		return Usage{}, false
	}
	u := rec.Message.Usage
	total := u.Input + u.CacheWrite + u.CacheRead
	if total <= 0 {
		return Usage{}, false
	}
	return Usage{Tokens: total, Model: rec.Message.Model}, true
}
