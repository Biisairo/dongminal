// Package diagtail 은 실행 진단 문자열을 사람이 읽을 만큼만 남긴다
// (DRIFT_RECLAIM_SRS FR-DRC-9).
//
// 같은 로직이 세 벌 있었고 상한만 달랐다 — `sandbox`(400) · `submodule`(2000) ·
// `gitapi`(2048). 상한이 표면마다 다른 것은 정당하다: 진단이 실리는 자리가
// 다르다. **판정이 세 벌인 것이 정당하지 않았다.**
//
// 세 벌 중 하나만 옳았다. `gitapi.gitTail` 만 `ToValidUTF8` 를 지났고, 나머지
// 둘은 UTF-8 문자열을 바이트 경계로 잘랐다 — 한글이 실린 stderr 를 자르면 마지막
// 글자가 깨진 바이트로 남고, 그것이 JSON 으로 나가면 인코더가 조용히 U+FFFD 로
// 바꾼다. 자르는 자리가 한 곳이면 그 규칙도 한 곳이다.
package diagtail

import "strings"

// Cut 은 **뒤쪽을** 남긴다 — 실패의 이유는 stderr 끝에 있다.
//
// 자른 자리가 문자 가운데면 그 조각을 버린다. 깨진 바이트를 남기면 그것을 받는
// 쪽(JSON 인코더·터미널)이 각자 다르게 고쳐 쓴다.
func Cut(msg string, max int) string {
	if len(msg) <= max {
		return msg
	}
	return strings.ToValidUTF8(msg[len(msg)-max:], "")
}

// Of 는 실행 결과 하나의 진단이다. 출력이 비었으면 오류를 쓴다 — **어느 쪽도
// 조용히 버리지 않는다.** 실패했는데 stdout 이 빈 경우가 흔하고, 그때 빈 문자열을
// 돌려주면 사용자는 아무 사유도 못 본다.
func Of(out string, err error, max int) string {
	s := strings.TrimSpace(out)
	if s == "" && err != nil {
		s = err.Error()
	}
	return Cut(s, max)
}
