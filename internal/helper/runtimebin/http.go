package runtimebin

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"time"

	"dongminal/internal/shared/dmenv"
	"dongminal/internal/shared/serverconf"
)

// serverAddr 는 이 셸이 붙을 서버 주소다 (HOT_REBIND_SRS FR-HRB-12·13·14).
//
// 주소 파일 → `server.json` → 기본값 순서이고 **요청마다 다시 읽는다** — 서버가 포트를
// 바꿔도 이미 뜬 셸이 따라간다. 셸의 `DONGMINAL_PORT` 는 읽지 않는다. 이 변경 전 데몬이
// 띄운 셸에 옛 값이 남아 있기 때문이다.
//
// 샌드박스 컨테이너 안(`DONGMINAL_HOST` 가 게이트웨이)은 마운트된 주소 파일의 포트를 쓰고,
// 없으면 기동 때 심은 `DONGMINAL_PORT` 를 쓴다.
func serverAddr() (host, port string) {
	if os.Getenv(dmenv.EnvHost) == dmenv.ContainerHost {
		if _, p, ok := serverconf.ReadAddrFile(containerAddrFile); ok {
			return dmenv.ContainerHost, p
		}
		return dmenv.ContainerHost, dmenv.Or(dmenv.EnvPort, dmenv.DefaultPort)
	}
	home := helperHome()
	if h, p, ok := serverconf.ReadAddr(home); ok {
		return h, p
	}
	conf := serverconf.Resolve(serverconf.Inputs{Home: home})
	return conf.Host.Value, conf.Port.Value
}

// containerAddrFile 은 컨테이너 안 주소 파일의 자리다. 변수인 것은 시험이 바꾸기 위해서다.
var containerAddrFile = path.Join(dmenv.ContainerAddrDir, serverconf.AddrFileName)

// helperHome 은 인스턴스 홈이다. 서버가 셸에 `DONGMINAL_HOME` 을 넣는다. 없으면 기본 홈이다.
func helperHome() string {
	if h := os.Getenv(dmenv.EnvHome); h != "" {
		return h
	}
	return fallbackHome()
}

// fallbackHome 은 `DONGMINAL_HOME` 이 없을 때의 홈이다. 변수인 것은 시험이 사용 중인 홈에
// 닿지 않게 바꾸기 위해서다.
var fallbackHome = func() string {
	if u, err := os.UserHomeDir(); err == nil {
		return filepath.Join(u, dmenv.DefaultHomeDir)
	}
	return ""
}

// baseURL 은 서버를 두드릴 주소다. 미지정 주소(`0.0.0.0`)는 `dmenv.BaseURL` 이 loopback 으로 바꾼다.
func baseURL() string {
	h, p := serverAddr()
	return dmenv.BaseURL(h, p)
}

func currentPort() string {
	_, p := serverAddr()
	return p
}

// selfToolID 는 이 셸이 속한 도구다. --at 이 생략됐을 때의 기본 대상이고,
// 자신을 서버에 알리는 모든 명령의 신원이다.
//
// **runtimebin 안에서 도구 식별자를 읽는 유일한 자리다.** 파일마다 os.Getenv 를
// 따로 부르면 심는 이름(toolhub)과 읽는 이름이 갈라져도 아무 데서도 걸리지 않는다.
func selfToolID() string { return os.Getenv(dmenv.EnvToolID) }

var httpClient = &http.Client{Timeout: 10 * time.Second}

// hookBudget 은 에이전트 훅이 부르는 보고(activity·context·attention)의 예산이다
// (OPTIMIZE_REFACTOR_SRS FR-OPT-8-5 · SHR-10). 훅은 에이전트 턴의 핫패스이고 결과를
// 기다릴 까닭이 없다 — 서버가 받아 놓고 멈추면(데드락·GC 정지·과부하) 공용 10초가
// 턴마다 그대로 실린다. 서버가 없을 때는 연결 거절로 곧 돌아오므로 근거가 아니다.
const hookBudget = 2 * time.Second

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
	return httpJSONWithin(http.MethodPost, url, body, budget)
}

// httpJSONWithin 은 JSON 본문을 싣는 요청이다. budget<=0 이면 공용 클라이언트다.
func httpJSONWithin(method, url string, body any, budget time.Duration) (status int, respBody []byte, err error) {
	buf, err := json.Marshal(body)
	if err != nil {
		return 0, nil, err
	}
	req, err := http.NewRequest(method, url, bytes.NewReader(buf))
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
	// 서버의 요청 게이트는 상태를 바꾸는 메서드에 JSON Content-Type 을 요구한다 — DELETE 도
	// 그렇다(reqgate ④). 없으면 415 다.
	req.Header.Set("Content-Type", "application/json")
	return httpDoWithin(req, 0)
}

func httpPostJSON(url string, body any) (status int, respBody []byte, err error) {
	return httpPostJSONWithin(url, body, 0)
}

func httpGet(url string) (status int, respBody []byte, err error) {
	return httpGetWithin(url, 0)
}
