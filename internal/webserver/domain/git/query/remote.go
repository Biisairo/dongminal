package query

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"

	"dongminal/internal/webserver/domain/git/core"
)

// 원격 목록 조회 (GIT_SRS §3B.1 FR-GIT-100, GIT_ACTIONS_SRS §3.5 FR-GIT-269).
//
// **자격증명을 받는 자리가 없다** (FR-GIT-104). 원격의 존재를 세고, 화면이 어느
// 원격인지 가릴 수 있도록 URL 을 함께 주되 **나가는 값은 지운 값이다** —
// `https://user:…@host` 의 비밀 자리는 core.SanitizeRemote 가 지운 뒤에야 이
// 패키지를 떠난다. 원본은 어디에도 보관하지 않는다.

// Remote 는 원격 하나다. URL 은 지운 값이므로 **그대로 실행할 수 없을 수 있다** —
// 자격증명이 박힌 URL 이었다면 그 자리가 `***` 다.
type Remote struct {
	Name    string `json:"name"`
	URL     string `json:"url,omitempty"`
	PushURL string `json:"pushUrl,omitempty"`
}

// Remotes 는 원격 전부다 (FR-GIT-269). 이름순이며 빈 목록은 빈 슬라이스다 —
// nil 은 JSON 에서 null 이 되고 목록이 되지 못한다 (FR-RPT-1).
//
// **새 조회를 만들지 않는다.** `git remote -v` 를 쓰려면 읽기 허용 목록을 늘려야
// 하고, DefaultRemote 가 이미 읽는 `config --list` 로 같은 값을 얻는다.
func Remotes(s *core.Service, ctx context.Context, repo string) ([]Remote, error) {
	out, err := s.Exec(ctx, repo, "config", "--list")
	if err != nil {
		return nil, err
	}
	return parseRemotes(out.Stdout), nil
}

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

// remoteNames 는 원격 이름 전부다. **Remotes 와 같은 규칙을 쓴다** — 판정이 두
// 벌이면 한쪽만 고쳐지고, 목록에 있는 원격을 DefaultRemote 가 모르게 된다.
func remoteNames(out string) []string {
	list := parseRemotes(out)
	names := make([]string, 0, len(list))
	for _, r := range list {
		names = append(names, r.Name)
	}
	return names
}

// parseRemotes 는 `config --list` 에서 `remote.<name>.url` 과 `.pushurl` 을 골라
// 원격을 모은다.
//
// url 이 있는 것만 세는 이유는 `remote.<name>.prune` 처럼 전역 설정에 흔히 있는
// 키가 원격의 **존재**를 뜻하지 않기 때문이다. 이름에 점이 들 수 있으므로
// (`remote.my.fork.url`) 접두·접미만 떼고 남은 것을 그대로 이름으로 본다.
//
// 값은 **여기서 지운다** (FR-GIT-104) — 지우는 자리를 호출자에게 맡기면 한 호출자만
// 잊어도 그곳이 유출 경로가 된다.
func parseRemotes(out string) []Remote {
	at := map[string]*Remote{}
	order := []string{}
	for _, line := range strings.Split(out, "\n") {
		key, val, ok := strings.Cut(line, "=")
		if !ok || !strings.HasPrefix(key, "remote.") {
			continue
		}
		rest := strings.TrimPrefix(key, "remote.")
		var name, field string
		switch {
		case strings.HasSuffix(rest, ".url"):
			name, field = strings.TrimSuffix(rest, ".url"), "url"
		case strings.HasSuffix(rest, ".pushurl"):
			name, field = strings.TrimSuffix(rest, ".pushurl"), "pushurl"
		default:
			continue
		}
		if name == "" {
			continue
		}
		r, seen := at[name]
		if !seen {
			r = &Remote{Name: name}
			at[name] = r
			order = append(order, name)
		}
		if field == "url" {
			r.URL = core.SanitizeRemote(val)
		} else {
			r.PushURL = core.SanitizeRemote(val)
		}
	}
	// pushurl 만 있는 항목은 원격의 **존재**를 뜻하지 않는다 — url 이 기준이다.
	names := make([]string, 0, len(order))
	for _, n := range order {
		if at[n].URL != "" {
			names = append(names, n)
		}
	}
	sort.Strings(names)
	list := make([]Remote, 0, len(names))
	for _, n := range names {
		list = append(list, *at[n])
	}
	return list
}
