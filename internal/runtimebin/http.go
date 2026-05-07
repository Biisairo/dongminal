package runtimebin

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"time"
)

// defaultPort는 DONGMINAL_PORT 가 비었을 때만 사용되는 안전망이다.
// 정상 경로에서는 server 가 자식 프로세스에 항상 DONGMINAL_PORT 를 주입한다.
const (
	defaultHost = "127.0.0.1"
	defaultPort = "58146"
)

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func baseURL() string {
	return fmt.Sprintf("http://%s:%s",
		envOr("DONGMINAL_HOST", defaultHost),
		envOr("DONGMINAL_PORT", defaultPort),
	)
}

func currentPort() string { return envOr("DONGMINAL_PORT", defaultPort) }

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

func httpPostEmpty(url string) (status int, respBody []byte, err error) {
	req, err := http.NewRequest(http.MethodPost, url, nil)
	if err != nil {
		return 0, nil, err
	}
	resp, err := httpClient.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(resp.Body)
	return resp.StatusCode, data, err
}
