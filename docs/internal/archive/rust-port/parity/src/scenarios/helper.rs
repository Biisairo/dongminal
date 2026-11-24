//! 런타임 헬퍼 (`internal/helper/runtimebin`) 의 도움말·인자 오류 시나리오.
//!
//! 여기의 입력은 모두 헬퍼가 서버에 요청을 보내기 전에 끝난다(도움말 출력 또는 인자 오류).
//! 그래도 격리 서버를 먼저 띄운다(C-PAR-7). 헬퍼는 주소 파일이 없으면 기본 포트로 붙으므로,
//! 혹시 네트워크 단계까지 가더라도 요청이 운영 서버가 아니라 격리 서버로 가게 한다.

use crate::{Cli, Scenario, Serve};

const OWNER: &str = "6.3";

fn server() -> Serve {
    Serve::new(["start", "--foreground", "--port", "{port}"], "/api/ping")
}

fn helper(mut s: Scenario, argv0: &str, cases: &[&[&str]]) -> Scenario {
    for args in cases {
        s = s.run_cli(Cli::new(args.iter().copied()).argv0(argv0));
    }
    s
}

pub fn all() -> Vec<Scenario> {
    let dmctl = helper(
        Scenario::new("helper-dmctl").owner(OWNER).serve(server()),
        "dmctl",
        &[
            &[],
            &["--help"],
            &["-h"],
            &["help"],
            &["bogus"],
            &["bogus", "--force"],
            &["new-tab", "--help"],
            &["new-tab", "--no-such-flag"],
            &["new-tab", "--at"],
            &["new-tab", "--name="],
            &["new-tab", "--group", "W1.P1.T1"],
            &["new-tab", "--force"],
            &["close-tab", "--force", "--background"],
            &["split-h", "1"],
            &["read-screen", "--bytes"],
            &["read-screen", "--no-such-flag"],
            &["send-input", "--no-such-flag"],
            &["msg", "--no-such-flag"],
            &["status", "--no-such-flag"],
            &["wait", "--no-such-flag"],
            &["list-workspace", "--no-such-flag"],
            &["who-am-i", "--no-such-flag"],
            &["chat-mcp", "--help"],
        ],
    );
    let dmctl_sub = helper(
        Scenario::new("helper-dmctl-sub")
            .owner(OWNER)
            .serve(server()),
        "dmctl",
        &[
            &["run"],
            &["run", "--help"],
            &["run", "-h"],
            &["run", "bogus"],
            &["run", "start", "--no-such-flag"],
            &["run", "start", "--objective"],
            &["edge"],
            &["edge", "help"],
            &["edge", "--help"],
            &["edge", "bogus"],
            &["edge", "invite", "--addr"],
            &["account"],
            &["account", "--help"],
            &["account", "bogus"],
        ],
    );
    let mut misc = helper(
        Scenario::new("helper-misc").owner(OWNER).serve(server()),
        "edit",
        &[&[], &["--help"], &["-h"]],
    );
    misc = helper(misc, "download", &[&["some/file.txt"]]);
    misc = helper(
        misc,
        "detach",
        &[
            &["--help"],
            &["-h"],
            &["--no-such-flag"],
            &["--restore"],
            &["--cwd", "x"],
            &["--at", "x"],
            &["--list", "--run", "y"],
            &["positional"],
        ],
    );
    misc = helper(misc, "open-url", &[&[], &["--help"], &["-h"], &["a", "b"]]);
    vec![dmctl, dmctl_sub, misc]
}
