//! 도움말 (FR-CLI-1..7). 액션 목록은 액션 표에서 나온다 — 손으로 적지 않는다.

use crate::actions::{actions, lookup_action};
use crate::homelayout::{HomeEntry, home_layout};
use crate::options::DEFAULT_PORT;
use crate::version::VERSION;

fn common_flags() -> String {
    format!(
        "  --port <n>        포트 (기본: $OTTERMINAL_HOME/server.json, 없으면 {DEFAULT_PORT})
  --home <path>     OTTERMINAL_HOME (기본: $OTTERMINAL_HOME, 없으면 ~/.otterminal)"
    )
}

/// 무인자·-h·--help 실행 시의 출력이다 (FR-CLI-1..3).
pub fn help() -> String {
    let mut b = format!(
        "otterminal {VERSION} — 브라우저에서 쓰는 터미널 워크스페이스

사용법:
  otterminal <action> [옵션]

액션:
"
    );
    for a in actions() {
        b.push_str(&format!("  {:<10} {}\n", a.name, a.brief));
    }
    b.push_str(
        "
액션별 옵션은 다음으로 본다:
  otterminal <action> --help

빌드는 ./scripts/build.sh 가 한다.
",
    );
    b
}

/// 액션별 사용법이다 (FR-CLI-6/7). 표에 없는 이름은 전체 도움말로 떨어진다.
pub fn usage(action: &str) -> String {
    match lookup_action(action) {
        Some(a) => (a.usage)(),
        None => help(),
    }
}

/// 알 수 없는 첫 인자에 대한 안내다 (FR-CLI-5).
pub fn unknown_action(name: &str) -> String {
    format!("알 수 없는 액션: {name}\n\n{}", help())
}

/// home_layout 에서 고른 이름을 도움말 목록으로 낸다 (SHR-20). 폭은 바이트로 잰다(Go `len`).
fn layout_list(keep: impl Fn(&HomeEntry) -> bool) -> String {
    const INDENT: &str = "    ";
    const WIDTH: usize = 72;
    let trim = |s: &str| s.trim_end_matches([' ', '·']).to_owned();
    let mut b = String::new();
    let mut line = INDENT.to_owned();
    for e in home_layout().iter().filter(|e| keep(e)) {
        let name = if e.is_dir {
            format!("{}/", e.name)
        } else {
            e.name.to_owned()
        };
        if line != INDENT && line.len() + name.len() + 3 > WIDTH {
            b.push_str(&trim(&line));
            b.push('\n');
            line = INDENT.to_owned();
        }
        line.push_str(&name);
        line.push_str(" · ");
    }
    b.push_str(&trim(&line));
    b.push('\n');
    b
}

pub fn usage_start() -> String {
    [
        r#"사용법: otterminal start [옵션]

서버를 띄운다. 기본은 배경 모드 — 준비를 확인한 뒤 프롬프트를 돌려준다.

옵션:
  --expose          0.0.0.0 에 바인드한다 (사내망 다른 기기에서 접근 가능)
                    인증이 없으므로, 켜 두지 않으면 같은 망의 누구나 셸을 얻는다
                    Settings ▸ Access 에서 허용 목록을 켜세요
  (기본)            otterminald 를 세션을 유지하며 새 바이너리로 교체한다
                    교체하지 못하면 서버·데몬을 그대로 두고 실패로 끝난다
  --server-only     otterminald 는 그대로 두고 서버만 다시 띄운다
  --refresh-daemon  otterminald 를 새로 띄운다 (터미널 세션을 잃는다)
                    도구 안에서 쓰면 대리 프로세스가 이어서 수행하고
                    출력은 $OTTERMINAL_HOME/restart.log 에 남는다
  --isolated        임시 홈 + 비어 있는 포트로 띄운다. 운영 인스턴스를 건드리지 않는다
                    도구 셸도 그 아래의 빈 홈(tool-home)에서 뜬다 — 사용자 rc·
                    git config·자격증명이 없다. 기동 출력이 두 경로를 찍는다
  --foreground      터미널을 점유하며 실행한다 (^C 로 정지)
"#,
        common_flags().as_str(),
        r#"

--port·--expose 는 $OTTERMINAL_HOME/server.json 에 저장되어 다음 기동에도 쓰인다.
서버를 끄지 않고 바꾸려면 otterminal config set port|expose 나 설정 ▸ Server 를 쓴다.
환경변수 PORT·OTTERMINAL_PORT·OTTERMINAL_HOST 는 바인드를 정하지 않는다.

로그: $OTTERMINAL_LOG (기본: $OTTERMINAL_HOME/server.log) — 배경 모드에서만
"#,
    ]
    .concat()
}

pub fn usage_window() -> String {
    [
        r#"사용법: otterminal window [옵션]

돌고 있는 서버에 frameless window(Chrome --app)를 연다.

서버를 띄우지 않는다 — 창만 연다. 서버가 떠 있지 않으면 열지 않고 알린다.
띄우는 것은 otterminal start 다.

옵션:
"#,
        common_flags().as_str(),
        r#"
"#,
    ]
    .concat()
}

pub fn usage_stop() -> String {
    [
        r#"사용법: otterminal stop [옵션]

옵션:
  --all             otterminald 까지 정지한다 (기본은 서버만 — 세션 유지)
"#,
        common_flags().as_str(),
        r#"
"#,
    ]
    .concat()
}

pub fn usage_doctor() -> String {
    [
        r#"사용법: otterminal doctor [옵션]

이 호스트에서 플랫폼 계층이 실제로 동작하는지 확인한다. 서버가 쓰는 것과 같은
경로를 같은 순서로 밟는다 — 헬퍼·셸 훅 설치, 셸 선택, 의사 터미널 기동과 명령
왕복, 로컬 IPC 종단 왕복, 프로세스 제어.

터미널이 뜨지 않거나 비어 보일 때 먼저 이것을 돌린다. 어느 계층에서 무슨
오류로 막혔는지 나온다.

종료 코드: 0 정상 / 1 이상 있음

옵션:

  --bundle <파일>   신고에 붙일 진단 번들(zip)을 만든다 (G2-3).
                    판·OS·홈 파일 목록·로그 끝·설정을 담고, 자격증명은 마스킹한다.
                    붙이기 전에 한 번 열어 확인하는 것을 권한다.
"#,
        common_flags().as_str(),
        r#"
"#,
    ]
    .concat()
}

pub fn usage_verify() -> String {
    r#"사용법: otterminal verify [옵션]

격리 인스턴스를 **스스로 띄워** 종단간 표면을 훑고 치운다. 세 OS 가 같은 목록을
돈다 — 기동 표면, 도구(PTY+IPC 왕복), 워크스페이스·설정, git 읽기 표면, 정적 자산.

doctor 와 겹치지 않는다. doctor 는 서버 **없이** 플랫폼 계층을 보고, verify 는
서버를 **데몬 모드로** 띄워 그 위의 표면을 본다.

--port·--home 을 받지 않는다. 언제나 임시 홈과 빈 포트에서 돌며, 운영 인스턴스를
건드릴 방법이 없다.

종료 코드: 0 실패 없음 / 1 실패 있음 (건너뜀은 실패가 아니다)

옵션:
  --repo <path>     git 표면 검사의 대상 저장소 (기본: 현재 디렉터리)
"#
    .to_owned()
}

pub fn usage_health() -> String {
    [
        r#"사용법: otterminal health [옵션]

서버 HTTP 응답과 otterminald 소켓·pid 를 확인한다.
종료 코드: 0 정상 / 1 이상 있음

옵션:
  --daemon          데몬의 낡음만 본다 — 지금 도는 otterminald 가 이 바이너리의
                    코드인지. HTTP 검사를 지나지 않으므로 즉시 답한다
                    (scripts/build.sh 가 빌드 끝에 부르는 자리다)
"#,
        common_flags().as_str(),
        r#"
"#,
    ]
    .concat()
}

pub fn usage_rollback() -> String {
    r#"사용법: otterminal rollback [--file <이름>] [--gen <번호>] [--home <경로>]

  상태 파일을 백업 세대로 되돌린다 (G3-2·G4-4).

  --file 을 주지 않으면 workspace.json 이다. 되돌릴 수 있는 것은 세대를 남기는
  상태 파일뿐이다 — settings.json·access.json·runs.json·tools.json.
  설정 가져오기로 덮인 설정을 되돌리는 길이 여기다.

  --gen 없이 부르면 되돌릴 수 있는 세대를 보여 준다. 자동으로 고르지 않는 것은
  어느 세대가 맞는지 사용자만 알기 때문이다.

  되돌리기 전의 판은 지우지 않고 .before-rollback-<시각> 으로 남긴다 —
  세대를 잘못 골랐을 때 돌아올 자리다.

  돌고 있는 인스턴스가 있으면 거부한다. 지금 되돌려도 그 서버가 곧 자기
  메모리로 덮어쓰기 때문이다.
"#
    .to_owned()
}

pub fn usage_backup() -> String {
    [
        r#"사용법: otterminal backup --out <파일.zip> [--home <경로>]

  홈 전체를 zip 하나로 담는다 (G4-3).

  담는 것:
"#,
        layout_list(|e| e.in_backup).as_str(),
        r#"
  담지 않는 것 — 다음 기동이 다시 만드는 것들이고, 소켓은 zip 에 담기지도 않는다:
"#,
        layout_list(|e| !e.in_backup).as_str(),
        r#"
  되돌리는 것은 otterminal restore 다.
  상태 파일 하나를 세대로 되돌리는 것은 otterminal rollback 이다 — 이쪽이 더 좁다.
"#,
    ]
    .concat()
}

pub fn usage_restore() -> String {
    r#"사용법: otterminal restore <파일.zip> [--yes] [--home <경로>]

  backup 으로 담은 zip 을 홈에 되돌린다 (G4-3).

  **담긴 것만 되돌린다.** 담기지 않은 것(로그 등)은 건드리지 않는다 — 복원이
  로그를 지우면 사고 직후의 증거가 사라진다.

  되돌릴 수 없으므로 --yes 가 있어야 진행한다. 먼저 지금 것을 담아 두세요:
    otterminal backup --out <파일.zip>

  홈 밖을 가리키는 항목은 건너뛰고 그 사실을 알린다.
  돌고 있는 서버가 있으면 다시 띄워야 반영된다.
"#
    .to_owned()
}

pub fn usage_uninstall() -> String {
    [
        r#"사용법: otterminal uninstall [--dry-run] [--purge] [--yes] [--home <경로>]

  무엇을 지울지 보인다 (G3-4).

  기본은 **다시 만들어지는 것만** 지운다:
"#,
        layout_list(|e| !e.keep_on_uninstall).as_str(),
        r#"  설정과 배치는 남으므로, 다시 설치하면 그대로 돌아온다.

  --purge    되살릴 수 있는 상태까지 전부 지운다 (설정·배치·메모장)
  --dry-run  목록만 내고 아무것도 지우지 않는다
  --yes      실제로 지운다. 없으면 목록만 내고 멈춘다

  되돌릴 수 없다. 먼저: otterminal backup --out <파일.zip>
"#,
    ]
    .concat()
}

pub fn usage_service() -> String {
    r#"사용법: otterminal service install [--out <파일>] [--home <경로>]

  이 OS 의 감독자에 넣을 정의를 만든다 (SEC-23).

    macOS        launchd plist (KeepAlive — 죽으면 되살린다)
    Linux · WSL  systemd **user** unit (Restart=always)
    Windows      아직 없다. 작업 스케줄러의 안내만 낸다

  지금의 실효 기동값(host·port·로그 수준)을 그대로 박는다 — otterminal config
  show 가 내는 것과 같은 값이다. 나중에 그 값을 바꿨으면 이 파일도 고쳐야 한다.

  **설치하지 않는다.** 파일을 쓰고 다음 걸음을 안내한다 — 사용자의 감독자
  설정에 손을 넣으면 그것을 되돌리는 길도 이 명령이 져야 한다.

  --out 을 주지 않으면 화면에 낸다.
"#
    .to_owned()
}

pub fn usage_update() -> String {
    r#"사용법: otterminal update [--check]

  최신 판이 있는지 확인한다 (G3-3).

  **이 제품은 스스로 판을 확인하지 않는다.** --check 를 줄 때만 밖으로 나간다 —
  상시 노출된 작업 도구가 묻지 않고 나가면 그 트래픽은 사용자가 통제하지 못하는
  것이 된다.

  **내려받지 않는다.** 설치 형태가 여럿이라(직접 빌드·릴리스 산출물·패키지
  매니저) 스스로 자기 바이너리를 덮으면 그중 어느 형태에서는 패키지 관리자와
  싸운다. 무엇을 받을지 알려 주고 거기서 멈춘다.
"#
    .to_owned()
}

pub fn usage_config() -> String {
    r#"사용법: otterminal config <show|validate> [--json] [--home <경로>]
       otterminal config set port <1024~65535> [--home <경로>]
       otterminal config set expose <on|off> [--home <경로>]
       otterminal config get [--home <경로>]

  설정의 **실효값과 그 출처**를 보이고, 설정 파일을 서술자 표에 대조한다
  (CONFIG_MANAGEMENT_SRS 묶음 C).

  show      서버 기동값이 지금 무엇이고 **어디서 왔는지** 낸다.
            출처는 flag · env · file · default 넷이며 우선순위도 그 순서다.
            안 듣는 설정을 쫓을 때 사람이 묻는 것은 값이 아니라 출처다.

  validate  server.json 과 settings.json 을 대조한다. 불일치를 **전부** 내며
            첫 오류에서 멈추지 않는다 — 고치고 다시 돌리는 왕복을 키 수만큼
            시키지 않는다. 불일치가 있으면 exit 1.

            **알 수 없는 키는 경고이지 실패가 아니다.** 판이 앞선 브라우저가
            쓴 키가 빨갛게 뜨면 사용자가 멀쩡한 설정을 지운다.

  --json    기계가 읽는 형태. 기본은 사람이 읽는 표다.

  set       포트나 expose 를 바꾼다. 서버가 돌고 있으면 끄지 않고 바꾸고
            (열린 화면은 새 주소로 옮겨 간다), 돌고 있지 않으면 server.json 만 고친다.
            바인드는 서버가 도는 컴퓨터에서만 바꿀 수 있다.

  get       지금 리슨하는 바인드($OTTERMINAL_HOME/run/server.addr)와
            server.json 의 값·출처를 함께 보인다.

  서버는 settings.json 을 **런타임에 해석하지 않는다.** 이 명령이 그것을 읽는
  것은 사람이 부를 때만 도는 진단이며 요청 경로에 없다.
"#
    .to_owned()
}

pub fn usage_migrate() -> String {
    [
        r#"사용법: otterminal migrate [옵션]

워크스페이스 데이터를 최신 스키마로 변환한다. 멱등이다.
서버가 포트에서 응답하면 변환을 거부한다 — 먼저 otterminal stop --all.

옵션:
  --dry-run, -n     변환 내용만 출력하고 파일을 건드리지 않는다
"#,
        common_flags().as_str(),
        r#"

백업: *.v1.bak       스키마 변환 직전 (v1 원본)
      *.preuuid.bak  식별자 재작성 직전
"#,
    ]
    .concat()
}
