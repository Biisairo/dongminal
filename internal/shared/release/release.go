// Package release 는 **최신 릴리스가 무엇인가** 하나만 안다
// (UPDATE_NOTICE_SRS FR-UPD-5).
//
// 이 패키지가 따로 있는 이유는 묻는 자리가 둘이기 때문이다 — 사람이 직접 치는
// `dongminal update --check` 와, 서버가 캐시를 채우는 확인. 판정 로직을 두 벌로
// 두면 한쪽만 고쳐진다. **이 패키지는 언제 묻는지를 모른다.** 그 결정은 부르는
// 쪽에 있다.
package release

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// API 는 최신 릴리스를 묻는 자리다.
const API = "https://api.github.com/repos/dykim-hancom/dongminal/releases/latest"

// Timeout 은 확인에 주는 시간이다. 짧다 — 사용자가 기다리는 명령이고, 닿지
// 못하는 것이 사용자가 할 일을 만들지 않는다.
const Timeout = 5 * time.Second

// Latest 는 최신 태그와 그 릴리스 링크를 읽는다.
func Latest(url string) (tag, link string, err error) {
	if url == "" {
		url = API
	}
	c := &http.Client{Timeout: Timeout}
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return "", "", err
	}
	// NFR-UPD-4: 싣는 것은 이 한 줄뿐이다. 식별자·사용 통계·머신 정보를 보내지 않는다.
	req.Header.Set("Accept", "application/vnd.github+json")
	res, err := c.Do(req)
	if err != nil {
		return "", "", err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return "", "", fmt.Errorf("응답 %d", res.StatusCode)
	}
	var body struct {
		Tag  string `json:"tag_name"`
		Link string `json:"html_url"`
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&body); err != nil {
		return "", "", err
	}
	if body.Tag == "" {
		return "", "", fmt.Errorf("태그가 비었습니다")
	}
	return body.Tag, body.Link, nil
}

// Newer 는 a 가 b 보다 새로운가다.
//
// **문자열 비교가 아니다.** 그러면 `v1.10.0` 이 `v1.9.0` 보다 작아진다 —
// 한 자리가 열을 넘는 순간 갱신 안내가 조용히 멎는다.
func Newer(a, b string) bool {
	pa, pb := parts(a), parts(b)
	for i := 0; i < 3; i++ {
		if pa[i] != pb[i] {
			return pa[i] > pb[i]
		}
	}
	return false
}

// Comparable 은 그 판이 견줄 수 있는 것인가다. 개발 빌드는 기준이 없다 —
// 그것을 "뒤졌다" 로 말하면 거짓이다 (FR-UPD-9b).
func Comparable(v string) bool {
	v = strings.TrimSpace(v)
	return v != "" && v != "dev"
}

// parts 는 `v1.2.3` 을 [1 2 3] 으로 읽는다. 읽지 못한 자리는 0 이다 —
// 판정이 거짓이 되더라도 **패닉하지 않는다.**
func parts(v string) [3]int {
	var out [3]int
	s := strings.TrimPrefix(strings.TrimSpace(v), "v")
	// 사전 릴리스·빌드 메타는 버린다 (`1.2.3-rc1+abc`).
	if i := strings.IndexAny(s, "-+"); i >= 0 {
		s = s[:i]
	}
	for i, part := range strings.SplitN(s, ".", 3) {
		if i > 2 {
			break
		}
		n, err := strconv.Atoi(part)
		if err != nil {
			continue
		}
		out[i] = n
	}
	return out
}
