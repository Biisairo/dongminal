//! 부분 스테이징 (FR-GIT-67~72): hunk·줄 범위를 패치로 만들어 `git apply` 에 stdin 으로 준다.

use otter_gocompat::strconv::quote;
use otter_webserver_domain_git_core::{self as core, Ctx, Hint, Output, Service, WriteSpec};
use otter_webserver_domain_git_query as query;

use crate::commit::argv;
use crate::error::{Error, WriteKind, exec_write};

/// worktree → index.
pub const PATCH_STAGE: &str = "stage";
/// index → HEAD 로 되돌린다.
pub const PATCH_UNSTAGE: &str = "unstage";
/// 워킹 트리의 그 줄을 버린다. 파괴적이다.
pub const PATCH_REVERT: &str = "revert";

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PatchOpts {
    pub op: String,
    pub axis: String,
    pub path: String,
    pub hunk: i64,
    /// 1-based 줄 범위. 둘 다 0 이면 hunk 전체.
    pub from: i64,
    pub to: i64,
    /// 클라이언트가 본 관측 식별자 (FR-GIT-72).
    pub diff_id: String,
}

fn patch_axis(op: &str) -> &'static str {
    match op {
        PATCH_UNSTAGE => query::AXIS_INDEX_HEAD,
        _ => query::AXIS_WORKTREE_INDEX,
    }
}

/// op 의 argv 와 파괴 여부.
pub fn patch_args(op: &str) -> Result<(Vec<String>, bool), Error> {
    match op {
        PATCH_STAGE => Ok((
            argv(&["apply", "--cached", "--whitespace=nowarn", "-"]),
            false,
        )),
        PATCH_UNSTAGE => Ok((
            argv(&["apply", "--cached", "-R", "--whitespace=nowarn", "-"]),
            false,
        )),
        PATCH_REVERT => Ok((argv(&["apply", "-R", "--whitespace=nowarn", "-"]), true)),
        _ => Err(Error::new(
            WriteKind::PatchOp,
            format!("{} 는 부분 스테이징의 동작이 아니다", quote(op)),
        )),
    }
}

pub async fn patch(s: &Service, ctx: &Ctx, repo: &str, o: &PatchOpts) -> Result<Output, Error> {
    let (av, destructive) = patch_args(&o.op)?;
    let want = patch_axis(&o.op);
    if o.axis != want {
        return Err(Error::new(
            WriteKind::PatchAxis,
            format!(
                "{} 는 {want} 축의 동작이다 (받은 축 {})",
                o.op,
                quote(&o.axis)
            ),
        ));
    }
    if o.diff_id.trim().is_empty() {
        return Err(Error::new(
            WriteKind::PatchStale,
            "관측 식별자가 없다 — 무엇을 보고 고른 조각인지 알 수 없다",
        ));
    }
    let fd = query::hunks_of(s, ctx, repo, &o.axis, &o.path).await?;
    if fd.diff_id != o.diff_id {
        return Err(Error::new(
            WriteKind::PatchStale,
            "관측이 그 사이 바뀌었다 — 낡은 hunk 번호로 다른 곳을 고치지 않는다",
        ));
    }
    let n = fd.hunks.len();
    let Some(h) = usize::try_from(o.hunk).ok().and_then(|i| fd.hunks.get(i)) else {
        return Err(Error::new(
            WriteKind::PatchRange,
            format!("hunk {} 은 {n} 개 중에 없다", o.hunk),
        ));
    };
    let text = build_patch(&fd, h, o.from, o.to, o.op != PATCH_STAGE)?;
    if destructive {
        s.add_hint(patch_hint(repo, &fd.path));
    }
    let spec = WriteSpec {
        argv: av,
        destructive,
        stdin: text,
    };
    exec_write(s, ctx, repo, spec).await
}

fn build_patch(
    fd: &query::FileDiff,
    h: &query::Hunk,
    from: i64,
    to: i64,
    reverse: bool,
) -> Result<String, Error> {
    let n = i64::try_from(h.lines.len()).unwrap_or(i64::MAX);
    let all = from == 0 && to == 0;
    if !all && (from < 1 || to < from || to > n) {
        return Err(Error::new(
            WriteKind::PatchRange,
            format!("줄 범위 {from}~{to} 은 {n} 줄짜리 덩어리에 없다"),
        ));
    }
    let sel = |i: i64| all || (i >= from && i <= to);
    let (body, old_n, new_n, changed) = patch_body(h, sel, reverse);
    if changed == 0 {
        return Err(Error::new(
            WriteKind::PatchEmpty,
            "고른 범위에 바뀐 줄이 없다",
        ));
    }
    let mut b = String::new();
    for l in &fd.preamble {
        b.push_str(l);
        b.push('\n');
    }
    b.push_str(&format!(
        "@@ -{},{old_n} +{},{new_n} @@\n",
        h.old_start, h.new_start
    ));
    for l in body {
        b.push_str(&l);
        b.push('\n');
    }
    Ok(b)
}

/// 고른 줄은 그대로, 고르지 않은 쪽은 버리거나(drop) 문맥으로 바꾼다.
fn patch_body(
    h: &query::Hunk,
    sel: impl Fn(i64) -> bool,
    reverse: bool,
) -> (Vec<String>, i64, i64, i64) {
    let drop = if reverse {
        query::HUNK_DEL_MARK
    } else {
        query::HUNK_ADD_MARK
    };
    let (mut body, mut old_n, mut new_n, mut changed) = (Vec::new(), 0, 0, 0);
    let mut kept = false;
    for (i, l) in h.lines.iter().enumerate() {
        let Some(&mark) = l.as_bytes().first() else {
            continue;
        };
        if mark == query::HUNK_NO_NEWLINE {
            if kept {
                body.push(l.clone());
            }
            continue;
        }
        if mark == query::HUNK_CONTEXT_MARK {
            body.push(l.clone());
            old_n += 1;
            new_n += 1;
            kept = true;
        } else if sel(i64::try_from(i).unwrap_or(i64::MAX) + 1) {
            body.push(l.clone());
            changed += 1;
            kept = true;
            if mark == query::HUNK_DEL_MARK {
                old_n += 1;
            } else {
                new_n += 1;
            }
        } else if mark == drop {
            kept = false;
        } else {
            let mut ctx_line = String::from(char::from(query::HUNK_CONTEXT_MARK));
            ctx_line.push_str(&String::from_utf8_lossy(&l.as_bytes()[1..]));
            body.push(ctx_line);
            old_n += 1;
            new_n += 1;
            kept = true;
        }
    }
    (body, old_n, new_n, changed)
}

fn patch_hint(repo: &str, path: &str) -> Hint {
    Hint {
        repo: repo.to_owned(),
        action: core::ACTION_DISCARD.to_owned(),
        targets: Some(vec![path.to_owned()]),
        command: format!("git stash push -- {}", patch_sh_quote(path)),
        note: "고른 줄의 워킹 트리 내용은 git 에 저장된 적이 없어 되살릴 값이 없다. 버리기 전에 위 명령을 실행하면 stash 로 남는다.".to_owned(),
        ..Hint::default()
    }
}

fn patch_sh_quote(p: &str) -> String {
    format!("'{}'", p.replace('\'', r"'\''"))
}
