//! lsp `RepoWatch` 가 딛는 git 관측이다 (CODEMIRROR_MIGRATION_SRS §11.6 W). Go `lsp_watch.go`.
//! lsp 는 git 을 모른다 — 두 도메인을 여기서 잇는다.

use std::collections::BTreeMap;
use std::sync::Arc;

use otter_webserver_domain_git_core::Ctx;
use otter_webserver_domain_git_query as query;
use otter_webserver_domain_git_store::Store;
use otter_webserver_domain_lsp::{NameStatus, RepoSnap, RepoView};

pub(crate) struct LspRepoView {
    pub(crate) st: Arc<Store>,
}

impl RepoView for LspRepoView {
    /// 마지막 유효 관측이다 — gitwatch 가 git_changed 를 내기 직전에 관측한 값이다. 새 파일은
    /// 미추적이거나 index 에 추가(`A`)된 것이다. 디렉터리 항목(중첩 저장소·서브모듈)은 뺀다.
    fn snapshot(&self, repo: &str) -> Option<RepoSnap> {
        let obs = self.st.observed(repo)?;
        let s = &obs.status;
        let mut files: BTreeMap<String, bool> = BTreeMap::new();
        for group in [&s.staged, &s.changes, &s.untracked, &s.conflicts] {
            for e in group {
                if e.dir {
                    continue;
                }
                let is_new = e.untracked || e.xy.as_bytes().first() == Some(&b'A');
                let v = files.entry(e.path.clone()).or_insert(false);
                *v = *v || is_new;
                if !e.orig_path.is_empty() {
                    files.entry(e.orig_path.clone()).or_insert(false);
                }
            }
        }
        Some(RepoSnap {
            head: s.oid.clone(),
            files,
        })
    }

    /// 두 커밋 사이의 바뀐 파일이다 (`diff-tree --name-status -r -z -M`). git 실행을 기다리므로
    /// 런타임의 blocking 스레드에서 부른다.
    fn name_status(&self, repo: &str, from: &str, to: &str) -> Result<Vec<NameStatus>, String> {
        let args = [
            "diff-tree",
            "--no-commit-id",
            "--name-status",
            "-r",
            "-z",
            "-M",
            from,
            to,
        ];
        let svc = Arc::clone(self.st.service());
        let fut = async move { svc.exec(&Ctx::background(), repo, &args).await };
        let out = match tokio::runtime::Handle::try_current() {
            Ok(h) => h.block_on(fut),
            Err(_) => return Err("git diff-tree: 런타임이 없다".to_owned()),
        }
        .map_err(|e| e.to_string())?;
        if out.exit_code != 0 {
            return Err(format!(
                "git diff-tree {from} {to}: exit {}: {}",
                out.exit_code, out.stderr
            ));
        }
        if out.stdout_truncated {
            return Err(format!("git diff-tree {from} {to}: 출력이 상한에서 잘렸다"));
        }
        let files = query::parse_name_status_z(&out.stdout_str()).map_err(|e| e.to_string())?;
        Ok(files
            .into_iter()
            .map(|f| NameStatus {
                status: f.status,
                path: f.path,
                orig_path: f.orig_path,
            })
            .collect())
    }
}
