//! 트리의 이슈 원천 조회 (UX_BATCH14_SRS FR-ITV-1·2·4·5·10). `GET /api/runs/issue-tree?ref=<트리>[&refresh=1]`.
//!
//! GitHub 트리(`owner/repo#N`)는 `gh api graphql` 의 `subIssues` 를 단계마다 한 번씩 읽는다. gh 호출은 사건 때만이다
//! (D-UB14-8): 결과는 트리마다 메모리에 두고, `refresh` 없는 GET 은 그것을 돌려준다. 실패도 마지막 결과다(FR-ITV-10).
//! 로컬 트리(Run 의 `issueDir`)는 이슈 폴더를 `issuefile` 로 그때그때 읽는다 — 외부 프로세스가 없다.
//! `/api/runs/tree` 는 Go 골든 모양이라 바꾸지 않고 이 종단을 따로 둔다 (D-UB14-10).

use std::collections::HashMap;
use std::pin::Pin;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use http::StatusCode;
use otter_shared_httpresp::Response;
use otter_webserver_apierr as apierr;
use otter_webserver_domain_run as run;
use serde::Serialize;
use serde_json::Value;

use crate::Server;
use crate::httperr::{http_err, write_json};
use crate::req::Req;

/// 단계마다 읽는 하위 이슈 수의 상한 — issue-tree 명령 문서의 `subIssues(first:100)` 와 같다 (A-4).
const GH_PAGE: usize = 100;
/// 하위 이슈를 따라 내려가는 깊이의 상한 (A-4).
const GH_DEPTH: usize = 8;
/// 몰린 새로고침을 합치는 최소 간격 (FR-ITV-4). 사용자가 단추를 거듭 눌러도 gh 는 이 간격에 한 번이다.
const GH_MIN_GAP: Duration = Duration::from_secs(2);
/// gh 한 번의 시한. 넘으면 실패로 남긴다.
const GH_TIMEOUT: Duration = Duration::from_secs(30);
/// 오류 글의 길이 상한(바이트).
const GH_MESSAGE_MAX: usize = 300;

const STORAGE_LOCAL: &str = "local";
const STORAGE_GITHUB: &str = "github";
const ERR_GH_UNAVAILABLE: &str = "gh_unavailable";
const ERR_GH_FAILED: &str = "gh_failed";
const ERR_BAD_REF: &str = "bad_ref";
const ERR_ISSUE_DIR: &str = "issue_dir_unreadable";

const ISSUE_FIELDS: &str =
    "id number title state url repository{nameWithOwner} subIssuesSummary{total}";

/// gh 실패 하나. `code` 는 응답의 `error` 다.
#[derive(Debug, Clone)]
pub(crate) struct GhFail {
    pub(crate) code: &'static str,
    pub(crate) message: String,
}

type GhFuture = Pin<Box<dyn std::future::Future<Output = Result<Value, GhFail>> + Send>>;
/// `gh` 뒤의 인자를 받아 응답 JSON 을 준다. 시험은 이것을 바꿔 끼운다.
pub(crate) type GhCall = Arc<dyn Fn(Vec<String>) -> GhFuture + Send + Sync>;

/// 이슈 노드 하나.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct IssueNode {
    key: String,
    num: String,
    title: String,
    state: String,
    parent: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    url: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    path: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct IssueTreeOut {
    #[serde(rename = "ref")]
    reference: String,
    storage: &'static str,
    issues: Vec<IssueNode>,
    fetched_at: u64,
    #[serde(skip_serializing_if = "str::is_empty")]
    error: &'static str,
    #[serde(skip_serializing_if = "String::is_empty")]
    message: String,
}

type Slot = Arc<tokio::sync::Mutex<Option<(Instant, IssueTreeOut)>>>;

/// 트리마다의 마지막 GitHub 결과와 gh 호출 자리.
pub(crate) struct IssueTrees {
    pub(crate) gh: Mutex<GhCall>,
    pub(crate) min_gap: Duration,
    slots: Mutex<HashMap<String, Slot>>,
}

impl Default for IssueTrees {
    fn default() -> Self {
        IssueTrees {
            gh: Mutex::new(Arc::new(run_gh)),
            min_gap: GH_MIN_GAP,
            slots: Mutex::default(),
        }
    }
}

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

fn clip(s: &str) -> String {
    let mut end = s.len().min(GH_MESSAGE_MAX);
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    s[..end].trim().to_owned()
}

/// 실제 gh 를 부른다. PATH 에서 찾지 못하면 `gh_unavailable` 이다.
fn run_gh(args: Vec<String>) -> GhFuture {
    Box::pin(async move {
        let bin = otter_shared_platform::command_path("gh").map_err(|e| GhFail {
            code: ERR_GH_UNAVAILABLE,
            message: clip(&e),
        })?;
        let child = tokio::process::Command::new(bin)
            .args(&args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| GhFail {
                code: ERR_GH_UNAVAILABLE,
                message: clip(&e.to_string()),
            })?;
        let out = tokio::time::timeout(GH_TIMEOUT, child.wait_with_output())
            .await
            .map_err(|_| GhFail {
                code: ERR_GH_FAILED,
                message: "timeout".to_owned(),
            })?
            .map_err(|e| GhFail {
                code: ERR_GH_FAILED,
                message: clip(&e.to_string()),
            })?;
        if !out.status.success() {
            return Err(GhFail {
                code: ERR_GH_FAILED,
                message: clip(&String::from_utf8_lossy(&out.stderr)),
            });
        }
        serde_json::from_slice(&out.stdout).map_err(|e| GhFail {
            code: ERR_GH_FAILED,
            message: clip(&e.to_string()),
        })
    })
}

/// GitHub 의 owner·repo 이름에 드는 글자. gh 인자로 넘기기 전에 거른다 — `@` 로 시작하는 값은 gh 가 파일로 읽는다.
fn gh_name_ok(s: &str) -> bool {
    !s.is_empty()
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

/// `owner/repo#N` → (owner, repo, N). 이름 글자가 아니면 거절한다.
fn parse_github_ref(r: &str) -> Option<(String, String, u64)> {
    let (repo, n) = r.rsplit_once('#')?;
    let (owner, name) = repo.split_once('/')?;
    let n = n.parse().ok()?;
    (gh_name_ok(owner) && gh_name_ok(name)).then(|| (owner.to_owned(), name.to_owned(), n))
}

fn gh_errors(v: &Value) -> Option<GhFail> {
    let errs = v.get("errors")?.as_array()?;
    let first = errs.first()?;
    Some(GhFail {
        code: ERR_GH_FAILED,
        message: clip(first["message"].as_str().unwrap_or_default()),
    })
}

struct GhIssue {
    id: String,
    node: IssueNode,
    has_subs: bool,
}

fn gh_issue(v: &Value, parent: &str) -> GhIssue {
    let repo = v["repository"]["nameWithOwner"]
        .as_str()
        .unwrap_or_default();
    let number = v["number"].as_u64().unwrap_or_default();
    GhIssue {
        id: v["id"].as_str().unwrap_or_default().to_owned(),
        node: IssueNode {
            key: format!("{repo}#{number}"),
            num: format!("#{number}"),
            title: v["title"].as_str().unwrap_or_default().to_owned(),
            state: v["state"].as_str().unwrap_or_default().to_ascii_lowercase(),
            parent: parent.to_owned(),
            url: v["url"].as_str().unwrap_or_default().to_owned(),
            path: String::new(),
        },
        has_subs: v["subIssuesSummary"]["total"].as_u64().unwrap_or(0) > 0,
    }
}

fn gh_children(v: &Value, parent: &str) -> Vec<GhIssue> {
    v["subIssues"]["nodes"]
        .as_array()
        .map(|a| a.iter().map(|c| gh_issue(c, parent)).collect())
        .unwrap_or_default()
}

/// 루트부터 단계마다 한 번씩 읽어, 하위 이슈 차례를 지키는 깊이 우선 목록을 만든다.
async fn fetch_github(gh: &GhCall, reference: &str) -> Result<Vec<IssueNode>, GhFail> {
    let Some((owner, name, n)) = parse_github_ref(reference) else {
        return Err(GhFail {
            code: ERR_BAD_REF,
            message: reference.to_owned(),
        });
    };
    let q = format!(
        "query($o:String!,$r:String!,$n:Int!){{repository(owner:$o,name:$r){{issue(number:$n){{{ISSUE_FIELDS} subIssues(first:{GH_PAGE}){{nodes{{{ISSUE_FIELDS}}}}}}}}}}}"
    );
    let v = gh(vec![
        "api".into(),
        "graphql".into(),
        "-f".into(),
        format!("query={q}"),
        "-f".into(),
        format!("o={owner}"),
        "-f".into(),
        format!("r={name}"),
        "-F".into(),
        format!("n={n}"),
    ])
    .await?;
    if let Some(e) = gh_errors(&v) {
        return Err(e);
    }
    let root_v = &v["data"]["repository"]["issue"];
    if root_v.is_null() {
        return Err(GhFail {
            code: ERR_GH_FAILED,
            message: format!("issue not found: {reference}"),
        });
    }
    let root = gh_issue(root_v, "");
    let mut kids: HashMap<String, Vec<GhIssue>> = HashMap::new();
    let mut frontier: Vec<(String, String)> = Vec::new();
    let first = gh_children(root_v, &root.node.key);
    frontier.extend(
        first
            .iter()
            .filter(|c| c.has_subs)
            .map(|c| (c.id.clone(), c.node.key.clone())),
    );
    kids.insert(root.node.key.clone(), first);
    for _ in 1..GH_DEPTH {
        if frontier.is_empty() {
            break;
        }
        let mut next = Vec::new();
        for chunk in frontier.chunks(GH_PAGE) {
            let q = format!(
                "query($ids:[ID!]!){{nodes(ids:$ids){{... on Issue{{id subIssues(first:{GH_PAGE}){{nodes{{{ISSUE_FIELDS}}}}}}}}}}}"
            );
            let mut args = vec![
                "api".into(),
                "graphql".into(),
                "-f".into(),
                format!("query={q}"),
            ];
            for (id, _) in chunk {
                args.push("-f".into());
                args.push(format!("ids[]={id}"));
            }
            let v = gh(args).await?;
            if let Some(e) = gh_errors(&v) {
                return Err(e);
            }
            let keys: HashMap<&str, &str> = chunk
                .iter()
                .map(|(i, k)| (i.as_str(), k.as_str()))
                .collect();
            for n in v["data"]["nodes"].as_array().into_iter().flatten() {
                let Some(pkey) = n["id"].as_str().and_then(|i| keys.get(i)) else {
                    continue;
                };
                let cs = gh_children(n, pkey);
                next.extend(
                    cs.iter()
                        .filter(|c| c.has_subs)
                        .map(|c| (c.id.clone(), c.node.key.clone())),
                );
                kids.insert((*pkey).to_owned(), cs);
            }
        }
        frontier = next;
    }
    let mut out = Vec::new();
    fn walk(key: &str, kids: &mut HashMap<String, Vec<GhIssue>>, out: &mut Vec<IssueNode>) {
        for c in kids.remove(key).unwrap_or_default() {
            let k = c.node.key.clone();
            out.push(c.node);
            walk(&k, kids, out);
        }
    }
    let rk = root.node.key.clone();
    out.push(root.node);
    walk(&rk, &mut kids, &mut out);
    Ok(out)
}

/// 로컬 트리 `<별칭>:<ID>` 의 루트 이슈와 그 아래를 ID 차례(= 깊이 우선)로 읽는다.
fn read_local(issue_dir: &str, reference: &str) -> Result<Vec<IssueNode>, String> {
    let root = reference.rsplit_once(':').map_or(reference, |(_, id)| id);
    let loaded = otter_shared_issuefile::Dir::new(issue_dir)
        .load()
        .map_err(|e| e.to_string())?;
    let all: Vec<_> = loaded.iter().map(|(_, i)| i.clone()).collect();
    let under = |id: &str| id == root || id.strip_prefix(root).is_some_and(|r| r.starts_with('.'));
    Ok(loaded
        .iter()
        .filter(|(_, i)| under(&i.id))
        .map(|(p, i)| IssueNode {
            key: i.id.clone(),
            num: i.id.clone(),
            title: i.title.clone(),
            state: otter_shared_issuefile::shown_status(i, &all)
                .as_str()
                .to_owned(),
            parent: if i.id == root {
                String::new()
            } else {
                otter_shared_issuefile::parent(&i.id)
                    .unwrap_or_default()
                    .to_owned()
            },
            url: String::new(),
            path: p.to_string_lossy().into_owned(),
        })
        .collect())
}

impl IssueTrees {
    fn slot(&self, reference: &str) -> Slot {
        self.slots
            .lock()
            .unwrap()
            .entry(reference.to_owned())
            .or_default()
            .clone()
    }

    /// 마지막 결과를 주거나 gh 로 새로 읽는다. 같은 트리의 조회는 한 줄로 서고, 기다리는 동안 끝난 조회는 그대로 쓴다.
    async fn github(&self, reference: &str, refresh: bool) -> IssueTreeOut {
        let slot = self.slot(reference);
        let asked = Instant::now();
        let mut cur = slot.lock().await;
        if let Some((at, out)) = cur.as_ref()
            && (!refresh || *at + self.min_gap > asked)
        {
            return out.clone();
        }
        let gh = self.gh.lock().unwrap().clone();
        let mut out = IssueTreeOut {
            reference: reference.to_owned(),
            storage: STORAGE_GITHUB,
            issues: Vec::new(),
            fetched_at: unix_now(),
            error: "",
            message: String::new(),
        };
        match fetch_github(&gh, reference).await {
            Ok(issues) => out.issues = issues,
            Err(e) => {
                out.error = e.code;
                out.message = e.message;
            }
        }
        *cur = Some((Instant::now(), out.clone()));
        out
    }
}

impl Server {
    /// GET /api/runs/issue-tree?ref=<트리>[&refresh=1] (FR-ITV-1).
    pub(crate) async fn api_runs_issue_tree(&self, r: &mut Req) -> Response {
        let st = match self.runs_ready() {
            Ok(st) => st,
            Err(res) => return res,
        };
        let reference = r.q("ref").trim().to_owned();
        if reference.is_empty() {
            return http_err(
                "ref required",
                StatusCode::BAD_REQUEST,
                apierr::CODE_MISSING_ARG,
            );
        }
        let refresh = r.q("refresh") == "1";
        let key = reference.clone();
        let found = tokio::task::spawn_blocking(move || {
            let open: Vec<_> = st
                .list()
                .into_iter()
                .filter(|rec| rec.state == run::OPEN && rec.tree == key)
                .collect();
            (!open.is_empty()).then(|| {
                open.into_iter()
                    .map(|rec| rec.issue_dir)
                    .find(|d| !d.is_empty())
                    .unwrap_or_default()
            })
        })
        .await
        .ok()
        .flatten();
        let Some(issue_dir) = found else {
            return http_err(
                "no open run for tree",
                StatusCode::NOT_FOUND,
                apierr::CODE_NOT_FOUND,
            );
        };
        if issue_dir.is_empty() {
            return write_json(&self.issue_trees.github(&reference, refresh).await);
        }
        let key = reference.clone();
        let read = tokio::task::spawn_blocking(move || read_local(&issue_dir, &key)).await;
        let mut out = IssueTreeOut {
            reference,
            storage: STORAGE_LOCAL,
            issues: Vec::new(),
            fetched_at: unix_now(),
            error: "",
            message: String::new(),
        };
        match read {
            Ok(Ok(issues)) => out.issues = issues,
            Ok(Err(e)) => {
                out.error = ERR_ISSUE_DIR;
                out.message = clip(&e);
            }
            Err(e) => {
                out.error = ERR_ISSUE_DIR;
                out.message = clip(&e.to_string());
            }
        }
        write_json(&out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn github_ref_parses_owner_repo_number() {
        assert_eq!(
            parse_github_ref("o/r#12"),
            Some(("o".into(), "r".into(), 12))
        );
        assert_eq!(parse_github_ref("o/r"), None);
        assert_eq!(parse_github_ref("/r#1"), None);
        assert_eq!(parse_github_ref("o/r#x"), None);
        assert_eq!(parse_github_ref("perf:2"), None);
        // gh 의 `-F key=@file` 이 파일을 읽지 않게 이름 글자만 받는다.
        assert_eq!(parse_github_ref("o/@/etc/passwd#1"), None);
        assert_eq!(parse_github_ref("@o/r#1"), None);
        assert_eq!(parse_github_ref("o/r/x#1"), None);
        assert_eq!(
            parse_github_ref("my-org/my.repo_1#7"),
            Some(("my-org".into(), "my.repo_1".into(), 7))
        );
    }

    #[test]
    fn clip_keeps_char_boundary() {
        let s = "가".repeat(GH_MESSAGE_MAX);
        assert!(clip(&s).len() <= GH_MESSAGE_MAX);
    }
}
