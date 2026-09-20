package runtimebin

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"time"

	"dongminal/internal/shared/dmenv"
)

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

// baseURL 의 기본값은 dmenv 가 갖는다 — 정상 경로에서는 server 가 자식
// 프로세스에 주소를 항상 주입하고, 여기 값은 그것이 비었을 때의 안전망이다.
//
// **파일 계층(`server.json`)은 여기 없다** (D-STR-3). `helper/runtimebin` 은
// `ctl/cli` 를 import 할 수 없다 — 프로세스 축 경계이고 `check-pkg-axis.sh` 가
// 그것을 지킨다. 계층을 주려면 `serverconf` 가 `shared` 로 가야 하고 그것은
// 패키지 구조 변경이다. 여기서 한 벌로 만든 것은 **주소 조립**까지다
// (FR-STR-21·26) — IPv6 의 대괄호가 `dmenv.BaseURL` 에서 붙는다.
func baseURL() string {
	return dmenv.BaseURL(
		envOr(dmenv.EnvHost, dmenv.DefaultHost),
		envOr(dmenv.EnvPort, dmenv.DefaultPort),
	)
}

func currentPort() string { return envOr(dmenv.EnvPort, dmenv.DefaultPort) }

// selfToolID 는 이 셸이 속한 도구다. --at 이 생략됐을 때의 기본 대상이고,
// 자신을 서버에 알리는 모든 명령의 신원이다.
//
// **runtimebin 안에서 도구 식별자를 읽는 유일한 자리다.** 파일마다 os.Getenv 를
// 따로 부르면 심는 이름(toolhub)과 읽는 이름이 갈라져도 아무 데서도 걸리지 않는다.
func selfToolID() string { return os.Getenv(dmenv.EnvToolID) }

var httpClient = &http.Client{Timeout: 10 * time.Second}

// clientWithin 은 한 요청에 예산을 주는 클라이언트다 (M8 D-A-1). 서버가 요청을
// 붙잡는 종단(`wait`·`succeed`·`preamble`·`close`)은 공용 10초 클라이언트로 부르면
// 정상 경로가 끊긴다 — 끊긴 뒤에도 서버는 계속 일하므로 "실패로 보고된 성공" 이 된다.
//
// 변수인 것은 테스트가 어떤 예산으로 불렀는지 기록하기 위해서다. 이 패키지의 명령은
// 구조체가 없는 함수라 주입할 자리가 이것뿐이다.
var clientWithin = func(budget time.Duration) *http.Client {
	return &http.Client{Timeout: budget}
}

func httpDoWithin(req *http.Request, budget time.Duration) (status int, respBody []byte, err error) {
	client := httpClient
	if budget > 0 {
		client = clientWithin(budget)
	}
	resp, err := client.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(resp.Body)
	return resp.StatusCode, data, err
}

// httpPostJSONWithin 은 예산이 있는 POST 다. budget<=0 이면 공용 클라이언트다.
func httpPostJSONWithin(url string, body any, budget time.Duration) (status int, respBody []byte, err error) {
	buf, err := json.Marshal(body)
	if err != nil {
		return 0, nil, err
	}
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(buf))
	if err != nil {
		return 0, nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	return httpDoWithin(req, budget)
}

// httpGetWithin 은 예산이 있는 GET 이다. budget<=0 이면 공용 클라이언트다.
func httpGetWithin(url string, budget time.Duration) (status int, respBody []byte, err error) {
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return 0, nil, err
	}
	return httpDoWithin(req, budget)
}

func httpDelete(url string) (status int, respBody []byte, err error) {
	req, err := http.NewRequest(http.MethodDelete, url, nil)
	if err != nil {
		return 0, nil, err
	}
	return httpDoWithin(req, 0)
}

func httpPostJSON(url string, body any) (status int, respBody []byte, err error) {
	return httpPostJSONWithin(url, body, 0)
}

func httpGet(url string) (status int, respBody []byte, err error) {
	return httpGetWithin(url, 0)
}
