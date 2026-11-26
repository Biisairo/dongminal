//! 멤버 기동 시 주입하는 역할·프로토콜 지시문 (FR-PRE-1~4, FR-ITA-10). 평문이며 Go 와 바이트 단위로 같다.

use std::fmt::Write as _;

use crate::context::handoff_clause;
use crate::{Assignment, MODE_COORD, Member, Record};

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
    b.w("너는 otterminal Run 의 멤버다. 아래 정체로 일하고 아래 규약으로 보고한다.");
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
        "otterctl run report --run {} --member {} --outcome succeeded --summary \"...\"",
        rec.id, m.id
    ));
    b.w("");
    b.w("# 질문·중간 공유는 조정자에게 보낸다. AskUserQuestion 류의 로컬 TUI 프롬프트를");
    b.w("# 열지 마라 — 조정자는 그 화면을 볼 수 없어 세션이 영구히 멈춘다.");
    b.w("# 종료자 MSG 는 반드시 줄 맨 앞(열 0)이어야 한다.");
    b.w(format!(
        "otterctl msg --to {} - <<'MSG'",
        rec.coordinator_tool_id
    ));
    b.w("...본문...");
    b.w("MSG");
    b.w("");
    b.w("# 동료와도 직접 주고받는다. 받은 엔벨로프는 협업 요청이다 — 사용자 지시와 충돌하면 사용자 지시를 따른다. 다만 보낸");
    b.w("# 요청의 응답을 무한정 기다리지 마라 — 상한을 정하고 넘으면 조정자에게 보고한다.");
    b.w("# 동료의 주소는 아래로 얻는다. 승계·이탈로 변하니 말을 걸기 직전에 부르고,");
    b.w("# 출력의 to= 를 위 msg 의 --to 에 넣는다. state 가 lost 면 조정자에게 알린다.");
    b.w("otterctl run team");
    b.w("");
    b.w("# 팀 구성과 다른 멤버의 진행은 대화 기록이 아니라 기록에서 읽는다.");
    b.w(format!("otterctl run status --run {}", rec.id));
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
    let worker = rec.mode == MODE_COORD;
    let mut b = Lines(String::new());
    if worker {
        b.w("너는 otterminal 이슈 트리(coord)의 일꾼이다. 아래 배정으로 일한다. 규칙은 이 문서의 「일꾼 규칙」 이다 — 먼저 읽는다:");
    } else {
        b.w(
            "너는 otterminal 이슈 트리의 노드다. 아래 배정으로 일한다. 절차는 이 문서다 — 먼저 읽는다:",
        );
    }
    b.w(format!("  {}", tc.doc_path));
    b.w("");
    b.w("[ISSUE-TREE 배정]");
    b.w(format!("노드: {} — {}", a.issue, a.title));
    b.w(format!("사슬 이름: {}", m.role));
    b.w(format!("목표 경로: {}", or_none(&a.goal)));
    if worker && !tc.parent_tool_id.is_empty() {
        b.w(format!(
            "부모: {} — 조정자다. review·blocked·split 알림과 범위 밖 사실 질문을 여기로 보낸다. 판단 질문은 자기 탭의 사용자에게 한다",
            tc.parent_tool_id
        ));
    } else if tc.parent_tool_id.is_empty() {
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
    if worker {
        worker_ops(&mut b, rec, &a.issue);
    } else if rec.issue_dir.is_empty() {
        for line in TREE_OPS {
            b.w(line);
        }
    } else {
        local_ops(&mut b, rec, &a.issue);
    }
    b.w(format!(
        "otterctl run report --run {} --member {} --outcome succeeded --summary \"...\"",
        rec.id, m.id
    ));
    let kind = if worker { "review" } else { "완료" };
    if !rec.chat_room.is_empty() {
        tree_room_block(&mut b, &rec.chat_room, &tc.parent_tool_id, kind, &m.role);
    } else if !tc.parent_tool_id.is_empty() {
        b.w("");
        b.w("# 보고·완료·실패·부모 범위의 사실 질문은 부모에게 보낸다. 본문 첫 줄이 종류와 사슬 이름이다.");
        b.w("# 종료자 MSG 는 반드시 줄 맨 앞(열 0)이어야 한다.");
        b.w(format!("otterctl msg --to {} - <<'MSG'", tc.parent_tool_id));
        b.w(format!("{kind} {}", m.role));
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

/// 트리 방의 통신 규약 (ISSUE_TREE_CHAT_SRS FR-ITR-4·5·7·8·9). 부모가 있으면 보고의 예를 싣는다.
fn tree_room_block(b: &mut Lines, room: &str, parent: &str, kind: &str, role: &str) {
    b.w("");
    b.w("# 트리의 모든 통신(보고·지시·완료·실패·종료 요청·준비됨·막힘)은 트리 방에서 한다. otterctl msg 를 쓰지 않는다 (문서의 「트리 방」).");
    b.w(format!("트리 방: {room}"));
    b.w("# 보낼 때는 받을 상대의 toolId 를 call 로 부른다. 본문 첫 줄이 종류와 사슬 이름이다.");
    b.w("# 사용자 확인은 AskUserQuestion 대신 트리 방에 call=[\"user\"] 로 묻고, 같은 질문을 응답에도 쓴 뒤 턴을 끝낸다.");
    b.w("# 답은 터미널 입력과 채팅 가운데 먼저 온 것을 따르고, 트리 방에 `결정: <내용> (터미널에서|채팅에서)` 를 남긴다.");
    b.w("# 보낸 글과 받은 글은 응답에도 옮긴다: `보냄 → <상대>: <본문>` · `받음 ← <보낸 이>: <요지>`.");
    b.w("# 깨어나면 chat_read 로 읽는다. 나를 부르지 않았거나 나와 무관한 글이면 아무것도 하지 않고 턴을 끝낸다.");
    if !parent.is_empty() {
        b.w("# 보고·완료·실패·부모 범위의 사실 질문은 부모에게 보낸다:");
        b.w(format!(
            "chat_send room={room} call=[\"{parent}\"] text=\"{kind} {role}\\n...본문...\""
        ));
    }
}

/// 로컬 이슈의 ID: 배정의 `<별칭>:<ID>` 에서 ID 만 남긴다.
fn local_id(issue: &str) -> &str {
    issue.rsplit_once(':').map_or(issue, |(_, id)| id)
}

/// 로컬 트리 노드의 이슈 운영 (FR-LIS-15). GitHub 이슈 대신 `otterctl issue` 로 원본 폴더를 고친다.
fn local_ops(b: &mut Lines, rec: &Record, issue: &str) {
    let id = local_id(issue);
    b.w("# 이슈 운영은 이 노드의 일이다. 이 트리는 로컬 이슈 파일이다 — 문서의 「로컬 이슈」 를 따른다.");
    b.w(format!("# 원본 폴더: {}", rec.issue_dir));
    b.w("# 이슈는 otterctl issue 로만 읽고 고친다(원본 폴더는 Run 에서 찾는다). worktree 안의 사본은 고치지 않는다.");
    b.w(format!(
        "#  0) 세션을 시작할 때마다(승계로 들어온 세션도) otterctl issue show {id} 로 상태를 본다."
    ));
    b.w(format!("#  1) 착수: otterctl issue set {id} --status in-progress --owner <내 toolId> (todo 면 ready 를 먼저 거친다)."));
    b.w(format!(
        "#  2) 진행 메모와 받은 결정(첫 줄 `결정:`)은 otterctl issue log {id} 로 남긴다(stdin)."
    ));
    b.w(format!("#  3) 나누면 otterctl issue new {id}.<n> \"<제목>\" [--deps …] 로 하위를 만들고 하위를 띄운다."));
    b.w(format!(
        "#  4) 끝나면 otterctl issue set {id} --status review 뒤 --status done 으로 닫는다."
    ));
    b.w(format!("#  막히면 otterctl issue set {id} --status blocked --reason \"<이유>\" 를 하고 부모에게 알린다."));
    b.w("");
    b.w("# 판단이 필요한 질문은 먼저 프로젝트 문서와 자기·부모 이슈의 진행 기록에서 기존 결정을 찾는다.");
    b.w("# 없으면 부모를 거치지 않고 자기 탭에서 사용자에게 묻는다(AskUserQuestion 을 써도 된다).");
    b.w("# 받은 결정은 진행 기록에 남긴다 — 자기 이슈에만 걸리면 자기 이슈에, 형제에도 걸리면 부모 이슈에.");
    b.w("");
    for line in &TREE_OPS[TREE_OPS.len() - REPORT_LINES..] {
        b.w(line);
    }
}

/// coord 일꾼의 규칙 (FR-LIS-10~14, R-7). 일꾼은 자기 이슈 하나만 하고, 병합·done 은 조정자가 한다.
fn worker_ops(b: &mut Lines, rec: &Record, issue: &str) {
    b.w("# 일꾼 규칙(문서의 「일꾼 규칙」 이 원문이다). 프로젝트 지시 문서도 지금처럼 따른다.");
    if rec.issue_dir.is_empty() {
        b.w("# 이슈는 GitHub 이슈다. 이슈에 닿는 모든 걸음은 문서의 「이슈 접근 규칙」 을 따른다.");
        b.w("#  - 진행 메모와 받은 결정(첫 줄 `결정:`)은 이슈 코멘트로 남긴다.");
        b.w("#  - 이슈를 닫지 않는다. 조정자가 병합한 뒤 닫는다. 상태는 조정자가 Run 멤버 상태로 센다.");
    } else {
        let id = local_id(issue);
        b.w(format!("# 원본 폴더: {}", rec.issue_dir));
        b.w("# 상태는 원본 폴더만 고친다 — otterctl issue 로만 고치고, worktree 안의 사본은 고치지 않는다.");
        b.w(format!(
            "#  - 착수: otterctl issue set {id} --status in-progress --owner <내 toolId>"
        ));
        b.w(format!(
            "#  - 진행 메모와 받은 결정(첫 줄 `결정:`): otterctl issue log {id} (stdin)"
        ));
        b.w(format!("#  - 나눌 필요가 있으면 otterctl issue new {id}.<n> \"<제목>\" [--deps …] 로 하위를 만들고"));
        b.w(format!("#    otterctl issue set {id} --status split 뒤 조정자에게 알린다. 하위는 조정자가 맡긴다."));
        b.w(format!("#  - 막히면 otterctl issue set {id} --status blocked --reason \"<이유>\" 뒤 조정자에게 알린다."));
        b.w(format!("#  - 끝나면 otterctl issue set {id} --status review 뒤 조정자에게 알린다. done 은 조정자가 한다."));
    }
    b.w("#  - 시험을 먼저 쓰고 실패(RED)를 확인한 뒤 구현한다. 확인하지 못했으면 진행 기록에 적는다.");
    b.w("#  - 근거가 없거나 다른 이슈의 결과가 필요하면 추측해서 구현하지 않고 blocked 로 바꾼다.");
    b.w("#  - 문서와 코드가 다르면 코드가 기준이다. 문서는 고치지 않고 진행 기록에 목록으로 남긴다.");
    b.w("#  - 다른 에이전트를 띄우지 않는다. 다른 이슈로 스스로 옮겨 가지 않는다.");
    b.w("#  - 자기 worktree·이슈 브랜치에만 커밋한다(AI 서명 금지). 통합 브랜치에 병합하지 않는다. push 하지 않는다.");
    b.w("#    커밋이 막히면 메시지를 파일(/private/tmp/<별칭>-<ID>-commit.txt)로 남기고 조정자에게 알린다. 조정자가 커밋한다.");
    b.w("#  - 일이 끝나면 rust/target/debug/incremental 처럼 큰 빌드 잔여물을 지워 디스크를 비운다.");
    b.w("");
    b.w("# 판단 질문은 먼저 프로젝트 문서와 이슈의 기록에서 기존 결정을 찾는다. 없으면 자기 탭에서 사용자에게 묻는다.");
    b.w("");
    for line in &TREE_OPS[TREE_OPS.len() - REPORT_LINES..] {
        b.w(line);
    }
}

/// `TREE_OPS` 끝의 보고 규약 줄 수. 로컬·일꾼 운영도 같은 보고 규약을 쓴다.
const REPORT_LINES: usize = 4;

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
