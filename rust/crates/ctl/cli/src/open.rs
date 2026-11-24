//! frameless window 열기. 명령 조립은 platform 이 한다 (FR-XBR-3).

use otter_gocompat::oserr::go_error_string;

/// frameless window 를 연다. 문구는 Go `exec.Cmd.Start` 의 오류와 같다.
pub(crate) fn open_frameless(url: &str) -> Result<(), String> {
    let (name, args) = otter_shared_platform::current()
        .browser
        .frameless_command(url)
        .map_err(|e| go_error_string(&e))?;
    start(&name, &args)
}

/// Go `exec.Command(name, args...).Start()` 다. 경로 구분자가 없는 이름은 PATH 에서 찾는다.
fn start(name: &str, args: &[String]) -> Result<(), String> {
    let has_sep = name.contains('/') || (cfg!(windows) && name.contains('\\'));
    let prog = if has_sep {
        name.to_owned()
    } else {
        otter_shared_platform::try_look_path(name)
            .map_err(|e| otter_shared_platform::exec_error(name, e))?
    };
    std::process::Command::new(&prog)
        .args(args)
        .spawn()
        .map(drop)
        .map_err(|e| format!("fork/exec {prog}: {}", go_error_string(&e)))
}
