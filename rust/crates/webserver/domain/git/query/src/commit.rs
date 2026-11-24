//! 커밋 메시지 조회와 커밋 상세 (FR-GIT-76·135~138).

use otter_gocompat::strconv::quote;
use otter_webserver_domain_git_core::{Ctx, Service};
use serde::Serialize;

use crate::error::{Error, QueryKind};
use crate::log::{
    Commit, LOG_DECORATE, LOG_FIELDS, LOG_FORMAT, check_rev, commit_from_fields, rev_error,
};

const LAST_MESSAGE_FORMAT: &str = "--pretty=%B";
const HEAD_COMMIT_FORMAT: &str = "--pretty=%H%x00%B";
const DETAIL_FIELDS: usize = 12;

/// 루트 커밋의 parentIndex.
pub const COMMIT_NO_PARENT: i64 = -1;
const NAME_STATUS_FIELDS: usize = 2;
const NAME_STATUS_RENAMED: usize = 3;

/// HEAD 커밋 메시지다 (amend 의 초기값).
pub async fn last_commit_message(s: &Service, ctx: &Ctx, repo: &str) -> Result<String, Error> {
    let out = s
        .exec(ctx, repo, &["log", "-1", LAST_MESSAGE_FORMAT])
        .await?;
    Ok(out.stdout_str().trim_end_matches('\n').to_owned())
}

/// HEAD 의 oid 와 메시지다.
pub async fn head_commit(s: &Service, ctx: &Ctx, repo: &str) -> Result<(String, String), Error> {
    let out = s
        .exec(ctx, repo, &["log", "-1", HEAD_COMMIT_FORMAT])
        .await?;
    let text = out.stdout_str();
    let (oid, msg) = text.split_once('\0').unwrap_or((&text, ""));
    Ok((oid.to_owned(), msg.trim_end_matches('\n').to_owned()))
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct CommitFile {
    pub status: String,
    pub path: String,
    #[serde(rename = "origPath", skip_serializing_if = "String::is_empty")]
    pub orig_path: String,
    #[serde(skip_serializing_if = "crate::status::is_zero")]
    pub score: i64,
}

/// 커밋 상세. JSON 은 Go 의 임베드(Commit 필드 뒤에 상세 필드)와 같은 순서다.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CommitDetail {
    pub commit: Commit,
    pub committer_name: String,
    pub committer_mail: String,
    pub body: String,
    pub files: Vec<CommitFile>,
    pub parent_index: i64,
}

#[derive(Serialize)]
struct CommitDetailWire<'a> {
    oid: &'a str,
    abbrev: &'a str,
    parents: &'a [String],
    #[serde(rename = "authorName")]
    author_name: &'a str,
    #[serde(rename = "authorMail")]
    author_mail: &'a str,
    #[serde(rename = "authorAtUnixMs")]
    author_at: i64,
    #[serde(rename = "commitAtUnixMs")]
    commit_at: i64,
    subject: &'a str,
    refs: &'a [crate::log::CommitRef],
    #[serde(rename = "isHead")]
    is_head: bool,
    #[serde(rename = "committerName")]
    committer_name: &'a str,
    #[serde(rename = "committerMail")]
    committer_mail: &'a str,
    body: &'a str,
    files: &'a [CommitFile],
    #[serde(rename = "parentIndex")]
    parent_index: i64,
}

impl Serialize for CommitDetail {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let c = &self.commit;
        CommitDetailWire {
            oid: &c.oid,
            abbrev: &c.abbrev,
            parents: &c.parents,
            author_name: &c.author_name,
            author_mail: &c.author_mail,
            author_at: c.author_at,
            commit_at: c.commit_at,
            subject: &c.subject,
            refs: &c.refs,
            is_head: c.is_head,
            committer_name: &self.committer_name,
            committer_mail: &self.committer_mail,
            body: &self.body,
            files: &self.files,
            parent_index: self.parent_index,
        }
        .serialize(s)
    }
}

/// 커밋 하나의 상세와 변경 파일이다. parent_index 번째 부모와 비교한다.
pub async fn commit_detail_of(
    s: &Service,
    ctx: &Ctx,
    repo: &str,
    oid: &str,
    parent_index: i64,
) -> Result<CommitDetail, Error> {
    check_rev("oid", oid)?;
    let format = format!("{LOG_FORMAT}%x00%cn%x00%ce%x00%B");
    let out = s
        .exec(
            ctx,
            repo,
            &["log", "-z", format.as_str(), LOG_DECORATE, "-n", "1", oid],
        )
        .await
        .map_err(rev_error)?;
    let mut d = parse_commit_detail(&out.stdout_str())?;
    let args = commit_files_args(oid, &d.commit.parents, parent_index)?;
    let tree = s.exec(ctx, repo, &args).await.map_err(rev_error)?;
    if tree.stdout_truncated {
        return Err(Error::other(format!(
            "git diff-tree 의 출력이 상한({}B)에서 잘렸다: 변경 파일 목록을 온전히 줄 수 없다",
            s.max_output()
        )));
    }
    d.files = parse_name_status_z(&tree.stdout_str())?;
    d.parent_index = if d.commit.parents.is_empty() {
        COMMIT_NO_PARENT
    } else {
        parent_index
    };
    Ok(d)
}

pub(crate) fn commit_files_args(
    oid: &str,
    parents: &[String],
    parent_index: i64,
) -> Result<Vec<String>, Error> {
    let mut base: Vec<String> = [
        "diff-tree",
        "--no-commit-id",
        "--name-status",
        "-r",
        "-z",
        "-M",
    ]
    .map(String::from)
    .to_vec();
    if parents.is_empty() {
        if parent_index > 0 {
            return Err(Error::new(
                QueryKind::CommitParent,
                format!("루트 커밋에는 부모가 없다 (parent={parent_index})"),
            ));
        }
        if parent_index < 0 {
            return Err(Error::new(
                QueryKind::CommitParent,
                format!("부모 번호가 음수다 (parent={parent_index})"),
            ));
        }
        base.extend(["--root".into(), oid.into()]);
        return Ok(base);
    }
    if parent_index < 0 || parent_index >= parents.len() as i64 {
        return Err(Error::new(
            QueryKind::CommitParent,
            format!("부모 {parent_index} 가 없다 (부모 {}개)", parents.len()),
        ));
    }
    base.extend([format!("{oid}^{}", parent_index + 1), oid.into()]);
    Ok(base)
}

fn parse_commit_detail(out: &str) -> Result<CommitDetail, Error> {
    if out.is_empty() {
        return Err(Error::new(
            QueryKind::RevNotFound,
            "git log 가 커밋을 주지 않았다",
        ));
    }
    let f: Vec<&str> = out.splitn(DETAIL_FIELDS, '\0').collect();
    if f.len() < DETAIL_FIELDS {
        return Err(Error::other(format!(
            "git log(상세): 필드가 {}개다 (want {DETAIL_FIELDS})",
            f.len()
        )));
    }
    Ok(CommitDetail {
        commit: commit_from_fields(&f[..LOG_FIELDS]),
        committer_name: f[9].into(),
        committer_mail: f[10].into(),
        body: f[11].into(),
        ..CommitDetail::default()
    })
}

/// `diff-tree --name-status -z` 출력을 파싱한다.
pub fn parse_name_status_z(out: &str) -> Result<Vec<CommitFile>, Error> {
    if out.is_empty() {
        return Ok(Vec::new());
    }
    let mut toks: Vec<&str> = out.split('\0').collect();
    if toks.last() == Some(&"") {
        toks.pop();
    }
    let mut files = Vec::new();
    let mut i = 0;
    while i < toks.len() {
        let st = toks[i];
        if st.is_empty() {
            return Err(Error::other(format!(
                "diff-tree -z: 상태 조각이 비었다 (조각 {i})"
            )));
        }
        let split = st.chars().next().map_or(1, char::len_utf8);
        let mut f = CommitFile {
            status: st[..split].into(),
            ..CommitFile::default()
        };
        if st.len() > split {
            f.score = crate::status::atoi(&st[split..]).ok_or_else(|| {
                Error::other(format!(
                    "diff-tree -z: 상태 {} 의 점수를 읽지 못했다",
                    quote(st)
                ))
            })?;
        }
        let want = if f.status == "R" || f.status == "C" {
            NAME_STATUS_RENAMED
        } else {
            NAME_STATUS_FIELDS
        };
        if i + want > toks.len() {
            return Err(Error::other(format!(
                "diff-tree -z: {} 레코드의 조각이 {}개다 (want {want})",
                quote(st),
                toks.len() - i
            )));
        }
        if want == NAME_STATUS_RENAMED {
            f.orig_path = toks[i + 1].into();
            f.path = toks[i + 2].into();
        } else {
            f.path = toks[i + 1].into();
        }
        files.push(f);
        i += want;
    }
    Ok(files)
}
