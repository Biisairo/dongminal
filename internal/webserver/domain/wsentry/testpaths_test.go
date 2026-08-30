package wsentry

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
	absA           = testpath.Abs("a")
	absB           = testpath.Abs("b")
	absC           = testpath.Abs("c")
	absHomeU       = testpath.Abs("home", "u")
	absNoSuchDir   = testpath.Abs("no", "such", "dir")
	absWorkRepo    = testpath.Abs("work", "repo")
	absWorkRepoSub = testpath.Abs("work", "repo", "sub")
	absX           = testpath.Abs("x")
)

var (
	qA = testpath.JSONQuote(absA)
	qB = testpath.JSONQuote(absB)
	qC = testpath.JSONQuote(absC)
)
