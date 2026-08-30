package gitapi

import (
	"dongminal/internal/shared/testpath"
)

// 테스트가 쓰는 절대경로다. 리터럴("/work/repo")을 쓰면 **Windows 에서
// 절대경로가 아니게 되어** 경로 가드에 걸린다 — 이 저장소의 가드는
// filepath.IsAbs 를 쓰고, 그것은 OS 의존이다
// (WINDOWS_TEST_PARITY_SRS §2.2, FR-WTP-10).
//
// 입력과 기대값을 **같은 함수**로 만드는 것이 요점이다 (FR-WTP-12) —
// 한쪽만 바꾸면 Windows 에서 다시 어긋난다.

var (
	absA              = testpath.Abs("a")
	absB              = testpath.Abs("b")
	absBad            = testpath.Abs("bad")
	absC              = testpath.Abs("c")
	absD              = testpath.Abs("d")
	absE              = testpath.Abs("e")
	absGone           = testpath.Abs("gone")
	absGood           = testpath.Abs("good")
	absHomeXWorktrees = testpath.Abs("home", "x", "worktrees")
	absNopeNope       = testpath.Abs("nope", "nope")
	absOther          = testpath.Abs("other")
	absOtherRepo      = testpath.Abs("Users", "dev", "other-repo")
	absR              = testpath.Abs("r")
	absTmpPlain       = testpath.Abs("tmp", "plain")
	absWorkRepo       = testpath.Abs("work", "repo")
	absWorkRepoSub    = testpath.Abs("work", "repo", "sub")
	absX              = testpath.Abs("x")
)

var (
	qA        = testpath.JSONQuote(absA)
	qB        = testpath.JSONQuote(absB)
	qBad      = testpath.JSONQuote(absBad)
	qC        = testpath.JSONQuote(absC)
	qD        = testpath.JSONQuote(absD)
	qE        = testpath.JSONQuote(absE)
	qGone     = testpath.JSONQuote(absGone)
	qGood     = testpath.JSONQuote(absGood)
	qNopeNope = testpath.JSONQuote(absNopeNope)
	qOther    = testpath.JSONQuote(absOther)
	qR        = testpath.JSONQuote(absR)
	qTmpPlain = testpath.JSONQuote(absTmpPlain)
	qWorkRepo = testpath.JSONQuote(absWorkRepo)
)
