package run

import (
	"fmt"
	"strings"
)

// Preamble 은 멤버 기동 시 주입하는 역할·프로토콜 지시문이다 (FR-PRE-1~4).
//
// **평문이다.** 구조화 페이로드가 아니라, 실제로 실행할 dmctl 예제에 Run·Member
// uuid 를 박아 넣은 텍스트이며 send-input 으로 도구에 붙여넣는다. id 를 박는
// 이유는 늦게 도착한 이전 시도의 보고가 현재 시도를 완료시키지 못하게 하기
// 위해서다 — 저장소는 실려 온 id 를 발신자와 대조해 불일치를 거부한다.
//
// 행동 규칙은 **각 예제 바로 위**에 둔다 (FR-PRE-2). 산문 블록으로 몰지 않는
// 이유는 LLM 독자가 예제에 정박하고 뒤따르는 산문은 훑기 때문이다.
//
// 조립 주체가 서버인 이유: 이 함수가 필요로 하는 것(Run·Member uuid·조정자·
// worktree)을 서버는 멤버 생성 시점에 이미 전부 알고 있고, 여기 적힌 규칙은
// 서버가 **실제로 강제하는 계약**(1회 보고·outcome 필수·발신자 정체 권한)의
// 문장화다. 강제 코드와 같은 패키지에 두어야 둘이 갈라지지 않는다. 역할 본문
// (m.Brief)만 정책이라 스킬이 넣는다.
//
// 엔벨로프 신뢰 규약은 여기 적지 않는다 — `dmctl agent-context` 가 모든 세션에
// 상시 주입한다 (FR-PRE-3). 중복 서술은 프리앰블을 늘리고, 길어지면 규칙이 묻힌다.
func Preamble(rec Record, m Member) string {
	var b strings.Builder
	w := func(format string, args ...any) { fmt.Fprintf(&b, format+"\n", args...) }

	w("너는 dongminal Run 의 멤버다. 아래 정체로 일하고 아래 규약으로 보고한다.")
	w("")
	w("  역할     %s", m.Role)
	w("  Run 목적 %s", rec.Objective)
	w("  run      %s", rec.ID)
	w("  member   %s", m.ID)
	w("  조정자   %s", rec.CoordinatorToolID)
	if brief := strings.TrimSpace(m.Brief); brief != "" {
		w("")
		w("[작업]")
		w("%s", brief)
	}
	// FR-CBG-9: 승계로 만들어진 멤버에게는 인수인계 절이 붙는다. 절의 조립은
	// store_context.go 의 HandoffClause 가 하고 여기서는 자리만 준다 — 묶음 C 가
	// 이 파일에 남기는 흔적을 이 네 줄로 묶기 위해서다.
	if clause := HandoffClause(rec, m); clause != "" {
		w("")
		w("%s", strings.TrimRight(clause, "\n"))
	}
	// FR-PRE-4: 격리된 Run 이면 어디서 일하는지를 적어 준다. 멤버가 자기 작업
	// 위치를 화면에서 추론하게 두면 엉뚱한 트리를 고친다.
	if m.Worktree != nil && m.Worktree.Path != "" {
		w("")
		w("[작업 트리] 이 경로 안에서만 파일을 고친다. cd 로 벗어나지 마라.")
		w("  경로   %s", m.Worktree.Path)
		w("  브랜치 %s", m.Worktree.Branch)
		w("  base   %s", m.Worktree.Base)
	}
	w("")
	w("# 일을 마치면 아래를 정확히 한 번 실행한다. --outcome 을 반드시 명시한다 —")
	w("# 실패를 산문에만 담으면 조정자가 성공으로 읽는다. --summary 는 3문장이다:")
	w("# 무엇을 했는가 / 무엇을 발견했는가 / 무엇이 남았는가.")
	w("dmctl run report --run %s --member %s --outcome succeeded --summary \"...\"", rec.ID, m.ID)
	w("")
	w("# 질문·중간 공유는 조정자에게 보낸다. AskUserQuestion 류의 로컬 TUI 프롬프트를")
	w("# 열지 마라 — 조정자는 그 화면을 볼 수 없어 세션이 영구히 멈춘다.")
	w("# 종료자 MSG 는 반드시 줄 맨 앞(열 0)이어야 한다.")
	w("dmctl msg --to %s - <<'MSG'", rec.CoordinatorToolID)
	w("...본문...")
	w("MSG")
	w("")
	w("# 팀 구성과 다른 멤버의 진행은 대화 기록이 아니라 기록에서 읽는다.")
	w("dmctl run status --run %s", rec.ID)
	w("")
	w("# 보고 뒤에는 유휴 프롬프트로 돌아가 대기한다. 폴링 루프를 돌리지 말고,")
	w("# 탭이나 셸을 스스로 닫지 마라 — 정리는 조정자가 한다.")
	w("")
	w("# 사용자가 이 도구에 직접 지시하면 언제나 그쪽이 우선한다. 그 작업은 사용자")
	w("# 작업으로 처리하고, 위 run·member id 로 다시 보고하지 않는다.")

	return b.String()
}
