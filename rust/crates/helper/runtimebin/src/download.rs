//! `download` — 터미널에 OSC 777 Download 를 써서 브라우저가 파일을 받게 한다.

use crate::ctx::{Ctx, outf};

pub(crate) fn run_download(ctx: &mut Ctx<'_>, args: &[String]) -> i32 {
    let mut path = args.first().cloned().unwrap_or_default();
    if !path.is_empty()
        && let Ok(abs) = dm_gocompat::filepath::abs(&path)
    {
        path = abs;
    }
    outf!(ctx, "\x1b]777;Download;{path}\x07");
    0
}
