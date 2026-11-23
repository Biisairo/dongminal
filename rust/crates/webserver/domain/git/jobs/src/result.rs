use dm_webserver_domain_git_query as query;
use serde::Serialize;

/// 완료 처리(Finisher)가 채우는 잡의 결과다.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename = "jobs.Result")]
pub struct JobResult {
    /// index 잡 — 쓰기 이후 관측.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<query::Status>,
    /// 사후 재조회 실패.
    #[serde(rename = "statusError", skip_serializing_if = "String::is_empty")]
    pub status_error: String,
    /// 실패 시 before 대비 변화.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub partial: bool,
    #[serde(skip_serializing_if = "dm_gocompat::json::is_empty")]
    pub changed: Option<Vec<String>>,
    /// commit 성공.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub oid: String,
    #[serde(rename = "undoToken", skip_serializing_if = "String::is_empty")]
    pub undo_token: String,
    /// worktree 잡 성공.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub path: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub branch: String,
}
