use super::*;
use dm_gocompat::json;

fn at(secs: i64) -> OffsetDateTime {
    OffsetDateTime::from_unix_timestamp(secs).unwrap()
}

#[test]
fn socket_path_beside_daemon_socket() {
    let home = Path::new("x").join("home");
    let ep = dm_shared_platform::current().ipc.endpoint(&home);
    assert_eq!(socket_path(&home), ep.parent().unwrap().join(SOCKET_FILE));
}

#[test]
fn known_method_only_four() {
    for m in [
        METHOD_ACTIVITY,
        METHOD_USAGE,
        METHOD_SUBAGENTS,
        METHOD_NOTIFY,
    ] {
        assert!(known_method(m));
    }
    for m in ["", "write", "report.write", "recordset"] {
        assert!(!known_method(m));
    }
}

#[test]
fn sanitize_strips_control_and_cuts_on_boundary() {
    assert_eq!(sanitize("a\u{7}b\u{7f}c", DETAIL_MAX), "abc");
    assert_eq!(
        sanitize(&"x".repeat(DETAIL_MAX + 88), DETAIL_MAX).len(),
        DETAIL_MAX
    );
    assert_eq!(sanitize(&"가".repeat(200), DETAIL_MAX).len(), 510);
    assert_eq!(sanitize("abc", 2), "ab");
}

#[test]
fn notify_reason_defaults_to_signaled() {
    assert_eq!(notify_reason(""), "signaled");
    assert_eq!(notify_reason("done"), "done");
}

#[test]
fn valid_subagent_states() {
    for s in [activity::WORKING, activity::WAITING, activity::DONE] {
        assert!(valid_subagent_state(s));
    }
    for s in [activity::IDLE, activity::ENDED, "x"] {
        assert!(!valid_subagent_state(s));
    }
}

#[test]
fn put_subagent_activity_caps_oldest_out() {
    let mut m = BTreeMap::new();
    let n = statusline::SUBAGENT_MAX_TASKS;
    for i in 0..=n {
        let id = char::from(b'A' + u8::try_from(i).unwrap()).to_string();
        let a = SubagentActivity {
            state: activity::WORKING.into(),
            ..SubagentActivity::default()
        };
        put_subagent_activity(&mut m, &id, a, at(1000 + i64::try_from(i).unwrap()));
    }
    assert_eq!(m.len(), n);
    assert!(!m.contains_key("A"));
    let last = char::from(b'A' + u8::try_from(n).unwrap()).to_string();
    assert_eq!(m[&last].updated_at, at(1000 + i64::try_from(n).unwrap()));
}

#[test]
fn merge_limits_keeps_others_and_ignores_empty() {
    let w = BTreeMap::from([(
        "five_hour".to_owned(),
        statusline::RateWindow {
            used_pct: Some(40.0),
            resets_at: None,
        },
    )]);
    let mut m = BTreeMap::from([(
        "other".to_owned(),
        LimitRecord {
            windows: None,
            observed_at: 1,
        },
    )]);
    merge_limits(
        &mut m,
        "claude-x",
        &w,
        OffsetDateTime::from_unix_timestamp_nanos(5_000_000_000).unwrap(),
    );
    assert_eq!(m["claude-x"].observed_at, 5000);
    assert!(
        m["claude-x"].windows.as_ref().unwrap()["five_hour"]
            .used_pct
            .is_some()
    );
    assert!(m.contains_key("other"));
    merge_limits(&mut m, "claude-x", &BTreeMap::new(), at(9));
    assert_eq!(m["claude-x"].observed_at, 5000);
}

#[test]
fn record_shapes_keep_stage1_json() {
    let s = |b: Vec<u8>| String::from_utf8(b).unwrap();
    assert_eq!(
        s(json::marshal(&SubagentList {
            tasks: None,
            observed_at: 7
        })
        .unwrap()),
        r#"{"tasks":null,"observedAt":7}"#
    );
    assert_eq!(
        s(json::marshal(&LimitRecord {
            windows: None,
            observed_at: 7
        })
        .unwrap()),
        r#"{"windows":null,"observedAt":7}"#
    );
    let a = SubagentActivity {
        state: "done".into(),
        updated_at: at(0),
        ..SubagentActivity::default()
    };
    let raw = s(json::marshal(&a).unwrap());
    assert_eq!(
        raw,
        r#"{"state":"done","updatedAt":"1970-01-01T00:00:00Z"}"#
    );
    assert_eq!(
        json::unmarshal::<SubagentActivity>(raw.as_bytes()).unwrap(),
        a
    );
    assert_eq!(
        s(json::marshal(&Usage {
            usage: statusline::Usage::default(),
            observed_at: 7
        })
        .unwrap()),
        r#"{"observedAt":7}"#
    );
    let u = Usage {
        usage: statusline::Usage {
            session_id: Some("s".into()),
            ..statusline::Usage::default()
        },
        observed_at: 7,
    };
    assert_eq!(
        s(json::marshal(&u).unwrap()),
        r#"{"sessionId":"s","observedAt":7}"#
    );
}

#[test]
fn report_wire_shapes() {
    let s = |b: Vec<u8>| String::from_utf8(b).unwrap();
    assert_eq!(
        s(json::marshal(&Reply {
            ok: true,
            error: String::new()
        })
        .unwrap()),
        r#"{"ok":true}"#
    );
    assert_eq!(
        s(json::marshal(&Request {
            method: "m".into(),
            body: RawMessage::default()
        })
        .unwrap()),
        r#"{"method":"m","body":null}"#
    );
    assert_eq!(
        s(json::marshal(&ActivityReport::default()).unwrap()),
        r#"{"toolId":"","state":"","tool":"","detail":"","agent":"","sessionId":"","agentId":"","agentType":""}"#
    );
    let r: ActivityReport =
        json::unmarshal(br#"{"toolId":"t","input":{"a": 1},"inputOver":true,"hook":"h"}"#).unwrap();
    assert_eq!(
        s(json::marshal(&r).unwrap()),
        r#"{"toolId":"t","state":"","tool":"","detail":"","agent":"","sessionId":"","agentId":"","agentType":"","hook":"h","input":{"a":1},"inputOver":true}"#
    );
}

#[test]
fn usage_context_tokens() {
    let mut u = Usage::default();
    assert_eq!(u.context_tokens(), None);
    u.usage.context_window = Some(statusline::ContextWindow {
        current_usage: Some(statusline::CurrentUsage {
            input_tokens: Some(10.0),
            cache_read_input_tokens: Some(5.0),
            ..statusline::CurrentUsage::default()
        }),
        ..statusline::ContextWindow::default()
    });
    assert_eq!(u.context_tokens(), Some(15.0));
}

#[test]
fn agent_reports_turn_start_reads_declaration() {
    assert!(agent_reports_turn_start(""));
    assert!(agent_reports_turn_start("unknown"));
    assert!(agent_reports_turn_start("claude"));
    assert!(!agent_reports_turn_start("codex"));
}

#[test]
fn records_read_back() {
    let u: Usage =
        json::unmarshal(br#"{"sessionId":"s","contextWindow":{"usedPct":3},"observedAt":7}"#)
            .unwrap();
    assert_eq!(u.usage.session_id.as_deref(), Some("s"));
    assert_eq!(u.usage.context_window.unwrap().used_pct, Some(3.0));
    assert_eq!(u.observed_at, 7);
    let r: UsageReport = json::unmarshal(
        br#"{"toolId":"t","usage":{"version":"1"},"account":{"email":"e","organizationUuid":"o"}}"#,
    )
    .unwrap();
    assert_eq!(
        (r.tool_id.as_str(), r.usage.version.as_deref()),
        ("t", Some("1"))
    );
    assert_eq!(r.account.unwrap().org_uuid, "o");
    let s: SubagentsReport = json::unmarshal(br#"{"toolId":"t","tasks":[{"id":"a"}]}"#).unwrap();
    assert_eq!(s.tasks.unwrap()[0].id.as_deref(), Some("a"));
    let l: SubagentList = json::unmarshal(br#"{"tasks":null,"observedAt":7}"#).unwrap();
    assert_eq!((l.tasks, l.observed_at), (None, 7));
    let l: LimitRecord =
        json::unmarshal(br#"{"windows":{"five_hour":{"usedPct":40}},"observedAt":5}"#).unwrap();
    assert_eq!(l.windows.unwrap()["five_hour"].used_pct, Some(40.0));
}
