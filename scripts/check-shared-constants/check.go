package main

import (
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// 대조할 파일 (SERVER_DRIVEN_ACTIONS_SRS K-j). 경로는 저장소 뿌리 기준이다.
const (
	jsGitChanges = "web/js/core/constants-git-changes.js"
	jsGitActions = "web/js/core/constants-git-actions.js"
	jsEditor     = "web/js/core/constants-editor.js"
	jsCore       = "web/js/core/constants.js"
	goPreflight  = "internal/webserver/domain/git/query/preflight.go"
	goOperation  = "internal/webserver/domain/git/query/operation.go"
	goLspWS      = "internal/webserver/httpapi/handlers_lsp_ws.go"
	goWorkspace  = "internal/shared/workspace/manager.go"
	goCommands   = "internal/webserver/httpapi/commands.go"
)

// Needed 는 Check 가 읽는 파일 전부다.
var Needed = []string{jsGitChanges, jsGitActions, jsEditor, jsCore, goPreflight, goOperation, goLspWS, goWorkspace, goCommands}

// Locales 는 잡 종류 라벨을 볼 화면 카탈로그다.
var Locales = []string{"ko", "en"}

// Sources 는 대조의 재료다. 파일은 경로 → 내용, 로케일은 이름 → 카탈로그 원문이다.
type Sources struct {
	Files          map[string]string
	Locales        map[string]string
	IndicatorKinds []string
}

// K10 의 화면 이름. `GIT_OP_AT`·`GIT_OP_CONTINUE` 등은 작업 종류가 아니라 고르지 않는다.
var jsOpNames = []string{"GIT_OP_MERGE", "GIT_OP_REBASE", "GIT_OP_CHERRY", "GIT_OP_REVERT", "GIT_OP_AM", "GIT_OP_BISECT"}

var (
	reBlockInProgress = regexp.MustCompile(`^Block\w+InProgress$`)
	reOp              = regexp.MustCompile(`^Op[A-Z]\w*$`)
)

// Check 는 두 벌의 어긋남을 `<짝 ID>: <사유>` 로 돌려준다. 비면 같다.
func Check(s Sources) []string {
	var out []string
	say := func(id, f string, a ...any) { out = append(out, id+": "+fmt.Sprintf(f, a...)) }

	goOf := func(id, file string) (map[string]string, map[string]string) {
		v, bad := GoConsts(s.Files[file])
		if v == nil {
			say(id, "%s 를 Go 로 읽지 못했다", file)
		}
		return v, bad
	}
	goOne := func(id, file, name string) (string, bool) {
		v, bad := goOf(id, file)
		if why, ok := bad[name]; ok {
			say(id, "%s 의 %s 식을 읽지 못한다(%s) — 리터럴이나 N * time.<단위> 로 둔다", file, name, why)
			return "", false
		}
		x, ok := v[name]
		if !ok {
			say(id, "%s 에 상수 %s 가 없다", file, name)
		}
		return x, ok
	}
	jsOne := func(id, file, name string) (string, bool) {
		x, ok := JSConsts(s.Files[file])[name]
		if !ok {
			say(id, "%s 에 const %s 가 없다", file, name)
		}
		return x, ok
	}
	goSet := func(id, file string, re *regexp.Regexp, skipEmpty bool) []string {
		v, _ := goOf(id, file)
		var out []string
		for k, x := range v {
			if re.MatchString(k) && !(skipEmpty && x == "") {
				out = append(out, x)
			}
		}
		return out
	}

	// K9: preflight 의 진행 중 코드 = GIT_OP_BY_BLOCK 의 키.
	if keys, ok := JSObjectKeys(s.Files[jsGitChanges], "GIT_OP_BY_BLOCK"); !ok {
		say("K9", "%s 에 GIT_OP_BY_BLOCK 이 없다", jsGitChanges)
	} else if d := setDiff(goSet("K9", goPreflight, reBlockInProgress, false), keys); d != "" {
		say("K9", "query.Block…InProgress 와 GIT_OP_BY_BLOCK 의 키가 다르다 — %s", d)
	}

	// K10: 작업 종류.
	var jsOps []string
	for _, n := range jsOpNames {
		if x, ok := jsOne("K10", jsGitActions, n); ok {
			jsOps = append(jsOps, x)
		}
	}
	if d := setDiff(goSet("K10", goOperation, reOp, true), jsOps); d != "" {
		say("K10", "query.Op* 와 GIT_OP_* 가 다르다 — %s", d)
	}

	// K12: LSP 통로의 close code.
	for _, p := range [][2]string{{"LSP_WS_CLOSE_LIMIT", "lspWSCloseLimit"}, {"LSP_WS_CLOSE_START", "lspWSCloseStart"}, {"LSP_WS_CLOSE_ENDED", "lspWSCloseEnded"}} {
		j, jok := jsOne("K12", jsEditor, p[0])
		g, gok := goOne("K12", goLspWS, p[1])
		if jok && gok && j != g {
			say("K12", "%s=%s 와 %s=%s 가 다르다", p[0], j, p[1], g)
		}
	}

	// K13: workspace 스키마 판.
	if j, ok := jsOne("K13", jsCore, "WS_SCHEMA_VERSION"); ok {
		if g, ok := goOne("K13", goWorkspace, "SchemaVersion"); ok && j != g {
			say("K13", "WS_SCHEMA_VERSION=%s 와 workspace.SchemaVersion=%s 가 다르다", j, g)
		}
	}

	// K17: SSE 침묵 상한은 인사 주기의 세 배다.
	if j, ok := jsOne("K17", jsCore, "SSE_SILENCE_MS"); ok {
		if g, ok := goOne("K17", goCommands, "sseHelloEvery"); ok {
			gms, _ := strconv.ParseInt(g, 10, 64)
			if j != strconv.FormatInt(3*gms, 10) {
				say("K17", "SSE_SILENCE_MS=%s 가 3 × sseHelloEvery(%sms) 가 아니다", j, g)
			}
		}
	}

	// K-h 덧붙임: 표시기 종류마다 라벨.
	locs := make([]string, 0, len(s.Locales))
	for l := range s.Locales {
		locs = append(locs, l)
	}
	sort.Strings(locs)
	for _, l := range locs {
		for _, k := range s.IndicatorKinds {
			key := "git.job_kind." + strings.ReplaceAll(k, "-", "_")
			if !strings.Contains(s.Locales[l], "'"+key+"'") {
				say("K-h", "%s: %s 가 없다", l, key)
			}
		}
	}
	return out
}

// setDiff 는 서버 쪽(srv)과 화면 쪽(scr)의 집합 차이를 글로 낸다. 같으면 빈 글자다.
func setDiff(srv, scr []string) string {
	in := func(xs []string) map[string]bool {
		m := map[string]bool{}
		for _, x := range xs {
			m[x] = true
		}
		return m
	}
	a, b := in(srv), in(scr)
	var onlySrv, onlyScr []string
	for x := range a {
		if !b[x] {
			onlySrv = append(onlySrv, x)
		}
	}
	for x := range b {
		if !a[x] {
			onlyScr = append(onlyScr, x)
		}
	}
	if len(onlySrv) == 0 && len(onlyScr) == 0 {
		return ""
	}
	sort.Strings(onlySrv)
	sort.Strings(onlyScr)
	return fmt.Sprintf("서버에만 %v, 화면에만 %v", onlySrv, onlyScr)
}

// 시간 단위의 밀리초.
var durationMS = map[string]int64{"Millisecond": 1, "Second": 1000, "Minute": 60000, "Hour": 3600000}

/**
 * GoConsts 는 Go 소스의 상수를 이름 → 값 글자로 읽는다. 정수는 10진, 문자열은 그대로,
 * `time.<단위>`·`N * time.<단위>` 는 밀리초다. 그 밖의 식은 bad(이름 → 사유)에 든다 —
 * 게이트가 그 이름을 대조하려 하면 실패한다. 소스를 파싱하지 못하면 둘 다 nil 이다.
 */
func GoConsts(src string) (vals, bad map[string]string) {
	f, err := parser.ParseFile(token.NewFileSet(), "", src, 0)
	if err != nil {
		return nil, nil
	}
	vals, bad = map[string]string{}, map[string]string{}
	for _, d := range f.Decls {
		g, ok := d.(*ast.GenDecl)
		if !ok || g.Tok != token.CONST {
			continue
		}
		for _, sp := range g.Specs {
			vs := sp.(*ast.ValueSpec)
			for i, n := range vs.Names {
				if i >= len(vs.Values) {
					bad[n.Name] = "값이 없다"
					continue
				}
				if v, ok := goValue(vs.Values[i]); ok {
					vals[n.Name] = v
				} else {
					bad[n.Name] = "지원하지 않는 식"
				}
			}
		}
	}
	return vals, bad
}

func goValue(e ast.Expr) (string, bool) {
	switch x := e.(type) {
	case *ast.BasicLit:
		switch x.Kind {
		case token.INT:
			n, err := strconv.ParseInt(x.Value, 0, 64)
			return strconv.FormatInt(n, 10), err == nil
		case token.STRING:
			s, err := strconv.Unquote(x.Value)
			return s, err == nil
		}
	case *ast.SelectorExpr:
		if ms, ok := timeUnit(x); ok {
			return strconv.FormatInt(ms, 10), true
		}
	case *ast.BinaryExpr:
		if x.Op != token.MUL {
			return "", false
		}
		lit, lok := x.X.(*ast.BasicLit)
		sel, sok := x.Y.(*ast.SelectorExpr)
		if !lok || !sok || lit.Kind != token.INT {
			return "", false
		}
		n, err := strconv.ParseInt(lit.Value, 0, 64)
		ms, ok := timeUnit(sel)
		if err != nil || !ok {
			return "", false
		}
		return strconv.FormatInt(n*ms, 10), true
	}
	return "", false
}

func timeUnit(s *ast.SelectorExpr) (int64, bool) {
	pkg, ok := s.X.(*ast.Ident)
	if !ok || pkg.Name != "time" {
		return 0, false
	}
	ms, ok := durationMS[s.Sel.Name]
	return ms, ok
}

var reJSConst = regexp.MustCompile(`(?m)^\s*const\s+([A-Za-z_$][\w$]*)\s*=\s*('[^'\n]*'|"[^"\n]*"|-?\d+)\s*;`)

// JSConsts 는 `const NAME=<문자열|정수>;` 줄을 이름 → 값 글자로 읽는다.
func JSConsts(src string) map[string]string {
	out := map[string]string{}
	for _, m := range reJSConst.FindAllStringSubmatch(src, -1) {
		v := m[2]
		if v[0] == '\'' || v[0] == '"' {
			v = v[1 : len(v)-1]
		}
		out[m[1]] = v
	}
	return out
}

var (
	reLineComment = regexp.MustCompile(`//[^\n]*`)
	reObjKey      = regexp.MustCompile(`(?:^|[{,])\s*([A-Za-z_$][\w$]*|'[^']*'|"[^"]*")\s*:`)
)

// JSObjectKeys 는 `const NAME={…};` 객체 리터럴의 맨 위 키를 순서대로 읽는다. 값은
// 중괄호를 품지 않는 단순 값이어야 한다.
func JSObjectKeys(src, name string) ([]string, bool) {
	start := regexp.MustCompile(`(?m)^\s*const\s+` + regexp.QuoteMeta(name) + `\s*=\s*\{`).FindStringIndex(src)
	if start == nil {
		return nil, false
	}
	end := strings.Index(src[start[1]:], "}")
	if end < 0 {
		return nil, false
	}
	body := "{" + reLineComment.ReplaceAllString(src[start[1]:start[1]+end], "")
	var keys []string
	for _, m := range reObjKey.FindAllStringSubmatch(body, -1) {
		k := m[1]
		if k[0] == '\'' || k[0] == '"' {
			k = k[1 : len(k)-1]
		}
		keys = append(keys, k)
	}
	return keys, true
}
