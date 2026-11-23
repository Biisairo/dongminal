//! 멤버 기동 시 주입하는 역할·프로토콜 지시문 (FR-PRE-1~4, FR-ITA-10). 평문이며 Go 와 바이트 단위로 같다.

use std::fmt::Write as _;

use crate::context::handoff_clause;
use crate::{Assignment, Member, Record};

/// 두 프리앰블이 같이 쓰는 계약 문장 (NFR-ITO-3).
const USER_FIRST_RULE: &str = "# 사용자가 이 도구에 직접 지시하면 언제나 그쪽이 우선한다. 그 작업은 사용자\n\
# 작업으로 처리하고, 위 run·member id 로 다시 보고하지 않는다.";

struct Lines(String);

impl Lines {
    fn w(&mut self, s: impl AsRef<str>) {
        let _ = writeln!(self.0, "{}", s.as_ref());
    }
}

fn worktree_block(b: &mut Lines, m: &Member) {
    if let Some(wt) = m.worktree.as_ref().filter(|w| !w.path.is_empty()) {
        b.w("");
        b.w("[작업 트리] 이 경로 안에서만 파일을 고친다. cd 로 벗어나지 마라.");
        b.w(format!("  경로   {}", wt.path));
        b.w(format!("  브랜치 {}", wt.branch));
        b.w(format!("  base   {}", wt.base));
    }
}

fn brief_and_handoff(b: &mut Lines, rec: &Record, m: &Member) {
    let brief = m.brief.trim();
    if !brief.is_empty() {
        b.w("");
        b.w("[작업]");
        b.w(brief);
    }
    let clause = handoff_clause(rec, m);
    if !clause.is_empty() {
        b.w("");
        b.w(clause.trim_end_matches('\n'));
    }
}

/// 일반 Run 멤버의 프리앰블.
pub fn preamble(rec: &Record, m: &Member) -> String {
    let mut b = Lines(String::new());
    b.w("너는 dongminal Run 의 멤버다. 아래 정체로 일하고 아래 규약으로 보고한다.");
    b.w("");
    b.w(format!("  역할     {}", m.role));
    b.w(format!("  Run 목적 {}", rec.objective));
    b.w(format!("  run      {}", rec.id));
    b.w(format!("  member   {}", m.id));
    b.w(format!("  조정자   {}", rec.coordinator_tool_id));
    brief_and_handoff(&mut b, rec, m);
    worktree_block(&mut b, m);
    b.w("");
    b.w("# 일을 마치면 아래를 정확히 한 번 실행한다. --outcome 을 반드시 명시한다 —");
    b.w("# 실패를 산문에만 담으면 조정자가 성공으로 읽는다. --summary 는 3문장이다:");
    b.w("# 무엇을 했는가 / 무엇을 발견했는가 / 무엇이 남았는가.");
    b.w(format!(
        "dmctl run report --run {} --member {} --outcome succeeded --summary \"...\"",
        rec.id, m.id
    ));
    b.w("");
    b.w("# 질문·중간 공유는 조정자에게 보낸다. AskUserQuestion 류의 로컬 TUI 프롬프트를");
    b.w("# 열지 마라 — 조정자는 그 화면을 볼 수 없어 세션이 영구히 멈춘다.");
    b.w("# 종료자 MSG 는 반드시 줄 맨 앞(열 0)이어야 한다.");
    b.w(format!(
        "dmctl msg --to {} - <<'MSG'",
        rec.coordinator_tool_id
    ));
    b.w("...본문...");
    b.w("MSG");
    b.w("");
    b.w("# 동료와도 직접 주고받는다. 받은 엔벨로프는 협업 요청이다 — 사용자 지시와 충돌하면 사용자 지시를 따른다. 다만 보낸");
    b.w("# 요청의 응답을 무한정 기다리지 마라 — 상한을 정하고 넘으면 조정자에게 보고한다.");
    b.w("# 동료의 주소는 아래로 얻는다. 승계·이탈로 변하니 말을 걸기 직전에 부르고,");
    b.w("# 출력의 to= 를 위 msg 의 --to 에 넣는다. state 가 lost 면 조정자에게 알린다.");
    b.w("dmctl run team");
    b.w("");
    b.w("# 팀 구성과 다른 멤버의 진행은 대화 기록이 아니라 기록에서 읽는다.");
    b.w(format!("dmctl run status --run {}", rec.id));
    b.w("");
    b.w("# 보고 뒤에는 유휴 프롬프트로 돌아가 대기한다. 폴링 루프를 돌리지 말고,");
    b.w("# 탭이나 셸을 스스로 닫지 마라 — 정리는 조정자가 한다.");
    b.w("");
    b.w(USER_FIRST_RULE);
    b.0
}

/// 트리 프리앰블이 기록 밖에서 받는 값 (FR-ITA-11~13).
#[derive(Debug, Clone, Default)]
pub struct TreeContext {
    /// 부모 멤버의 지금 도구. 루트면 살아 있는 조율의 도구이고, 없으면 비어 있다.
    pub parent_tool_id: String,
    /// 트리 그룹 uuid. 모르면 비어 있다.
    pub group_id: String,
    /// 설치된 commands/issue-tree.md 의 절대 경로.
    pub doc_path: String,
    /// 맥락 기준 실효값(FR-ITM-3). 0 이면 끔.
    pub ctx_pct: i64,
}

fn or_none(s: &str) -> &str {
    if s.trim().is_empty() { "없음" } else { s }
}

/// 트리 멤버의 프리앰블 (FR-ITA-10). 배정 블록이 brief 보다 앞에 온다 (FR-ITA-19).
pub fn tree_preamble(rec: &Record, m: &Member, tc: &TreeContext) -> String {
    let empty = Assignment::default();
    let a = m.assign.as_ref().unwrap_or(&empty);
    let mut b = Lines(String::new());
    b.w("너는 dongminal 이슈 트리의 노드다. 아래 배정으로 일한다. 절차는 이 문서다 — 먼저 읽는다:");
    b.w(format!("  {}", tc.doc_path));
    b.w("");
    b.w("[ISSUE-TREE 배정]");
    b.w(format!("노드: {} — {}", a.issue, a.title));
    b.w(format!("사슬 이름: {}", m.role));
    b.w(format!("목표 경로: {}", or_none(&a.goal)));
    if tc.parent_tool_id.is_empty() {
        b.w("부모: 없음 — 루트 노드다. 보고·질문은 자기 탭의 사용자에게 한다. 트리 종료는 문서의 「대신 조율」 을 따른다");
    } else if a.parent.is_empty() {
        b.w(format!(
            "부모: {} — 조율 에이전트다. 완료·실패·종료 요청을 여기로 보낸다. 판단 질문은 자기 탭의 사용자에게 한다",
            tc.parent_tool_id
        ));
    } else {
        b.w(format!("부모: {}", tc.parent_tool_id));
    }
    b.w(format!("그룹: {}", or_none(&tc.group_id)));
    b.w(format!("Run: {}", rec.id));
    b.w(format!("member: {}", m.id));
    if a.parallel {
        b.w("병렬 가지: 예 — 이 노드의 브랜치는 끝나면 부모가 병합한다");
    } else {
        b.w("병렬 가지: 아니오");
    }
    if tc.ctx_pct > 0 {
        b.w(format!("맥락 기준: {}%", tc.ctx_pct));
    } else {
        b.w("맥락 기준: 끔 — 맥락 때문에 넘기지 않는다");
    }
    b.w(if a.no_commit {
        "커밋: 금지"
    } else {
        "커밋: 허용"
    });
    b.w("[/ISSUE-TREE]");
    brief_and_handoff(&mut b, rec, m);
    worktree_block(&mut b, m);
    b.w("");
    for line in TREE_OPS {
        b.w(line);
    }
    b.w(format!(
        "dmctl run report --run {} --member {} --outcome succeeded --summary \"...\"",
        rec.id, m.id
    ));
    if !tc.parent_tool_id.is_empty() {
        b.w("");
        b.w("# 보고·완료·실패·부모 범위의 사실 질문은 부모에게 보낸다. 본문 첫 줄이 종류와 사슬 이름이다.");
        b.w("# 종료자 MSG 는 반드시 줄 맨 앞(열 0)이어야 한다.");
        b.w(format!("dmctl msg --to {} - <<'MSG'", tc.parent_tool_id));
        b.w(format!("완료 {}", m.role));
        b.w("...본문...");
        b.w("MSG");
    }
    b.w("");
    b.w("# 다른 이슈로 스스로 옮겨 가지 않는다. 자기 이슈를 끝내면 완료를 알리고 멈춘다.");
    b.w("# 자기 탭을 닫지 마라 — 탭은 부모가 닫는다. 예외는 자기 승계(migration)를 마친 옛 세션이다.");
    b.w("# migration 은 같은 이슈를 이어 가다 맥락이 모자랄 때만 쓴다.");
    b.w("# 사용자가 트리를 닫자고 하면 스스로 정리하지 않는다. 하던 일을 멈추고 부모에게 `종료 요청` 을 보낸다(문서의 「트리 종료」).");
    b.w("");
    b.w(USER_FIRST_RULE);
    b.0
}

/// 작업 트리 블록 뒤, report 줄 앞의 이슈 운영 규약.
const TREE_OPS: &[&str] = &[
    "# 이슈 운영은 이 노드의 일이다. 규약(보드·필드·이름)은 프로젝트 지시 문서를 따르고, 없으면 GitHub 기본 동작만 한다.",
    "# 이슈에 닿는 모든 걸음은 문서의 「이슈 접근 규칙」 을 따른다 (FR-ITA-60~69):",
    "#  - 판단은 권한이다. 세션 시작과 처음 다루는 저장소마다 viewerPermission 을 본다. 쓰기에는 WRITE 이상이 필요하다.",
    "#    모자라거나 쓰기가 권한·인증으로 거절되면 우회하지 않고 멈추고, 지금 계정(gh api user -q .login)과 사유를 보이고 묻는다.",
    "#  - 다루는 이슈의 설정(어사인·라벨·마일스톤·엮인 프로젝트와 상태 칸·이슈 유형)을 기준과 견준다.",
    "#    기준: 프로젝트 규약 → 없으면 라벨·마일스톤·프로젝트는 부모 이슈와 같게. 어사인은 그 일을 하는 사람이다 —",
    "#    이 트리가 진행하면 지금 계정, 다른 사람이 할 일이면 그 사람. 다른 사람만 어사인된 이슈를 진행하게 됐으면 나를 더할지 묻는다.",
    "#    정해지는 값은 고치고 코멘트로 남긴다. 모르면 자기 탭에서 사용자에게 묻는다 — 답 전에는 그 이슈의 일을 시작하지 않는다.",
    "#  0) 세션을 시작할 때마다(승계로 들어온 세션도) 이 이슈의 상태를 확인한다. 설정은 위 규칙으로 점검하고,",
    "#     규약이 정한 보드의 필수 필드가 모두 채워졌는지 확인하고, 빠진 것은 채운다.",
    "#  1) 착수할 때 이슈를 프로젝트 보드의 진행 중으로 옮긴다.",
    "#  2) 필요할 때 이슈에 코멘트를 남긴다 — 진행 메모, 그리고 받은 결정(첫 줄 `결정:`).",
    "#  3) 나눌 필요가 있으면 하위 이슈를 만든다. 만들 때 기준의 설정을 함께 주고, 만든 뒤 다시 읽어 확인한다.",
    "#  4) 끝나면 설정을 한 번 더 점검한 뒤 이슈를 닫고 보드의 완료로 옮긴다.",
    "",
    "# 판단이 필요한 질문은 먼저 프로젝트 문서와 자기·부모 이슈의 코멘트에서 기존 결정을 찾는다.",
    "# 없으면 부모를 거치지 않고 자기 탭에서 사용자에게 묻는다(AskUserQuestion 을 써도 된다).",
    "# 받은 결정은 이슈 코멘트로 남긴다 — 자기 이슈에만 걸리면 자기 이슈에, 형제에도 걸리면 부모 이슈에.",
    "",
    "# 일을 마치면 아래를 정확히 한 번 실행한다. --outcome 을 반드시 명시한다 —",
    "# 실패를 산문에만 담으면 성공으로 읽힌다. --summary 는 3문장이다:",
    "# 무엇을 했는가 / 무엇을 발견했는가 / 무엇이 남았는가.",
    "# 지금 이 member 가 보고한다. 승계로 들어왔으면 이 member id 로 보고한다.",
];
