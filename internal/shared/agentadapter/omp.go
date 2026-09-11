package agentadapter

import "encoding/json"

// ompAdapter 는 omp(oh my pi) 선언이다 (OMP_AGENT_SUPPORT_SRS 묶음 A).
//
// **훅의 성질이 claude 와 다르다.** claude 의 훅은 stdin 으로 JSON 을 받는 외부
// 명령이지만, omp 의 훅은 **in-process TS/JS 모듈**이다(`--hook <file>`,
// `pi.on("tool_call", …)`). 그래서 dongminal 이 shim 을 배포해 그 안에서
// `dmctl activity omp` 를 부르고, 이 파서는 **우리가 정한 형식**을 읽는다
// (형식은 SRS §3.2 = FR-OMP-12).
//
// 얻는 것과 못 얻는 것이 갈린다:
//
//   - 활동 해상도는 claude 급이다 — session_start·agent_start·turn_*·tool_*·
//     compaction·agent_end·session_shutdown 이 전부 온다 (FR-OMP-7)
//   - **`waiting` 은 반만 온다** — 승인 게이트는 훅에 통지되지 않는다. 관측
//     가능한 대기는 `ask` 툴의 호출뿐이며, 없는 신호를 지어내지 않는다
//     (FR-OMP-8 / FR-CBG-5)
//
// 값은 실측이다 (SRS §2.1, `omp v17.4.0`). 판이 올라 이벤트 이름이 바뀌면
// 깨지는 자리는 shim 하나다 — 이 파서는 우리 형식만 본다 (R-OMP-3).
var ompAdapter = Adapter{
	ID:        "omp",
	DetectCmd: "omp",
	Launch:    []string{"omp"},
	ModelFlag: "--model", // 퍼지 매칭이다 — 해석은 omp 의 것이다
	// 위치 인자로 받는다: `omp "List all .ts files in src/"`.
	PromptInjection: PromptArgv,
	// FR-OMP-3: **비운다.** claude 가 `--` 를 쓰는 것은 `--allowedTools` 가 가변
	// 인자라 프롬프트를 삼켰기 때문이고, omp 의 멤버 인자는 `--config <path>` 로
	// 값이 하나다. 없는 함정에 장치를 두면 그 장치가 새 함정이 된다.
	ArgvSeparator: "",
	// FR-OMP-20~23: 멤버의 `dmctl` 사전 허용.
	//
	// **훅으로는 승인할 수 없다** — `ToolCallEventResult` 는 block/reason/input
	// 뿐이라 훅은 막을 수만 있다(실측). 같은 뜻을 이루는 수단은 설정이며
	// (`bash.patterns`), 그것을 이 실행에만 얹는 길이 `--config` 다.
	//
	// 오버레이는 **멤버 기동에만** 실린다. 셸 래퍼는 이 파일을 모른다 — 알면
	// 사전 허용이 모든 omp 세션으로 새어 나간다 (R-OMP-6).
	MemberArgs: []string{"--config", HooksDirToken + "/" + OmpMemberConfigFile},
	PolicyInjection: PolicyInjection{
		// 활동 shim 은 `--hook`, 오케스트레이션 스킬은 `--plugin-dir` 로 붙는다.
		// 둘 다 per-invocation 이라 사용자의 `~/.omp` 를 건드리지 않는다.
		Flags:         []string{"--hook", "--plugin-dir"},
		SessionScoped: true,
	},
	HookParse: parseOmpHook,
	// FR-AEV-2·3: **`Waiting` 만 거짓이다.** omp 의 승인 게이트는 훅에 통지되지
	// 않으므로(OMP_AGENT_SUPPORT_SRS §2.4) 승인 대기를 관측할 길이 없다. 그것을
	// 여기 적는 이유는 FR-OMP-8 과 같다 — 관측되지 않는 것을 지어내지 않되,
	// **없다는 사실은 남긴다.** omp 에 그 이벤트가 생기면 이 한 줄이 참이 된다.
	//
	// `UserTurn` 이 참인 것이 알람을 살린다 — `agent_start` 가 그 자리다.
	Signals: Signals{
		Idle: true, Working: true, Waiting: false, Done: true, Ended: true,
		UserTurn: true, Compaction: true, ToolDetail: true, Session: true,
	},
	Readiness: Readiness{Hooks: true},
	// `/exit` 은 "Exit the application" 이며 `/quit` 과 같은 종료 경로다 (실측).
	ExitCommand: "/exit",
}

// OmpMemberConfigFile 은 멤버의 `dmctl` 사전 허용을 담은 오버레이의 파일명이다.
// 설치(runtime)가 이 이름으로 쓰고 `MemberArgs` 가 이 이름으로 읽는다 — 두 벌이
// 되면 한쪽만 고쳐진다.
const OmpMemberConfigFile = "omp-member.yml"

// parseOmpHook 은 **우리 shim 의 형식**을 활동 보고로 바꾼다 (FR-OMP-6·7).
//
// 형식의 임자가 우리이므로 필드가 적다 — `event` 하나가 상태를 정하고 나머지는
// 곁들이 값이다. 남의 형식(claude 의 `hook_event_name`)은 `event` 가 비어
// 거절된다: 두 형식이 섞이면 어느 쪽이 진실인지 말할 수 없다.
func parseOmpHook(data []byte) (Report, bool) {
	var ev struct {
		Event      string `json:"event"`
		Tool       string `json:"tool"`
		Detail     string `json:"detail"`
		SessionID  string `json:"sessionId"`
		Transcript string `json:"transcript"`
	}
	if err := json.Unmarshal(data, &ev); err != nil {
		return Report{}, false
	}
	var rep Report
	switch ev.Event {
	case "session_start":
		rep = Report{State: "idle", Detail: ev.Detail}
	case "agent_start":
		// FR-ATN-2·3: 이 턴이 **사용자 프롬프트에서 시작했다**고 말하는 이벤트는
		// 이것 하나다. turn_start 는 루프의 한 바퀴이며 출처를 말하지 않는다.
		rep = Report{State: "working", Detail: ev.Detail, UserPrompt: true}
	case "turn_start", "turn_end":
		rep = Report{State: "working"}
	case "tool_call", "tool_result":
		rep = Report{State: "working", Tool: ev.Tool, Detail: ev.Detail}
	case "compaction":
		// 압축은 추정이 아니라 확정이다 (FR-CBG-1). omp 쪽 계기는
		// `auto_compaction_start`·`session_compact` 이며 shim 이 둘을 여기로 접는다.
		rep = Report{State: "working", Compacted: true}
	case "agent_end":
		rep = Report{State: "done"}
	case "session_shutdown":
		rep = Report{State: "ended"}
	default:
		return Report{}, false
	}
	rep.SessionID = ev.SessionID
	rep.Transcript = ev.Transcript
	return rep, true
}
