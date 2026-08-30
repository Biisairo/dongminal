package cli

import (
	"fmt"
	"io"
)

// checkReport 는 계층별·항목별 검사의 보고 형식이다. `doctor` 와 `verify` 가
// 함께 딛는다.
//
// 한 벌인 것이 요구사항이다 (E2E_UNIFICATION_SRS FR-E2R-1). 형식을 두 벌로 두면
// 이 저장소가 반복해서 경계하는 "규칙을 두 벌로 두면 한쪽만 고쳐진다" 를 검증
// 하네스 안에 새로 만드는 것이 된다.
type checkReport struct {
	out  io.Writer
	fail int
	skip int
	// bads 는 실패 줄을 모은다. 보고서가 길어 사용자가 앞부분을 잘라 붙이는
	// 일이 실제로 있었다 — 마지막에 다시 모아 찍으면 꼬리만 붙여도 답이 실린다.
	bads []string
}

func (r *checkReport) ok(format string, a ...any) {
	fmt.Fprintf(r.out, "  ✅ "+format+"\n", a...)
}

func (r *checkReport) info(format string, a ...any) {
	fmt.Fprintf(r.out, "  ·  "+format+"\n", a...)
}

func (r *checkReport) bad(format string, a ...any) {
	line := fmt.Sprintf(format, a...)
	fmt.Fprintf(r.out, "  ❌ %s\n", line)
	r.bads = append(r.bads, line)
	r.fail++
}

// skipped 는 검사를 돌리지 않았음을 **남긴다**. 침묵과 구별되는 것이 요점이다
// (FR-E2S-4) — 이유 없이 빠지면 빠진 줄 모르는 보증이 는다.
func (r *checkReport) skipped(name, reason string) {
	fmt.Fprintf(r.out, "  ⏭  %s — %s\n", name, reason)
	r.skip++
}

func (r *checkReport) section(title string) {
	fmt.Fprintf(r.out, "\n▶ %s\n", title)
}
