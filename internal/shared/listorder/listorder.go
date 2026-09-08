// Package listorder 는 "끌어다 놓기" 한 번을 목록에 반영한다
// (DRIFT_RECLAIM_SRS FR-DRC-11).
//
// 같은 25줄이 `gitapi`(핀 목록)와 `domain/wsentry`(편집기 탭 목록)에 두 벌 있었고,
// **한 줄에서 갈라져 있었다** — target 을 목록에서 못 찾았을 때다. 그 divergence 는
// 실수가 아니라 서로 반대되는 판단이었고, 양쪽 주석이 각자의 이유를 적어 두었다:
//
//	gitapi:  "target 이 없으면 맨 끝이다 — 끌어다 놓은 곳이 사라졌다고 조작을
//	          통째로 잃지 않는다"
//	wsentry: "낡은 화면이 보낸 델타가 사용자가 지시한 적 없는 '맨 끝으로' 가 된다
//	          (FR-EDT-27)"
//
// 그래서 정책을 지우지 않고 **인자로 드러낸다.** 두 벌로 두면 이 갈림이 있다는
// 사실 자체를 아무것도 알려주지 않는다 — 지금 이 주석이 그것을 말하는 유일한 자리다.
package listorder

// Missing 은 target 을 목록에서 못 찾았을 때의 정책이다.
type Missing int

const (
	// Keep 은 목록을 그대로 둔다. 낡은 화면이 보낸 델타를 사용자가 지시한 적 없는
	// 이동으로 바꾸지 않는다 (FR-EDT-27).
	Keep Missing = iota
	// ToEnd 는 맨 끝으로 옮긴다. 끌어다 놓은 자리가 사라졌다고 조작을 통째로
	// 잃지 않는다.
	ToEnd
)

// Move 는 src 를 target 의 앞(before) 또는 뒤로 옮긴 새 목록이다.
//
// **빈 target 은 언제나 "맨 끝"이다** — 사라진 대상이 아니라 의도다 (목록 아래
// 빈 자리에 놓는 드롭이 그 값을 보낸다). 그래서 `missing` 정책보다 앞선다.
//
// src 가 목록에 없거나 src == target 이면 무동작이다. 원본은 바뀌지 않는다.
func Move(cur []string, src, target string, before bool, missing Missing) []string {
	si := indexOf(cur, src)
	if si < 0 || src == target {
		return cur
	}
	out := make([]string, 0, len(cur))
	out = append(out, cur[:si]...)
	out = append(out, cur[si+1:]...)

	ti := indexOf(out, target)
	if ti < 0 {
		if target == "" || missing == ToEnd {
			return append(out, src)
		}
		return cur
	}
	if !before {
		ti++
	}
	out = append(out, "")
	copy(out[ti+1:], out[ti:])
	out[ti] = src
	return out
}

func indexOf(list []string, want string) int {
	for i, p := range list {
		if p == want {
			return i
		}
	}
	return -1
}
