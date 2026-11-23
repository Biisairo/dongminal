//! Go 골든(`testdata/*.golden`)을 같은 입력으로 다시 만들어 비교한다. 6.3.2·6.3.3 이 옮길
//! 명령(run·edge·account)의 블록은 아직 건너뛴다.

use std::fmt::Write as _;

use super::*;
use crate::detach::parse_detach_flags;
use crate::dmctl::listworkspace::parse_list_workspace_flags;
use crate::dmctl::parse_dmctl_flags;
use crate::dmctl::status::parse_status_flags;
use crate::dmctl::toolio::{parse_msg_flags, parse_send_input_flags};

fn fnv32(s: &[u8]) -> u32 {
    let mut h: u32 = 2166136261;
    for b in s {
        h ^= *b as u32;
        h = h.wrapping_mul(16777619);
    }
    h
}

/// Go `setFields` — 기본값이 아닌 필드만 `{이름:값 …}`.
struct Fields(Vec<String>);

impl Fields {
    fn new() -> Self {
        Self(Vec::new())
    }
    fn s(mut self, name: &str, v: &str) -> Self {
        if !v.is_empty() {
            self.0.push(format!("{name}:{v}"));
        }
        self
    }
    fn b(mut self, name: &str, v: bool) -> Self {
        if v {
            self.0.push(format!("{name}:true"));
        }
        self
    }
    fn i(mut self, name: &str, v: i64) -> Self {
        if v != 0 {
            self.0.push(format!("{name}:{v}"));
        }
        self
    }
    fn p(mut self, name: &str, v: Option<i64>) -> Self {
        if let Some(v) = v {
            self.0.push(format!("{name}:{v}"));
        }
        self
    }
    fn l(mut self, name: &str, v: &[String]) -> Self {
        if !v.is_empty() {
            self.0.push(format!("{name}:[{}]", v.join(" ")));
        }
        self
    }
    fn done(self) -> String {
        format!("{{{}}}", self.0.join(" "))
    }
}

fn parse_cases() -> Vec<(&'static str, Vec<&'static str>)> {
    let mut cs: Vec<(&str, Vec<&str>)> = Vec::new();
    let mut add = |p: &'static str, argss: &[&[&'static str]]| {
        for a in argss {
            cs.push((p, a.to_vec()));
        }
    };
    let common: &[&[&str]] = &[
        &[],
        &["-h"],
        &["--help"],
        &["--json"],
        &["--json", "-h", "--bogus"],
        &["--bogus", "-h"],
        &["--json=1"],
        &["="],
        &["-"],
        &["x"],
        &["--"],
    ];
    add("list-workspace", common);
    add(
        "list-workspace",
        &[
            &["--window"],
            &["--tab"],
            &["--window", "a", "--tab", "b"],
            &["--window", "--json"],
            &["--json", "--window", "w"],
        ],
    );
    for cmd in ["status", "wait"] {
        add(cmd, common);
        add(
            cmd,
            &[
                &["--at"],
                &["--at", "t1"],
                &["--at=t1"],
                &["--at="],
                &["-l", "t1"],
                &["-l=t1"],
                &["-l="],
                &["--at=a=b"],
                &["--member"],
                &["--member", "m1"],
                &["--member=m1"],
                &["--at", "t1", "--member", "m1"],
                &["--at", "--json"],
                &["--for"],
                &["--for", "ready", "--at", "t"],
                &["--for=done", "--at", "t"],
                &["--for", "bad", "--at", "t"],
                &["--at", "t"],
                &["--timeout-ms"],
                &["--timeout-ms", "abc", "--bogus"],
                &["--timeout-ms=0", "--at", "t"],
                &["--timeout-ms", "-5", "--at", "t"],
                &["--timeout-ms=100", "--for", "ready", "--at", "t"],
                &[
                    "--timeout-ms",
                    "100",
                    "--for",
                    "done",
                    "--at",
                    "t",
                    "--json",
                ],
            ],
        );
    }
    add("run", common);
    add(
        "run",
        &[
            &["--run"],
            &[
                "--run",
                "r1",
                "--member",
                "m",
                "--force",
                "--headless",
                "--keep-worktrees",
                "--keep-tools",
                "--json",
                "--text",
            ],
            &["--run=r1", "--role=x", "-l=t", "--timeout-ms=5"],
            &["--run="],
            &["-l"],
            &["--force=1"],
            &["--at", "--brief"],
            &["--brief", "-"],
            &["--bogus=1"],
            &[
                "--objective",
                "o",
                "--projection",
                "p",
                "--isolation",
                "i",
                "--window",
                "w",
                "--outcome",
                "o",
                "--summary",
                "s",
                "--files",
                "f",
                "--base",
                "b",
                "--agent",
                "a",
                "--model",
                "m",
            ],
        ],
    );
    add("dmctl", common);
    add(
        "dmctl",
        &[
            &["--at"],
            &["--at", "1.2"],
            &["--at="],
            &["--at=1"],
            &["-l="],
            &["-l=2"],
            &["--name"],
            &["--name="],
            &["--name=n"],
            &["--name", "n", "a", "b"],
            &["--sandbox", "p", "--workdir", "w", "--cwd", "c"],
            &["--sandbox=", "x"],
            &["--sandbox=p", "--workdir=w", "--cwd=c"],
            &["--workdir="],
            &["--cwd="],
            &["--no-focus", "-n", "--auto", "--force", "--background"],
            &["--no-focus=1"],
            &["a", "--", "--at", "b"],
            &["-h", "a"],
            &["a", "--bogus"],
            &["-5"],
        ],
    );
    add("send-input", common);
    add(
        "send-input",
        &[
            &["--at"],
            &["--at", "t1", "hi"],
            &["--at=t1", "a", "b"],
            &["--at="],
            &["-l", "t1", "-x", "-"],
            &["-l=t1", "--execute", "x"],
            &["--execute=1"],
            &["a", "--", "--at", "b"],
            &["-h", "a"],
            &["a", "--bogus"],
            &["-5"],
            &["--bogus", "-h"],
            &["a", "-h"],
            &["--at", "--execute"],
        ],
    );
    add("msg", common);
    add(
        "msg",
        &[
            &["--to"],
            &["--from"],
            &["--to", "u1", "hi"],
            &["--to=u1", "--from=u2", "a"],
            &["--to="],
            &["--to", "u1", "-"],
            &["--to", "u1", "--", "-x"],
            &["-5"],
            &["--to", "u1", "-h"],
            &["--to", "u1", "--bogus"],
            &["--from", "--to"],
        ],
    );
    add("detach", common);
    add(
        "detach",
        &[
            &["--run"],
            &["--run", "npm test"],
            &["--run=ls"],
            &["--run="],
            &["--run", "ls", "--cwd", "/tmp"],
            &["--cwd"],
            &["--cwd=/tmp"],
            &["--cwd="],
            &["--list"],
            &["-l"],
            &["--list=1"],
            &["--restore"],
            &["--restore", "id1"],
            &["-r", "id1", "--at", "t1"],
            &["--restore=id1"],
            &["-r=id1"],
            &["--at"],
            &["--at", "t1"],
            &["--at="],
            &["--at=t1"],
            &["--at", ""],
            &["--list", "--bogus"],
            &["--bogus", "-h"],
            &["-h", "--bogus"],
        ],
    );
    cs
}

fn code_res(code: Option<i32>, f: String) -> String {
    format!(
        "code={} proceed={} f={f}",
        code.unwrap_or(0),
        code.is_none()
    )
}

fn render_parse(env: &Env, parser: &str, args: &[&str]) -> String {
    let (mut out, mut err) = (Vec::new(), Vec::new());
    let mut inp: &[u8] = b"";
    let owned: Vec<String> = args.iter().map(|s| (*s).to_owned()).collect();
    let res = {
        let mut ctx = Ctx::new(&mut out, &mut err, &mut inp, env);
        match parser {
            "list-workspace" => {
                let (f, c) = parse_list_workspace_flags(&mut ctx, &owned);
                let fs = Fields::new()
                    .b("jsonOut", f.json_out)
                    .s("windowFilter", &f.window_filter)
                    .s("tabFilter", &f.tab_filter);
                code_res(c, fs.done())
            }
            "status" | "wait" => {
                let (f, c) = parse_status_flags(&mut ctx, parser, &owned, parser == "wait");
                let fs = Fields::new()
                    .s("target", &f.target)
                    .s("cond", &f.cond)
                    .i("timeoutMS", f.timeout_ms)
                    .b("jsonOut", f.json_out)
                    .s("member", &f.member);
                code_res(c, fs.done())
            }
            "dmctl" => {
                let (p, e) = match parse_dmctl_flags(&owned) {
                    Ok(p) => (p, "<nil>".to_owned()),
                    Err(e) => (Default::default(), e),
                };
                let fs = Fields::new()
                    .s("location", &p.location)
                    .p("count", p.count)
                    .b("keepFocus", p.keep_focus)
                    .s("name", &p.name)
                    .b("auto", p.auto)
                    .s("sandbox", &p.sandbox)
                    .s("workdir", &p.workdir)
                    .s("cwd", &p.cwd)
                    .s("positional", &p.positional)
                    .b("force", p.force)
                    .b("background", p.background)
                    .s("group", &p.group)
                    .s("after", &p.after)
                    .p("index", p.index);
                format!("err={e} p={}", fs.done())
            }
            "send-input" => {
                let (f, c) = parse_send_input_flags(&mut ctx, &owned);
                let fs = Fields::new()
                    .s("target", &f.target)
                    .b("execute", f.execute)
                    .l("positional", &f.positional);
                code_res(c, fs.done())
            }
            "msg" => {
                let (f, c) = parse_msg_flags(&mut ctx, &owned);
                let fs = Fields::new()
                    .s("to", &f.to)
                    .s("from", &f.from)
                    .l("positional", &f.positional);
                code_res(c, fs.done())
            }
            "run" => {
                let (f, c) = crate::dmctl::run::parse_run_flags(&mut ctx, "sub", &owned);
                let mut fs = Fields::new()
                    .s("run", &f.run)
                    .s("member", &f.member)
                    .s("role", &f.role)
                    .s("agent", &f.agent)
                    .s("brief", &f.brief)
                    .s("model", &f.model)
                    .s("at", &f.at)
                    .s("objective", &f.objective)
                    .s("projection", &f.projection)
                    .s("isolation", &f.isolation)
                    .s("window", &f.window)
                    .s("outcome", &f.outcome)
                    .s("summary", &f.summary)
                    .s("files", &f.files)
                    .s("base", &f.base)
                    .b("force", f.force)
                    .b("keepTrees", f.keep_trees)
                    .b("keepTools", f.keep_tools)
                    .b("textOut", f.text_out)
                    .b("jsonOut", f.json_out)
                    .b("headless", f.headless)
                    .s("timeoutMs", &f.timeout_ms)
                    .s("tree", &f.tree)
                    .b("branch", f.branch)
                    .s("ref", &f.ref_)
                    .s("issue", &f.issue)
                    .s("title", &f.title)
                    .s("parent", &f.parent)
                    .s("goal", &f.goal)
                    .s("ctx", &f.ctx)
                    .b("parallel", f.parallel)
                    .b("noCommit", f.no_commit)
                    .b("self", f.self_)
                    .s("to", &f.to)
                    .b("coord", f.coord);
                let m: Vec<String> = f.given.iter().map(|k| format!("{k}:true")).collect();
                fs.0.push(format!("given:map[{}]", m.join(" ")));
                code_res(c, fs.done())
            }
            _ => {
                let (f, c) = parse_detach_flags(&mut ctx, &owned);
                let fs = Fields::new()
                    .b("doList", f.do_list)
                    .s("restoreID", &f.restore_id)
                    .s("at", &f.at)
                    .s("runCmd", &f.run_cmd)
                    .b("hasRun", f.has_run)
                    .s("cwd", &f.cwd);
                code_res(c, fs.done())
            }
        }
    };
    let stdout = if out.len() > 40 {
        format!("<{} bytes, sum {:x}>", out.len(), fnv32(&out))
    } else {
        String::from_utf8_lossy(&out).into_owned()
    };
    format!(
        "{parser} {}\n  {res}\n  stdout={}\n  stderr={}\n",
        q_list(args),
        q(&stdout),
        dm_gocompat::strconv::quote_bytes(&err)
    )
}

#[test]
fn argparse_golden() {
    let env = Env::with_vars([(dm_shared_dmenv::ENV_TOOL_ID, "self-tool")]);
    let mut got = String::new();
    for (p, args) in parse_cases() {
        got.push_str(&render_parse(&env, p, &args));
    }
    // 6.3.2 의 `run` 파서 블록은 아직 없다.
    let want: String = blocks(&read_testdata("argparse.golden"))
        .into_iter()
        .collect();
    assert_same(&got, &want, "argparse.golden");
}

#[test]
fn httpresult_golden() {
    let cmds: &[&[&str]] = &[
        &["who-am-i"],
        &["read-output", "--at", "t"],
        &["send-input", "--at", "t", "hi"],
        &["msg", "--to", "t", "hi"],
        &["status", "--at", "t"],
        &["list-workspace"],
        &["send", "focus"],
        &["send", "focus", r#"{"location":"1"}"#],
        &["focus", "1"],
        &["run", "status", "--run", "r1"],
    ];
    let bodies: &[(u16, &str)] = &[
        (500, r#"{"error":"boom"}"#),
        (502, "raw body"),
        (400, ""),
        (409, r#"{"error":"conflict","detail":"d","code":"x"}"#),
        (200, r#"{"delivered":0}"#),
        (200, r#"{"delivered":1,"timedOut":true}"#),
    ];
    let mut got = String::new();
    for (status, body) in bodies {
        let srv = TestServer::fixed(*status, body);
        let home = tempfile::tempdir().unwrap();
        let env = srv.env(home.path());
        for c in cmds {
            let (code, out, err) = dm(&env, c);
            let _ = write!(
                got,
                "{status} {} {}\n  code={code}\n  stdout={}\n  stderr={}\n",
                q(body),
                q_list(c),
                q(&out),
                q(&err)
            );
        }
    }
    let want: String = blocks(&read_testdata("httpresult.golden"))
        .into_iter()
        .collect();
    assert_same(&got, &want, "httpresult.golden");
}

type RunBox = Box<dyn Fn(&Env) -> (i32, String, String)>;
type GoldenCmd = (&'static str, RunBox, Option<fn(u16, &str) -> bool>);

fn httpexit_cmds(file: String) -> Vec<GoldenCmd> {
    let dmc = |args: &'static [&'static str]| -> RunBox { Box::new(move |env| dm(env, args)) };
    // DM-F3: detach 가 배달 수를 모르는 본문을 1 로 읽던 것은 Go 쪽 §5 의 변경이다.
    let detach_skip: fn(u16, &str) -> bool = |s, b| s / 100 == 2 && !b.contains(r#""delivered""#);
    vec![
        (
            "detach",
            Box::new(|env| run_with(env, crate::detach::run_detach, &[], b"")),
            Some(detach_skip),
        ),
        (
            "detach --restore",
            Box::new(|env| run_with(env, crate::detach::run_detach, &["--restore", "x"], b"")),
            Some(detach_skip),
        ),
        (
            "detach --list",
            Box::new(|env| run_with(env, crate::detach::run_detach, &["--list"], b"")),
            None,
        ),
        (
            "detach --run",
            Box::new(|env| run_with(env, crate::detach::run_detach, &["--run", "ls"], b"")),
            None,
        ),
        (
            "edit",
            Box::new(move |env| run_with(env, crate::edit::run_edit, &[&file], b"")),
            None,
        ),
        (
            "open-url",
            Box::new(|env| run_with(env, crate::openurl::run_open_url, &["https://x"], b"")),
            None,
        ),
        ("edges", dmc(&["edges"]), None),
        ("edge add", dmc(&["edge", "add", "c"]), None),
        // DM-F5: 본문이 null 이면 옛 코드는 panic 한다 — 따로 시험한다.
        (
            "account list --json",
            dmc(&["account", "list", "--json"]),
            Some(|s, b| s / 100 == 2 && b == "null"),
        ),
        ("account list", dmc(&["account", "list"]), None),
        (
            "move-tab",
            dmc(&[
                "move-tab",
                "--at",
                "11111111-1111-4111-8111-111111111111",
                "--next",
            ]),
            None,
        ),
        ("notify", dmc(&["notify", "done"]), None),
        ("list-groups", dmc(&["list-groups"]), None),
        ("read-screen", dmc(&["read-screen", "--at", "t"]), None),
        (
            "wait",
            dmc(&["wait", "--at", "t", "--timeout-ms", "10"]),
            None,
        ),
        ("run tree", dmc(&["run", "tree", "--ref", "o/r#32"]), None),
        ("run close", dmc(&["run", "close", "--run", "r1"]), None),
    ]
}

#[test]
fn httpexit_golden() {
    let tmp = tempfile::tempdir().unwrap();
    let file = tmp.path().join("f.txt");
    std::fs::write(&file, "x").unwrap();
    let cmds = httpexit_cmds(file.to_string_lossy().into_owned());
    let bodies: &[(u16, &str)] = &[
        (200, "{}"),
        (200, "null"),
        (200, r#"{"delivered":0}"#),
        (200, r#"{"delivered":1}"#),
        (200, r#"{"where":"local"}"#),
        (200, r#"{"where":"viewer","delivered":1}"#),
        (200, r#"{"error":"bad move","delivered":1}"#),
        (204, ""),
        (302, "moved"),
        (400, r#"{"error":"bad"}"#),
        (400, "bad url\n"),
        (409, r#"{"error":"conflict","detail":"d","code":"x"}"#),
        (
            409,
            r#"{"error":"node_taken","memberId":"m","state":"s","hint":"h","runId":"r","stale":true,"unreported":[{"role":"a","state":"b","memberId":"c"}]}"#,
        ),
        (422, "{\"code\":\"edge_x\",\"message\":\"m\\u0007\"}"),
        (500, "raw body"),
        (500, r#"{"error":5}"#),
        (503, r#"{"error":"e","stale":"x"}"#),
        (502, r#"{"code":7,"message":"m"}"#),
        (500, "[1]"),
    ];
    let mut got = String::new();
    for (status, body) in bodies {
        let srv = TestServer::fixed(*status, body);
        let home = tempfile::tempdir().unwrap();
        let env = srv.env(home.path());
        for (name, run, skip) in &cmds {
            if skip.is_some_and(|s| s(*status, body)) {
                continue;
            }
            let (code, out, err) = run(&env);
            let _ = write!(
                got,
                "{status} {} {name}\n  code={code}\n  stdout={}\n  stderr={}\n",
                q(body),
                q(&out),
                q(&err)
            );
        }
    }
    let port = closed_port();
    let home = tempfile::tempdir().unwrap();
    let env = env_at(home.path(), port);
    let p = port.to_string();
    for (name, run, _) in &cmds {
        let (code, out, err) = run(&env);
        let _ = write!(
            got,
            "refused {name}\n  code={code}\n  stdout={}\n  stderr={}\n",
            q(&out.replace(&p, "PORT")),
            q(&err.replace(&p, "PORT"))
        );
    }
    let want: String = blocks(&read_testdata("httpexit.golden"))
        .into_iter()
        .collect();
    assert_same(&got, &want, "httpexit.golden");
}

const LIST_WS_GOLDEN_STATE: &str = r#"{
  "tools": [
    {"id":"p1","pid":101,"sizeCols":80,"sizeRows":24,"fgName":"vim"},
    {"id":"p2","pid":102,"sizeCols":120,"sizeRows":40},
    {"id":"p3","pid":103,"fgName":"claude"},
    {"id":"p4","pid":104}
  ],
  "fgTabNames": true,
  "workspace": {
    "schemaVersion": 2,
    "activeWindow": "w2",
    "windowGroups": [
      {"id":"g1","name":"이슈","tree":{"repo":"o/r","root":32}},
      {"id":"g0","name":"빈 그룹"}
    ],
    "windows": [
      {"id":"w1","name":"메인","focusedPane":"r1","layout":{"type":"pane","id":"r1","activeTab":"11111111-aaaa","tabs":[
        {"id":"11111111-aaaa","name":"Shell","toolId":"p1","type":"terminal"},
        {"id":"short","name":"내작업","toolId":"p2","type":"terminal","nameSource":"manual"}
      ]}},
      {"id":"w2","name":"분할","groupId":"g1","focusedPane":"r3","layout":{"type":"split","direction":"h","children":[
        {"type":"pane","id":"r2","activeTab":"t3","tabs":[{"id":"t3","name":"Shell","toolId":"p3","nameSource":"auto"}]},
        {"type":"split","direction":"v","children":[
          {"type":"pane","id":"r3","activeTab":"t4","tabs":[{"id":"t4","name":"main.go","toolId":"","type":"editor"}]},
          {"type":"pane","id":"r4","activeTab":"t5","tabs":[{"id":"t5","name":"Shell","toolId":"p4","nameSource":"manual"}]}
        ]}
      ]}},
      {"id":"w3","name":"그룹 둘째","groupId":"g1","focusedPane":"r5","layout":{"type":"pane","id":"r5","tabs":[]}},
      {"id":"w4","name":"diff","type":"git","layout":{"type":"pane","id":"r6","activeTab":"t6","tabs":[{"id":"t6","name":"git","type":"git"}]}},
      {"id":"w5","name":"빈 창","focusedPane":"","layout":null}
    ]
  }
}"#;

#[test]
fn listworkspace_golden() {
    let srv = TestServer::fixed(200, LIST_WS_GOLDEN_STATE);
    let home = tempfile::tempdir().unwrap();
    let env = srv.env(home.path());
    let mut got = String::new();
    for args in [
        &["list-workspace"][..],
        &["list-workspace", "--json"],
        &["list-workspace", "--window", "분할"],
        &["list-workspace", "--tab", "nope", "--json"],
        &["list-groups"],
        &["list-groups", "--json"],
    ] {
        let (code, out, err) = dm(&env, args);
        let _ = write!(
            got,
            "{}\n  code={code}\n  stdout={out}\n  stderr={}\n",
            q_list(args),
            q(&err)
        );
    }
    assert_same(
        &got,
        &read_testdata("listworkspace.golden"),
        "listworkspace.golden",
    );
}
