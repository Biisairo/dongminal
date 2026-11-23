//! Manager — 생성·조회·되돌리기와 안전 가드 (worktree.go).

use std::sync::Arc;
use std::time::Duration;

use dm_gocompat::filepath;
use dm_gocompat::strconv::quote;
use dm_webserver_domain_git_core::{
    self as core, BoxFut, Ctx, MANAGER_WRITE_TIMEOUT, Service as GitService, unguarded_text_runner,
};
use serde::Serialize;

use crate::error::{Error, Failure, Kind};
use crate::lock::{RepoLock, lock_repo};
use crate::naming::{safe_segment, valid_ref};
use crate::parse::{Entry, normalize_git_path, parse_worktree_list};

/// git 한 번의 상한이다 (WORKTREE_ADD_TIMEOUT_MS 기본 180초). 호출자 ctx 의 마감이 더 짧으면
/// 그것이 이긴다.
pub(crate) const OP_TIMEOUT: Duration = MANAGER_WRITE_TIMEOUT;

/// 실행 기록에 남는 사유다 (GIT_EXEC_UNIFY_SRS FR-GXU-1).
pub const UNGUARDED_REASON: &str = "worktree 도메인 — 화이트리스트가 argv[0] 으로 키잉되어 list 와 add 를 가를 수 없다 (FR-GIT-246)";

/// git 한 번이다. 성공은 stdout(앞뒤 공백을 다듬은 것), 실패는 stdout 다음 stderr 와 오류다.
/// ctx 는 호출자의 것이다 (REPO_FIX 01 §5.6).
pub type Runner =
    Arc<dyn Fn(Ctx, String, Vec<String>) -> BoxFut<Result<String, Failure>> + Send + Sync>;

/// 이 패키지의 유일한 git 실행이다 (FR-GXU-7). 인가는 이 패키지가 진다 — core 의 화이트리스트를
/// 지나지 않는다. svc 가 없으면 기록 없이 돈다 (FR-GXU-4).
pub fn git_runner(svc: Option<Arc<GitService>>) -> Runner {
    let inner = unguarded_text_runner(svc, OP_TIMEOUT, UNGUARDED_REASON, str::trim);
    Arc::new(move |ctx, dir, args| {
        let fut = inner(ctx, dir, args);
        Box::pin(async move {
            fut.await.map_err(|f| {
                if f.err.is(core::Kind::GitMissing) {
                    return Failure {
                        text: f.text,
                        err: Error::new(Kind::GitMissing, &f.err),
                    };
                }
                Failure {
                    text: f.text,
                    err: Error::from(f.err),
                }
            })
        })
    })
}

/// Service 없이 도는 기본 실행이다.
pub async fn exec_git(ctx: &Ctx, dir: &str, args: &[&str]) -> Result<String, Failure> {
    git_runner(None)(ctx.clone(), dir.to_owned(), to_owned(args)).await
}

fn to_owned(args: &[&str]) -> Vec<String> {
    args.iter().map(|s| (*s).to_owned()).collect()
}

/// 조정자 cwd 에서 확정한 저장소와 base 다.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct Repo {
    pub root: String,
    pub base: String,
}

/// worktree 하나의 생성 인자다.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct Spec {
    pub repo: String,
    pub path: String,
    pub branch: String,
    pub base: String,
    /// 잠금 키 — 저장소의 common-dir 키다. 비면 repo 가 키다(단독 배선).
    #[serde(skip)]
    pub lock_key: String,
}

/// 호출자가 실행할 git 과 인가 우회의 사유다 (worktree add 는 잡으로 돈다).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "PascalCase")]
pub struct ExecSpec {
    pub argv: Vec<String>,
    pub reason: String,
}

/// `$DONGMINAL_HOME/worktrees` 아래만을 자기 영역으로 삼는다.
#[derive(Clone)]
pub struct Manager {
    pub(crate) root: String,
    git: Runner,
    lock_wait: Duration,
}

impl std::fmt::Debug for Manager {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Manager")
            .field("root", &self.root)
            .field("lock_wait", &self.lock_wait)
            .finish()
    }
}

fn lock_key_of<'a>(key: &'a str, repo: &'a str) -> &'a str {
    if key.is_empty() { repo } else { key }
}

impl Manager {
    /// 루트는 절대 경로로 만들고 심볼릭 링크를 푼다 (FR-WKT-13 전제, V163) — `git worktree list`
    /// 는 realpath 를 보고하므로 여기 한 곳에서 풀어야 판정이 전부 맞는다.
    pub fn new(root: &str) -> Self {
        let mut clean = filepath::clean(root);
        if let Ok(abs) = filepath::abs(&clean) {
            clean = abs;
        }
        Manager {
            root: core::exclusion_key(&clean),
            git: git_runner(None),
            lock_wait: MANAGER_WRITE_TIMEOUT,
        }
    }

    /// git 실행기를 바꾼다.
    pub fn with_runner(mut self, r: Runner) -> Self {
        self.git = r;
        self
    }

    /// 잠금 대기 상한이다. 기본은 180초다.
    pub fn with_lock_wait(mut self, d: Duration) -> Self {
        self.lock_wait = d;
        self
    }

    /// 실행 기록을 core 와 공유한다 (FR-GXU-10).
    pub fn with_service(mut self, svc: Arc<GitService>) -> Self {
        self.git = git_runner(Some(svc));
        self
    }

    pub fn root(&self) -> &str {
        &self.root
    }

    pub(crate) async fn git(&self, ctx: &Ctx, dir: &str, args: &[&str]) -> Result<String, Failure> {
        (self.git)(ctx.clone(), dir.to_owned(), to_owned(args)).await
    }

    pub(crate) async fn lock(&self, ctx: &Ctx, key: &str, repo: &str) -> Result<RepoLock, Error> {
        lock_repo(ctx, lock_key_of(key, repo), self.lock_wait).await
    }

    /// worktree 경로를 식별자에서 파생한다 (FR-WKT-3): `<root>/<run.short>/<member.short>`.
    pub fn path(&self, run_short: &str, leaf: &str) -> String {
        filepath::join(&[
            self.root.clone(),
            safe_segment(run_short, "run"),
            safe_segment(leaf, "member"),
        ])
    }

    /// 격리 Run 이 설 수 있는지 판정한다 (FR-WKT-5/11). 실패는 명확한 오류다.
    pub async fn resolve(&self, ctx: &Ctx, cwd: &str, base: &str) -> Result<Repo, Error> {
        if cwd.trim().is_empty() {
            return Err(Error::new(Kind::NotRepo, "조정자의 cwd 를 알 수 없다"));
        }
        if !filepath::is_abs(cwd) {
            return Err(Error::new(
                Kind::NotRepo,
                format!("cwd 는 절대 경로여야 한다: {}", quote(cwd)),
            ));
        }
        if !base.is_empty() {
            valid_ref(base)?;
        }
        // FR-OPT-7-3: toplevel 과 base 를 한 번에 묻는다. 실패하면 그때만 toplevel 을 다시 묻는다.
        let rev = format!("{base}^{{commit}}");
        let argv: Vec<&str> = if base.is_empty() {
            vec![
                "rev-parse",
                "--show-toplevel",
                "HEAD",
                "--abbrev-ref",
                "HEAD",
            ]
        } else {
            vec!["rev-parse", "--show-toplevel", "--verify", "--quiet", &rev]
        };
        let out = match self.git(ctx, cwd, &argv).await {
            Ok(o) => o,
            Err(f) => {
                if f.err.is(Kind::GitMissing) {
                    return Err(f.err);
                }
                self.repo_top(ctx, cwd).await?;
                if !base.is_empty() {
                    return Err(Error::new(
                        Kind::UnsafeArgument,
                        format!("base 를 찾을 수 없다: {}", quote(base)),
                    ));
                }
                return Err(Error::new(
                    Kind::NotRepo,
                    format!("HEAD 를 확인할 수 없다 (커밋이 없는 저장소인가): {}", f.err),
                ));
            }
        };
        let lines: Vec<&str> = out
            .split('\n')
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .collect();
        let not_repo = || Error::new(Kind::NotRepo, format!("{cwd} 는 git 저장소가 아니다"));
        let Some(first) = lines.first() else {
            return Err(not_repo());
        };
        let top = top_of(first);
        if top.is_empty() {
            return Err(not_repo());
        }
        let mut base = base.to_owned();
        if base.is_empty() {
            if lines.len() != 3 {
                return Err(Error::new(
                    Kind::NotRepo,
                    format!(
                        "HEAD 를 확인할 수 없다: rev-parse 가 {} 줄을 줬다",
                        lines.len()
                    ),
                ));
            }
            // FR-WKT-5: 기본 base 는 HEAD 의 이름, 분리 HEAD 면 커밋이다.
            base = if lines[2] == "HEAD" {
                lines[1].to_owned()
            } else {
                lines[2].to_owned()
            };
        }
        Ok(Repo { root: top, base })
    }

    async fn repo_top(&self, ctx: &Ctx, cwd: &str) -> Result<String, Error> {
        let not_repo = || Error::new(Kind::NotRepo, format!("{cwd} 는 git 저장소가 아니다"));
        match self.git(ctx, cwd, &["rev-parse", "--show-toplevel"]).await {
            Ok(out) => {
                let top = top_of(&out);
                if top.is_empty() {
                    Err(not_repo())
                } else {
                    Ok(top)
                }
            }
            Err(f) if f.err.is(Kind::GitMissing) => Err(f.err),
            Err(_) => Err(not_repo()),
        }
    }

    /// worktree 를 만든다 (FR-WKT-2): `git worktree add --no-track -b <branch> <path> [<base>]`.
    /// Branch 가 비면 Base 를 그대로 체크아웃한다 (FR-GIT-242).
    pub async fn create(&self, ctx: &Ctx, s: &Spec) -> Result<(), Error> {
        let spec = self.add_spec(s)?;
        let _lock = self.lock(ctx, &s.lock_key, &s.repo).await?;
        let parent = filepath::dir(&s.path);
        if let Err(e) = std::fs::create_dir_all(&parent) {
            return Err(Error::io("mkdir", &parent, e));
        }
        let argv: Vec<&str> = spec.argv.iter().map(String::as_str).collect();
        self.git(ctx, &s.repo, &argv).await.map_err(|f| f.err)?;
        self.configure(ctx, s).await;
        Ok(())
    }

    /// `git worktree add` 의 검증과 argv 다 — 실행하지 않는다 (REPO_FIX 01 §5.6).
    pub fn add_spec(&self, s: &Spec) -> Result<ExecSpec, Error> {
        if !s.branch.is_empty() {
            valid_ref(&s.branch)?;
        }
        if !s.base.is_empty() {
            valid_ref(&s.base)?;
        }
        if s.branch.is_empty() && s.base.is_empty() {
            return Err(Error::new(
                Kind::UnsafeArgument,
                "branch 나 base 중 하나는 있어야 한다",
            ));
        }
        self.check_path(&s.path)?;
        if s.repo.trim().is_empty() {
            return Err(Error::new(Kind::NotRepo, "repo 가 비었다"));
        }
        let mut argv: Vec<String> = Vec::new();
        if !s.branch.is_empty() {
            argv.extend(
                ["worktree", "add", "--no-track", "-b", &s.branch, &s.path].map(str::to_owned),
            );
            if !s.base.is_empty() {
                argv.push(s.base.clone());
            }
        } else {
            argv.extend(["worktree", "add", &s.path, &s.base].map(str::to_owned));
        }
        Ok(ExecSpec {
            argv,
            reason: UNGUARDED_REASON.to_owned(),
        })
    }

    /// 만든 worktree 의 best-effort 설정 두 건이다. 호출자는 잠금을 쥐고 있다.
    pub async fn configure(&self, ctx: &Ctx, s: &Spec) {
        let _ = self
            .git(ctx, &s.path, &["config", "push.autoSetupRemote", "true"])
            .await;
        if !s.branch.is_empty() && !s.base.is_empty() {
            let key = format!("branch.{}.base", s.branch);
            let _ = self.git(ctx, &s.repo, &["config", &key, &s.base]).await;
        }
    }

    /// refs/heads/<branch> 가 있는가. 잠그지 않는다 (REPO_FIX 01 §5.6).
    pub async fn branch_exists(&self, ctx: &Ctx, repo: &str, branch: &str) -> bool {
        if repo.is_empty() || valid_ref(branch).is_err() {
            return false;
        }
        let r = format!("refs/heads/{branch}");
        self.git(ctx, repo, &["rev-parse", "--verify", "--quiet", &r])
            .await
            .is_ok()
    }

    /// 생성 실패의 되돌리기 전용이다 (FR-WKT-8). 여기서만 -D 를 쓴다. 잠금을 얻지 못하면
    /// 되돌리지 않는다.
    pub async fn rollback(&self, ctx: &Ctx, s: &Spec) {
        if self.check_path(&s.path).is_err() || s.repo.trim().is_empty() {
            return;
        }
        let Ok(_lock) = self.lock(ctx, &s.lock_key, &s.repo).await else {
            return;
        };
        let _ = self
            .git(ctx, &s.repo, &["worktree", "remove", "--force", &s.path])
            .await;
        let _ = self.git(ctx, &s.repo, &["worktree", "prune"]).await;
        if valid_ref(&s.branch).is_ok() {
            let _ = self.git(ctx, &s.repo, &["branch", "-D", &s.branch]).await;
        }
        if std::fs::metadata(&s.path).is_ok() {
            let _ = std::fs::remove_dir_all(&s.path);
        }
    }

    /// repo 의 worktree 전부다 (FR-GIT-240) — main 도 포함한다. 이 명령을 실행하는 자리는
    /// 여기 하나뿐이다 (FR-GIT-246).
    pub async fn list(&self, ctx: &Ctx, repo: &str) -> Result<Vec<Entry>, Error> {
        let out = self
            .git(ctx, repo, &["worktree", "list", "--porcelain"])
            .await
            .map_err(|f| f.err)?;
        Ok(parse_worktree_list(&out))
    }

    /// 위험 경로를 거부한다 (FR-WKT-10). 경로가 worktrees 루트 아래인지 본다.
    pub(crate) fn check_path(&self, p: &str) -> Result<(), Error> {
        check_abs_path(p)?;
        let clean = filepath::clean(p);
        if clean == self.root {
            return Err(Error::new(Kind::UnsafePath, "worktrees 루트 자신"));
        }
        let prefix = format!("{}{}", self.root, filepath::SEPARATOR);
        if !clean.starts_with(&prefix) {
            return Err(Error::new(
                Kind::UnsafePath,
                format!("{} 아래가 아니다: {}", self.root, quote(p)),
            ));
        }
        Ok(())
    }
}

/// 영역과 무관한 위험 경로 거부다 (FR-WRA-2).
pub(crate) fn check_abs_path(p: &str) -> Result<(), Error> {
    if p.trim().is_empty() {
        return Err(Error::new(Kind::UnsafePath, "빈 경로"));
    }
    if !filepath::is_abs(p) {
        return Err(Error::new(
            Kind::UnsafePath,
            format!("절대 경로가 아니다: {}", quote(p)),
        ));
    }
    // `..` 는 조각으로 본다 (M8 D-A-14) — `a..b` 는 정상 이름이다.
    if filepath::to_slash(p).split('/').any(|seg| seg == "..") {
        return Err(Error::new(
            Kind::UnsafePath,
            format!("경로 이탈: {}", quote(p)),
        ));
    }
    if filepath::clean(p) == filepath::SEPARATOR.to_string() {
        return Err(Error::new(Kind::UnsafePath, "파일시스템 루트"));
    }
    Ok(())
}

/// git 이 준 toplevel 을 OS 형태로 옮긴다 (FR-WTP-3).
fn top_of(line: &str) -> String {
    normalize_git_path(line.trim())
}
