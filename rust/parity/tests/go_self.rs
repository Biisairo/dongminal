//! V-PAR-3: 등록 시나리오 전부를 Go 대 Go 로 돌려 차이가 없어야 한다.
//! `DM_PARITY_GO_BIN` 이 없으면 건너뛴다. `rust/parity/run.sh --self-test` 가 이 변수를 준다.
#![cfg(unix)]

use std::fs;
use std::path::PathBuf;
use std::process::Command;

use dm_parity::runner::{OBS_ERROR, OBS_EXIT, OBS_READY, OBS_STDOUT, run_side};
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
                    .stderr(std::process::Stdio::null())
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

/// 두 쪽이 똑같이 실패해도 차이는 없다. Go 쪽 관측값이 시나리오의 의도대로인지 따로 본다.
/// - 서버 시나리오: 준비가 `ok` 이고 `error` 관측값이 없다(연결이 모두 됐다).
/// - `cli-*-args`: 모든 단계가 종료 코드 2 다(파서가 거절했고 액션은 실행되지 않았다).
/// - `cli-*-help`: 모든 단계가 종료 코드 0 이고 stdout 이 비어 있지 않다.
/// - `helper-*`: 종료 코드가 0 또는 2 뿐이다(1 은 서버 요청까지 갔다는 뜻이다).
#[test]
fn go_observations_match_scenario_intent() {
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
        let name = s.name();
        let values = |obs: &str| -> Vec<(String, String)> {
            run.observations
                .iter()
                .filter(|o| o.name == obs)
                .map(|o| {
                    (
                        o.step_label.clone(),
                        String::from_utf8_lossy(&o.value).into_owned(),
                    )
                })
                .collect()
        };
        let errors = values(OBS_ERROR);
        assert!(errors.is_empty(), "{name}: {errors:?}");
        for (label, ready) in values(OBS_READY) {
            assert_eq!(ready, "ok", "{name} {label}");
        }
        let exits = values(OBS_EXIT);
        if name.starts_with("cli-") && name.ends_with("-args") {
            assert!(exits.iter().all(|(_, c)| c == "2"), "{name}: {exits:?}");
        }
        if name.starts_with("cli-") && name.ends_with("-help") {
            assert!(exits.iter().all(|(_, c)| c == "0"), "{name}: {exits:?}");
            assert!(
                values(OBS_STDOUT).iter().all(|(_, o)| !o.is_empty()),
                "{name}"
            );
        }
        if name.starts_with("helper-") {
            assert!(
                exits.iter().all(|(_, c)| c == "0" || c == "2"),
                "{name}: {exits:?}"
            );
        }
    }
}
