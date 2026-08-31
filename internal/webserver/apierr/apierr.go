// Package apierr는 domain sentinel 을 HTTP 응답의 (status, code) 로 옮기는
// 등록부다 (DEEPENING_REFACTOR_SRS 묶음 A).
//
// **본문 모양은 여기 없다.** 이 서버에는 오류 본문 방언이 넷 있고
// (`{"error","message"}` · `{"code","message"}` · `{"error","detail"}` ·
// `{"error"}`) 각각이 브라우저가 소비하는 공개 계약이다. 통일은 리팩터가 아니라
// 파괴적 변경이므로, 이 패키지가 소유하는 것은 **매핑과 어휘**뿐이고 렌더링은
// 각 표면에 남는다. 렌더러가 둘 이상이라 이 이음매는 가설이 아니라 실재한다.
//
// **테이블이 표면마다 하나인 이유** 는 같은 sentinel 의 옳은 상태 코드가 표면마다
// 다르기 때문이다:
//
//	worktree.ErrNotRepo → /api/git/worktrees  404 (지목한 것이 거기 없다)
//	                    → /api/runs           400 (호출자가 인자로 준 것이 틀렸다)
//
// 기계(Table.Lookup)는 공유하고 정책(어느 sentinel 이 무엇이 되는가)은 표면이
// 갖는다. 하나로 뭉치면 둘 중 하나가 조용히 틀린다.
package apierr

import "errors"

// StatusClientClosed 는 499 다. nginx 관례이므로 Go 에 상수가 없다 — 이름을 여기
// 한 번만 두고 그것만 쓴다 (FR-GIT-217). 서버가 실패한 것이 아니라 요청이 사라진
// 것이므로 500 과 갈라 적어야 로그에서 진짜 장애와 구분된다.
const StatusClientClosed = 499

// Rule은 sentinel 하나를 (status, code) 로 옮긴다.
type Rule struct {
	Err    error
	Status int
	Code   string
}

// Table은 한 HTTP 표면의 매핑 정책이다. 순서대로 걸어 첫 errors.Is 일치가 이긴다.
//
// 순서가 의미를 갖는 자리가 하나 있다: `write.StashPop` 이 실패를 errors.Join 으로
// 묶어 돌려줄 수 있어(stash.go:226) 한 오류가 두 sentinel 에 일치할 수 있다.
// 그래서 stash 규칙의 상대 순서를 원본 switch 그대로 둔다.
type Table []Rule

// Lookup은 err 에 맞는 (status, code) 를 돌려준다. 일치가 없으면 ok==false 이며
// **기본값을 정하지 않는다** — 미분류 실패의 코드가 표면마다 다르다
// (`git_failed` · `io_failed` · sentinel 문자열). 등록부가 대신 고르면 그중
// 하나가 틀린다.
func (t Table) Lookup(err error) (status int, code string, ok bool) {
	for _, r := range t {
		if errors.Is(err, r.Err) {
			return r.Status, r.Code, true
		}
	}
	return 0, "", false
}

// Sentinels는 이 테이블이 다루는 sentinel 전부다. 전수성 테스트가 쓴다.
func (t Table) Sentinels() []error {
	out := make([]error, 0, len(t))
	for _, r := range t {
		out = append(out, r.Err)
	}
	return out
}
