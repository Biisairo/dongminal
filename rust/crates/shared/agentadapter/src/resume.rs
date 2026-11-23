//! 세션 재개 (RUN_RECOVERY_SRS FR-RRC-1~5).

use dm_shared_platform::ShellProvider;

use crate::{Adapter, Error};

/// 세션 id 길이의 상한 (FR-RRC-4).
const SESSION_ID_MAX: usize = 128;

/// 재개줄에 실을 수 있는 세션 id 인가 (FR-RRC-4). 영문·숫자·`.`·`_`·`-`, 1~128자, 첫 글자는 영문·숫자.
pub fn valid_session_id(id: &str) -> bool {
    if id.is_empty() || id.len() > SESSION_ID_MAX {
        return false;
    }
    id.chars().enumerate().all(|(i, r)| {
        r.is_ascii_alphanumeric() || (i != 0 && matches!(r, '.' | '_' | '-'))
    })
}

impl Adapter {
    /// 재개 방법이 선언돼 있는가.
    pub fn can_resume(&self) -> bool {
        self.resume.is_some()
    }

    /// 빈 셸에 타이핑할 재개 명령줄이다 (FR-RRC-3). member 면 member_args 를 붙인다.
    pub fn resume_line(&self, hooks_dir: &str, session_id: &str, member: bool) -> Result<String, Error> {
        self.resume_line_in(dm_shared_platform::current().shell, hooks_dir, session_id, member)
    }

    /// [`Adapter::resume_line`] 과 같되 인용할 셸을 받는다.
    pub fn resume_line_in(
        &self,
        sh: &dyn ShellProvider,
        hooks_dir: &str,
        session_id: &str,
        member: bool,
    ) -> Result<String, Error> {
        let Some(resume) = self.resume else {
            return Err(Error::NoResume {
                agent: self.id.to_owned(),
            });
        };
        if !valid_session_id(session_id) {
            return Err(Error::BadSession);
        }
        let mut parts: Vec<String> = self.launch.iter().map(|s| (*s).to_owned()).collect();
        parts.extend(resume(session_id).iter().map(|a| sh.quote(a)));
        if member {
            parts.extend(self.member_args_in(sh, hooks_dir)?);
        }
        Ok(parts.join(" "))
    }
}
