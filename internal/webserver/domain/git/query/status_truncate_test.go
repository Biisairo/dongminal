package query

import (
	"context"
	"strings"
	"testing"

	"dongminal/internal/webserver/domain/git/core"
)

// SAFETY_CORRECTNESS_SRS 묶음 G (TC-SAF-12).
//
// 조회 아홉 중 `StatusOf` **하나만** 출력 잘림을 보지 않았다. 나머지 여덟
// (`log`·`refs`·`diff`×2·`diff_image`·`blame`·`commitdetail`·`stash`×2)은 전부
// `StdoutTruncated` 를 검사하고 명시적 오류를 낸다.
//
// 상한은 1MiB 이고 `--untracked-files=all` 은 접힌 디렉터리를 전부 펼친다
// (FR-GIT-215). 경로 평균 50B 로 잡아도 약 2만 항목에서 상한에 닿는다 —
// `status.go` 머리말이 직접 지목한 *"변경·미추적 파일이 수만 개인 저장소"* 가
// 그 조건이다.
//
// **그러나 status 는 실패로 끝낼 수 없는 표면이다** (D-SAF-2). 배지·관측이
// 여기 딛고, `StashPush`·`CleanUntracked`·`Rebase`·`PushSpec` 이 전부 이 함수를
// 지난다 — 다른 조회처럼 오류를 내면 그 저장소에서 여섯이 함께 막힌다.
// 그래서 **사실을 싣는다**.

// truncRunner 는 잘린 출력을 흉내낸다.
func truncRunner(stdout string, truncated bool) core.Runner {
	return func(context.Context, string, []string) (core.Output, error) {
		return core.Output{Stdout: stdout, StdoutTruncated: truncated}, nil
	}
}

// porcelainRecords 는 유효한 v2 레코드 n 개를 NUL 로 이어 만든다.
func porcelainRecords(n int) string {
	var b strings.Builder
	b.WriteString("# branch.head main\x00")
	for i := range n {
		b.WriteString("? untracked-")
		b.WriteString(strings.Repeat("a", 3))
		b.WriteString(string(rune('0' + i%10)))
		b.WriteString(".txt\x00")
	}
	return b.String()
}

func svcWith(r core.Runner) *core.Service { return core.New(core.WithRunner(r)) }

// TC-SAF-12 — 잘린 출력에서 파싱이 죽지 않고, 잘렸다는 사실이 실린다.
func TestStatusOf_TruncatedOutputIsCarriedNotFatal(t *testing.T) {
	// 마지막 레코드를 중간에서 끊는다 — 상한은 NUL 경계를 가리지 않는다.
	full := porcelainRecords(5)
	cut := full[:len(full)-6]

	st, err := StatusOf(svcWith(truncRunner(cut, true)), context.Background(), t.TempDir())
	if err != nil {
		t.Fatalf("잘림이 오류가 됐다 — status 는 실패로 끝낼 수 없는 표면이다 (D-SAF-2): %v", err)
	}
	if !st.OutputTruncated {
		t.Error("잘렸는데 OutputTruncated 가 서지 않았다 — 조용히 짧은 목록이 된다")
	}
	if st.Branch != "main" {
		t.Errorf("온전한 앞부분이 버려졌다: Branch=%q", st.Branch)
	}
	if len(st.Untracked) == 0 {
		t.Error("온전한 레코드가 하나도 살아남지 않았다")
	}
}

// 잘리지 않은 출력은 종전 그대로다 (회귀 방지).
func TestStatusOf_UntruncatedIsUnchanged(t *testing.T) {
	st, err := StatusOf(svcWith(truncRunner(porcelainRecords(3), false)), context.Background(), t.TempDir())
	if err != nil {
		t.Fatalf("StatusOf: %v", err)
	}
	if st.OutputTruncated {
		t.Error("잘리지 않았는데 OutputTruncated 가 섰다")
	}
	if len(st.Untracked) != 3 {
		t.Errorf("미추적 %d개 (want 3)", len(st.Untracked))
	}
}
