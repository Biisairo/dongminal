package runtimebin

import (
	"bytes"
	"encoding/json"
	"fmt"
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
func baseURL() string {
	return fmt.Sprintf("http://%s:%s",
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

func httpPostJSON(url string, body any) (status int, respBody []byte, err error) {
	buf, err := json.Marshal(body)
	if err != nil {
		return 0, nil, err
	}
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(buf))
	if err != nil {
		return 0, nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := httpClient.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(resp.Body)
	return resp.StatusCode, data, err
}

func httpGet(url string) (status int, respBody []byte, err error) {
	resp, err := httpClient.Get(url)
	if err != nil {
		return 0, nil, err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(resp.Body)
	return resp.StatusCode, data, err
}
