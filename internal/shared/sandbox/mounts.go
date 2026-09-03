package sandbox

import (
	"fmt"
	"path/filepath"
	"strings"
)

// Mount 는 호스트의 한 자리를 컨테이너 안으로 잇는다 (FR-SBX-39).
type Mount struct {
	Host      string
	Container string
	ReadOnly  bool
	// Scratch 는 이 항목을 scratch 프로파일에도 붙이는가다. 붙이면 그 창은
	// 더 이상 격리 경계가 아니다 (FR-SBX-39b).
	Scratch bool
}

// Arg 는 런타임에 넘길 -v 값이다.
func (m Mount) Arg() string {
	s := m.Host + ":" + m.Container
	if m.ReadOnly {
		s += ":ro"
	}
	return s
}

// ParseMount 는 간편 형식을 읽는다 — `호스트:컨테이너[:ro|:rw]`.
//
// 뒤에서부터 가르는 것이 요점이다. 호스트 경로에는 콜론이 들어갈 수 있지만
// (`C:\src\app`), 컨테이너 경로는 게스트가 리눅스이므로 언제나 "/" 로 시작한다.
// 앞에서부터 가르면 Windows 경로가 드라이브 문자에서 잘린다.
func ParseMount(v string, home func() (string, error)) (Mount, error) {
	raw := strings.TrimSpace(v)
	if raw == "" {
		return Mount{}, fmt.Errorf("빈 마운트 항목입니다")
	}
	m := Mount{}
	switch {
	case strings.HasSuffix(raw, ":ro"):
		m.ReadOnly, raw = true, raw[:len(raw)-3]
	case strings.HasSuffix(raw, ":rw"):
		raw = raw[:len(raw)-3]
	}
	i := strings.LastIndex(raw, ":")
	if i <= 0 || i == len(raw)-1 {
		return Mount{}, fmt.Errorf("마운트 형식이 아닙니다(호스트경로:컨테이너경로[:ro]): %q", v)
	}
	m.Host, m.Container = raw[:i], raw[i+1:]
	if !strings.HasPrefix(m.Container, "/") {
		return Mount{}, fmt.Errorf("컨테이너 경로는 %q 처럼 절대 경로여야 합니다: %q", "/work", v)
	}
	host, err := expandHome(m.Host, home)
	if err != nil {
		return Mount{}, err
	}
	m.Host = host
	return m, nil
}

// expandHome 은 앞머리 `~` 를 사용자 홈으로 편다. 설정 파일에 절대 경로를 적게
// 하면 홈 경로가 사람마다 달라 그 파일을 공유할 수 없다.
func expandHome(p string, home func() (string, error)) (string, error) {
	if p != "~" && !strings.HasPrefix(p, "~/") && !strings.HasPrefix(p, `~\`) {
		return p, nil
	}
	h, err := home()
	if err != nil || h == "" {
		return "", fmt.Errorf("사용자 홈을 알 수 없어 %q 를 펼 수 없습니다", p)
	}
	if p == "~" {
		return h, nil
	}
	return filepath.Join(h, p[2:]), nil
}

// mountEntry 는 정의 파일의 한 항목이다. 문자열과 객체를 모두 받는다.
type mountEntry struct {
	Host      string `json:"host"`
	Container string `json:"container"`
	ReadOnly  bool   `json:"readonly"`
	Scratch   bool   `json:"scratch"`
}

// toMount 는 항목을 Mount 로 만든다. any 인 것은 같은 배열에 문자열과 객체가
// 섞일 수 있기 때문이다.
func toMount(v any, home func() (string, error)) (Mount, error) {
	switch t := v.(type) {
	case string:
		return ParseMount(t, home)
	case map[string]any:
		e := mountEntry{}
		e.Host, _ = t["host"].(string)
		e.Container, _ = t["container"].(string)
		e.ReadOnly, _ = t["readonly"].(bool)
		e.Scratch, _ = t["scratch"].(bool)
		if e.Host == "" || e.Container == "" {
			return Mount{}, fmt.Errorf("마운트에 host 와 container 가 모두 필요합니다: %v", v)
		}
		if !strings.HasPrefix(e.Container, "/") {
			return Mount{}, fmt.Errorf("컨테이너 경로는 절대 경로여야 합니다: %q", e.Container)
		}
		host, err := expandHome(e.Host, home)
		if err != nil {
			return Mount{}, err
		}
		return Mount{Host: host, Container: e.Container, ReadOnly: e.ReadOnly, Scratch: e.Scratch}, nil
	default:
		return Mount{}, fmt.Errorf("마운트 항목을 해석할 수 없습니다: %v", v)
	}
}

// VerifyMounts 는 마운트 원본이 실재하는지 본다 (FR-SBX-39).
//
// 없는 원본을 런타임에 넘기면 **호스트에 그 디렉터리가 생긴다**(§2.6 실측).
// 기본 마운트는 사용자가 직접 적은 것이므로 오타를 삼키지 않고 알린다 — 동적
// 마운트가 조용히 건너뛰는 것과 갈리는 지점이다 (FR-SBX-41).
func VerifyMounts(ms []Mount, stat func(string) error) error {
	for _, m := range ms {
		if err := stat(m.Host); err != nil {
			return fmt.Errorf("기본 마운트의 원본이 없습니다: %s (%s 를 확인하세요)",
				m.Host, ProfilesFileName)
		}
	}
	return nil
}
