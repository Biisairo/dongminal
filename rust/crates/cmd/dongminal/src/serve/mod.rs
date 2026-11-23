//! 서버 조립 (이슈 7.3 이 채운다). 7.2 는 컴파일만 되는 자리를 둔다.

use dm_shared_dmlog::errorf;

/// `dongminal start --foreground` 의 실체다. 7.3 이 Go `serve` 로 바꾼다.
pub(crate) fn serve(_t: &dm_ctl_cli::ServeTarget<'_>) -> i32 {
    errorf!(None, "server init: 서버 조립이 이 빌드에 없습니다");
    1
}
