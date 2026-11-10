package run

import (
	"fmt"
	"strings"
)

// TreeContext 는 트리 프리앰블이 기록 밖에서 받는 값이다 (ISSUE_TREE_OPS_SRS FR-ITA-11~13).
// 서버가 프리앰블을 만드는 순간에 정한다 — 부모가 승계됐으면 승계자의 도구다.
type TreeContext struct {
	ParentToolID string // 부모 멤버의 지금 도구. 루트면 살아 있는 조율의 도구이고, 없으면 비어 있다
	GroupID      string // 트리 그룹 uuid. 모르면 비어 있다
	DocPath      string // 설치된 commands/issue-tree.md 의 절대 경로
	CtxPct       int    // 맥락 기준 실효값(FR-ITM-3). 0 이면 끔
}

// TreePreamble 은 트리 멤버의 프리앰블이다 (FR-ITA-10). 일반 프리앰블의 「조정자」
// 규약을 쓰지 않는다 — 트리에서 말을 받는 쪽은 부모이고, 루트는 사용자다 (D-ITO-2).
//
// 배정 블록이 brief 보다 앞에 온다 (FR-ITA-19). 기동하자마자 읽히는 것이 배정이어야
// 배정 전에 일을 시작하는 일이 없다 (입력 3).
func TreePreamble(rec Record, m Member, tc TreeContext) string {
	var b strings.Builder
	w := func(format string, args ...any) { fmt.Fprintf(&b, format+"\n", args...) }
	a := m.Assign
	if a == nil {
		a = &Assignment{}
	}

	w("너는 dongminal 이슈 트리의 노드다. 아래 배정으로 일한다. 절차는 이 문서다 — 먼저 읽는다:")
	w("  %s", tc.DocPath)
	w("")
	w("[ISSUE-TREE 배정]")
	w("노드: %s — %s", a.Issue, a.Title)
	w("사슬 이름: %s", m.Role)
	w("목표 경로: %s", orNone(a.Goal))
	switch {
	case tc.ParentToolID == "":
		w("부모: 없음 — 루트 노드다. 보고·질문은 자기 탭의 사용자에게 한다. 트리 종료는 문서의 「대신 조율」 을 따른다")
	case a.Parent == "":
		w("부모: %s — 조율 에이전트다. 완료·실패·종료 요청을 여기로 보낸다. 판단 질문은 자기 탭의 사용자에게 한다", tc.ParentToolID)
	default:
		w("부모: %s", tc.ParentToolID)
	}
	w("그룹: %s", orNone(tc.GroupID))
	w("Run: %s", rec.ID)
	w("member: %s", m.ID)
	if a.Parallel {
		w("병렬 가지: 예 — 이 노드의 브랜치는 끝나면 부모가 병합한다")
	} else {
		w("병렬 가지: 아니오")
	}
	if tc.CtxPct > 0 {
		w("맥락 기준: %d%%", tc.CtxPct)
	} else {
		w("맥락 기준: 끔 — 맥락 때문에 넘기지 않는다")
	}
	if a.NoCommit {
		w("커밋: 금지")
	} else {
		w("커밋: 허용")
	}
	w("[/ISSUE-TREE]")
	if brief := strings.TrimSpace(m.Brief); brief != "" {
		w("")
		w("[작업]")
		w("%s", brief)
	}
	if clause := HandoffClause(rec, m); clause != "" {
		w("")
		w("%s", strings.TrimRight(clause, "\n"))
	}
	if m.Worktree != nil && m.Worktree.Path != "" {
		w("")
		w("[작업 트리] 이 경로 안에서만 파일을 고친다. cd 로 벗어나지 마라.")
		w("  경로   %s", m.Worktree.Path)
		w("  브랜치 %s", m.Worktree.Branch)
		w("  base   %s", m.Worktree.Base)
	}
	w("")
	w("# 이슈 운영은 이 노드의 일이다. 규약(보드·필드·이름)은 프로젝트 지시 문서를 따르고, 없으면 GitHub 기본 동작만 한다.")
	w("#  0) 세션을 시작할 때마다(승계로 들어온 세션도) 이 이슈의 상태를 확인한다. 규약이 정한 보드의")
	w("#     필수 필드가 모두 채워졌는지 확인하고, 빠진 것은 채운다.")
	w("#  1) 착수할 때 이슈를 프로젝트 보드의 진행 중으로 옮긴다.")
	w("#  2) 필요할 때 이슈에 코멘트를 남긴다 — 진행 메모, 그리고 받은 결정(첫 줄 `결정:`).")
	w("#  3) 나눌 필요가 있으면 하위 이슈를 만든다.")
	w("#  4) 끝나면 이슈를 닫고 보드의 완료로 옮긴다.")
	w("")
	w("# 판단이 필요한 질문은 먼저 프로젝트 문서와 자기·부모 이슈의 코멘트에서 기존 결정을 찾는다.")
	w("# 없으면 부모를 거치지 않고 자기 탭에서 사용자에게 묻는다(AskUserQuestion 을 써도 된다).")
	w("# 받은 결정은 이슈 코멘트로 남긴다 — 자기 이슈에만 걸리면 자기 이슈에, 형제에도 걸리면 부모 이슈에.")
	w("")
	w("# 일을 마치면 아래를 정확히 한 번 실행한다. --outcome 을 반드시 명시한다 —")
	w("# 실패를 산문에만 담으면 성공으로 읽힌다. --summary 는 3문장이다:")
	w("# 무엇을 했는가 / 무엇을 발견했는가 / 무엇이 남았는가.")
	w("# 지금 이 member 가 보고한다. 승계로 들어왔으면 이 member id 로 보고한다.")
	w("dmctl run report --run %s --member %s --outcome succeeded --summary \"...\"", rec.ID, m.ID)
	if tc.ParentToolID != "" {
		w("")
		w("# 보고·완료·실패·부모 범위의 사실 질문은 부모에게 보낸다. 본문 첫 줄이 종류와 사슬 이름이다.")
		w("# 종료자 MSG 는 반드시 줄 맨 앞(열 0)이어야 한다.")
		w("dmctl msg --to %s - <<'MSG'", tc.ParentToolID)
		w("완료 %s", m.Role)
		w("...본문...")
		w("MSG")
	}
	w("")
	w("# 다른 이슈로 스스로 옮겨 가지 않는다. 자기 이슈를 끝내면 완료를 알리고 멈춘다.")
	w("# 자기 탭을 닫지 마라 — 탭은 부모가 닫는다. 예외는 자기 승계(migration)를 마친 옛 세션이다.")
	w("# migration 은 같은 이슈를 이어 가다 맥락이 모자랄 때만 쓴다.")
	w("# 사용자가 트리를 닫자고 하면 스스로 정리하지 않는다. 하던 일을 멈추고 부모에게 `종료 요청` 을 보낸다(문서의 「트리 종료」).")
	w("")
	w("%s", userFirstRule)
	return b.String()
}

func orNone(s string) string {
	if strings.TrimSpace(s) == "" {
		return "없음"
	}
	return s
}
