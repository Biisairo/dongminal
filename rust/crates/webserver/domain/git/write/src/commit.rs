//! 커밋과 커밋 하나를 대상으로 하는 동작 (FR-GIT-77·82·263~266).

use std::time::Duration;

use otter_gocompat::strconv::quote;
use otter_webserver_domain_git_core::{self as core, Ctx, Hint, Output, Service, WriteSpec};
use serde::{Deserialize, Serialize};

use crate::error::{Error, WriteKind, exec, exec_write};

/// 메시지는 stdin 이다 (FR-GIT-77).
const COMMIT_FILE_STDIN: &str = "--file=-";
const COMMIT_CLEANUP: &str = "--cleanup=strip";

/// 커밋을 되돌릴 수 있는 창이다 (FR-GIT-83, O7).
pub const UNDO_TTL: Duration = Duration::from_secs(5);

/// 직전 커밋 이전의 상태다.
const UNDO_REV: &str = "HEAD@{1}";

/// 커밋 한 번의 옵션이다 (FR-GIT-79).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CommitOpts {
    pub message: String,
    pub amend: bool,
    pub sign_off: bool,
    pub no_verify: bool,
    pub all: bool,
}

/// `git commit --file=- --cleanup=strip [--amend] [--signoff] [--no-verify] [-a]`
pub fn commit_spec(o: &CommitOpts) -> WriteSpec {
    let mut argv = argv(&["commit", COMMIT_FILE_STDIN, COMMIT_CLEANUP]);
    for (on, flag) in [
        (o.amend, "--amend"),
        (o.sign_off, "--signoff"),
        (o.no_verify, "--no-verify"),
        (o.all, "-a"),
    ] {
        if on {
            argv.push(flag.to_owned());
        }
    }
    WriteSpec {
        argv,
        destructive: false,
        stdin: o.message.clone(),
    }
}

/// `git reset --soft HEAD@{1}` (FR-GIT-82).
pub async fn undo_last(s: &Service, ctx: &Ctx, repo: &str) -> Result<Output, Error> {
    exec_write(
        s,
        ctx,
        repo,
        spec(argv(&["reset", "--soft", UNDO_REV]), false),
    )
    .await
}

/// git 의 `--cleanup=strip` 과 같은 정규화다 (REPO_FIX 01 §7.7).
pub fn normalize_commit_message(msg: &str, comment_prefix: &str) -> String {
    let mut out: Vec<&str> = Vec::new();
    let mut blank = false;
    let msg = msg.replace("\r\n", "\n");
    for line in msg.split('\n') {
        if !comment_prefix.is_empty() && line.starts_with(comment_prefix) {
            continue;
        }
        let line = line.trim_end_matches([' ', '\t']);
        if line.is_empty() {
            blank = !out.is_empty();
            continue;
        }
        if blank {
            out.push("");
            blank = false;
        }
        out.push(line);
    }
    out.join("\n")
}

/// 커밋 메시지의 주석 접두다. `core.commentString` → `core.commentChar` → `#`. `auto` 면 "".
pub async fn comment_prefix(s: &Service, ctx: &Ctx, repo: &str) -> String {
    for key in ["core.commentString", "core.commentChar"] {
        let Ok(out) = exec(s, ctx, repo, &["config", "--get", "--default=", key]).await else {
            continue;
        };
        let v = out.stdout_str();
        let v = v.trim_end_matches('\n');
        match v {
            "" => continue,
            "auto" => return String::new(),
            _ => return v.to_owned(),
        }
    }
    "#".to_owned()
}

/// 메시지에 Signed-off-by 트레일러 줄이 있는가다.
pub fn has_signoff(msg: &str) -> bool {
    msg.split('\n').any(|l| l.starts_with("Signed-off-by:"))
}

pub const PICK_CHERRY: &str = "cherry-pick";
pub const PICK_REVERT: &str = "revert";

pub const RESET_SOFT: &str = "soft";
pub const RESET_MIXED: &str = "mixed";
pub const RESET_HARD: &str = "hard";

/// 다이얼로그가 보일 순서다. 파괴적인 것이 마지막이다 (O14).
pub const RESET_MODES: [&str; 3] = [RESET_MIXED, RESET_SOFT, RESET_HARD];

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "write.PickOpts")]
pub struct PickOpts {
    pub oid: String,
    pub merge: bool,
    /// 머지 커밋의 부모 번호 (1-based).
    pub mainline: i64,
    /// revert 의 --no-commit (FR-GIT-264).
    #[serde(rename = "noCommit")]
    pub no_commit: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "write.ResetOpts")]
pub struct ResetOpts {
    pub oid: String,
    /// soft | mixed | hard. 비면 mixed.
    pub mode: String,
}

/// `git cherry-pick [-m <n>] <oid>` / `git revert [-m <n>] [--no-commit] <oid>`
pub fn pick_args(verb: &str, o: &PickOpts) -> Result<Vec<String>, Error> {
    if verb != PICK_CHERRY && verb != PICK_REVERT {
        return Err(Error::new(WriteKind::PickVerb, quote(verb)));
    }
    core::check_ref_arg("oid", &o.oid)?;
    if o.no_commit && verb != PICK_REVERT {
        return Err(Error::new(
            WriteKind::PickVerb,
            format!("--no-commit 은 {PICK_REVERT} 의 옵션이다"),
        ));
    }
    if o.merge && o.mainline < 1 {
        return Err(Error::new(
            WriteKind::MergeParent,
            format!("머지 커밋 {} 는 부모 번호를 받아야 한다", o.oid),
        ));
    }
    if !o.merge && o.mainline != 0 {
        return Err(Error::new(
            WriteKind::MergeParent,
            format!("머지 커밋이 아닌 {} 에 부모 번호를 줄 수 없다", o.oid),
        ));
    }
    let mut out = vec![verb.to_owned()];
    if o.merge {
        out.push("-m".to_owned());
        out.push(o.mainline.to_string());
    }
    if o.no_commit {
        out.push("--no-commit".to_owned());
    }
    out.push(o.oid.clone());
    Ok(out)
}

/// 모드를 생략하면 `--mixed` 다 (FR-GIT-97).
pub fn reset_args(o: &ResetOpts) -> Result<Vec<String>, Error> {
    core::check_ref_arg("oid", &o.oid)?;
    let mode = if o.mode.is_empty() {
        RESET_MIXED
    } else {
        o.mode.as_str()
    };
    if mode != RESET_SOFT && mode != RESET_MIXED && mode != RESET_HARD {
        return Err(Error::new(WriteKind::ResetMode, quote(&o.mode)));
    }
    Ok(vec!["reset".to_owned(), format!("--{mode}"), o.oid.clone()])
}

/// `git rebase --onto <oid>^ <oid>` (FR-GIT-266).
pub fn drop_args(oid: &str) -> Result<Vec<String>, Error> {
    core::check_ref_arg("oid", oid)?;
    Ok(vec![
        "rebase".to_owned(),
        "--onto".to_owned(),
        format!("{oid}^"),
        oid.to_owned(),
    ])
}

/// 현재 브랜치를 그 커밋으로 옮긴다 (FR-GIT-265). `--hard` 만 파괴적이며 실행 전에 hint 를 남긴다.
pub async fn reset(
    s: &Service,
    ctx: &Ctx,
    repo: &str,
    o: &ResetOpts,
    head_oid: &str,
) -> Result<Output, Error> {
    let argv = reset_args(o)?;
    let hard = o.mode == RESET_HARD;
    if hard {
        s.add_hint(restore_head_hint(
            repo,
            core::ACTION_RESET_HARD,
            &o.oid,
            head_oid,
            "워킹 트리와 index 를 그 커밋으로 되돌린다. 저장하지 않은 변경은 git 에 남은 적이 없어 되살릴 값이 없다.",
        ));
    }
    exec_write(s, ctx, repo, spec(argv, hard)).await
}

/// 커밋 하나를 히스토리에서 빼는 spec 과 recovery hint 다 (FR-GIT-266). 파괴적이다.
pub fn drop_spec(repo: &str, oid: &str, head_oid: &str) -> Result<(WriteSpec, Hint), Error> {
    let argv = drop_args(oid)?;
    let hint = restore_head_hint(
        repo,
        core::ACTION_COMMIT_DROP,
        oid,
        head_oid,
        "그 커밋을 빼고 뒤따르는 커밋을 다시 얹는다. 해시가 전부 바뀐다.",
    );
    Ok((spec(argv, true), hint))
}

/// 옮기기 전 HEAD 로 되돌아가는 명령이다 (FR-GIT-250.2). headOid 가 비면 명령을 지어내지 않는다.
fn restore_head_hint(repo: &str, action: &str, target: &str, head_oid: &str, note: &str) -> Hint {
    let mut h = Hint {
        repo: repo.to_owned(),
        action: action.to_owned(),
        targets: Some(vec![target.to_owned()]),
        note: note.to_owned(),
        ..Hint::default()
    };
    if head_oid.is_empty() {
        return h;
    }
    h.values = Some(vec![head_oid.to_owned()]);
    h.command = format!("git reset --hard {head_oid}");
    h
}

pub(crate) fn argv(a: &[&str]) -> Vec<String> {
    a.iter().map(|s| (*s).to_owned()).collect()
}

pub(crate) fn spec(argv: Vec<String>, destructive: bool) -> WriteSpec {
    WriteSpec {
        argv,
        destructive,
        stdin: String::new(),
    }
}
