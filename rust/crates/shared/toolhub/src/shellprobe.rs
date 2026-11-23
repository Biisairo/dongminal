use std::collections::{HashMap, HashSet};

/// 복구 판정의 셸 상태다 (RUN_RECOVERY_SRS FR-RRC-10).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ShellState {
    /// 셸이 비었다 — 자식이 없고 세션도 돌지 않는다.
    Idle,
    /// 세션은 꺼졌지만 셸에 다른 자식이 있다.
    Busy,
    /// 세션이 이 셸(자신 또는 자손)에서 돈다.
    Here,
    /// 세션이 다른 곳에서 돈다.
    Elsewhere,
    /// 판정하지 못했다.
    Unknown,
}

impl ShellState {
    /// 와이어 값이다 (toolipc `ShellProbeResult.state`).
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::Busy => "busy",
            Self::Here => "here",
            Self::Elsewhere => "elsewhere",
            Self::Unknown => "unknown",
        }
    }

    /// 와이어 값을 읽는다. 모르는 값은 `Unknown` 이다.
    pub fn parse(s: &str) -> Self {
        match s {
            "idle" => Self::Idle,
            "busy" => Self::Busy,
            "here" => Self::Here,
            "elsewhere" => Self::Elsewhere,
            _ => Self::Unknown,
        }
    }
}

/// FR-RRC-10 의 순서다. `parents` 는 프로세스 표(pid → ppid)이고 `None` 은 표를 못 읽은 것이다.
/// 표에 있는 후보만 살아 있는 세션으로 본다.
pub fn judge_shell(parents: Option<&HashMap<i32, i32>>, shell: i32, cands: &[i32]) -> ShellState {
    let Some(parents) = parents else {
        return ShellState::Unknown;
    };
    if shell <= 0 || !parents.contains_key(&shell) {
        return ShellState::Unknown;
    }
    let mut alive = false;
    for &c in cands {
        if !parents.contains_key(&c) {
            continue;
        }
        alive = true;
        if descends_from(parents, c, shell) {
            return ShellState::Here;
        }
    }
    if alive {
        return ShellState::Elsewhere;
    }
    if parents
        .iter()
        .any(|(&pid, &ppid)| ppid == shell && pid != shell)
    {
        return ShellState::Busy;
    }
    ShellState::Idle
}

/// pid 가 anc 자신이거나 그 자손인가다. 고리가 있어도 끝난다.
fn descends_from(parents: &HashMap<i32, i32>, pid: i32, anc: i32) -> bool {
    let mut seen = HashSet::new();
    let mut cur = pid;
    while cur > 0 && seen.insert(cur) {
        if cur == anc {
            return true;
        }
        match parents.get(&cur) {
            Some(&next) => cur = next,
            None => return false,
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    type Case<'a> = (
        &'a str,
        Option<&'a HashMap<i32, i32>>,
        i32,
        &'a [i32],
        ShellState,
    );

    #[test]
    fn judge_shell_cases() {
        let parents: HashMap<i32, i32> = [
            (1, 0),
            (10, 1),
            (11, 10),
            (12, 11),
            (20, 1),
            (21, 20),
            (30, 1),
        ]
        .into_iter()
        .collect();
        let empty = HashMap::new();
        let p = Some(&parents);
        let cases: [Case; 10] = [
            ("표를 못 읽음", None, 10, &[12], ShellState::Unknown),
            ("셸 pid 모름", p, 0, &[], ShellState::Unknown),
            ("세션이 손자로 돈다", p, 10, &[12], ShellState::Here),
            ("셸이 세션 자신", p, 12, &[12], ShellState::Here),
            ("다른 가지", p, 30, &[21], ShellState::Elsewhere),
            ("하나라도 여기면 here", p, 10, &[21, 12], ShellState::Here),
            (
                "후보가 표에 없음, 자식 있음",
                p,
                10,
                &[99],
                ShellState::Busy,
            ),
            ("후보 없음, 자식 없음", p, 30, &[], ShellState::Idle),
            ("표에 셸이 없음", p, 77, &[], ShellState::Unknown),
            ("빈 표", Some(&empty), 10, &[], ShellState::Unknown),
        ];
        for (name, t, shell, cands, want) in cases {
            assert_eq!(judge_shell(t, shell, cands), want, "{name}");
        }
        let lp: HashMap<i32, i32> = [(5, 6), (6, 5), (40, 1)].into_iter().collect();
        assert_eq!(judge_shell(Some(&lp), 40, &[5]), ShellState::Elsewhere);
    }

    #[test]
    fn wire_values() {
        for s in [
            ShellState::Idle,
            ShellState::Busy,
            ShellState::Here,
            ShellState::Elsewhere,
            ShellState::Unknown,
        ] {
            assert_eq!(ShellState::parse(s.as_str()), s);
        }
    }
}
