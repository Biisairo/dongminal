package store

import (
	"encoding/json"
	"fmt"
	"hash/fnv"
	"strconv"
)

// REPO_FIX 04 §3A-0 X5: hub/gitwatch.go 에서 옮겼다 — git_changed 방송과 status 응답이
// 같은 함수로 관측 식별자를 만든다.

// Mark 는 관측 하나를 비교 가능한 한 줄로 접는다.
//
// **무엇이 바뀌면 알려야 하는가** 의 정의다. signature 는 `.git` 의 변화를,
// status 는 작업 트리·머리글·진행 중 작업을 잡는다.
//
// OPTIMIZE_REFACTOR_SRS FR-OPT-4-7: **status 의 필드 전부**를 접는다.
//
//	이전 동작: 브랜치·ahead/behind·진행 중 작업·파일의 경로·XY·sub 만 접었다
//	새  동작: status 를 JSON 으로 부호화한 바이트 전부를 접는다
//	이유:     `GET /api/git/status?ifMark=` 는 mark 가 같으면 목록을 생략한다. 응답에
//	          실리는 필드가 mark 밖에 있으면(`total`·`upstream`·잘림·`origPath`) 그
//	          변화는 조건부 응답 뒤에서 영영 전달되지 않는다. 필드를 손으로 고르면
//	          다음에 더해지는 필드가 또 빠진다
//
// 부호화는 결정적이다 — 구조체 필드 순서는 고정이고 map 키는 정렬된다. 목록의
// 순서는 `git status` 가 정한다.
func Mark(o Observation) string {
	h := fnv.New64a()
	fmt.Fprintf(h, "%s|", o.Signature.Value)
	// 쓰기 대상이 해시라 부호화 오류는 값의 것뿐이고, Status 에는 부호화할 수 없는
	// 값이 없다.
	_ = json.NewEncoder(h).Encode(o.Status)
	return strconv.FormatUint(h.Sum64(), 36)
}
