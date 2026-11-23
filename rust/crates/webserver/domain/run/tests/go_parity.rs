//! `testdata/goref` 와 같은 시나리오를 Rust 로 돌려 출력(반환 JSON·오류 문구·프리앰블·runs.json)을
//! Go 와 바이트 단위로 비교한다 (FR-RSP-3). `go` 가 없으면 건너뛴다.

use std::fmt::Write as _;
use std::path::Path;
use std::process::Command;
use std::sync::atomic::{AtomicUsize, Ordering};

use dm_gocompat::fmt::v_float;
use dm_gocompat::json;
use dm_gocompat::strconv::quote;
use dm_webserver_domain_run::*;
use serde::Serialize;

struct Out(String);

impl Out {
    fn p<T: Serialize>(&mut self, label: &str, r: Result<T, Error>) {
        match r {
            Err(e) => writeln!(self.0, "{label}: ERR {e}").unwrap(),
            Ok(v) => {
                let b = json::marshal(&v).unwrap();
                writeln!(self.0, "{label}: {}", String::from_utf8(b).unwrap()).unwrap();
            }
        }
    }
    fn e(&mut self, label: &str, r: Result<(), Error>) {
        self.p(label, r.map(|()| None::<()>));
    }
    fn raw(&mut self, s: &str) {
        self.0.push_str(s);
    }
}

fn wt(path: &str, branch: &str) -> Option<Worktree> {
    Some(Worktree {
        path: path.into(),
        branch: branch.into(),
        base: "main".into(),
        ..Worktree::default()
    })
}

fn start(objective: &str, projection: &str, isolation: &str) -> StartOptions {
    StartOptions {
        objective: objective.into(),
        projection: projection.into(),
        isolation: isolation.into(),
        ..StartOptions::default()
    }
}

fn spec(role: &str, agent: &str, tool: &str) -> MemberSpec {
    MemberSpec {
        role: role.into(),
        agent: agent.into(),
        tool_id: tool.into(),
        ..MemberSpec::default()
    }
}

fn report(outcome: &str, summary: &str) -> ReportSpec {
    ReportSpec {
        outcome: outcome.into(),
        summary: summary.into(),
        ..ReportSpec::default()
    }
}

fn assign(issue: &str) -> Assignment {
    Assignment {
        issue: issue.into(),
        ..Assignment::default()
    }
}

fn scenario(dir: &Path) -> String {
    let n = AtomicUsize::new(0);
    let s = Store::new(dir)
        .with_clock(|| 1_700_000_000)
        .with_id_gen(move || {
            let k = n.fetch_add(1, Ordering::SeqCst) + 1;
            format!("0000000{}-aaaa-bbbb-cccc-00000000000{}", k % 10, k % 10)
        });
    s.load();
    let mut o = Out(String::new());

    o.p(
        "start-empty",
        s.start(start("  ", INLINE, ISOLATION_NONE)).map(|_| ()),
    );
    o.p(
        "start-proj",
        s.start(start("x", "bogus", ISOLATION_NONE)).map(|_| ()),
    );
    o.p("start-iso", s.start(start("x", INLINE, "x")).map(|_| ()));
    let a = s
        .start(StartOptions {
            coordinator_tool_id: "coord-tool".into(),
            window_id: "win".into(),
            repo: "/r".into(),
            base: "main".into(),
            merge_into: "dev".into(),
            worktree: wt("/w/a", "dm/a"),
            ..start(" 목적 <&> ", DEDICATED_WINDOW, ISOLATION_PER_MEMBER)
        })
        .unwrap();
    o.p("start-a", Ok::<_, Error>(&a));

    o.p(
        "add-unknown-agent",
        s.add_member(&a.id, spec("dev", "gpt", "t1")).map(|_| ()),
    );
    o.p(
        "add-empty-role",
        s.add_member(&a.id, spec(" ", "claude", "t1")).map(|_| ()),
    );
    o.p(
        "add-unknown-run",
        s.add_member("nope", spec("dev", "claude", "t1"))
            .map(|_| ()),
    );
    let m1 = s
        .add_member(
            &a.id,
            MemberSpec {
                tab_id: "tab1".into(),
                brief: " 일을 한다\n둘째 줄 ".into(),
                worktree: wt("/w/m1", "dm/m1"),
                ..spec(" dev ", " claude ", "t1")
            },
        )
        .unwrap();
    o.p("add-m1", Ok::<_, Error>(&m1));
    o.p(
        "add-dup-tool",
        s.add_member(&a.id, spec("x", "claude", "t1")).map(|_| ()),
    );
    let m2 = s
        .add_member(
            &a.id,
            MemberSpec {
                id: "pre-m2".into(),
                headless: true,
                ..spec("qa", "omp", "t2")
            },
        )
        .unwrap();
    o.p("add-m2", Ok::<_, Error>(&m2));
    o.p(
        "add-assign-nontree",
        s.add_member(
            &a.id,
            MemberSpec {
                assign: Some(assign("#1")),
                ..spec("x", "claude", "t5")
            },
        )
        .map(|_| ()),
    );
    let rec = s.get(&a.id).unwrap();
    o.raw(&format!("PREAMBLE-m1\n{}END\n", preamble(&rec, &m1)));

    o.p(
        "report-stranger",
        s.report("t9", report(OUTCOME_SUCCEEDED, "s")).map(|_| ()),
    );
    o.p(
        "report-outcome",
        s.report("t1", report("maybe", "s")).map(|_| ()),
    );
    o.p(
        "report-summary",
        s.report("t1", report(OUTCOME_FAILED, " ")).map(|_| ()),
    );
    o.p(
        "report-mismatch",
        s.report(
            "t1",
            ReportSpec {
                run_id: "other".into(),
                ..report(OUTCOME_FAILED, "s")
            },
        )
        .map(|_| ()),
    );
    o.p(
        "report-ok",
        s.report(
            "t1",
            ReportSpec {
                run_id: a.id.clone(),
                member_id: m1.id.clone(),
                files_modified: vec!["a.go".into(), "b.go".into()],
                ..report(OUTCOME_SUCCEEDED, " 했다 ")
            },
        ),
    );
    o.p(
        "report-again",
        s.report("t1", report(OUTCOME_SUCCEEDED, "s")).map(|_| ()),
    );

    let (r, pending) = s.close(&a.id, false);
    o.p("close-guard", r.map(|_| ()));
    o.p(
        "close-guard-pending",
        Ok::<_, Error>(nil_if_empty(&pending)),
    );

    let pol = ContextPolicy::default_policy();
    let obs = |f: &dyn Fn(&mut ContextObservation)| {
        let mut x = ContextObservation::default();
        f(&mut x);
        x
    };
    let m2obs = [
        obs(&|x| {
            x.bytes = 100_000;
            x.has_bytes = true;
            x.agent = "omp".into();
            x.session_id = "s1".into();
        }),
        obs(&|x| {
            x.bytes = 600_000;
            x.has_bytes = true;
            x.agent = "omp".into();
        }),
        obs(&|x| {
            x.tokens = 900_000;
            x.has_tokens = true;
            x.agent = "omp".into();
        }),
        obs(&|x| {
            x.compacted = true;
            x.agent = "omp".into();
        }),
        obs(&|x| {
            x.tokens = 1_200_000;
            x.has_tokens = true;
            x.agent = "omp".into();
            x.window = 2_000_000.0;
        }),
    ];
    for (i, ob) in m2obs.iter().enumerate() {
        let (m, entered, found) = observe(&s, "t2", ob, pol);
        o.p(
            &format!("observe-m2-{i} {} {found}", quote(&entered)),
            Ok::<_, Error>(&m),
        );
    }
    let cpol = ContextPolicy {
        bytes_per_token: 2.0,
        warn_ratio: 0.9,
        critical_ratio: 0.5,
        ..ContextPolicy::default()
    };
    let cobs = [
        obs(&|x| {
            x.tokens = 150_000;
            x.has_tokens = true;
            x.agent = "claude".into();
            x.model = "claude-opus-5".into();
        }),
        obs(&|x| {
            x.tokens = 150_000;
            x.has_tokens = true;
            x.agent = "claude".into();
            x.model = "claude-opus-5".into();
        }),
        obs(&|x| {
            x.bytes = 5000;
            x.has_bytes = true;
        }),
    ];
    for (i, ob) in cobs.iter().enumerate() {
        let (m, entered, found) = observe(&s, "coord-tool", ob, cpol);
        o.p(
            &format!("observe-coord-{i} {} {found}", quote(&entered)),
            Ok::<_, Error>(&m),
        );
    }
    let (_, entered, found) = observe(
        &s,
        "nobody",
        &obs(&|x| {
            x.bytes = 1;
            x.has_bytes = true;
        }),
        pol,
    );
    o.p(
        &format!("observe-nobody {} {found}", quote(&entered)),
        Ok::<_, Error>(None::<()>),
    );

    let msg = |from: &str, to: &str, kind: &str, at: i64, size: i64| MsgEvent {
        from: from.into(),
        to: to.into(),
        kind: kind.into(),
        at,
        size,
    };
    o.e(
        "msg-ok",
        s.append_message(&a.id, msg(COORDINATOR_PARTY, &m1.id, MSG_KIND_AGENT, 0, 12)),
    );
    o.e(
        "msg-at",
        s.append_message(&a.id, msg(&m1.id, "pre-m2", "", 5, 1)),
    );
    o.e(
        "msg-stranger",
        s.append_message(&a.id, msg("x", "y", "", 0, 0)),
    );
    o.e("msg-empty", s.append_message(&a.id, msg("x", "", "", 0, 0)));
    o.e(
        "msg-unknown-run",
        s.append_message("nope", msg("x", "y", "", 0, 0)),
    );

    o.p("detach-not-attached", s.detach("pre-m2").map(|_| ()));
    o.p("attach-empty", s.attach("pre-m2", "").map(|_| ()));
    o.p("attach", s.attach("pre-m2", "tab9").map(|r| r.1));
    o.p("attach-again", s.attach("pre-m2", "tab10").map(|_| ()));
    o.p("detach", s.detach("pre-m2").map(|r| r.1));
    o.p("attach-unknown", s.attach("nope", "tab").map(|_| ()));

    let succ = |prev: &str, tool: &str| SucceedSpec {
        prev_member_id: prev.into(),
        tool_id: tool.into(),
        ..SucceedSpec::default()
    };
    o.p("succeed-no-tool", s.succeed(succ(&m1.id, "")).map(|_| ()));
    o.p(
        "succeed-dup-tool",
        s.succeed(succ(&m1.id, "t2")).map(|_| ()),
    );
    let (prev, next) = s
        .succeed(SucceedSpec {
            tab_id: "tab3".into(),
            handoff_asked: true,
            ..succ(&m1.id, "t3")
        })
        .unwrap();
    o.p("succeed-prev", Ok::<_, Error>(&prev));
    o.p("succeed-next", Ok::<_, Error>(&next));
    o.raw(&format!(
        "handoff-waiting: {}\n",
        s.handoff_waiting(&next.id)
    ));
    o.p(
        "handoff-mismatch",
        s.handoff("t1", "wrong", "요약").map(|_| ()),
    );
    o.p("handoff", s.handoff("t1", "", " 요약 첫 줄\n둘째 "));
    o.raw(&format!(
        "handoff-waiting-after: {}\n",
        s.handoff_waiting(&next.id)
    ));
    o.p("succeed-twice", s.succeed(succ(&m1.id, "t4")).map(|_| ()));
    let rec = s.get(&a.id).unwrap();
    o.raw(&format!("PREAMBLE-next\n{}END\n", preamble(&rec, &next)));
    o.raw(&format!("CLAUSE-m2\n{}END\n", handoff_clause(&rec, &m2)));

    let b = s
        .start(StartOptions {
            tree: " T1 ".into(),
            coordinator_tool_id: "coord-b".into(),
            ..start("트리", BACKGROUND, ISOLATION_PER_RUN)
        })
        .unwrap();
    o.p("start-tree", Ok::<_, Error>(&b));
    o.p(
        "start-tree-dup",
        s.start(StartOptions {
            tree: "T1".into(),
            ..start("트리2", BACKGROUND, ISOLATION_PER_RUN)
        })
        .map(|_| ()),
    );
    o.p(
        "start-branch-noroot",
        s.start(StartOptions {
            tree: "T2".into(),
            tree_branch: true,
            ..start("가지", INLINE, ISOLATION_NONE)
        })
        .map(|_| ()),
    );
    let c = s
        .start(StartOptions {
            id: "branch-run-id-1234567890".into(),
            tree: "T1".into(),
            tree_branch: true,
            ..start("가지", INLINE, ISOLATION_NONE)
        })
        .unwrap();
    o.p("start-branch", Ok::<_, Error>(&c));
    let tree_spec = |role: &str, tool: &str, a: Assignment| MemberSpec {
        assign: Some(a),
        ..spec(role, "claude", tool)
    };
    o.p(
        "add-tree-noissue",
        s.add_member(&b.id, spec("chain1", "claude", "t10"))
            .map(|_| ()),
    );
    o.p(
        "add-tree-ctx",
        s.add_member(
            &b.id,
            tree_spec(
                "chain1",
                "t10",
                Assignment {
                    ctx_pct: 200,
                    ..assign("#1")
                },
            ),
        )
        .map(|_| ()),
    );
    o.p(
        "add-tree-parent",
        s.add_member(
            &b.id,
            tree_spec(
                "chain1",
                "t10",
                Assignment {
                    parent: "ghost".into(),
                    ..assign("#1")
                },
            ),
        )
        .map(|_| ()),
    );
    let mb = s
        .add_member(
            &b.id,
            tree_spec(
                "chain1",
                "t10",
                Assignment {
                    title: "제목".into(),
                    goal: "1.2".into(),
                    parallel: true,
                    ctx_pct: 50,
                    no_commit: true,
                    ..assign("#1")
                },
            ),
        )
        .unwrap();
    o.p("add-tree-root", Ok::<_, Error>(&mb));
    o.p(
        "add-tree-taken",
        s.add_member(
            &c.id,
            tree_spec(
                "chain1",
                "t11",
                Assignment {
                    parent: mb.id.clone(),
                    ..assign("#2")
                },
            ),
        )
        .map(|_| ()),
    );
    let mc = s
        .add_member(
            &c.id,
            tree_spec(
                "chain2",
                "t11",
                Assignment {
                    title: "자식".into(),
                    parent: mb.id.clone(),
                    ..assign("#2")
                },
            ),
        )
        .unwrap();
    o.p("add-tree-child", Ok::<_, Error>(&mc));
    o.raw(&format!(
        "has-open-child: {} {}\n",
        s.has_open_child(&mb.id),
        s.has_open_child(&mc.id)
    ));
    let rec_c = s.get(&c.id).unwrap();
    let rec_b = s.get(&b.id).unwrap();
    let tc = |parent: &str, group: &str, pct: i64| TreeContext {
        parent_tool_id: parent.into(),
        group_id: group.into(),
        doc_path: "/d/issue-tree.md".into(),
        ctx_pct: pct,
    };
    o.raw(&format!(
        "TREE-child\n{}END\n",
        tree_preamble(&rec_c, &mc, &tc("t10", "g-1", 50))
    ));
    o.raw(&format!(
        "TREE-root\n{}END\n",
        tree_preamble(&rec_b, &mb, &tc("coord-b", "", 0))
    ));
    let lone = Member {
        id: "x".into(),
        role: "r".into(),
        ..Member::default()
    };
    o.raw(&format!(
        "TREE-lone\n{}END\n",
        tree_preamble(&rec_b, &lone, &TreeContext::default())
    ));
    let title = || Some("  새 제목 ".to_owned());
    o.p(
        "assign-stranger",
        s.update_assign(
            "t99",
            &mc.id,
            AssignPatch {
                title: title(),
                ..AssignPatch::default()
            },
        )
        .map(|_| ()),
    );
    o.p(
        "assign-ctx",
        s.update_assign(
            "t10",
            &mc.id,
            AssignPatch {
                ctx_pct: Some(0),
                ..AssignPatch::default()
            },
        )
        .map(|_| ()),
    );
    o.p(
        "assign-none",
        s.update_assign(
            "t10",
            &m2.id,
            AssignPatch {
                title: title(),
                ..AssignPatch::default()
            },
        )
        .map(|_| ()),
    );
    o.p(
        "assign-ok",
        s.update_assign(
            "t10",
            &mc.id,
            AssignPatch {
                title: title(),
                goal: Some(" 2.1 ".into()),
                no_commit: Some(true),
                ..AssignPatch::default()
            },
        ),
    );
    o.p(
        "succeed-tree",
        s.succeed(SucceedSpec {
            summary: "넘김".into(),
            ..succ(&mb.id, "t12")
        })
        .map(|r| r.1),
    );
    o.p(
        "child-parent-moved",
        Ok::<_, Error>(s.find_member(&mc.id).unwrap().1),
    );

    o.e(
        "mark",
        s.mark_worktrees(
            &a.id,
            &[
                WorktreeMark {
                    path: "/w/m1".into(),
                    removed: true,
                    residue: "r".into(),
                    detail: "d".into(),
                },
                WorktreeMark::default(),
            ],
        ),
    );
    let rec = s.get(&a.id).unwrap();
    o.p(
        "targets",
        Ok::<_, Error>(nil_if_empty(&rec.worktree_targets())),
    );
    o.p(
        "move",
        s.move_coordinator("coord-tool", "coord2").map(|v| v.len()),
    );
    o.p("move-none", s.move_coordinator("none", "x"));

    let (r, pending) = s.close(&a.id, true);
    o.p("close-force", r);
    o.p(
        "close-force-pending",
        Ok::<_, Error>(nil_if_empty(&pending)),
    );
    o.p(
        "report-closed",
        s.report("t2", report(OUTCOME_FAILED, "s")).map(|_| ()),
    );
    o.p("handoff-closed", s.handoff("t2", "", "s").map(|_| ()));
    o.p("close-again", s.close(&a.id, true).0.map(|_| ()));
    o.p("sweep-open", s.sweep(&b.id).map(|_| ()));
    o.p("sweep", s.sweep(&a.id).map(|r| r.id));
    let dead = |t: &str| t == "coord-b";
    let ids: Vec<String> = s
        .reap_targets(Some(&dead))
        .into_iter()
        .map(|r| r.id)
        .collect();
    o.p("reap", Ok::<_, Error>(ids));
    o.raw(&format!("has-open: {}\n", s.has_open()));
    if let Some(mm) = s.member_by_tool("t11") {
        o.p("by-tool", Ok::<_, Error>(mm.id));
    }
    for id in [
        "",
        "abc",
        "12345678",
        "123456789",
        a.id.as_str(),
        "0123456789abcdef-x",
    ] {
        o.raw(&format!(
            "slug {} {} {}\n",
            quote(id),
            quote(&short(id)),
            quote(&path_slug(id))
        ));
    }
    o.raw(&format!(
        "widen {} {} {}\n",
        v_float(widen_window(200_000.0, 100.0)),
        v_float(widen_window(200_000.0, 300_000.0)),
        v_float(widen_window(200_000.0, 3e6))
    ));
    let blob = std::fs::read(dir.join("runs.json")).unwrap();
    o.raw(&format!("FILE {}\n", String::from_utf8(blob).unwrap()));
    o.p("delete", s.delete(&a.id).map(|r| r.id));
    o.p("delete-again", s.delete(&a.id).map(|_| ()));
    let s2 = Store::new(dir);
    s2.load();
    o.p("reload", Ok::<_, Error>(s2.list()));
    o.0
}

/// Go 는 nil slice 를 `null` 로 낸다.
fn nil_if_empty<T: Clone>(v: &[T]) -> Option<Vec<T>> {
    (!v.is_empty()).then(|| v.to_vec())
}

fn observe(
    s: &Store,
    tool: &str,
    ob: &ContextObservation,
    pol: ContextPolicy,
) -> (Member, String, bool) {
    match s.observe_context(tool, ob, pol) {
        Some((m, e)) => (m, e, true),
        None => (Member::default(), String::new(), false),
    }
}

#[test]
fn scenario_matches_go() {
    if dm_shared_platform::look_path("go").is_none() {
        eprintln!("go 가 없어 건너뛴다");
        return;
    }
    let work = tempfile::tempdir().unwrap();
    let exe = work.path().join("goref");
    let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../../..");
    let st = Command::new("go")
        .current_dir(&repo)
        .args(["build", "-o"])
        .arg(&exe)
        .arg("./rust/crates/webserver/domain/run/testdata/goref")
        .status()
        .unwrap();
    assert!(st.success(), "go build 실패");
    let go_dir = work.path().join("go");
    let rs_dir = work.path().join("rs");
    std::fs::create_dir_all(&go_dir).unwrap();
    std::fs::create_dir_all(&rs_dir).unwrap();
    let out = Command::new(&exe).arg(&go_dir).output().unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let go = String::from_utf8(out.stdout).unwrap();
    let rs = scenario(&rs_dir);
    for (i, (g, r)) in go.lines().zip(rs.lines()).enumerate() {
        assert_eq!(r, g, "{}번째 줄이 다르다", i + 1);
    }
    assert_eq!(go.lines().count(), rs.lines().count());
    assert_eq!(rs, go);
}
