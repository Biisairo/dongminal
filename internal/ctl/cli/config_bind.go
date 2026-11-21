package cli

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"strconv"
	"time"

	"dongminal/internal/shared/apipath"
	"dongminal/internal/shared/dmenv"
	"dongminal/internal/shared/serverconf"
)

// `dongminal config set|get` — 바인드를 바꾸고 보는 CLI (HOT_REBIND_SRS FR-HRB-41·42·43).
//
// 서버가 돌고 있으면 리바인드 API 를 부르고, 돌고 있지 않으면 `server.json` 만 고친다.
// 두 길이 같은 파일에 닿는다 (D-HRB-2·3).

const (
	bindPortMin = 1024
	bindPortMax = 65535
	// bindCallTimeout 은 리바인드 요청 하나의 상한이다. 서버 쪽 목표는 1초다 (NFR-HRB-1).
	bindCallTimeout = 5 * time.Second
)

// bindErrText 는 리바인드 API 의 오류 코드를 사람 말로 옮긴다 (FR-HRB-43).
var bindErrText = map[string]string{
	"bind_port_invalid":  "포트는 1024~65535 사이여야 합니다",
	"bind_port_in_use":   "그 포트를 다른 프로세스가 쓰고 있습니다 — 바인드는 그대로입니다",
	"bind_rebind_failed": "새 호스트로 다시 리슨하지 못해 옛 호스트로 돌아갔습니다",
	"bind_busy":          "다른 바인드 변경이 진행 중입니다 — 잠시 뒤 다시 하세요",
	"bind_local_only":    "바인드는 서버가 도는 컴퓨터에서만 바꿀 수 있습니다",
	"bind_unavailable":   "이 서버는 실행 중에 바인드를 바꿀 수 없습니다 — server.json 을 고친 뒤 다시 띄우세요",
	"save_failed":        "server.json 이나 주소 파일을 쓰지 못했습니다 — 바인드는 그대로입니다",
}

// checkConfigSet 은 `set` 의 키와 값을 본다.
func checkConfigSet(key, value string) error {
	switch key {
	case "port":
		if n, err := strconv.Atoi(value); err != nil || n < bindPortMin || n > bindPortMax {
			return fmt.Errorf("config set port: %d~%d 사이의 숫자여야 합니다: %q", bindPortMin, bindPortMax, value)
		}
	case "expose":
		if value != "on" && value != "off" {
			return fmt.Errorf("config set expose: on 또는 off 여야 합니다: %q", value)
		}
	case "":
		return fmt.Errorf("config set: 키가 필요합니다 (port|expose)")
	default:
		return fmt.Errorf("config set: 알 수 없는 키 %q (port|expose)", key)
	}
	return nil
}

// runningServer 는 주소 파일이 가리키고 실제로 답하는 서버의 URL 이다.
func runningServer(home string) (string, bool) {
	h, p, ok := serverconf.ReadAddr(home)
	if !ok {
		return "", false
	}
	u := dmenv.BaseURL(h, p)
	return u, ping(u+apipath.Ping, aliveProbeTimeout)
}

func runConfigSet(home, key, value string, stdout, stderr io.Writer) int {
	body := map[string]any{}
	host, port := "", ""
	if key == "port" {
		n, _ := strconv.Atoi(value)
		body["port"] = n
		port = value
	} else {
		on := value == "on"
		body["expose"] = on
		host = DefaultHost
		if on {
			host = ExposeHost
		}
	}
	if url, ok := runningServer(home); ok {
		return callBind(url, body, stdout, stderr)
	}
	if err := serverconf.SetBind(home, host, port); err != nil {
		fmt.Fprintf(stderr, "%s 를 쓰지 못했습니다: %v\n", serverconf.FileName, err)
		return 1
	}
	fmt.Fprintf(stdout, "서버가 돌고 있지 않아 %s 만 고쳤습니다 — 다음 기동부터 씁니다\n", serverconf.FileName)
	if host == ExposeHost {
		fmt.Fprintln(stderr, "⚠ 인증이 없습니다 — 같은 망의 누구나 셸을 얻습니다. Settings ▸ Access 에서 허용 목록을 켜세요")
	}
	return 0
}

// callBind 는 `POST /api/server/bind` 를 부른다.
func callBind(url string, body map[string]any, stdout, stderr io.Writer) int {
	raw, err := json.Marshal(body)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	c := &http.Client{Timeout: bindCallTimeout}
	resp, err := c.Post(url+apipath.ServerBind, "application/json", bytes.NewReader(raw))
	if err != nil {
		fmt.Fprintf(stderr, "서버에 닿지 못했습니다: %v\n", err)
		return 1
	}
	defer resp.Body.Close()
	var out struct {
		Host    string `json:"host"`
		Port    string `json:"port"`
		Expose  bool   `json:"expose"`
		URL     string `json:"url"`
		Warning string `json:"warning"`
		Code    string `json:"code"`
		Message string `json:"message"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&out)
	if resp.StatusCode != http.StatusOK {
		msg, ok := bindErrText[out.Code]
		if !ok {
			msg = fmt.Sprintf("%s (%d)", out.Message, resp.StatusCode)
		}
		fmt.Fprintf(stderr, "❌ %s\n", msg)
		return 1
	}
	fmt.Fprintf(stdout, "✅ 바인드 %s (%s) — %s\n", net.JoinHostPort(out.Host, out.Port), exposeWord(out.Expose), out.URL)
	if out.Warning != "" {
		fmt.Fprintf(stderr, "⚠ %s\n", out.Warning)
	}
	return 0
}

func exposeWord(on bool) string {
	if on {
		return "expose 켜짐"
	}
	return "expose 꺼짐"
}

// runConfigGet 은 지금 바인드와 server.json 의 값을 함께 보인다 (FR-HRB-42).
func runConfigGet(home string, stdout io.Writer) int {
	if h, p, ok := serverconf.ReadAddr(home); ok && ping(dmenv.BaseURL(h, p)+apipath.Ping, aliveProbeTimeout) {
		fmt.Fprintf(stdout, "지금 바인드: %s (%s)\n", net.JoinHostPort(h, p), exposeWord(dmenv.IsExposedHost(h)))
	} else {
		fmt.Fprintln(stdout, "지금 바인드: 서버가 돌고 있지 않습니다")
	}
	conf := serverconf.Resolve(serverconf.Inputs{Home: home})
	fmt.Fprintf(stdout, "%s: host %s (%s) · port %s (%s)\n", serverconf.FileName,
		conf.Host.Value, conf.Host.Source, conf.Port.Value, conf.Port.Source)
	for _, w := range conf.Warnings {
		fmt.Fprintf(stdout, "⚠ %s\n", w)
	}
	return 0
}
