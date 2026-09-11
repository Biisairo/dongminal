package cli

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// `dongminal update --check` — **묻지 않으면 나가지 않는다** (M5 `G3-3`).
//
// 자동 갱신 확인을 두지 않는다. 이 제품은 상시 노출된 작업 도구이고, 그런
// 프로그램이 묻지 않고 밖으로 나가면 그 트래픽은 사용자가 통제하지 못하는
// 것이 된다. 그래서 **옵트인**이고, 확인만 하며, 내려받지 않는다.
//
// 내려받지 않는 이유는 따로 있다 — 설치 형태가 여럿이다(직접 빌드·릴리스 산출물·
// 앞으로 패키지 매니저). 스스로 자기 바이너리를 덮으면 그중 어느 형태에서는
// 패키지 관리자와 싸운다. **무엇을 받을지 알려 주고 거기서 멈춘다.**

// defaultReleaseAPI 는 최신 릴리스를 묻는 자리다.
const defaultReleaseAPI = "https://api.github.com/repos/dykim-hancom/dongminal/releases/latest"

// updateTimeout 은 확인에 주는 시간이다. 짧다 — 사용자가 기다리는 명령이고,
// 닿지 못하는 것이 사용자가 할 일을 만들지 않는다.
const updateTimeout = 5 * time.Second

// UpdateOpts 는 `dongminal update` 의 옵션이다.
type UpdateOpts struct {
	Check bool
	// endpoint 는 검사가 바꿔 끼우는 자리다. 비면 기본값이다.
	endpoint string
}

// ParseUpdate 는 `update [--check]` 다.
func ParseUpdate(args []string) (UpdateOpts, error) {
	var o UpdateOpts
	for _, a := range args {
		switch a {
		case "-h", "--help":
			return UpdateOpts{}, ErrHelp
		case "--check":
			o.Check = true
		default:
			return UpdateOpts{}, unknownFlag("update", a)
		}
	}
	return o, nil
}

// RunUpdate 는 `dongminal update` 다.
func RunUpdate(o UpdateOpts, stdout, stderr io.Writer) int {
	return runUpdateWith(o, Version, stdout, stderr)
}

// runUpdateWith 는 판을 인자로 받는다 — 검사가 `dev` 갈래까지 밟기 위해서다.
func runUpdateWith(o UpdateOpts, cur string, stdout, stderr io.Writer) int {
	if !o.Check {
		// **여기서 그물에 나가지 않는다.** 옵트인이 이 명령의 계약이다.
		fmt.Fprintln(stdout, "이 제품은 스스로 판을 확인하지 않습니다.")
		fmt.Fprintln(stdout, "확인하려면: dongminal update --check")
		fmt.Fprintln(stdout, "  (확인만 합니다 — 내려받거나 덮어쓰지 않습니다.)")
		return 0
	}
	url := o.endpoint
	if url == "" {
		url = defaultReleaseAPI
	}
	latest, link, err := fetchLatest(url)
	if err != nil {
		fmt.Fprintf(stderr, "최신 판을 확인하지 못했습니다: %v\n", err)
		return 1
	}
	fmt.Fprintf(stdout, "지금 판: %s\n최신 판: %s\n", cur, latest)

	if cur == "dev" || cur == "" {
		// 견줄 기준이 없다. 이것을 "뒤졌다" 로 말하면 거짓이다.
		fmt.Fprintln(stdout, "\n개발 빌드입니다 — 릴리스 판과 견줄 기준이 없습니다.")
		if link != "" {
			fmt.Fprintf(stdout, "최신 릴리스: %s\n", link)
		}
		return 0
	}
	if versionNewer(latest, cur) {
		fmt.Fprintln(stdout, "\n새 판이 있습니다.")
		if link != "" {
			fmt.Fprintf(stdout, "  %s\n", link)
		}
		fmt.Fprintln(stdout, "  내려받은 뒤 dongminal stop --all 하고 바꿔 넣으세요.")
		fmt.Fprintln(stdout, "  바꾸기 전에: dongminal backup --out <파일.zip>")
		return 0
	}
	fmt.Fprintln(stdout, "\n최신입니다.")
	return 0
}

// fetchLatest 는 최신 태그와 링크를 읽는다.
func fetchLatest(url string) (tag, link string, err error) {
	c := &http.Client{Timeout: updateTimeout}
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return "", "", err
	}
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

// versionNewer 는 a 가 b 보다 새로운가다.
//
// **문자열 비교가 아니다.** 그러면 `v1.10.0` 이 `v1.9.0` 보다 작아진다 —
// 한 자리가 열을 넘는 순간 갱신 안내가 조용히 멎는다.
func versionNewer(a, b string) bool {
	pa, pb := semverParts(a), semverParts(b)
	for i := 0; i < 3; i++ {
		if pa[i] != pb[i] {
			return pa[i] > pb[i]
		}
	}
	return false
}

// semverParts 는 `v1.2.3` 을 [1 2 3] 으로 읽는다. 읽지 못한 자리는 0 이다 —
// 판정이 거짓이 되더라도 **패닉하지 않는다.**
func semverParts(v string) [3]int {
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
