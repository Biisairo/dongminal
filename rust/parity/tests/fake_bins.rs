//! V-PAR-2: 가짜 바이너리(셸 스크립트)로 같음·다름과 격리를 확인한다.
#![cfg(unix)]

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use dm_parity::runner::{OBS_ERROR, run_side};
use dm_parity::{Cli, Options, Scenario, Side, run_scenario};

const BASE_SCRIPT: &str = r#"#!/bin/sh
echo "argv0=$(basename "$0") args:$*"
echo "home=$DONGMINAL_HOME uh=$HOME nouc=$DONGMINAL_NO_UPDATE_CHECK extra=${EXTRA:-}"
echo "err:$1" >&2
if [ "$1" = write ]; then printf '%s' "$CONTENT" > "$DONGMINAL_HOME/out.txt"; mkdir -p "$DONGMINAL_HOME/d"; fi
if [ "$1" = stdin ]; then cat; fi
if [ "$1" = sleep ]; then sleep 5; fi
exit ${CODE:-0}
"#;

/// 실제 두 바이너리처럼 이름은 같고(`dongminal`) 디렉터리만 다르다.
fn fake(dir: &Path, name: &str, body: &str) -> PathBuf {
    let d = dir.join(name);
    fs::create_dir_all(&d).unwrap();
    let p = d.join("dongminal");
    fs::write(&p, body).unwrap();
    fs::set_permissions(&p, fs::Permissions::from_mode(0o755)).unwrap();
    p
}

fn opts(dir: &Path) -> Options {
    let work = dir.join("work");
    fs::create_dir_all(&work).unwrap();
    Options {
        port_base: 60400,
        keep: false,
        work_dir: work,
    }
}

fn rich_scenario() -> Scenario {
    Scenario::new("fake rich")
        .run(["a", "b"])
        .run_cli(Cli::new(["stdin"]).stdin("hello\n"))
        .run_cli(Cli::new(["x"]).argv0("download"))
        .run_cli(Cli::new(["env"]).env("EXTRA", "{home}/sub"))
        .write_home("pre/seed.json", "{\"root\":\"{root}\"}")
        .run_cli(Cli::new(["write"]).env("CONTENT", "v1"))
        .home_file("out.txt")
        .home_file("pre/seed.json")
        .home_file("missing.txt")
        .home_tree(["pre/"])
}

#[test]
fn identical_binaries_are_equal() {
    let dir = tempfile::tempdir().unwrap();
    let a = fake(dir.path(), "a", BASE_SCRIPT);
    let b = fake(dir.path(), "b", BASE_SCRIPT);
    let r = run_scenario(&rich_scenario(), &a, &b, &opts(dir.path()));
    assert!(r.ok(), "errors={:?} diffs={:#?}", r.errors, r.diffs);
}

#[test]
fn side_roots_are_removed_unless_keep() {
    let dir = tempfile::tempdir().unwrap();
    let a = fake(dir.path(), "a", BASE_SCRIPT);
    let o = opts(dir.path());
    let r = run_scenario(&rich_scenario(), &a, &a, &o);
    assert_eq!(r.roots.len(), 2);
    assert!(r.roots.iter().all(|p| !p.exists()));
    let keep = Options { keep: true, ..o };
    let r = run_scenario(&rich_scenario(), &a, &a, &keep);
    assert!(r.roots.iter().all(|p| p.join("dmhome/out.txt").exists()));
}

#[test]
fn stdout_difference_is_detected() {
    let dir = tempfile::tempdir().unwrap();
    let a = fake(dir.path(), "a", BASE_SCRIPT);
    let b = fake(dir.path(), "b", &BASE_SCRIPT.replace("args:$*", "ARGS:$*"));
    let r = run_scenario(&Scenario::new("s").run(["q"]), &a, &b, &opts(dir.path()));
    assert_eq!(r.diffs.len(), 1, "{:#?}", r.diffs);
    let d = &r.diffs[0];
    assert_eq!((d.name.as_str(), d.line), ("stdout", 1));
    assert_eq!(d.go_line.as_deref(), Some("argv0=dongminal args:q"));
    assert_eq!(d.rust_line.as_deref(), Some("argv0=dongminal ARGS:q"));
}

#[test]
fn exit_code_and_home_file_differences_are_detected() {
    let dir = tempfile::tempdir().unwrap();
    let a = fake(dir.path(), "a", BASE_SCRIPT);
    let b = fake(
        dir.path(),
        "b",
        &BASE_SCRIPT
            .replace("${CODE:-0}", "3")
            .replace("\"$CONTENT\"", "\"other\""),
    );
    let s = Scenario::new("s")
        .run_cli(Cli::new(["write"]).env("CONTENT", "v1"))
        .home_file("out.txt");
    let r = run_scenario(&s, &a, &b, &opts(dir.path()));
    let names: Vec<&str> = r.diffs.iter().map(|d| d.name.as_str()).collect();
    assert_eq!(names, ["exit", "file:out.txt"], "{:#?}", r.diffs);
    assert_eq!(r.diffs[1].step_label, "home");
}

#[test]
fn timeout_becomes_error_observation() {
    let dir = tempfile::tempdir().unwrap();
    let a = fake(dir.path(), "a", BASE_SCRIPT);
    let s = Scenario::new("t").run_cli(Cli::new(["sleep"]).timeout(Duration::from_millis(200)));
    let mut next = 60400;
    let run = run_side(
        &s,
        Side::Go,
        &fs::canonicalize(&a).unwrap(),
        &opts(dir.path()),
        &mut next,
    )
    .unwrap();
    assert_eq!(run.observations.len(), 1);
    assert_eq!(run.observations[0].name, OBS_ERROR);
    assert!(String::from_utf8_lossy(&run.observations[0].value).contains("제한 시간"));
}

#[test]
fn invalid_scenario_is_not_run() {
    let dir = tempfile::tempdir().unwrap();
    let a = fake(dir.path(), "a", BASE_SCRIPT);
    let r = run_scenario(
        &Scenario::new("bad").run(["start", "--port", "8080"]),
        &a,
        &a,
        &opts(dir.path()),
    );
    assert_eq!(r.errors.len(), 1);
    assert!(r.roots.is_empty());
}

/// 실행기 바이너리: 부모 환경의 DONGMINAL_*·DM_E2E_* 가 자식에 닿지 않는다 (C-PAR-1).
/// a 는 실제 환경을 찍고 b 는 지워졌을 때의 값을 고정으로 찍으므로, 같으면 지워진 것이다.
#[test]
fn cli_scrubs_inherited_env_and_reports_exit_codes() {
    let dir = tempfile::tempdir().unwrap();
    let a = fake(
        dir.path(),
        "a",
        "#!/bin/sh\necho \"p=${DONGMINAL_PORT:-none} e=${DM_E2E_RUN:-none} n=$DONGMINAL_NO_UPDATE_CHECK\"\n",
    );
    let b = fake(dir.path(), "b", "#!/bin/sh\necho \"p=none e=none n=1\"\n");
    let c = fake(dir.path(), "c", "#!/bin/sh\necho different\n");
    let issues = issue_dir(dir.path(), "done");
    let run = |go: &Path, rust: &Path| {
        Command::new(env!("CARGO_BIN_EXE_dm-parity"))
            .args([
                "--go",
                go.to_str().unwrap(),
                "--rust",
                rust.to_str().unwrap(),
                "--only",
                "cli-help",
            ])
            .env("DONGMINAL_PORT", "1234")
            .env("DM_E2E_RUN", "x")
            .env("DM_HERMETIC_ROOT", dir.path())
            .env("DM_PARITY_ISSUES", &issues)
            .output()
            .unwrap()
    };
    let ok = run(&a, &b);
    assert_eq!(
        ok.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&ok.stdout)
    );
    assert!(String::from_utf8_lossy(&ok.stdout).contains("ok    cli-help"));
    let diff = run(&a, &c);
    assert_eq!(diff.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&diff.stdout).contains("DIFF  cli-help"));
    let usage = Command::new(env!("CARGO_BIN_EXE_dm-parity"))
        .arg("--nope")
        .output()
        .unwrap();
    assert_eq!(usage.status.code(), Some(2));
    let low = Command::new(env!("CARGO_BIN_EXE_dm-parity"))
        .args(["--go", "x", "--rust", "y"])
        .env("DM_PARITY_PORT_BASE", "8080")
        .output()
        .unwrap();
    assert_eq!(low.status.code(), Some(2));
}

/// cli-help 의 담당 이슈(6.1) 하나만 든 이슈 폴더.
fn issue_dir(dir: &Path, status: &str) -> PathBuf {
    let d = dir.join(format!("issues-{status}"));
    fs::create_dir_all(&d).unwrap();
    fs::write(
        d.join("6.1-x.md"),
        format!("---\nid: \"6.1\"\nstatus: {status}\n---\n"),
    )
    .unwrap();
    d
}

/// FR-PAR-42: 담당 이슈가 done 이 아니면 차이는 보류이고 종료 코드는 0 이다.
/// 이슈 폴더가 없으면 담당 이슈가 있는 시나리오를 돌리지 않는다(2).
#[test]
fn diffs_of_unfinished_owner_are_pending() {
    let dir = tempfile::tempdir().unwrap();
    let a = fake(dir.path(), "a", "#!/bin/sh\necho a\n");
    let b = fake(dir.path(), "b", "#!/bin/sh\necho b\n");
    let todo = issue_dir(dir.path(), "todo");
    let base = |cmd: &mut Command| {
        cmd.args([
            "--go",
            a.to_str().unwrap(),
            "--rust",
            b.to_str().unwrap(),
            "--only",
            "cli-help",
        ])
        .env("DM_HERMETIC_ROOT", dir.path())
        .env_remove("DM_PARITY_ISSUES");
    };
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_dm-parity"));
    base(&mut cmd);
    let out = cmd
        .args(["--issues", todo.to_str().unwrap()])
        .output()
        .unwrap();
    let text = String::from_utf8_lossy(&out.stdout);
    assert_eq!(out.status.code(), Some(0), "{text}");
    assert!(
        text.contains("PEND  cli-help (담당 6.1: todo, 차이 3개)"),
        "{text}"
    );
    assert!(text.contains("같음 0, 다름 0, 보류 1"), "{text}");
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_dm-parity"));
    base(&mut cmd);
    assert_eq!(cmd.output().unwrap().status.code(), Some(2));
}
