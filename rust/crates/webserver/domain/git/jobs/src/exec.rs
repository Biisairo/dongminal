//! 잡의 git 실행: 줄 단위로 흘려보낸다 (FR-GIT-107).

use std::io::{BufReader, Read};
use std::process::Command;
use std::sync::Arc;

use otter_webserver_domain_git_core::{self as core, Ctx, CtxError, Kind, SpawnError};

use crate::job::{JOB_LINE_MAX, LINE_STDERR, LINE_STDOUT};

/// 줄 하나를 받는 자리다. (stream, text).
pub type Emit = Arc<dyn Fn(&str, &str) + Send + Sync>;

/// Go `execStreamGit`: 공통 기동(core::command)으로 git 을 띄워 줄을 흘린다.
pub async fn exec_stream_git(
    ctx: Ctx,
    dir: String,
    args: Vec<String>,
    stdin: String,
    emit: Emit,
) -> (i32, Option<core::Error>) {
    let gc = match core::command(&dir, &args, &stdin) {
        Ok(gc) => gc,
        Err(e) => return (-1, Some(e)),
    };
    exec_stream(&ctx, gc.cmd, gc.stdin, &gc.bin, &args, emit).await
}

pub(crate) async fn exec_stream(
    ctx: &Ctx,
    cmd: Command,
    stdin: Option<String>,
    bin: &str,
    args: &[String],
    emit: Emit,
) -> (i32, Option<core::Error>) {
    let (eo, ee) = (Arc::clone(&emit), emit);
    let res = core::spawn(
        ctx,
        cmd,
        stdin,
        Box::new(move |r| read_lines(r, |t| eo(LINE_STDOUT, t))),
        Box::new(move |r| read_lines(r, |t| ee(LINE_STDERR, t))),
    )
    .await;
    let exit = match &res {
        Ok(st) => st.code().unwrap_or(-1),
        Err(SpawnError::Bind { status, .. }) => status.and_then(|s| s.code()).unwrap_or(-1),
        Err(SpawnError::Start { .. }) => -1,
    };
    let joined = args.join(" ");
    match ctx.err() {
        Some(CtxError::DeadlineExceeded) => {
            return (
                exit,
                Some(core::Error::new(
                    Kind::Timeout,
                    format!("git {joined} 가 상한을 넘겨 종료됐다"),
                )),
            );
        }
        Some(CtxError::Canceled) => return (exit, None),
        None => {}
    }
    if exit > 0 {
        return (exit, None);
    }
    let wait_err = match &res {
        Ok(st) if st.success() => return (exit, None),
        Ok(st) => core::exit_status_string(st),
        Err(e) => {
            if core::vanished_bin(bin, e) {
                return (exit, Some(core::Error::new(Kind::GitMissing, e)));
            }
            e.to_string()
        }
    };
    let base = otter_gocompat::filepath::base(bin);
    (
        exit,
        Some(core::Error::other(format!("{base} {joined}: {wait_err}"))),
    )
}

/// `\n`·`\r` 로 줄을 가르고, 줄이 [`JOB_LINE_MAX`] 에 닿으면 문자 경계에서 끊는다.
pub(crate) fn read_lines(r: Box<dyn Read + Send>, mut emit: impl FnMut(&str)) {
    let mut br = BufReader::with_capacity(JOB_LINE_MAX, r);
    let mut buf: Vec<u8> = Vec::with_capacity(JOB_LINE_MAX);
    let flush = |buf: &mut Vec<u8>, emit: &mut dyn FnMut(&str)| {
        if !buf.is_empty() {
            emit(&String::from_utf8_lossy(buf));
            buf.clear();
        }
    };
    let mut byte = [0u8; 1];
    loop {
        match br.read(&mut byte) {
            Ok(1) => {}
            Ok(_) | Err(_) => {
                flush(&mut buf, &mut emit);
                return;
            }
        }
        let b = byte[0];
        if b == b'\n' || b == b'\r' {
            flush(&mut buf, &mut emit);
            continue;
        }
        buf.push(b);
        if buf.len() >= JOB_LINE_MAX {
            let cut = rune_cut(&buf);
            emit(&String::from_utf8_lossy(&buf[..cut]));
            buf.drain(..cut);
        }
    }
}

/// 끝의 덜 끝난 UTF-8 문자를 다음 조각으로 넘기는 자리다 (Go `runeCut`).
pub(crate) fn rune_cut(b: &[u8]) -> usize {
    const UTF_MAX: usize = 4;
    let n = b.len();
    let mut i = n.saturating_sub(1);
    while i > 0 && i + UTF_MAX >= n {
        if !rune_start(b[i]) {
            i -= 1;
            continue;
        }
        if full_rune(&b[i..]) {
            return n;
        }
        return i;
    }
    n
}

fn rune_start(b: u8) -> bool {
    b & 0xC0 != 0x80
}

/// Go `utf8.FullRune`: 앞부분이 완전한 문자(또는 잘못된 바이트)인가.
fn full_rune(p: &[u8]) -> bool {
    let Some(&c) = p.first() else {
        return false;
    };
    let need = match c {
        0x00..=0x7F => 1,
        0xC2..=0xDF => 2,
        0xE0..=0xEF => 3,
        0xF0..=0xF4 => 4,
        _ => return true,
    };
    if p.len() >= need {
        return true;
    }
    // 둘째 바이트가 이미 잘못됐으면 Go 는 완전하다(잘못된 문자 하나)고 본다.
    if p.len() >= 2 {
        let (lo, hi) = match c {
            0xE0 => (0xA0, 0xBF),
            0xED => (0x80, 0x9F),
            0xF0 => (0x90, 0xBF),
            0xF4 => (0x80, 0x8F),
            _ => (0x80, 0xBF),
        };
        if !(lo..=hi).contains(&p[1]) {
            return true;
        }
    }
    false
}
