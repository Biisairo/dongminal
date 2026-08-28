package wsentry

// 연동 4규칙 (FR-EDT-31~34). 전부 **순수 함수**이며 서로를 호출하지 않는다
// (FR-EDT-36) — 부르는 순간 사용자 조작 한 번에 규칙이 두 겹 적용되고, 결과가
// 호출 순서에 달린다. link_test.go 가 이 사실을 코드로 검사한다.
//
// home 을 인자로 받는 이유는 root 행이 홈을 이미 대표하기 때문이다 —
// 홈은 editors.list 에 들어가지 않는다 (FR-EDT-16·17·37).

// LinkPinAdd 는 핀을 더하고 같은 경로의 Editor 행을 함께 만든다 (FR-EDT-31·37).
func LinkPinAdd(cur Lists, root, home string) Lists {
	out := cur
	out.Pinned = appendUnique(cur.Pinned, root)
	if root != home {
		out.Editors = appendUnique(cur.Editors, root)
	}
	return out
}

// LinkPinRemove 는 핀을 지우고 같은 경로의 Editor 행을 함께 지운다 (FR-EDT-32).
// 홈은 건드리지 않는다 — root 행은 연동으로 사라지지 않는다 (FR-EDT-38).
func LinkPinRemove(cur Lists, path, home string) Lists {
	out := cur
	out.Pinned = removeAll(cur.Pinned, path)
	if path != home {
		out.Editors = removeAll(cur.Editors, path)
	}
	return out
}

// LinkEditorAdd 는 Editor 행을 더하고, 그 경로가 저장소의 **루트일 때만** 핀을
// 함께 만든다 (FR-EDT-33). 홈이면 아무것도 하지 않는다 (FR-EDT-16).
func LinkEditorAdd(cur Lists, path, home string, repoRoot bool) Lists {
	out := cur
	if path == home {
		return out
	}
	out.Editors = appendUnique(cur.Editors, path)
	if repoRoot {
		out.Pinned = appendUnique(cur.Pinned, path)
	}
	return out
}

// LinkEditorRemove 는 Editor 행을 지우고 같은 경로의 핀을 함께 지운다 (FR-EDT-34).
//
// 홈이면 아무것도 하지 않는다 (FR-EDT-38a). 홈에는 애초에 Editor 행이 없으므로
// (FR-EDT-16·17) FR-EDT-34 의 전제 — "같은 경로의 행을 지운다" — 가 성립하지
// 않는다. 이 예외가 없으면 `editors/remove ~` 가 **홈의 git 핀만** 지운다.
func LinkEditorRemove(cur Lists, path, home string) Lists {
	out := cur
	if path == home {
		return out
	}
	out.Editors = removeAll(cur.Editors, path)
	out.Pinned = removeAll(cur.Pinned, path)
	return out
}

// appendUnique 는 멱등한 추가다 (FR-EDT-25). 정렬하지 않는다 — 사용자가 추가한
// 순서가 목록 순서다.
func appendUnique(cur []string, p string) []string {
	for _, v := range cur {
		if v == p {
			return cur
		}
	}
	out := make([]string, 0, len(cur)+1)
	return append(append(out, cur...), p)
}

// removeAll 은 문자열 완전 일치로 지운다 (FR-EDT-26).
func removeAll(cur []string, p string) []string {
	out := make([]string, 0, len(cur))
	for _, v := range cur {
		if v != p {
			out = append(out, v)
		}
	}
	return out
}

// reorder 는 src 를 빼서 target 앞/뒤에 넣는다 (FR-EDT-27).
//
// src 가 없으면 아무것도 바꾸지 않는다 — 목록에 없는 것을 옮기려는 요청은 이미
// 화면이 낡았다는 뜻이고, 그때 순서를 흔들면 사용자가 보지 않은 변경이 남는다.
// 목록에 없는 target 도 같은 이유로 무변경이다.
//
// **빈 target 만 예외다.** 그것은 사라진 대상이 아니라 "맨 끝" 이라는 의도이며
// (FR-EDT-111, 목록 아래 빈 자리에 놓는 드롭이 그 값을 보낸다) 그때는 끝으로
// 옮긴다. 둘을 하나로 접으면 낡은 화면이 보낸 델타가 사용자가 지시한 적 없는
// "맨 끝으로" 가 된다 (FR-EDT-27).
func reorder(cur []string, src, target string, before bool) []string {
	si := -1
	for i, p := range cur {
		if p == src {
			si = i
			break
		}
	}
	if si < 0 || src == target {
		return cur
	}
	out := make([]string, 0, len(cur))
	out = append(out, cur[:si]...)
	out = append(out, cur[si+1:]...)

	ti := -1
	for i, p := range out {
		if p == target {
			ti = i
			break
		}
	}
	if ti < 0 {
		if target == "" {
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
