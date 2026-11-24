//! 업데이트 확인의 최초 고지 (UPDATE_NOTICE_SRS FR-UPD-10).

use std::io::Write;
use std::path::Path;

use otter_shared_otterenv as otterenv;
use otter_shared_serverconf as serverconf;

/// 기본 켜짐을 처음 한 번 말한다. `server.json` 의 `updateCheck` 키가 곧 "이미 알렸다" 다 (D-UPD-6).
pub(crate) fn announce_update_check(
    home: &str,
    getenv: &dyn Fn(&str) -> String,
    stdout: &mut dyn Write,
) {
    if home.is_empty() {
        return;
    }
    if getenv(otterenv::ENV_NO_CHECK) == "1" {
        // 이미 막혀 있다. 하지도 않을 일을 알리는 것은 거짓이다.
        return;
    }
    let conf = serverconf::resolve(&serverconf::Inputs {
        home: Path::new(home),
        getenv: Some(getenv),
        ..Default::default()
    });
    if conf.update_check_set {
        return;
    }
    // 먼저 적고 나서 알린다. 적지 못하면 알리지 않는다.
    if serverconf::set_update_check(Path::new(home), serverconf::DEFAULT_UPDATE_CHECK).is_err() {
        return;
    }
    let _ = writeln!(
        stdout,
        "ℹ️  새 판이 나오면 화면에 알려 드립니다 — 서버가 GitHub 릴리스를 하루 한 번 확인합니다."
    );
    let _ = writeln!(
        stdout,
        "   끄려면: 설정 ▸ 업데이트 알림 (또는 server.json 의 updateCheck 를 false 로)"
    );
}
