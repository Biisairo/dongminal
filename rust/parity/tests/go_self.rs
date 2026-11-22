//! V-PAR-3: 등록 시나리오 전부를 Go 대 Go 로 돌려 차이가 없어야 한다.
//! `DM_PARITY_GO_BIN` 이 없으면 건너뛴다. `rust/parity/run.sh --self-test` 가 이 변수를 준다.
#![cfg(unix)]

use std::fs;
use std::path::PathBuf;
use std::process::Command;

use dm_parity::runner::{OBS_READY, OBS_STATUS, run_side};
use dm_parity::{Options, Side, run_scenario, scenarios};

#[test]
fn go_against_itself_has_no_diff_and_leaves_no_daemon() {
    let Some(go) = std::env::var_os("DM_PARITY_GO_BIN").map(PathBuf::from) else {
        eprintln!("DM_PARITY_GO_BIN 이 없어 건너뛴다");
        return;
    };
    let mut opts = Options::from_env().unwrap();
    opts.keep = true;
    for s in scenarios::all() {
        let r = run_scenario(&s, &go, &go, &opts);
        let alive: Vec<String> = r
            .roots
            .iter()
            .filter_map(|root| fs::read_to_string(root.join("dmhome/paned.pid")).ok())
            .map(|pid| pid.trim().to_string())
            .filter(|pid| {
                Command::new("kill")
                    .args(["-0", pid])
                    .status()
                    .is_ok_and(|st| st.success())
            })
            .collect();
        for root in &r.roots {
            let _ = fs::remove_dir_all(root);
        }
        assert!(
            r.ok(),
            "{}: errors={:?}\n{}",
            r.scenario,
            r.errors,
            r.diffs
                .iter()
                .map(ToString::to_string)
                .collect::<Vec<_>>()
                .join("\n")
        );
        assert!(
            alive.is_empty(),
            "{}: 정리 뒤에도 데몬이 살아 있다: {alive:?}",
            r.scenario
        );
    }
}

/// 두 쪽이 똑같이 실패해도 차이는 없다. 서버 시나리오가 실제로 떠서 응답했는지 따로 본다.
#[test]
fn go_server_scenarios_really_serve() {
    let Some(go) = std::env::var_os("DM_PARITY_GO_BIN").map(PathBuf::from) else {
        eprintln!("DM_PARITY_GO_BIN 이 없어 건너뛴다");
        return;
    };
    let go = fs::canonicalize(go).unwrap();
    let opts = Options::from_env().unwrap();
    let mut next = opts.port_base;
    for s in scenarios::all() {
        let run = run_side(&s, Side::Go, &go, &opts, &mut next).unwrap();
        let _ = fs::remove_dir_all(&run.root);
        let value = |name: &str| {
            run.observations
                .iter()
                .find(|o| o.name == name)
                .map(|o| String::from_utf8_lossy(&o.value).into_owned())
        };
        if let Some(ready) = value(OBS_READY) {
            assert_eq!(ready, "ok", "{}", s.name());
            assert_eq!(value(OBS_STATUS).as_deref(), Some("200 OK"), "{}", s.name());
        }
    }
}
