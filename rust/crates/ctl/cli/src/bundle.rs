//! `otterminal doctor --bundle <파일>` — 진단 번들 (G2-3).
//!
//! 신고에 늘 묻는 것(판·OS·홈에 무엇이 있는지·로그의 끝·설정)을 한 zip 으로 모은다. **비밀이 새면
//! 번들 자체가 위험이다** — 담는 것을 좁히고, 모든 항목이 이 저장소의 유일한 마스킹 규칙
//! (`sanitize_remote`)을 지난다.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::Path;

use otter_gocompat::filepath;
use otter_gocompat::oserr::{go_error_string, path_error};
use otter_shared_otterenv as otterenv;
use otter_shared_platform::{build_target, read_last_exit};
use otter_webserver_domain_git_core::sanitize_remote;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipWriter};

use crate::env::Env;
use crate::logcap::HOME_LOGS;
use crate::options::DoctorOpts;
use crate::redact::redact_secrets;
use crate::version::{GO_RUNTIME, VERSION};

/// 로그마다 담는 끝부분의 크기다. 전문을 담으면 번들이 커지고 비밀이 들어갈 면도 넓어진다.
const BUNDLE_LOG_TAIL: u64 = 64 << 10;

/// 그대로 담는 설정 파일들이다. `access.json` 은 허용 출발지 목록이지 자격이 아니다.
const BUNDLE_SETTINGS: [&str; 2] = [otterenv::SETTINGS_FILE, otterenv::ACCESS_FILE];

pub(crate) fn run_doctor_bundle(
    o: &DoctorOpts,
    env: &Env<'_>,
    stdout: &mut dyn Write,
    stderr: &mut dyn Write,
) -> i32 {
    let home = match o.common.resolve_home_in(env) {
        Ok(h) => h,
        Err(e) => {
            let _ = writeln!(stderr, "{e}");
            return 1;
        }
    };
    let f = match File::create(&o.bundle) {
        Ok(f) => f,
        Err(e) => {
            let _ = writeln!(
                stderr,
                "번들을 만들 수 없습니다: {}",
                go_error_string(&path_error("open", &o.bundle, e))
            );
            return 1;
        }
    };
    let mut z = ZipWriter::new(f);
    let opts = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    let mut add = |name: &str, body: &str| {
        // **모든 항목이 마스킹을 지난다.** 자리마다 고르면 새로 더한 자리가 빠진다. URL userinfo 는
        // 저장소의 유일한 규칙이 가리고, 나머지 비밀 모양은 번들 전용 가림이 가린다 (FR-RSP-6).
        if z.start_file(name, opts).is_ok() {
            let _ = z.write_all(redact_secrets(&sanitize_remote(body)).as_bytes());
        }
    };

    add("about.txt", &bundle_about(&home));
    add("home-files.txt", &bundle_home_listing(&home));
    for n in BUNDLE_SETTINGS {
        if let Ok(blob) = std::fs::read(filepath::join(&[home.as_str(), n])) {
            add(n, &String::from_utf8_lossy(&blob));
        }
    }
    for n in HOME_LOGS {
        let body = tail_of(&filepath::join(&[home.as_str(), n]), BUNDLE_LOG_TAIL);
        if !body.is_empty() {
            add(&format!("logs/{n}"), &String::from_utf8_lossy(&body));
        }
    }
    if let Err(e) = z.finish() {
        let _ = writeln!(stderr, "번들을 닫지 못했습니다: {e}");
        return 1;
    }
    let _ = writeln!(stdout, "✅ 진단 번들: {}", o.bundle);
    let _ = writeln!(
        stdout,
        "   붙이기 전에 한 번 열어 확인해 주세요 — 담는 것을 좁혔지만 최종 판단은 보내는 분의 것입니다."
    );
    0
}

/// "무엇을 받았는가" 다. 홈의 **경로**는 담지 않는다 — 사용자 이름이 들어간다.
pub(crate) fn bundle_about(home: &str) -> String {
    let exists = std::fs::metadata(home).is_ok_and(|m| m.is_dir());
    let mut b = format!(
        "version: {VERSION}\ntarget: {}\ngo: {GO_RUNTIME}\nhome-exists: {exists}\n",
        build_target()
    );
    // FR-OBS-17: 마지막 종료가 정상이었는지. 손상과 강제 종료는 증상이 같고 조치가 다르다.
    let le = read_last_exit(Path::new(home));
    if le.first {
        b.push_str("last-exit: unknown (마커 없음 — 첫 기동이거나 지워졌습니다)\n");
    } else if le.crashed {
        b.push_str("last-exit: CRASH (정상 종료 경로를 지나지 않았습니다)\n");
    } else {
        b.push_str(&format!("last-exit: {}\n", le.raw));
    }
    b
}

/// 홈에 **무엇이 있는가** 다 — 이름과 크기이지 내용이 아니다.
pub(crate) fn bundle_home_listing(home: &str) -> String {
    let Ok(rd) = std::fs::read_dir(home) else {
        return "(홈을 읽을 수 없습니다)\n".to_owned();
    };
    let mut names: Vec<String> = rd
        .filter_map(Result::ok)
        .filter_map(|e| {
            let st = e.metadata().ok()?;
            let kind = if st.is_dir() { "dir" } else { "file" };
            Some(format!(
                "{:<40} {kind:<5} {}",
                e.file_name().to_string_lossy(),
                st.len()
            ))
        })
        .collect();
    names.sort();
    names.join("\n") + "\n"
}

/// 파일의 끝 n 바이트다. 없거나 읽을 수 없으면 비어 있다.
fn tail_of(path: &str, n: u64) -> Vec<u8> {
    let Ok(st) = std::fs::metadata(path) else {
        return Vec::new();
    };
    if st.is_dir() {
        return Vec::new();
    }
    let Ok(mut f) = File::open(path) else {
        return Vec::new();
    };
    if st.len() > n && f.seek(SeekFrom::Start(st.len() - n)).is_err() {
        return Vec::new();
    }
    let mut blob = Vec::new();
    if f.read_to_end(&mut blob).is_err() {
        return Vec::new();
    }
    blob
}
