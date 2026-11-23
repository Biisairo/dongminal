//! doctor_table_test·doctor_probebin_test·helpercheck_test(doctor 부분).

use std::path::Path;

use dm_shared_dmenv as dmenv;

use super::{Vars, with_env};
use crate::doctor::{
    doctor_checks, doctor_helpers, doctor_hook_path, doctor_probe_bin, run_doctor_in,
};
use crate::doctor_probe::doctor_trim;
use crate::options::{Common, DoctorOpts};
use crate::report::CheckReport;

// M8 D-A-11 (GO-20): 진단 항목은 표다 — 순서가 계약이다(설치 뒤에 헬퍼·셸·터미널).
#[test]
fn table_order_is_the_contract() {
    let (a, b) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let home = a.path().to_str().unwrap();
    let bin = b.path().to_str().unwrap();
    let checks = doctor_checks(dm_shared_platform::current(), home, bin);
    let names: Vec<&str> = checks.iter().map(|c| c.name).collect();
    assert_eq!(
        names,
        [
            "환경",
            "설치",
            "설치된 헬퍼",
            "셸",
            "터미널",
            "도구",
            "콘솔 없는 자식",
            "IPC",
            "프로세스"
        ]
    );
}

// TC-ATF-59 (FR-ATF-59, D-ATF-7): 임시 bin 을 못 만들면 오류로 끝나고 운영 홈의 bin 으로 대신하지
// 않는다 (FR-HLI-5).
#[test]
fn probe_bin_failure_does_not_touch_home() {
    let d = tempfile::tempdir().unwrap();
    let missing = d.path().join("없음");
    let missing = missing.to_str().unwrap();
    let home = d.path().join("home");
    std::fs::create_dir(&home).unwrap();
    let mut vars = Vars::home(&home);
    for k in ["TMPDIR", "TMP", "TEMP"] {
        vars.set(k, missing);
    }
    let o = DoctorOpts {
        common: Common {
            home: home.to_str().unwrap().to_owned(),
            ..Common::default()
        },
        ..DoctorOpts::default()
    };
    let (mut out, mut err) = (Vec::new(), Vec::new());
    let code = with_env(&vars, |env| run_doctor_in(&o, env, &mut out, &mut err));
    let out = String::from_utf8(out).unwrap();
    assert_eq!(code, 1, "{out}");
    assert!(out.contains("임시 bin"), "실패 안내가 없다: {out}");
    #[cfg(unix)]
    assert!(
        out.contains(&format!(
            "검사용 임시 bin 을 만들지 못했습니다: mkdirtemp {missing}/dongminal-doctor-*: no such file or directory\n"
        )),
        "{out}"
    );
    assert!(
        !home.join(dmenv::BIN_DIR).exists(),
        "운영 홈의 bin 을 건드렸다"
    );
}

// 검사용 임시 bin 은 운영 홈 밖이고, 끝나면 사라진다 (FR-HLI-5).
#[test]
fn probe_bin_is_temporary() {
    let tmp = std::env::temp_dir().to_string_lossy().into_owned();
    let probe = doctor_probe_bin(&tmp).unwrap();
    let bin = probe.bin.clone();
    assert!(bin.starts_with(&tmp), "임시 자리가 아니다: {bin}");
    std::fs::create_dir_all(&bin).unwrap();
    drop(probe);
    assert!(!Path::new(&bin).exists(), "검사용 자리가 남았다: {bin}");
}

#[cfg(unix)]
fn suffix() -> &'static str {
    dm_shared_platform::current().paths.exe_suffix()
}

// V-HLI-6: 진단은 자국을 남기지 않는다 (D-4).
#[cfg(unix)]
#[test]
fn helpers_does_not_touch_target() {
    let d = tempfile::tempdir().unwrap();
    let bin = d.path().join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    let gone = d.path().join("go-build-사라짐").join("dongminal");
    for n in dmenv::helper_names() {
        std::os::unix::fs::symlink(&gone, bin.join(format!("{n}{}", suffix()))).unwrap();
    }
    let before = std::fs::read_dir(&bin).unwrap().count();

    let mut out = Vec::new();
    let mut r = CheckReport::new(&mut out);
    doctor_helpers(&mut r, bin.to_str().unwrap());
    let fail = r.fail;
    drop(r);
    let out = String::from_utf8(out).unwrap();
    assert!(fail > 0, "깨진 헬퍼를 통과시켰다:\n{out}");
    assert!(
        out.contains(&format!("  ·  {}\n", dm_shared_runtime::HELPER_FIX_HINT)),
        "{out}"
    );

    let after: Vec<_> = std::fs::read_dir(&bin)
        .unwrap()
        .map(Result::unwrap)
        .collect();
    assert_eq!(after.len(), before, "진단이 대상을 바꿨다");
    for e in after {
        assert!(
            std::fs::read_link(e.path()).is_ok(),
            "{:?} 가 링크가 아니게 됐다 — 진단이 다시 설치했다",
            e.file_name()
        );
    }
}

// FR-HLI-11: 설치 전 홈을 실패로 세지 않는다.
#[test]
fn helpers_fresh_home_is_not_failure() {
    let d = tempfile::tempdir().unwrap();
    let bin = d.path().join("bin");
    let mut out = Vec::new();
    let mut r = CheckReport::new(&mut out);
    doctor_helpers(&mut r, bin.to_str().unwrap());
    let fail = r.fail;
    drop(r);
    let out = String::from_utf8(out).unwrap();
    assert_eq!(fail, 0, "설치 전 홈을 실패로 셌다:\n{out}");
    assert_eq!(
        out,
        format!(
            "\n▶ 설치된 헬퍼 ({})\n  ·  {}\n",
            bin.display(),
            dm_shared_runtime::HELPER_NOT_INSTALLED
        )
    );
}

// 보고 형식(report.go)은 한 벌이다 — 실패 줄은 모아 둔다.
#[test]
fn report_format_and_bads() {
    let mut out = Vec::new();
    let mut r = CheckReport::new(&mut out);
    r.section("제목");
    r.ok("됨");
    r.info("참고");
    r.bad("깨짐");
    let (fail, bads) = (r.fail, r.bads.clone());
    drop(r);
    assert_eq!(fail, 1);
    assert_eq!(bads, ["깨짐"]);
    assert_eq!(
        String::from_utf8(out).unwrap(),
        "\n▶ 제목\n  ✅ 됨\n  ·  참고\n  ❌ 깨짐\n"
    );
}

#[test]
fn hook_path() {
    assert_eq!(
        doctor_hook_path("  /a/b/bash.sh "),
        Some("/a/b/bash.sh".to_owned())
    );
    assert_eq!(
        doctor_hook_path(". 'C:\\x\\it''s\\Hook.PS1'"),
        Some("C:\\x\\it's\\Hook.PS1".to_owned())
    );
    assert_eq!(doctor_hook_path("--rcfile"), None);
    assert_eq!(doctor_hook_path("-i"), None);
}

#[test]
fn trim_keeps_bytes_and_cuts_at_300() {
    assert_eq!(doctor_trim(b" \t\nab\r\n"), b"ab");
    assert_eq!(doctor_trim("\u{a0}x\u{85}".as_bytes()), b"x");
    // 깨진 바이트는 공백이 아니다.
    assert_eq!(doctor_trim(b"\xff \n"), b"\xff");
    let long = vec![b'a'; 301];
    let mut want = vec![b'a'; 300];
    want.extend_from_slice("…".as_bytes());
    assert_eq!(doctor_trim(&long), want);
    assert_eq!(doctor_trim(&long[..300]), &long[..300]);
}
