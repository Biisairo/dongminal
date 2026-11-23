//! 6.3.2(run)·6.3.3(edge·account·훅·chat-mcp) 이 채울 하위 명령의 자리다.

use crate::ctx::{Ctx, errf};

pub(crate) fn run(ctx: &mut Ctx<'_>, cmd: &str, _args: &[String]) -> i32 {
    errf!(ctx, "dmctl {cmd}: 아직 Rust 로 옮기지 않았다\n");
    1
}
