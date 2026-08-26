package query

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"

	"dongminal/internal/webserver/domain/git/core"
)

// 원격 목록 조회 (GIT_SRS §3B.1 FR-GIT-100).
//
// **자격증명을 받는 자리가 없다** (FR-GIT-104). 원격의 존재만 세며, URL 은
// 이름을 뽑는 데만 쓰고 보관하지 않는다.

// ErrNoRemote 는 밀 원격을 정할 수 없다는 것이다. 원격 목록을 읽는 것이 조회이므로
// 사유도 여기 있다 — write 가 이것을 참조하면 query 와 순환한다 (FR-GIT-9).
var ErrNoRemote = errors.New("no_remote")

// DefaultRemote 는 밀 대상 원격을 정한다. 하나면 그것, 여럿이면 origin, 없으면
// 오류다 (FR-GIT-100).
//
// 목록은 `git config --list` 에서 읽는다. `git remote` 는 읽기 허용 목록에 없고,
// **허용 목록을 늘리지 않고 얻을 수 있는 값이므로 늘리지 않는다.** `refs/remotes`
// 를 훑는 방법은 쓰지 않는다 — fetch 한 적 없는 원격은 그 아래에 아무것도 없다.
func DefaultRemote(s *core.Service, ctx context.Context, repo string) (string, error) {
	out, err := s.Exec(ctx, repo, "config", "--list")
	if err != nil {
		return "", err
	}
	names := remoteNames(out.Stdout)
	switch len(names) {
	case 0:
		return "", fmt.Errorf("%w: 원격이 없다", ErrNoRemote)
	case 1:
		return names[0], nil
	}
	for _, n := range names {
		if n == "origin" {
			return "origin", nil
		}
	}
	return "", fmt.Errorf("%w: 원격이 %d 개이고 origin 이 없다: %v", ErrNoRemote, len(names), names)
}

// remoteNames 는 `config --list` 에서 `remote.<name>.url` 만 골라 이름을 모은다.
//
// url 이 있는 것만 세는 이유는 `remote.<name>.prune` 처럼 전역 설정에 흔히 있는
// 키가 원격의 **존재**를 뜻하지 않기 때문이다. 이름에 점이 들 수 있으므로
// (`remote.my.fork.url`) 접두·접미만 떼고 남은 것을 그대로 이름으로 본다.
func remoteNames(out string) []string {
	seen := map[string]bool{}
	names := []string{}
	for _, line := range strings.Split(out, "\n") {
		key, _, ok := strings.Cut(line, "=")
		if !ok || !strings.HasPrefix(key, "remote.") || !strings.HasSuffix(key, ".url") {
			continue
		}
		name := strings.TrimSuffix(strings.TrimPrefix(key, "remote."), ".url")
		if name == "" || seen[name] {
			continue
		}
		seen[name] = true
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}
