use super::*;

fn marshal<T: Serialize + ?Sized>(v: &T) -> String {
    String::from_utf8(dm_gocompat::json::marshal(v).unwrap()).unwrap()
}

// 2026-11-05 실측 입력(Claude Code 2.1.318)에 사용률·한도를 채우고 모르는 필드를 더한 표본.
// 허용 목록의 끝 필드를 하나도 빠짐없이 채운다 (R-SLU-6).
const SAMPLE: &str = r#"{"session_id":"c009","transcript_path":"/Users/x/.claude/projects/p/c009.jsonl","cwd":"PROJ",
"effort":{"level":"medium"},"model":{"id":"claude-opus-5-5","display_name":"Opus 5.5"},
"workspace":{"current_dir":"PROJ","project_dir":"PROJ","added_dirs":[]},"version":"2.1.318",
"output_style":{"name":"default"},
"cost":{"total_cost_usd":0.5,"total_duration_ms":1019,"total_api_duration_ms":10,"total_lines_added":3,"total_lines_removed":1},
"context_window":{"total_input_tokens":100,"total_output_tokens":20,"context_window_size":1000000,
"current_usage":{"input_tokens":6,"output_tokens":8,"cache_creation_input_tokens":62146,"cache_read_input_tokens":0},
"used_percentage":6,"remaining_percentage":94},
"rate_limits":{"five_hour":{"used_percentage":12.5,"resets_at":1793860000},"Bad-Name":{"used_percentage":1}},
"exceeds_200k_tokens":false,"fast_mode":false,"thinking":{"enabled":true},"secret_new_field":"leak?"}"#;

// 끝 필드가 모두 채워지고, 바이트가 Go 와 같다 (FillsEveryLeaf · WireShape).
#[test]
fn from_input_fills_every_leaf_and_wire_shape() {
    let u = from_input(SAMPLE.as_bytes()).unwrap();
    let want = concat!(
        r#"{"sessionId":"c009","version":"2.1.318","model":{"id":"claude-opus-5-5","displayName":"Opus 5.5"},"#,
        r#""effort":"medium","thinking":true,"fastMode":false,"outputStyle":"default","exceeds200k":false,"#,
        r#""cost":{"totalCostUsd":0.5,"totalDurationMs":1019,"totalApiDurationMs":10,"totalLinesAdded":3,"totalLinesRemoved":1},"#,
        r#""contextWindow":{"totalInputTokens":100,"totalOutputTokens":20,"windowTokens":1000000,"usedPct":6,"remainingPct":94,"#,
        r#""currentUsage":{"inputTokens":6,"outputTokens":8,"cacheCreationInputTokens":62146,"cacheReadInputTokens":0}},"#,
        r#""rateLimits":{"five_hour":{"usedPct":12.5,"resetsAt":1793860000}}}"#
    );
    let got = marshal(&u);
    assert_eq!(got, want);
    for banned in [
        "transcript",
        "/Users/x",
        "PROJ",
        "workspace",
        "secret_new_field",
        "leak?",
        "Bad-Name",
        "badName",
        "fiveHour",
    ] {
        assert!(
            !got.contains(banned),
            "허용 목록 밖의 값 {banned:?} 이 나갔다"
        );
    }
}

#[test]
fn null_missing_and_wrong_type_dropped() {
    let raw = r#"{"session_id":7,"version":"v","context_window":{"context_window_size":"big","current_usage":null,"used_percentage":null},
"rate_limits":{"five_hour":{"used_percentage":null}}}"#;
    let u = from_input(raw.as_bytes()).unwrap();
    assert_eq!(u.version.as_deref(), Some("v"));
    assert!(u.session_id.is_none(), "숫자인 session_id 가 실렸다");
    assert!(
        u.context_window.is_none(),
        "채울 값이 없는 contextWindow 가 실렸다"
    );
    assert!(u.rate_limits.is_none(), "빈 한도 창이 실렸다");
    assert_eq!(marshal(&u), r#"{"version":"v"}"#);
}

#[test]
fn nothing_or_broken() {
    for raw in [
        "{}",
        r#"{"cwd":"/x"}"#,
        "not json",
        "[]",
        "null",
        r#"{"effort":"high"}"#,
    ] {
        assert!(from_input(raw.as_bytes()).is_none(), "{raw}");
    }
}

#[test]
fn rate_name_shape() {
    let raw = r#"{"rate_limits":{"seven_day":{"resets_at":1},"a":{"used_percentage":2},"x":1,"UP":{"used_percentage":3},"this_name_is_way_too_long_for_rate_x":{"used_percentage":4}}}"#;
    let u = from_input(raw.as_bytes()).unwrap();
    assert_eq!(
        marshal(&u),
        r#"{"rateLimits":{"a":{"usedPct":2},"seven_day":{"resetsAt":1}}}"#
    );
}

// SUBAGENT_USAGE_SRS — 2026-11-09 실측 입력에 effort·모르는 필드를 더한 표본.
const SUBAGENT_SAMPLE: &str = r#"{"session_id":"9cfd","transcript_path":"/Users/x/.claude/projects/p/9cfd.jsonl",
"cwd":"PROJ","prompt_id":"598f","columns":238,"tasks":[
{"id":"a3b7","type":"local_agent","agentType":"Explore","status":"running","description":"Find the file",
"label":"secret label","name":"probe","startTime":1794204238088,"model":"claude-haiku-5-5","effort":"low",
"contextWindowSize":1000000,"tokenCount":19250,"tokenSamples":[0,17078,19250],"cwd":"PROJ","leak":"x"},
{"id":"b001","agentType":"Plan","status":"completed","effort":8000,"tokenCount":5},
{"agentType":"NoID","status":"running"}]}"#;

// TC-SAU-1: 허용 목록 (FR-SAU-1·3·4), effort 수는 effortBudget (FR-SAU-2).
#[test]
fn subagents_allowlist_and_budget() {
    let got = subagents_from_input(SUBAGENT_SAMPLE.as_bytes()).expect("tasks 배열이 있는데 None");
    assert_eq!(got.len(), 2, "id 없는 원소는 버린다");
    assert_eq!(
        marshal(&got),
        concat!(
            r#"[{"id":"a3b7","agentType":"Explore","status":"running","model":"claude-haiku-5-5","effort":"low","#,
            r#""windowTokens":1000000,"tokens":19250,"startTime":1794204238088,"description":"Find the file"},"#,
            r#"{"id":"b001","agentType":"Plan","status":"completed","effortBudget":8000,"tokens":5}]"#
        )
    );
}

// FR-SAU-4: 앞에서부터 SUBAGENT_MAX_TASKS 개만.
#[test]
fn subagents_cap() {
    let items: Vec<String> = (0..=SUBAGENT_MAX_TASKS)
        .map(|i| format!(r#"{{"id":"t{i}"}}"#))
        .collect();
    let raw = format!(r#"{{"tasks":[{}]}}"#, items.join(","));
    let got = subagents_from_input(raw.as_bytes()).unwrap();
    assert_eq!(got.len(), SUBAGENT_MAX_TASKS);
    assert_eq!(got[0].id.as_deref(), Some("t0"));
    assert_eq!(SUBAGENT_MAX_TASKS, 32);
}

// FR-SAU-6: 빈 배열이면 빈 목록(`[]`). 없거나 배열이 아니면 None.
#[test]
fn subagents_empty_and_missing() {
    let got = subagents_from_input(br#"{"tasks":[]}"#).unwrap();
    assert_eq!(marshal(&got), "[]");
    for raw in [
        "{}",
        r#"{"tasks":{}}"#,
        "not json",
        r#"{"tasks":null}"#,
        "[]",
        "null",
    ] {
        assert!(subagents_from_input(raw.as_bytes()).is_none(), "{raw}");
    }
    // 원소가 객체가 아니면 건너뛴다.
    let got = subagents_from_input(br#"{"tasks":[1,"x",{"id":"a"}]}"#).unwrap();
    assert_eq!(got.len(), 1);
}
