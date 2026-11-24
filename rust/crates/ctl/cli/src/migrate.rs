//! `otterminal migrate` — 워크스페이스 데이터를 최신 스키마로 변환한다 (1회성).

use std::io::Write;
use std::path::Path;

use otter_gocompat::fmt::v_list;
use otter_shared_apipath as apipath;

use crate::env::Env;
use crate::http::{ALIVE_PROBE_TIMEOUT, ping};
use crate::options::{Common, DEFAULT_PORT, ENV_HOME, MigrateOpts};

/// 정지 안내에 붙일 겨냥 플래그다. 기본값이면 생략한다.
fn target_flags(c: &Common, env: &Env<'_>, port: &str, home: &str) -> String {
    let mut s = String::new();
    if port != DEFAULT_PORT {
        s.push_str(&format!(" --port {port}"));
    }
    if !c.home.is_empty() || !env.get(ENV_HOME).is_empty() {
        s.push_str(&format!(" --home {home}"));
    }
    s
}

pub fn run_migrate(o: &MigrateOpts, stdout: &mut dyn Write, stderr: &mut dyn Write) -> i32 {
    run_migrate_in(o, &Env::process(), stdout, stderr)
}

pub(crate) fn run_migrate_in(
    o: &MigrateOpts,
    env: &Env<'_>,
    stdout: &mut dyn Write,
    stderr: &mut dyn Write,
) -> i32 {
    // 포트 점유 검사는 안전장치다 — start 와 같은 서버를 봐야 한다 (FR-STR-23).
    let tgt = match o.common.resolve_target_in(env) {
        Ok(t) => t,
        Err(e) => {
            let _ = writeln!(stderr, "{e}");
            return 1;
        }
    };
    tgt.warn(stderr);
    let (home, port) = (tgt.home.as_str(), tgt.port.as_str());

    if !o.dry_run
        && ping(
            &format!("{}{}", tgt.url, apipath::PING),
            ALIVE_PROBE_TIMEOUT,
        )
    {
        let _ = writeln!(
            stderr,
            "❌ otterminal 이 포트 {port} 에서 실행 중입니다 — 변환하지 않았습니다."
        );
        let _ = writeln!(stderr, "   서버와 데몬을 완전히 정지한 뒤 다시 실행하세요:");
        let _ = writeln!(
            stderr,
            "     otterminal stop --all{}",
            target_flags(&o.common, env, port, home)
        );
        return 1;
    }

    let rep = match otter_ctl_migrate::apply(Path::new(home), o.dry_run) {
        Ok(r) => r,
        Err(e) => {
            let _ = writeln!(stderr, "마이그레이션 실패: {e}\n변경된 파일 없음.");
            return 1;
        }
    };
    if rep.empty {
        let _ = writeln!(stdout, "마이그레이션 대상 없음 ({home})");
        return 0;
    }
    if o.dry_run {
        let _ = writeln!(stdout, "[dry-run] 파일을 변경하지 않습니다.");
    }
    if rep.already_migrated {
        let _ = writeln!(stdout, "이미 v2 스키마입니다. 참조 정리만 수행합니다.");
    }
    let _ = writeln!(stdout, "Window {}개, Tool {}개", rep.windows, rep.tools);
    let lists = [
        (&rep.orphans, "고아 도구 {}개 폐기: "),
        (&rep.ghost_refs, "agentsOrder 유령 참조 {}개 제거: "),
        (&rep.shortcuts_renamed, "단축키 id {}개 개명: "),
        (&rep.broken_refs, "경고: 탭이 참조하나 도구가 없음 {}개: "),
    ];
    for (items, label) in lists {
        if !items.is_empty() {
            let _ = writeln!(
                stdout,
                "{}{}",
                label.replace("{}", &items.len().to_string()),
                v_list(items)
            );
        }
    }
    let id = &rep.identity;
    if id.total() > 0 {
        let _ = writeln!(
            stdout,
            "구 식별자 {}개를 uuid 로 재작성: 창 {}, 분할 칸 {}, 탭 {}, 도구 {}",
            id.total(),
            id.windows,
            id.panes,
            id.tabs,
            id.tools
        );
    } else {
        let _ = writeln!(stdout, "구 식별자 없음 — 재작성할 것이 없습니다.");
    }
    if !id.dangling.is_empty() {
        let _ = writeln!(
            stdout,
            "경고: 대상이 없어 값을 보존한 참조 {}개: {}",
            id.dangling.len(),
            v_list(&id.dangling)
        );
    }
    if !o.dry_run {
        let _ = writeln!(stdout, "백업: *.v1.bak (workspace/tools/settings)");
        if id.total() > 0 {
            let _ = writeln!(stdout, "백업: *.preuuid.bak (식별자 재작성 직전 상태)");
        }
    }
    0
}
