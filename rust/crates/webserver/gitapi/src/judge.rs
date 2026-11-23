//! 실행 종단이 판정 함수의 답으로 거절하는 자리 (Go `judge` · `judgeBranch` · `judgeFacts` ·
//! `remoteBranchOf`). 답 종단과 같은 함수를 부른다 (SERVER_DRIVEN_ACTIONS_SRS D-SDA-6).

use dm_webserver_action::{Answer, allow};
use dm_webserver_domain_git_query::{self as query, Ref};

use crate::answers::{BranchFacts, branch_answer, not_remote, split_remote_ref};
use crate::reply::GitErr;
use crate::write::GitWrite;

impl GitWrite<'_> {
    /// 답이 거짓이면 응답을 쓰고 거짓을 준다. 판정이 오류면 그 오류로 거절한다.
    pub(crate) fn judge<E: GitErr>(&mut self, a: Result<Answer, E>) -> bool {
        if self.stop() {
            return false;
        }
        match a {
            Err(e) => {
                self.reject(&e);
                false
            }
            Ok(a) if !a.ok => {
                self.reject_answer(&a, None);
                false
            }
            Ok(_) => true,
        }
    }

    /// 브랜치 동작의 판정이다. `pick` 이 `None` 이면 판정하지 않는다.
    pub(crate) async fn judge_branch(
        &mut self,
        id: &str,
        pick: impl FnOnce(&BranchFacts) -> Option<Ref>,
    ) -> bool {
        self.judge_facts(|f| match pick(f) {
            Some(r) => branch_answer(id, &r, f),
            None => allow(),
        })
        .await
    }

    /// 저장소의 사실로 판정하는 거절이다.
    pub(crate) async fn judge_facts(&mut self, judge: impl FnOnce(&BranchFacts) -> Answer) -> bool {
        if self.stop() {
            return false;
        }
        let st = self.snapshot().await;
        if self.stop() {
            return false;
        }
        let git = self.git();
        let f = self.s.branch_facts(&git, &self.ctx(), &self.root, st).await;
        self.judge(f.map(|f| judge(&f)))
    }

    /// 요청의 원격 ref 를 원격과 브랜치로 가른다 (GV-g · FR-SDA-42). `ref` 가 비었으면 요청의
    /// remote·branch 를 그대로 쓴다(R-3). 가를 수 없으면 400 not_remote_branch 로 거절한다.
    pub(crate) async fn remote_branch_of(
        &mut self,
        r: &str,
        remote: &mut String,
        branch: &mut String,
    ) -> bool {
        if self.stop() || r.is_empty() {
            return !self.stop();
        }
        let Some(short) = r.strip_prefix(query::REMOTE_REF_PREFIX) else {
            self.reject_answer(&not_remote(), None);
            return false;
        };
        let git = self.git();
        let mut names = match self.s.remote_names(&git, &self.ctx(), &self.root).await {
            Ok(n) => n,
            Err(e) => {
                self.reject(&e);
                return false;
            }
        };
        match split_remote_ref(&mut names, short) {
            Some((rm, br)) => {
                *remote = rm;
                *branch = br;
                true
            }
            None => {
                self.reject_answer(&not_remote(), None);
                false
            }
        }
    }
}
