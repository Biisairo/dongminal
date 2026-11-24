//! `otterctl run` 의 요청 본문과 출력 (Go otterctl_run_*_test.go 의 관측 기대값).

use std::time::Duration;

use serde_json::json;

use super::*;
use crate::otterctl::run::{graph_time, path_escape, succeed_budget};

fn tmp() -> tempfile::TempDir {
    tempfile::tempdir().unwrap()
}

#[test]
fn run_start_member_report_payloads() {
    let home = tmp();
    let srv = TestServer::fixed(
        200,
        r#"{"id":"r1","short":"r1s","state":"open","projection":"dedicated-window","isolation":"none","role":"dev","agent":"claude","toolId":"t","tabId":"tb","outcome":"succeeded","headless":true,"worktree":{"path":"/w","branch":"b"}}"#,
    );
    let env = srv.env(home.path());
    let got = ctl(&env, &["run", "start", "--objective", "목적"]);
    assert_eq!(
        got.1,
        "run=r1  short=r1s  state=open  projection=dedicated-window  isolation=none\n"
    );
    let got = ctl(
        &env,
        &[
            "run", "member", "--run", "r1", "--role", "dev", "--agent", "claude", "--at", "tb",
        ],
    );
    assert_eq!(
        got.1,
        "member=r1  role=dev  agent=claude  toolId=t  tabId=tb  state=open  headless=true  worktree=/w  branch=b\n"
    );
    let got = ctl(
        &env,
        &[
            "run",
            "report",
            "--outcome",
            "succeeded",
            "--summary",
            "s",
            "--files",
            " a, ,b ",
        ],
    );
    assert_eq!(
        got.1,
        "reported  member=r1  role=dev  outcome=succeeded  state=open\n"
    );
    let reqs = srv.requests();
    assert_eq!(
        reqs[0].json(),
        json!({"objective":"목적","projection":"dedicated-window","isolation":"none","toolId":"self-tool"})
    );
    assert_eq!(
        reqs[1].json(),
        json!({"runId":"r1","role":"dev","agent":"claude","id":"tb","brief":""})
    );
    assert_eq!(
        (reqs[2].path(), reqs[2].json()),
        (
            "/api/runs/report",
            json!({"outcome":"succeeded","summary":"s","toolId":"self-tool","files":["a","b"]})
        )
    );
}

#[test]
fn run_usage_errors() {
    let home = tmp();
    let env = env_at(home.path(), closed_port());
    for (args, err) in [
        (&["run", "start"][..], "run start: --objective 는 필수다\n"),
        (
            &["run", "start", "--objective", "o", "--base", "b"],
            "run start: --base 는 격리 Run 에만 쓴다 (--isolation per-run|per-member)\n",
        ),
        (
            &["run", "start", "--objective", "o", "--branch"],
            "run start: --branch 는 --tree 와 함께 쓴다\n",
        ),
        (
            &["run", "start", "--objective", "o", "--tree", "x"],
            "run start: --tree 는 owner/repo#N 꼴이다: x\n",
        ),
        (
            &[
                "run", "member", "--run", "r", "--role", "x", "--agent", "nope", "--at", "t",
            ],
            "",
        ),
        (
            &[
                "run", "member", "--run", "r", "--role", "x", "--agent", "claude", "--at", "t",
                "--title", "y",
            ],
            "run member: --title 는 --issue 와 함께 쓴다\n",
        ),
        (
            &[
                "run", "member", "--run", "r", "--role", "x", "--agent", "claude", "--at", "t",
                "--issue", "1", "--ctx", "0",
            ],
            "run member: --ctx 는 1~100 의 정수다: \"0\"\n",
        ),
        (
            &["run", "report", "--outcome", "x"],
            "run report: --outcome 은 succeeded 또는 failed 여야 한다: \"x\"\n",
        ),
        (
            &["run", "succeed", "--member", "m"],
            "run succeed: --at <탭 uuid> 또는 --headless 중 하나가 필요하다 — 새 멤버가 들어앉을 자리다\n",
        ),
        (
            &["run", "succeed", "--self", "--at", "t"],
            "run succeed: --self 는 --summary 가 필요하다 (무엇을 했는가 / 어디까지 왔는가 / 다음에 무엇을 / 함정)\n",
        ),
        (
            &["run", "recover", "--run", "r", "--force"],
            "run recover: --force 는 --member 나 --coordinator 와 함께일 때만 받는다\n",
        ),
        (
            &["run", "detach", "--member", "m", "--at", "t"],
            "run detach: --at 은 run attach 와 함께만 쓴다\n",
        ),
    ] {
        let got = ctl(&env, args);
        assert_eq!(got.0, 2, "{args:?} {}", got.2);
        if !err.is_empty() {
            assert_eq!(got.2, err, "{args:?}");
        }
    }
    let got = ctl(
        &env,
        &[
            "run", "member", "--run", "r", "--role", "x", "--agent", "claude",
        ],
    );
    assert!(
        got.2
            .starts_with("run member: --at <탭 uuid> 와 --headless 중 정확히 하나가 필요하다\n")
    );
}

#[test]
fn run_status_with_members_and_orphans() {
    let home = tmp();
    let srv = TestServer::fixed(
        200,
        r#"{"id":"r1","short":"s","state":"open","projection":"p","isolation":"per-run","objective":"o","repo":"/repo","base":"main",
"worktree":{"path":"/w","branch":"b","removed":true},
"members":[{"role":"dev","state":"working","agent":"claude","toolId":"t1","tabId":"x","contextLevel":"critical","contextRatio":0.875,"contextTokens":175000,"contextLimit":200000,"compactCount":2,"summary":"요약","succeededFrom":"m0"},
{"role":"qa","state":"idle","agent":"codex","toolId":"t2","headless":true,"outcome":"failed","worktree":{"path":"/w2","branch":"b2","residue":"dirty"}}],
"orphans":[{"memberId":"m9","role":"old","toolId":"t9"}]}"#,
    );
    let got = ctl(&srv.env(home.path()), &["run", "status", "--run", "r1"]);
    let want = "run=r1  short=s  state=open  projection=p  isolation=per-run  members=2  objective=o
  컨텍스트 주의(추정): critical 1명(dev) — 승계는 otterctl run succeed
  repo=/repo  base=main
  공유 트리 /w  branch=b  (정리됨)
  role=dev  state=working  agent=claude  toolId=t1  tabId=x  ctx=~88% (critical) [175k/200k] compact=2  승계←m0
    요약
  role=qa  state=idle  agent=codex  toolId=t2  tabId=  headless=true  outcome=failed  ctx=— (unknown)
    트리 /w2  branch=b2  잔여물=dirty
  고아 1건 (헤드리스 도구가 살아 있다 — otterctl run close --run <uuid> --force 로 거둔다):
    role=old  toolId=t9  memberId=m9
";
    assert_eq!(got.1, want);
    assert_eq!(srv.requests()[0].target, "/api/runs?id=r1");
    let srv = TestServer::fixed(200, r#"{"runs":[]}"#);
    assert_eq!(
        ctl(&srv.env(home.path()), &["run", "list"]).1,
        "(Run 없음)\n"
    );
}

#[test]
fn run_close_report() {
    let home = tmp();
    let srv = TestServer::fixed(
        200,
        r#"{"id":"r1","state":"closed","swept":true,
"closedTabs":[{"role":"dev","tabId":"a","exited":false},{"tabId":"e","empty":true}],
"cleanup":[{"role":"dev","toolId":"t","tabId":"a","live":true},{"role":"qa","toolId":"t2","tabId":"b","live":false}],
"keptTools":[{"memberId":"m","role":"h","toolId":"th"}],
"worktrees":[{"path":"/w","branch":"b","residue":"dirty","detail":"2 files"},{"path":"/x","removed":true}]}"#,
    );
    let got = ctl(
        &srv.env(home.path()),
        &["run", "close", "--run", "r1", "--force"],
    );
    let want = "run=r1  state=closed  (정리 전용 — 상태는 바꾸지 않았다)
탭 2건 정리:
  role=dev  tabId=a  (에이전트가 시한 안에 끝나지 않았다)
  tabId=e  (빈 탭)
남은 탭 (필요하면 otterctl close-tab --at <tabId>):
  role=qa  toolId=t2  tabId=b  live=false
헤드리스 도구 1건 보존 (--keep-tools):
  role=h  toolId=th  memberId=m
잔여물 1건 (지우지 않았다):
  /w  branch=b  사유=dirty  (2 files)
";
    assert_eq!(got.1, want);
    assert_eq!(
        srv.requests()[0].json(),
        json!({"runId":"r1","force":true,"keepWorktrees":false,"keepTools":false})
    );
}

#[test]
fn run_tree_recover_team_coordinate() {
    let home = tmp();
    let srv = TestServer::fixed(
        200,
        r#"{"tree":"o/r#1","nodes":[{"role":"root","state":"working","toolId":"a"},{"role":"c1","parent":"root","state":"idle","leaf":true,"toolId":"b","contextRatio":0.425}]}"#,
    );
    let got = ctl(&srv.env(home.path()), &["run", "tree", "--ref", "o/r#1"]);
    assert_eq!(
        got.1,
        "root  state=working  toolId=a\n  c1  state=idle  leaf  ctx=42%  toolId=b\n"
    );
    assert_eq!(srv.requests()[0].target, "/api/runs/tree?ref=o%2Fr%231");

    for (body, code, out) in [
        (
            r#"{"results":[{"target":"member","memberId":"m","outcome":"resumed"}]}"#,
            0,
            "member m  resumed\n",
        ),
        (
            r#"{"results":[{"target":"coordinator","outcome":"skipped","reason":"살아 있다","needsForce":true}]}"#,
            1,
            "coordinator  skipped  살아 있다\n",
        ),
    ] {
        let srv = TestServer::fixed(200, body);
        let got = ctl(&srv.env(home.path()), &["run", "recover", "--run", "r"]);
        assert_eq!((got.0, got.1.as_str()), (code, out));
    }
    let srv = TestServer::fixed(409, r#"{"error":"x"}"#);
    assert_eq!(
        ctl(&srv.env(home.path()), &["run", "recover", "--run", "r"]).0,
        2
    );

    let srv = TestServer::fixed(
        200,
        r#"{"team":[{"role":"a","memberId":"m","to":"t","state":"idle","headless":false}]}"#,
    );
    assert_eq!(
        ctl(&srv.env(home.path()), &["run", "team"]).1,
        "role=a  member=m  to=t  state=idle  headless=false\n"
    );
    assert_eq!(srv.requests()[0].target, "/api/runs/team?toolId=self-tool");
    let srv = TestServer::fixed(200, r#"{"to":"t9","moved":["r1","r2"]}"#);
    assert_eq!(
        ctl(&srv.env(home.path()), &["run", "coordinate", "--to", "t9"]).1,
        "조율 승계: 2 개 Run → t9\n  run=r1\n  run=r2\n"
    );
}

#[test]
fn run_succeed_lines_and_launch() {
    let home = tmp();
    let srv = TestServer::fixed(
        200,
        r#"{"member":{"id":"m2","role":"dev","toolId":"t2","tabId":"x2","worktree":{"path":"/w"},"preamble":"p"},"prevMemberId":"m1","prevState":"succeeded","hasSummary":false}"#,
    );
    let got = ctl(
        &srv.env(home.path()),
        &[
            "run", "succeed", "--member", "m1", "--at", "x2", "--model", "opus",
        ],
    );
    let want =
        "succeeded  prev=m1 (succeeded)  →  member=m2  role=dev  toolId=t2  tabId=x2  worktree=/w
  인수인계 요약 없음 — 이전 멤버가 답하지 않았다. 프리앰블에 그 사실이 적혀 있다
  작업 트리는 새로 만들지 않았다 — 이전 멤버의 트리를 그대로 쓴다
  이전 멤버의 도구는 그대로 살아 있다 — 인수인계를 다 읽었으면 /exit → close-tab 으로 정리해라
  다음: otterctl run launch --member m2 --model 'opus'
";
    assert_eq!(got.1, want);

    let srv = TestServer::fixed(
        200,
        r#"{"runId":"r","memberId":"m","role":"dev","agent":"claude","tabId":"t","preamble":"안녕\n"}"#,
    );
    let env = srv.env(home.path());
    assert_eq!(
        ctl(&env, &["run", "launch", "--member", "m", "--text"]).1,
        "안녕\n"
    );
    let got = ctl(&env, &["run", "launch", "--member", "m", "--json"]);
    assert_eq!(got.0, 0, "{}", got.2);
    let v: serde_json::Value = serde_json::from_str(&got.1).unwrap();
    assert_eq!(
        (v["agent"].as_str(), v["promptInjection"].as_str()),
        (Some("claude"), Some("argv"))
    );
    assert!(v["launch"].as_str().unwrap().starts_with("claude"));

    assert_eq!(succeed_budget(0), Duration::from_secs(190));
    assert_eq!(succeed_budget(1000), Duration::from_secs(11));
    assert_eq!(path_escape("a b/c?"), "a%20b%2Fc%3F");
    assert_eq!(graph_time(0), "-");
    assert_eq!(graph_time(1000).len(), 8);
}
