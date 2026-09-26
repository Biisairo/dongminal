package browser

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// 터미널 제어 `dmctl browser` 의 관찰·조작·대기 (BROWSER_TAB_SRS 묶음 A 2단계, FR-BRT-76·77).
//
// **방식은 Playwright 의 것이다** (D-BRT-12) — 신뢰 입력(`Input.*`) · 접근성 snapshot 의 ref ·
// actionability 대기. 라이브러리는 쓰지 않는다. 조작은 pipe 가 있는 이 자리(매니저)에서
// 돈다 — 요청 하나가 CDP 왕복 수십 번이라 데몬 IPC 를 건너 다니면 느리다.

// ErrStaleRef 는 ref 가 이동·문서 교체로 무효가 됐다는 뜻이다 (FR-BRT-77).
var ErrStaleRef = errors.New("ref 가 낡았습니다 — 페이지가 바뀌었습니다. 다시 snapshot 하세요")

// DefaultActTimeout 은 조작 하나가 actionability 를 기다리는 상한이다 (FR-BRT-76).
const DefaultActTimeout = 10 * time.Second

// ref 는 snapshot 이 준 번호 하나 — 그 요소의 backendNodeId 와 그것이 사는 세션이다.
type ref struct {
	session string
	backend int
	// frameOwner 는 교차 출처 iframe 안의 요소일 때 그 <iframe> 요소(부모 세션)다.
	frameOwner *ref
}

// logRing 은 최근 N 개만 드는 기록이다 (console·network).
type logRing struct {
	max   int
	items []json.RawMessage
}

func (r *logRing) add(v any) {
	b, _ := json.Marshal(v)
	r.items = append(r.items, b)
	if len(r.items) > r.max {
		r.items = r.items[len(r.items)-r.max:]
	}
}

func (r *logRing) last(n int) []json.RawMessage {
	if n <= 0 || n > len(r.items) {
		n = len(r.items)
	}
	return append([]json.RawMessage(nil), r.items[len(r.items)-n:]...)
}

// actState 는 페이지 하나의 2단계 상태다. pg.mu 아래.
type actState struct {
	refs    map[string]ref
	gen     int // 최상위 문서가 바뀔 때마다 는다 — ref 는 그 세대에만 유효하다
	refGen  int
	console logRing
	network logRing
	netIdx  map[string]int // requestId → network.items 의 자리
}

func (pg *page) act() *actState {
	if pg.acts == nil {
		pg.acts = &actState{refs: map[string]ref{}, console: logRing{max: 500}, network: logRing{max: 500}, netIdx: map[string]int{}}
	}
	return pg.acts
}

// onDocumentReplaced 는 최상위 문서가 바뀌었다 — ref 가 무효가 된다.
func (pg *page) onDocumentReplaced() {
	pg.mu.Lock()
	a := pg.act()
	a.gen++
	pg.mu.Unlock()
}

// ── console · network (FR-BRT-75 2단계) ─────────────────────────

func (pg *page) onLogEvent(method string, params json.RawMessage) {
	pg.mu.Lock()
	defer pg.mu.Unlock()
	a := pg.act()
	switch method {
	case "Runtime.consoleAPICalled":
		var p struct {
			Type string `json:"type"`
			Args []struct {
				Type        string          `json:"type"`
				Value       json.RawMessage `json:"value"`
				Description string          `json:"description"`
			} `json:"args"`
		}
		json.Unmarshal(params, &p)
		parts := make([]string, 0, len(p.Args))
		for _, x := range p.Args {
			var s string
			if json.Unmarshal(x.Value, &s) == nil {
				parts = append(parts, s)
			} else if len(x.Value) > 0 {
				parts = append(parts, string(x.Value))
			} else {
				parts = append(parts, x.Description)
			}
		}
		a.console.add(map[string]any{"type": p.Type, "text": strings.Join(parts, " "), "at": time.Now().UnixMilli()})
	case "Runtime.exceptionThrown":
		var p struct {
			ExceptionDetails struct {
				Text      string `json:"text"`
				Exception struct {
					Description string `json:"description"`
				} `json:"exception"`
			} `json:"exceptionDetails"`
		}
		json.Unmarshal(params, &p)
		t := p.ExceptionDetails.Exception.Description
		if t == "" {
			t = p.ExceptionDetails.Text
		}
		a.console.add(map[string]any{"type": "exception", "text": t, "at": time.Now().UnixMilli()})
	case "Network.requestWillBeSent":
		var p struct {
			RequestID string `json:"requestId"`
			Type      string `json:"type"`
			Request   struct {
				Method string `json:"method"`
				URL    string `json:"url"`
			} `json:"request"`
		}
		json.Unmarshal(params, &p)
		a.network.add(map[string]any{"id": p.RequestID, "method": p.Request.Method, "url": p.Request.URL, "type": p.Type})
		a.netIdx[p.RequestID] = len(a.network.items) - 1
	case "Network.responseReceived", "Network.loadingFailed":
		var p struct {
			RequestID string `json:"requestId"`
			ErrorText string `json:"errorText"`
			Response  struct {
				Status int `json:"status"`
			} `json:"response"`
		}
		json.Unmarshal(params, &p)
		i, ok := a.netIdx[p.RequestID]
		if !ok || i >= len(a.network.items) {
			return
		}
		var e map[string]any
		json.Unmarshal(a.network.items[i], &e)
		if e == nil || e["id"] != p.RequestID {
			return
		}
		if method == "Network.loadingFailed" {
			e["failed"] = p.ErrorText
		} else {
			e["status"] = p.Response.Status
		}
		a.network.items[i], _ = json.Marshal(e)
	}
}

// ── snapshot (FR-BRT-77) ────────────────────────────────────────

type axNode struct {
	NodeID           string `json:"nodeId"`
	Ignored          bool   `json:"ignored"`
	Role             axVal  `json:"role"`
	Name             axVal  `json:"name"`
	Value            axVal  `json:"value"`
	ChildIDs         []string
	RawChildIDs      []string `json:"childIds"`
	BackendDOMNodeID int      `json:"backendDOMNodeId"`
	Properties       []struct {
		Name  string `json:"name"`
		Value axVal  `json:"value"`
	} `json:"properties"`
}

type axVal struct {
	Value json.RawMessage `json:"value"`
}

func (v axVal) str() string {
	var s string
	if json.Unmarshal(v.Value, &s) == nil {
		return s
	}
	if len(v.Value) == 0 || string(v.Value) == "null" {
		return ""
	}
	return string(v.Value)
}

// snapshotLines 는 접근성 트리 하나를 들여쓴 목록으로 옮기고 ref 를 매긴다.
// 모양은 Playwright MCP 와 같다 — `- <role> "<name>" [ref=eN] [상태…]`.
func snapshotLines(nodes []axNode, session string, owner *ref, next *int, refs map[string]ref, depth0 int) []string {
	byID := make(map[string]*axNode, len(nodes))
	var root *axNode
	for i := range nodes {
		n := &nodes[i]
		byID[n.NodeID] = n
		if root == nil {
			root = n
		}
	}
	var out []string
	var walk func(n *axNode, depth int)
	walk = func(n *axNode, depth int) {
		role := n.Role.str()
		skip := n.Ignored || role == "InlineTextBox" || role == "none" || (role == "generic" && n.Name.str() == "")
		if !skip {
			line := strings.Repeat("  ", depth) + "- " + roleName(role)
			if name := strings.TrimSpace(n.Name.str()); name != "" {
				if len(name) > 200 {
					name = name[:200] + "…"
				}
				line += " " + strconv.Quote(name)
			}
			if n.BackendDOMNodeID != 0 && role != "StaticText" && role != "RootWebArea" {
				*next++
				id := "e" + strconv.Itoa(*next)
				refs[id] = ref{session: session, backend: n.BackendDOMNodeID, frameOwner: owner}
				line += " [ref=" + id + "]"
			}
			for _, p := range n.Properties {
				switch p.Name {
				case "focused", "checked", "disabled", "expanded", "selected", "required", "pressed":
					v := p.Value.str()
					if v == "true" {
						line += " [" + p.Name + "]"
					} else if v == "mixed" {
						line += " [" + p.Name + "=mixed]"
					}
				case "level":
					line += " [level=" + p.Value.str() + "]"
				}
			}
			if v := n.Value.str(); v != "" && role != "StaticText" {
				line += ": " + strconv.Quote(v)
			}
			out = append(out, line)
			depth++
		}
		for _, c := range n.RawChildIDs {
			if cn := byID[c]; cn != nil {
				walk(cn, depth)
			}
		}
	}
	if root != nil {
		walk(root, depth0)
	}
	return out
}

func roleName(r string) string {
	switch r {
	case "RootWebArea":
		return "document"
	case "StaticText":
		return "text"
	}
	return r
}

// snapshot 은 접근성 트리를 낸다. 교차 출처 iframe 의 트리는 그 아래에 이어 붙인다.
func (pg *page) snapshot(ctx context.Context) (string, error) {
	refs := map[string]ref{}
	next := 0
	lines, err := pg.axLines(ctx, pg.session, nil, &next, refs, 0)
	if err != nil {
		return "", err
	}
	for _, f := range pg.b.framesOf(pg) {
		ownerBackend, err := pg.frameOwner(ctx, f)
		if err != nil {
			continue
		}
		owner := &ref{session: f.parentSession, backend: ownerBackend}
		sub, err := pg.axLines(ctx, f.session, owner, &next, refs, 1)
		if err != nil {
			continue
		}
		lines = append(lines, "- iframe "+strconv.Quote(f.url))
		lines = append(lines, sub...)
	}
	pg.mu.Lock()
	a := pg.act()
	a.refs = refs
	a.refGen = a.gen
	pg.mu.Unlock()
	return strings.Join(lines, "\n"), nil
}

func (pg *page) axLines(ctx context.Context, session string, owner *ref, next *int, refs map[string]ref, depth int) ([]string, error) {
	res, err := pg.b.cl.Call(ctx, session, "Accessibility.getFullAXTree", nil)
	if err != nil {
		return nil, err
	}
	var t struct {
		Nodes []axNode `json:"nodes"`
	}
	json.Unmarshal(res, &t)
	return snapshotLines(t.Nodes, session, owner, next, refs, depth), nil
}

// domSnapshotScript 는 `--dom` 이 격리 world 에서 도는 판정이다. 상호작용 후보의 판정은
// browser-use `buildDomTree.js` 의 것을 따른다 (MIT, https://github.com/browser-use/browser-use) —
// 태그·역할·onclick·cursor:pointer·contenteditable·tabindex, 보이는 것만.
const domSnapshotScript = `(() => {
  const out = [];
  const tags = new Set(['A','BUTTON','INPUT','SELECT','TEXTAREA','SUMMARY','DETAILS','LABEL','OPTION']);
  const roles = new Set(['button','link','checkbox','radio','tab','menuitem','option','switch','textbox','combobox','slider']);
  const vis = (el) => { const r = el.getBoundingClientRect(); if (r.width < 1 || r.height < 1) return false;
    const s = getComputedStyle(el); return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0'; };
  const interactive = (el) => tags.has(el.tagName) || roles.has(el.getAttribute('role') || '') ||
    el.hasAttribute('onclick') || el.isContentEditable || (el.tabIndex >= 0 && el.hasAttribute('tabindex')) ||
    getComputedStyle(el).cursor === 'pointer' && !(el.parentElement && getComputedStyle(el.parentElement).cursor === 'pointer');
  for (const el of document.querySelectorAll('*')) {
    if (out.length >= 500) break;
    if (!interactive(el) || !vis(el)) continue;
    out.push(el);
  }
  const d = document.scrollingElement || document.documentElement;
  return { els: out, above: Math.round(d.scrollTop), below: Math.max(0, Math.round(d.scrollHeight - d.scrollTop - innerHeight)) };
})()`

// domSnapshot 은 `--dom` 이다 — 접근성 정보가 없는 `onclick`·`cursor:pointer` 도 잡는다.
func (pg *page) domSnapshot(ctx context.Context) (string, error) {
	ctxID, err := pg.isolatedContext(ctx)
	if err != nil {
		return "", err
	}
	res, err := pg.call(ctx, "Runtime.evaluate", map[string]any{"expression": domSnapshotScript, "contextId": ctxID})
	if err != nil {
		return "", err
	}
	var ev struct {
		Result struct {
			ObjectID string `json:"objectId"`
		} `json:"result"`
	}
	json.Unmarshal(res, &ev)
	props, err := pg.call(ctx, "Runtime.getProperties", map[string]any{"objectId": ev.Result.ObjectID, "ownProperties": true})
	if err != nil {
		return "", err
	}
	var pp struct {
		Result []struct {
			Name  string `json:"name"`
			Value struct {
				ObjectID string          `json:"objectId"`
				Value    json.RawMessage `json:"value"`
			} `json:"value"`
		} `json:"result"`
	}
	json.Unmarshal(props, &pp)
	var elsID string
	var above, below json.RawMessage
	for _, p := range pp.Result {
		switch p.Name {
		case "els":
			elsID = p.Value.ObjectID
		case "above":
			above = p.Value.Value
		case "below":
			below = p.Value.Value
		}
	}
	lines := []string{fmt.Sprintf("# scroll: above=%spx below=%spx", above, below)}
	refs := map[string]ref{}
	if elsID != "" {
		items, err := pg.call(ctx, "Runtime.getProperties", map[string]any{"objectId": elsID, "ownProperties": true})
		if err == nil {
			var ip struct {
				Result []struct {
					Name  string `json:"name"`
					Value struct {
						ObjectID string `json:"objectId"`
					} `json:"value"`
				} `json:"result"`
			}
			json.Unmarshal(items, &ip)
			n := 0
			for _, it := range ip.Result {
				if _, err := strconv.Atoi(it.Name); err != nil || it.Value.ObjectID == "" {
					continue
				}
				d, err := pg.call(ctx, "DOM.describeNode", map[string]any{"objectId": it.Value.ObjectID})
				if err != nil {
					continue
				}
				var dn struct {
					Node struct {
						BackendNodeID int      `json:"backendNodeId"`
						NodeName      string   `json:"nodeName"`
						Attributes    []string `json:"attributes"`
					} `json:"node"`
				}
				json.Unmarshal(d, &dn)
				txt, _ := pg.call(ctx, "Runtime.callFunctionOn", map[string]any{"objectId": it.Value.ObjectID,
					"functionDeclaration": `function(){return (this.innerText||this.value||this.getAttribute('aria-label')||this.getAttribute('placeholder')||this.title||'').trim().slice(0,120)}`,
					"returnByValue":       true})
				var tv struct {
					Result struct {
						Value string `json:"value"`
					} `json:"result"`
				}
				json.Unmarshal(txt, &tv)
				n++
				id := "e" + strconv.Itoa(n)
				refs[id] = ref{session: pg.session, backend: dn.Node.BackendNodeID}
				line := fmt.Sprintf("[%s] <%s", id, strings.ToLower(dn.Node.NodeName))
				for i := 0; i+1 < len(dn.Node.Attributes); i += 2 {
					switch dn.Node.Attributes[i] {
					case "type", "role", "name", "href", "aria-label", "placeholder":
						line += fmt.Sprintf(" %s=%q", dn.Node.Attributes[i], dn.Node.Attributes[i+1])
					}
				}
				line += ">"
				if tv.Result.Value != "" {
					line += " " + strconv.Quote(tv.Result.Value)
				}
				lines = append(lines, line)
			}
		}
	}
	pg.mu.Lock()
	a := pg.act()
	a.refs = refs
	a.refGen = a.gen
	pg.mu.Unlock()
	return strings.Join(lines, "\n"), nil
}

// isolatedContext 는 이 페이지의 격리 world 실행 컨텍스트다. 없으면 만든다.
func (pg *page) isolatedContext(ctx context.Context) (int, error) {
	res, err := pg.call(ctx, "Page.createIsolatedWorld", map[string]any{"frameId": pg.target, "worldName": isolatedWorld + "-act"})
	if err != nil {
		return 0, err
	}
	var r struct {
		ExecutionContextID int `json:"executionContextId"`
	}
	json.Unmarshal(res, &r)
	return r.ExecutionContextID, nil
}

// ── ref 풀기 · actionability (FR-BRT-76) ────────────────────────

func (pg *page) lookupRef(id string) (ref, error) {
	pg.mu.Lock()
	defer pg.mu.Unlock()
	a := pg.act()
	r, ok := a.refs[strings.TrimPrefix(id, "ref=")]
	if !ok {
		return ref{}, errors.New("그런 ref 가 없습니다: " + id + " — snapshot 이 준 ref 를 쓰세요")
	}
	if a.refGen != a.gen {
		return ref{}, ErrStaleRef
	}
	return r, nil
}

func (pg *page) resolve(ctx context.Context, r ref) (string, error) {
	res, err := pg.b.cl.Call(ctx, r.session, "DOM.resolveNode", map[string]any{"backendNodeId": r.backend})
	if err != nil {
		return "", ErrStaleRef
	}
	var o struct {
		Object struct {
			ObjectID string `json:"objectId"`
		} `json:"object"`
	}
	json.Unmarshal(res, &o)
	if o.Object.ObjectID == "" {
		return "", ErrStaleRef
	}
	return o.Object.ObjectID, nil
}

// center 는 그 요소의 보이는 사각형 중심이다 — 최상위 페이지 좌표로.
func (pg *page) center(ctx context.Context, r ref) (x, y, w, h float64, err error) {
	res, err := pg.b.cl.Call(ctx, r.session, "DOM.getContentQuads", map[string]any{"backendNodeId": r.backend})
	if err != nil {
		return 0, 0, 0, 0, err
	}
	var q struct {
		Quads [][]float64 `json:"quads"`
	}
	json.Unmarshal(res, &q)
	if len(q.Quads) == 0 || len(q.Quads[0]) < 8 {
		return 0, 0, 0, 0, errors.New("보이지 않음")
	}
	p := q.Quads[0]
	minX, maxX, minY, maxY := math.Inf(1), math.Inf(-1), math.Inf(1), math.Inf(-1)
	for i := 0; i < 8; i += 2 {
		minX, maxX = math.Min(minX, p[i]), math.Max(maxX, p[i])
		minY, maxY = math.Min(minY, p[i+1]), math.Max(maxY, p[i+1])
	}
	x, y, w, h = (minX+maxX)/2, (minY+maxY)/2, maxX-minX, maxY-minY
	if r.frameOwner != nil {
		ox, oy, ow, oh, err := pg.center(ctx, *r.frameOwner)
		if err != nil {
			return 0, 0, 0, 0, err
		}
		x += ox - ow/2
		y += oy - oh/2
	}
	return x, y, w, h, nil
}

const checkFn = `function(){
  if (!this.isConnected) return 'detached';
  const r = this.getBoundingClientRect(); const s = getComputedStyle(this);
  if (r.width < 1 || r.height < 1 || s.visibility === 'hidden' || s.display === 'none') return 'hidden';
  if (this.disabled || this.getAttribute('aria-disabled') === 'true') return 'disabled';
  return 'ok'; }`

var actReason = map[string]string{
	"detached": "문서에 붙어 있지 않음", "hidden": "보이지 않음", "disabled": "비활성",
	"moving": "움직이는 중", "covered": "다른 요소가 가림",
}

// actionPoint 는 조작할 좌표다 — 붙어 있음·보임·(enabled 면) 활성·위치 안정·hit-test 를
// 제한 시간 안에 기다린다. 넘으면 마지막 이유를 담아 실패한다.
func (pg *page) actionPoint(ctx context.Context, r ref, enabled bool) (x, y, w, h float64, err error) {
	deadline, ok := ctx.Deadline()
	if !ok {
		deadline = time.Now().Add(DefaultActTimeout)
	}
	last := ""
	var px, py float64
	stable := 0
	for time.Now().Before(deadline) {
		obj, err := pg.resolve(ctx, r)
		if err != nil {
			return 0, 0, 0, 0, err
		}
		st := callString(ctx, pg, r.session, obj, checkFn)
		if st == "disabled" && !enabled {
			st = "ok"
		}
		if st != "ok" {
			last = st
			sleepCtx(ctx, 100*time.Millisecond)
			continue
		}
		pg.b.cl.Call(ctx, r.session, "DOM.scrollIntoViewIfNeeded", map[string]any{"backendNodeId": r.backend})
		cx, cy, cw, ch, err := pg.center(ctx, r)
		if err != nil {
			last = "hidden"
			sleepCtx(ctx, 100*time.Millisecond)
			continue
		}
		if math.Abs(cx-px) > 0.5 || math.Abs(cy-py) > 0.5 {
			px, py, stable = cx, cy, 0
			last = "moving"
			sleepCtx(ctx, 50*time.Millisecond)
			continue
		}
		stable++
		if !pg.hits(ctx, r, obj, cx, cy) {
			last = "covered"
			sleepCtx(ctx, 100*time.Millisecond)
			continue
		}
		return cx, cy, cw, ch, nil
	}
	why := actReason[last]
	if why == "" {
		why = "응답 없음"
	}
	return 0, 0, 0, 0, fmt.Errorf("조작할 수 없습니다 (%s) — 제한 시간을 넘었습니다", why)
}

// hits 는 그 좌표를 누르면 그 요소(또는 자손)에 닿는가다.
func (pg *page) hits(ctx context.Context, r ref, obj string, x, y float64) bool {
	res, err := pg.call(ctx, "DOM.getNodeForLocation", map[string]any{"x": int(x), "y": int(y), "includeUserAgentShadowDOM": true})
	if err != nil {
		return false
	}
	var n struct {
		BackendNodeID int `json:"backendNodeId"`
	}
	json.Unmarshal(res, &n)
	if r.frameOwner != nil {
		// iframe 안의 요소는 부모에서 보면 그 <iframe> 이다.
		return n.BackendNodeID == r.frameOwner.backend
	}
	if n.BackendNodeID == r.backend {
		return true
	}
	hit, err := pg.resolve(ctx, ref{session: pg.session, backend: n.BackendNodeID})
	if err != nil {
		return false
	}
	res, err = pg.call(ctx, "Runtime.callFunctionOn", map[string]any{"objectId": obj,
		"functionDeclaration": `function(n){ for (let x = n; x; x = x.parentNode || x.host) if (x === this) return true; return false }`,
		"arguments":           []map[string]any{{"objectId": hit}}, "returnByValue": true})
	if err != nil {
		return false
	}
	var v struct {
		Result struct {
			Value bool `json:"value"`
		} `json:"result"`
	}
	json.Unmarshal(res, &v)
	return v.Result.Value
}

func callString(ctx context.Context, pg *page, session, obj, fn string, args ...any) string {
	params := map[string]any{"objectId": obj, "functionDeclaration": fn, "returnByValue": true}
	if len(args) > 0 {
		a := make([]map[string]any, len(args))
		for i, x := range args {
			a[i] = map[string]any{"value": x}
		}
		params["arguments"] = a
	}
	res, err := pg.b.cl.Call(ctx, session, "Runtime.callFunctionOn", params)
	if err != nil {
		return ""
	}
	var v struct {
		Result struct {
			Value any `json:"value"`
		} `json:"result"`
	}
	json.Unmarshal(res, &v)
	s, _ := v.Result.Value.(string)
	return s
}

func sleepCtx(ctx context.Context, d time.Duration) {
	select {
	case <-ctx.Done():
	case <-time.After(d):
	}
}

// ── 조작 ─────────────────────────────────────────────────────────

func (pg *page) mouse(ctx context.Context, typ string, x, y float64, clicks int) error {
	params := map[string]any{"type": typ, "x": x, "y": y, "button": "none"}
	if typ != "mouseMoved" {
		params["button"] = "left"
		params["clickCount"] = clicks
		if typ == "mousePressed" {
			params["buttons"] = 1
		}
	}
	_, err := pg.call(ctx, "Input.dispatchMouseEvent", params)
	return err
}

// overlay 는 에이전트 동작을 뷰어에 잠깐 그리게 한다 (FR-BRT-79).
func (pg *page) overlay(kind string, x, y, w, h float64) {
	pg.b.m.emitInfo(EvAct, pg.tab, map[string]any{"kind": kind, "x": x, "y": y, "w": w, "h": h})
}

func (pg *page) clickRef(ctx context.Context, id string) error {
	r, err := pg.lookupRef(id)
	if err != nil {
		return err
	}
	x, y, w, h, err := pg.actionPoint(ctx, r, true)
	if err != nil {
		return err
	}
	pg.overlay("click", x, y, w, h)
	if err := pg.mouse(ctx, "mouseMoved", x, y, 0); err != nil {
		return err
	}
	if err := pg.mouse(ctx, "mousePressed", x, y, 1); err != nil {
		return err
	}
	return pg.mouse(ctx, "mouseReleased", x, y, 1)
}

func (pg *page) hoverRef(ctx context.Context, id string) error {
	r, err := pg.lookupRef(id)
	if err != nil {
		return err
	}
	x, y, w, h, err := pg.actionPoint(ctx, r, false)
	if err != nil {
		return err
	}
	pg.overlay("hover", x, y, w, h)
	return pg.mouse(ctx, "mouseMoved", x, y, 0)
}

// fillRef 는 선택 후 `Input.insertText` 다 (FR-BRT-76). 빈 글이면 지운다.
func (pg *page) fillRef(ctx context.Context, id, text string) error {
	if err := pg.clickRef(ctx, id); err != nil {
		return err
	}
	r, _ := pg.lookupRef(id)
	obj, err := pg.resolve(ctx, r)
	if err != nil {
		return err
	}
	callString(ctx, pg, r.session, obj, `function(){ if (this.select) { this.select(); return 'ok' }
	  const rg = document.createRange(); rg.selectNodeContents(this); const s = getSelection(); s.removeAllRanges(); s.addRange(rg); return 'ok' }`)
	if text == "" {
		for _, ev := range (parsedKey{key: "Delete", code: "Delete", vk: 46}).events() {
			if _, err := pg.call(ctx, "Input.dispatchKeyEvent", ev); err != nil {
				return err
			}
		}
		return nil
	}
	_, err = pg.call(ctx, "Input.insertText", map[string]any{"text": text})
	return err
}

// selectRef 는 `<select>` 에 값을 넣고 input·change 를 일으킨다 (FR-BRT-76).
func (pg *page) selectRef(ctx context.Context, id, value string) error {
	r, err := pg.lookupRef(id)
	if err != nil {
		return err
	}
	x, y, w, h, err := pg.actionPoint(ctx, r, true)
	if err != nil {
		return err
	}
	pg.overlay("select", x, y, w, h)
	obj, err := pg.resolve(ctx, r)
	if err != nil {
		return err
	}
	switch callString(ctx, pg, r.session, obj, `function(v){
	  if (this.tagName !== 'SELECT') return 'not-select';
	  const o = [...this.options].find(o => o.value === v || o.label === v || o.text === v);
	  if (!o) return 'no-option';
	  this.value = o.value;
	  this.dispatchEvent(new Event('input', {bubbles: true}));
	  this.dispatchEvent(new Event('change', {bubbles: true}));
	  return 'ok' }`, value) {
	case "ok":
		return nil
	case "not-select":
		return errors.New("<select> 가 아닙니다: " + id)
	default:
		return errors.New("그런 선택지가 없습니다: " + value)
	}
}

func (pg *page) typeText(ctx context.Context, text string) error {
	for _, c := range text {
		k := parsedKey{key: string(c), text: string(c)}
		if c == '\n' {
			k = parsedKey{key: "Enter", code: "Enter", vk: 13, text: "\r"}
		}
		for _, ev := range k.events() {
			if _, err := pg.call(ctx, "Input.dispatchKeyEvent", ev); err != nil {
				return err
			}
		}
	}
	return nil
}

func (pg *page) press(ctx context.Context, combo string) error {
	k, err := parseKeyCombo(combo, pg.serverMac())
	if err != nil {
		return err
	}
	for _, ev := range k.events() {
		if _, err := pg.call(ctx, "Input.dispatchKeyEvent", ev); err != nil {
			return err
		}
	}
	return nil
}

func (pg *page) scroll(ctx context.Context, target string) error {
	switch target {
	case "up", "down":
		res, err := pg.call(ctx, "Page.getLayoutMetrics", nil)
		if err != nil {
			return err
		}
		var lm struct {
			CSSVisualViewport struct {
				ClientWidth  float64 `json:"clientWidth"`
				ClientHeight float64 `json:"clientHeight"`
			} `json:"cssVisualViewport"`
		}
		json.Unmarshal(res, &lm)
		dy := lm.CSSVisualViewport.ClientHeight * 0.8
		if target == "up" {
			dy = -dy
		}
		_, err = pg.call(ctx, "Input.dispatchMouseEvent", map[string]any{"type": "mouseWheel",
			"x": lm.CSSVisualViewport.ClientWidth / 2, "y": lm.CSSVisualViewport.ClientHeight / 2, "deltaX": 0, "deltaY": dy})
		return err
	}
	r, err := pg.lookupRef(target)
	if err != nil {
		return err
	}
	_, err = pg.b.cl.Call(ctx, r.session, "DOM.scrollIntoViewIfNeeded", map[string]any{"backendNodeId": r.backend})
	return err
}

func (pg *page) upload(ctx context.Context, id string, files []string) error {
	r, err := pg.lookupRef(id)
	if err != nil {
		return err
	}
	_, err = pg.b.cl.Call(ctx, r.session, "DOM.setFileInputFiles", map[string]any{"files": files, "backendNodeId": r.backend})
	return err
}

// ── 대기·eval·스크린샷 ────────────────────────────────────────────

// globRe 는 `--url` 의 glob 이다 — `*` 는 아무 글자열, `?` 는 한 글자.
func globRe(g string) *regexp.Regexp {
	var b strings.Builder
	b.WriteString("^")
	for _, c := range g {
		switch c {
		case '*':
			b.WriteString(".*")
		case '?':
			b.WriteString(".")
		default:
			b.WriteString(regexp.QuoteMeta(string(c)))
		}
	}
	b.WriteString("$")
	return regexp.MustCompile(b.String())
}

type waitSpec struct {
	Text string `json:"text"`
	Ref  string `json:"ref"`
	URL  string `json:"url"`
	Load bool   `json:"load"`
}

func (pg *page) wait(ctx context.Context, w waitSpec) error {
	var re *regexp.Regexp
	if w.URL != "" {
		re = globRe(w.URL)
	}
	for {
		ok := true
		if w.Text != "" {
			v, _ := pg.evalValue(ctx, `!!(document.body && document.body.innerText.includes(`+strconv.Quote(w.Text)+`))`)
			ok = ok && string(v) == "true"
		}
		if ok && w.Ref != "" {
			r, err := pg.lookupRef(w.Ref)
			if err != nil {
				return err
			}
			obj, err := pg.resolve(ctx, r)
			ok = err == nil && callString(ctx, pg, r.session, obj, checkFn) == "ok"
		}
		if ok && re != nil {
			pg.mu.Lock()
			u := pg.st.URL
			pg.mu.Unlock()
			ok = re.MatchString(u)
		}
		if ok && w.Load {
			v, _ := pg.evalValue(ctx, `document.readyState`)
			pg.mu.Lock()
			loading := pg.st.Loading
			pg.mu.Unlock()
			ok = string(v) == `"complete"` && !loading
		}
		if ok {
			return nil
		}
		select {
		case <-ctx.Done():
			return errors.New("기다린 조건이 제한 시간 안에 서지 않았습니다")
		case <-time.After(100 * time.Millisecond):
		}
	}
}

func (pg *page) evalValue(ctx context.Context, expr string) (json.RawMessage, error) {
	res, err := pg.call(ctx, "Runtime.evaluate", map[string]any{"expression": expr, "returnByValue": true,
		"awaitPromise": true, "userGesture": true})
	if err != nil {
		return nil, err
	}
	var r struct {
		Result struct {
			Type  string          `json:"type"`
			Value json.RawMessage `json:"value"`
			Desc  string          `json:"description"`
		} `json:"result"`
		ExceptionDetails *struct {
			Text      string `json:"text"`
			Exception struct {
				Description string `json:"description"`
			} `json:"exception"`
		} `json:"exceptionDetails"`
	}
	json.Unmarshal(res, &r)
	if r.ExceptionDetails != nil {
		msg := r.ExceptionDetails.Exception.Description
		if msg == "" {
			msg = r.ExceptionDetails.Text
		}
		return nil, errors.New(msg)
	}
	if len(r.Result.Value) == 0 {
		if r.Result.Type == "undefined" {
			return json.RawMessage(`null`), nil
		}
		b, _ := json.Marshal(r.Result.Desc)
		return b, nil
	}
	return r.Result.Value, nil
}

func (pg *page) screenshot(ctx context.Context, full bool) ([]byte, error) {
	params := map[string]any{"format": "png"}
	if full {
		res, err := pg.call(ctx, "Page.getLayoutMetrics", nil)
		if err != nil {
			return nil, err
		}
		var lm struct {
			CSSContentSize struct {
				Width  float64 `json:"width"`
				Height float64 `json:"height"`
			} `json:"cssContentSize"`
		}
		json.Unmarshal(res, &lm)
		params["captureBeyondViewport"] = true
		params["clip"] = map[string]any{"x": 0, "y": 0, "width": lm.CSSContentSize.Width, "height": lm.CSSContentSize.Height, "scale": 1}
	}
	res, err := pg.call(ctx, "Page.captureScreenshot", params)
	if err != nil {
		return nil, err
	}
	var s struct {
		Data string `json:"data"`
	}
	json.Unmarshal(res, &s)
	return base64.StdEncoding.DecodeString(s.Data)
}

// doAct 는 2단계 조작의 분기다 (`page.do` 가 부른다).
func (pg *page) doAct(ctx context.Context, op string, params json.RawMessage) (any, bool, error) {
	var p struct {
		Ref   string   `json:"ref"`
		Text  string   `json:"text"`
		Value string   `json:"value"`
		Key   string   `json:"key"`
		Dom   bool     `json:"dom"`
		Full  bool     `json:"full"`
		Limit int      `json:"limit"`
		Files []string `json:"files"`
		Expr  string   `json:"expr"`
		waitSpec
	}
	json.Unmarshal(params, &p)
	switch op {
	case "snapshot":
		var s string
		var err error
		if p.Dom {
			s, err = pg.domSnapshot(ctx)
		} else {
			s, err = pg.snapshot(ctx)
		}
		return map[string]any{"snapshot": s}, true, err
	case "click":
		return okResult, true, pg.clickRef(ctx, p.Ref)
	case "hover":
		return okResult, true, pg.hoverRef(ctx, p.Ref)
	case "fill":
		return okResult, true, pg.fillRef(ctx, p.Ref, p.Text)
	case "select":
		return okResult, true, pg.selectRef(ctx, p.Ref, p.Value)
	case "type":
		return okResult, true, pg.typeText(ctx, p.Text)
	case "press":
		return okResult, true, pg.press(ctx, p.Key)
	case "scroll":
		return okResult, true, pg.scroll(ctx, p.Ref)
	case "upload":
		return okResult, true, pg.upload(ctx, p.Ref, p.Files)
	case "wait":
		return okResult, true, pg.wait(ctx, p.waitSpec)
	case "eval":
		v, err := pg.evalValue(ctx, p.Expr)
		return map[string]any{"value": v}, true, err
	case "screenshot":
		b, err := pg.screenshot(ctx, p.Full)
		return map[string]any{"png": b}, true, err
	case "console", "network":
		pg.mu.Lock()
		a := pg.act()
		var items []json.RawMessage
		if op == "console" {
			items = a.console.last(p.Limit)
		} else {
			items = a.network.last(p.Limit)
		}
		pg.mu.Unlock()
		return map[string]any{"items": items}, true, nil
	}
	return nil, false, nil
}
