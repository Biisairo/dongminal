package runtimebin

import (
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"dongminal/internal/shared/browser"
)

// BROWSER_TAB_SRS 묶음 A — 터미널에서 서버의 브라우저를 다룬다 (FR-BRT-75·78).
//
// 종료 코드: 0 성공 · 1 동작 실패(엔진 없음·탭 없음·서버 거절) · 2 사용법 오류.
// 대상 탭은 `--tab <uuid>` 다. 없으면 **이 도구가 마지막으로 열거나 다룬 탭**이다 —
// 그 기억은 서버가 든다(도구 id 로).

const browserHelp = `dmctl browser — 서버 기기의 Chrome 을 탭으로 열고 다룬다

사용법:
  dmctl browser open <url|경로> [--profile P] [--isolated] [--split right|down|none] [--focus]
  dmctl browser list [--json]
  dmctl browser close [--tab <uuid>]
  dmctl browser focus [--tab <uuid>]
  dmctl browser goto <url> [--tab <uuid>]
  dmctl browser back | forward [--tab <uuid>]
  dmctl browser reload [--hard] [--tab <uuid>]
  dmctl browser viewport <W>x<H> | auto [--tab <uuid>]
  dmctl browser profile list [--json]

  관찰·조작·대기 (접근성 snapshot 의 ref 로 가리킨다):
  dmctl browser snapshot [--dom] [--json]
  dmctl browser screenshot [--full] [-o 파일]
  dmctl browser url | title
  dmctl browser click <ref> | hover <ref>
  dmctl browser fill <ref> <글> | select <ref> <값> | type <글> | press <키>   (예: Enter, Mod+A)
  dmctl browser scroll up|down|<ref>
  dmctl browser upload <ref> <서버 경로>…
  dmctl browser wait --text T | --ref R | --url GLOB | --load [--timeout 30s]
  dmctl browser eval <js>
  dmctl browser console [--limit N] | network [--limit N] [--json]
  dmctl browser cdp-url [--profile P]      # Playwright·puppeteer 가 붙을 CDP 주소

  대화상자·DevTools·다운로드:
  dmctl browser dialog --accept [--text T] | --dismiss   # 떠 있는 alert·confirm·prompt 에 답한다
  dmctl browser devtools [--panel P]       # 그 탭의 DevTools 를 새 탭으로 연다
  dmctl browser downloads [--json]

  ref 는 페이지가 바뀌면 무효다 — "다시 snapshot" 오류가 나면 snapshot 을 다시 부르세요.
  조작은 요소가 보이고 멈추고 가려지지 않을 때까지 기다린다 (기본 10초, --timeout).

  열 수 있는 주소는 http·https·file·about:blank 다. URL 이 아닌 인자는 이 셸의
  현재 폴더 기준 경로로 읽어 file:// 로 연다. localhost:3000 처럼 스킴 없이 적은
  host:port 는 http 다.

  --tab 이 없으면 이 도구가 마지막으로 열거나 다룬 브라우저 탭이다.
  --split 이 없으면 설정 ▸ 브라우저 ▸ 여는 위치를 따른다.
  --focus 가 없으면 포커스를 옮기지 않는다 (쉘의 open·$BROWSER 는 옮긴다).

  종료 코드: 0 성공 · 1 동작 실패 · 2 사용법 오류
`

func runDmctlBrowser(args []string, stdout, stderr io.Writer) int {
	if len(args) == 0 || args[0] == "-h" || args[0] == "--help" || args[0] == "help" {
		fmt.Fprint(stdout, browserHelp)
		return 0
	}
	sub, rest := args[0], args[1:]
	f, err := parseBrowserFlags(rest)
	if err != nil {
		fmt.Fprintf(stderr, "dmctl browser %s: %v\n", sub, err)
		return 2
	}
	if f.help {
		fmt.Fprint(stdout, browserHelp)
		return 0
	}
	switch sub {
	case "open":
		if len(f.pos) != 1 {
			return browserUsage(stderr, "open 은 주소 하나를 받습니다")
		}
		return browserOpen(f.pos[0], f, stdout, stderr)
	case "list":
		return browserList(f, stdout, stderr)
	case "close", "focus":
		if len(f.pos) != 0 {
			return browserUsage(stderr, sub+" 은 위치 인자를 받지 않습니다 — --tab 을 쓰세요")
		}
		return browserTabCall("/api/browser/"+sub, map[string]any{}, f, stdout, stderr)
	case "goto":
		if len(f.pos) != 1 {
			return browserUsage(stderr, "goto 는 주소 하나를 받습니다")
		}
		u, err := browser.ResolveTarget(f.pos[0], cwdOrEmpty(), statExists)
		if err != nil {
			fmt.Fprintf(stderr, "dmctl browser goto: %v\n", err)
			return 1
		}
		return browserTabCall("/api/browser/nav", map[string]any{"action": "goto", "url": u}, f, stdout, stderr)
	case "back", "forward":
		return browserTabCall("/api/browser/nav", map[string]any{"action": sub}, f, stdout, stderr)
	case "reload":
		return browserTabCall("/api/browser/nav", map[string]any{"action": "reload", "hard": f.hard}, f, stdout, stderr)
	case "viewport":
		if len(f.pos) != 1 {
			return browserUsage(stderr, "viewport 는 <W>x<H> 또는 auto 하나를 받습니다")
		}
		body, ok := parseViewport(f.pos[0])
		if !ok {
			return browserUsage(stderr, "viewport 는 <W>x<H> 또는 auto 입니다 (예: 1280x800)")
		}
		return browserTabCall("/api/browser/viewport", body, f, stdout, stderr)
	case "profile":
		if len(f.pos) != 1 || f.pos[0] != "list" {
			return browserUsage(stderr, "profile list 만 있습니다")
		}
		return browserProfiles(f, stdout, stderr)
	case "cdp-url":
		return browserCDPURL(f, stdout, stderr)
	case "downloads":
		if len(f.pos) != 0 {
			return browserUsage(stderr, "downloads 는 인자를 받지 않습니다")
		}
		return browserDownloads(f, stdout, stderr)
	}
	if code, ok := browserAct(sub, f, stdout, stderr); ok {
		return code
	}
	return browserUsage(stderr, "모르는 명령입니다: "+sub)
}

func browserUsage(stderr io.Writer, msg string) int {
	fmt.Fprintf(stderr, "dmctl browser: %s\n", msg)
	return 2
}

type browserFlags struct {
	pos      []string
	dom      bool
	full     bool
	out      string
	limit    int
	text     string
	ref      string
	url      string
	load     bool
	timeout  time.Duration
	tab      string
	profile  string
	split    string
	isolated bool
	focus    bool
	hard     bool
	json     bool
	help     bool
	accept   bool
	dismiss  bool
	panel    string
}

func parseBrowserFlags(args []string) (browserFlags, error) {
	var f browserFlags
	for i := 0; i < len(args); i++ {
		a := args[i]
		val := func() (string, error) {
			if i+1 >= len(args) {
				return "", fmt.Errorf("%s 에 값이 없습니다", a)
			}
			i++
			return args[i], nil
		}
		var err error
		switch a {
		case "--tab":
			f.tab, err = val()
		case "--profile":
			f.profile, err = val()
		case "--split":
			f.split, err = val()
			if err == nil && f.split != "right" && f.split != "down" && f.split != "none" {
				err = fmt.Errorf("--split 은 right·down·none 중 하나입니다")
			}
		case "--isolated":
			f.isolated = true
		case "--focus":
			f.focus = true
		case "--hard":
			f.hard = true
		case "--accept":
			f.accept = true
		case "--dismiss":
			f.dismiss = true
		case "--panel":
			f.panel, err = val()
		case "--json":
			f.json = true
		case "--dom":
			f.dom = true
		case "--full":
			f.full = true
		case "--load":
			f.load = true
		case "-o", "--out":
			f.out, err = val()
		case "--text":
			f.text, err = val()
		case "--ref":
			f.ref, err = val()
		case "--url":
			f.url, err = val()
		case "--limit":
			var v string
			if v, err = val(); err == nil {
				f.limit, err = strconv.Atoi(v)
				if err != nil || f.limit < 1 {
					err = fmt.Errorf("--limit 은 1 이상의 수입니다")
				}
			}
		case "--timeout":
			var v string
			if v, err = val(); err == nil {
				f.timeout, err = parseTimeout(v)
			}
		case "-h", "--help":
			f.help = true
		default:
			if strings.HasPrefix(a, "--") {
				err = fmt.Errorf("모르는 옵션입니다: %s", a)
			} else {
				f.pos = append(f.pos, a)
			}
		}
		if err != nil {
			return f, err
		}
	}
	return f, nil
}

func parseViewport(s string) (map[string]any, bool) {
	if s == "auto" {
		return map[string]any{"auto": true}, true
	}
	w, h, ok := strings.Cut(s, "x")
	if !ok {
		return nil, false
	}
	wi, e1 := strconv.Atoi(w)
	hi, e2 := strconv.Atoi(h)
	if e1 != nil || e2 != nil || wi < 100 || hi < 100 || wi > 8192 || hi > 8192 {
		return nil, false
	}
	return map[string]any{"w": wi, "h": hi}, true
}

func cwdOrEmpty() string {
	d, _ := os.Getwd()
	return d
}

func statExists(p string) error {
	_, err := os.Stat(p)
	return err
}

// browserOpen 은 `open` 이다. 쉘 훅·`$BROWSER`·`dmctl open-url` 도 이 길을 지난다
// (FR-BRT-70) — 그쪽은 focus 를 켠다 (FR-BRT-34).
func browserOpen(arg string, f browserFlags, stdout, stderr io.Writer) int {
	u, err := browser.ResolveTarget(arg, cwdOrEmpty(), statExists)
	if err != nil {
		fmt.Fprintf(stderr, "dmctl browser open: %v\n", err)
		return 1
	}
	status, body, err := httpPostJSONWithin(baseURL()+"/api/browser/open", map[string]any{
		"url": u, "profile": f.profile, "isolated": f.isolated, "split": f.split, "focus": f.focus,
		"tool": selfToolID()}, browserOpenBudget)
	if code := browserHTTPFail("open", status, body, err, stderr); code != 0 {
		return code
	}
	var r struct {
		Tab string `json:"tab"`
	}
	json.Unmarshal(body, &r)
	if f.json {
		fmt.Fprintf(stdout, "{\"tab\":%q,\"url\":%q}\n", r.Tab, u)
		return 0
	}
	fmt.Fprintf(stdout, "tab=%s url=%s\n", r.Tab, u)
	return 0
}

// browserOpenBudget 은 open 의 상한이다 — 프로필 브라우저를 처음 띄우는 일이 든다.
const browserOpenBudget = 90 * time.Second

func browserTabCall(path string, body map[string]any, f browserFlags, stdout, stderr io.Writer) int {
	body["tab"] = f.tab
	body["tool"] = selfToolID()
	status, resp, err := httpPostJSONWithin(baseURL()+path, body, browserOpenBudget)
	if code := browserHTTPFail(strings.TrimPrefix(path, "/api/browser/"), status, resp, err, stderr); code != 0 {
		return code
	}
	if f.json {
		stdout.Write(resp)
		if len(resp) > 0 && resp[len(resp)-1] != '\n' {
			fmt.Fprintln(stdout)
		}
	}
	return 0
}

// browserHTTPFail 은 서버의 거절을 문구 그대로 stderr 로 옮긴다. 성공이면 0 이다.
func browserHTTPFail(what string, status int, body []byte, err error, stderr io.Writer) int {
	if err != nil {
		fmt.Fprintf(stderr, "dmctl browser %s: 서버에 닿지 못했습니다: %v\n", what, err)
		return 1
	}
	if status == 200 {
		return 0
	}
	fmt.Fprintf(stderr, "dmctl browser %s: %s\n", what, strings.TrimSpace(string(body)))
	if status == 400 {
		return 2
	}
	return 1
}

func browserList(f browserFlags, stdout, stderr io.Writer) int {
	status, body, err := httpGet(baseURL() + "/api/browser/tabs")
	if code := browserHTTPFail("list", status, body, err, stderr); code != 0 {
		return code
	}
	if f.json {
		stdout.Write(body)
		fmt.Fprintln(stdout)
		return 0
	}
	var r struct {
		Tabs []browser.TabInfo `json:"tabs"`
	}
	json.Unmarshal(body, &r)
	for _, t := range r.Tabs {
		mark := ""
		if t.Isolated {
			mark = " isolated"
		}
		if !t.Live {
			mark += " asleep"
		}
		fmt.Fprintf(stdout, "tab=%s profile=%s%s title=%q url=%s\n", t.Tab, t.Profile, mark, t.Title, t.URL)
	}
	return 0
}

func browserProfiles(f browserFlags, stdout, stderr io.Writer) int {
	status, body, err := httpGet(baseURL() + "/api/browser/profiles")
	if code := browserHTTPFail("profile list", status, body, err, stderr); code != 0 {
		return code
	}
	if f.json {
		stdout.Write(body)
		fmt.Fprintln(stdout)
		return 0
	}
	var r struct {
		Profiles []browser.Profile `json:"profiles"`
	}
	json.Unmarshal(body, &r)
	for _, p := range r.Profiles {
		state := "stopped"
		if p.Running {
			state = "running"
		}
		fmt.Fprintf(stdout, "%s %s tabs=%d\n", p.Name, state, p.Tabs)
	}
	return 0
}

// parseTimeout 은 `30s`·`1m` 같은 Go 기간 또는 밀리초 수다.
func parseTimeout(v string) (time.Duration, error) {
	if n, err := strconv.Atoi(v); err == nil && n > 0 {
		return time.Duration(n) * time.Millisecond, nil
	}
	d, err := time.ParseDuration(v)
	if err != nil || d <= 0 {
		return 0, fmt.Errorf("--timeout 은 30s·1m 같은 기간입니다")
	}
	return d, nil
}

// browserAct 는 2단계 명령이다 — `/api/browser/act` 한 곳을 지난다.
func browserAct(sub string, f browserFlags, stdout, stderr io.Writer) (int, bool) {
	body := map[string]any{"op": sub}
	need := func(n int, what string) bool {
		if len(f.pos) != n {
			browserUsage(stderr, sub+" 은 "+what+" 를 받습니다")
			return false
		}
		return true
	}
	switch sub {
	case "snapshot":
		body["dom"] = f.dom
	case "screenshot":
		body["full"] = f.full
	case "url", "title":
		body["op"] = "state"
	case "click", "hover":
		if !need(1, "ref 하나") {
			return 2, true
		}
		body["ref"] = f.pos[0]
	case "fill", "select":
		if !need(2, "ref 와 값") {
			return 2, true
		}
		body["ref"] = f.pos[0]
		if sub == "fill" {
			body["text"] = f.pos[1]
		} else {
			body["value"] = f.pos[1]
		}
	case "type":
		if !need(1, "글 하나") {
			return 2, true
		}
		body["text"] = f.pos[0]
	case "press":
		if !need(1, "키 하나") {
			return 2, true
		}
		body["key"] = f.pos[0]
	case "scroll":
		if !need(1, "up·down·ref 하나") {
			return 2, true
		}
		body["ref"] = f.pos[0]
	case "upload":
		if len(f.pos) < 2 {
			return browserUsage(stderr, "upload 는 ref 와 서버 경로를 받습니다"), true
		}
		body["ref"] = f.pos[0]
		var files []string
		for _, p := range f.pos[1:] {
			abs, err := filepath.Abs(p)
			if err != nil || statExists(abs) != nil {
				fmt.Fprintf(stderr, "dmctl browser upload: 없는 파일입니다: %s\n", p)
				return 1, true
			}
			files = append(files, abs)
		}
		body["files"] = files
	case "wait":
		if f.text == "" && f.ref == "" && f.url == "" && !f.load {
			return browserUsage(stderr, "wait 는 --text·--ref·--url·--load 중 하나 이상을 받습니다"), true
		}
		body["text"], body["ref"], body["url"], body["load"] = f.text, f.ref, f.url, f.load
		if f.timeout == 0 {
			f.timeout = 30 * time.Second
		}
	case "eval":
		if !need(1, "식 하나") {
			return 2, true
		}
		body["expr"] = f.pos[0]
	case "console", "network":
		body["limit"] = f.limit
	case "dialog":
		if f.accept == f.dismiss || len(f.pos) != 0 {
			return browserUsage(stderr, "dialog 는 --accept 또는 --dismiss 하나를 받습니다"), true
		}
		body["accept"], body["text"] = f.accept, f.text
	case "devtools":
		if len(f.pos) != 0 {
			return browserUsage(stderr, "devtools 는 위치 인자를 받지 않습니다 — --panel 을 쓰세요"), true
		}
		body["panel"] = f.panel
	default:
		return 0, false
	}
	if f.timeout > 0 {
		body["timeoutMs"] = f.timeout.Milliseconds()
	}
	body["tab"] = f.tab
	body["tool"] = selfToolID()
	budget := browserOpenBudget
	if f.timeout+10*time.Second > budget {
		budget = f.timeout + 10*time.Second
	}
	status, resp, err := httpPostJSONWithin(baseURL()+"/api/browser/act", body, budget)
	if code := browserHTTPFail(sub, status, resp, err, stderr); code != 0 {
		return code, true
	}
	return browserActOutput(sub, f, resp, stdout, stderr), true
}

// browserActOutput 은 사람이 읽는 출력이다 (FR-BRT-78). `--json` 은 서버의 답 그대로다.
func browserActOutput(sub string, f browserFlags, resp []byte, stdout, stderr io.Writer) int {
	if f.json && sub != "screenshot" {
		stdout.Write(resp)
		fmt.Fprintln(stdout)
		return 0
	}
	switch sub {
	case "snapshot":
		var r struct {
			Snapshot string `json:"snapshot"`
		}
		json.Unmarshal(resp, &r)
		fmt.Fprintln(stdout, r.Snapshot)
	case "url", "title":
		var r struct {
			URL   string `json:"url"`
			Title string `json:"title"`
		}
		json.Unmarshal(resp, &r)
		if sub == "url" {
			fmt.Fprintln(stdout, r.URL)
		} else {
			fmt.Fprintln(stdout, r.Title)
		}
	case "eval":
		var r struct {
			Value json.RawMessage `json:"value"`
		}
		json.Unmarshal(resp, &r)
		fmt.Fprintln(stdout, string(r.Value))
	case "screenshot":
		var r struct {
			PNG []byte `json:"png"`
		}
		json.Unmarshal(resp, &r)
		out := f.out
		if out == "" {
			out = "screenshot-" + time.Now().Format("20060102-150405") + ".png"
		}
		abs, _ := filepath.Abs(out)
		if err := os.WriteFile(abs, r.PNG, 0o644); err != nil {
			fmt.Fprintf(stderr, "dmctl browser screenshot: %v\n", err)
			return 1
		}
		if f.json {
			fmt.Fprintf(stdout, "{\"path\":%q}\n", abs)
		} else {
			fmt.Fprintln(stdout, abs)
		}
	case "console", "network":
		var r struct {
			Items []map[string]any `json:"items"`
		}
		json.Unmarshal(resp, &r)
		for _, it := range r.Items {
			if sub == "console" {
				fmt.Fprintf(stdout, "[%v] %v\n", it["type"], it["text"])
				continue
			}
			st := fmt.Sprint(it["status"])
			if it["failed"] != nil {
				st = "failed(" + fmt.Sprint(it["failed"]) + ")"
			} else if it["status"] == nil {
				st = "-"
			}
			fmt.Fprintf(stdout, "%s %v %v\n", st, it["method"], it["url"])
		}
	}
	return 0
}

func browserCDPURL(f browserFlags, stdout, stderr io.Writer) int {
	q := "?tool=" + url.QueryEscape(selfToolID())
	if f.profile != "" {
		q += "&profile=" + url.QueryEscape(f.profile)
	}
	status, body, err := httpGet(baseURL() + "/api/browser/cdpurl" + q)
	if code := browserHTTPFail("cdp-url", status, body, err, stderr); code != 0 {
		return code
	}
	if f.json {
		stdout.Write(body)
		fmt.Fprintln(stdout)
		return 0
	}
	var r struct {
		WS string `json:"ws"`
	}
	json.Unmarshal(body, &r)
	fmt.Fprintln(stdout, r.WS)
	return 0
}

func browserDownloads(f browserFlags, stdout, stderr io.Writer) int {
	status, body, err := httpGet(baseURL() + "/api/browser/downloads")
	if code := browserHTTPFail("downloads", status, body, err, stderr); code != 0 {
		return code
	}
	if f.json {
		stdout.Write(body)
		fmt.Fprintln(stdout)
		return 0
	}
	var r struct {
		Downloads []browser.Download `json:"downloads"`
	}
	json.Unmarshal(body, &r)
	for _, d := range r.Downloads {
		where := d.Path
		if where == "" {
			where = d.Name
		}
		fmt.Fprintf(stdout, "%s %d/%d %s\n", d.State, d.Received, d.Total, where)
	}
	return 0
}
