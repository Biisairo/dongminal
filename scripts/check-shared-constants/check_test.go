package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"dongminal/internal/webserver/domain/git/jobs"
)

// SERVER_DRIVEN_ACTIONS_SRS K-j · TC-SDA-11 — 두 벌의 대조 게이트를 탐침한다.

func repoSources(t *testing.T) Sources {
	t.Helper()
	s := Sources{Files: map[string]string{}, Locales: map[string]string{}, IndicatorKinds: jobs.IndicatorKinds()}
	for _, p := range Needed {
		raw, err := os.ReadFile(filepath.Join("..", "..", p))
		if err != nil {
			t.Fatal(err)
		}
		s.Files[p] = string(raw)
	}
	for _, l := range Locales {
		raw, err := os.ReadFile(filepath.Join("..", "..", "web", "js", "i18n", l+".js"))
		if err != nil {
			t.Fatal(err)
		}
		s.Locales[l] = string(raw)
	}
	return s
}

func TestCheck_RepoIsConsistent(t *testing.T) {
	if got := Check(repoSources(t)); len(got) != 0 {
		t.Fatalf("지금 저장소에서 어긋남이 났다:\n%s", strings.Join(got, "\n"))
	}
}

// 한쪽만 바꾸면 실패한다. 바꾼 짝의 ID 가 문구에 있어야 한다.
func TestCheck_ProbesEachPair(t *testing.T) {
	cases := []struct {
		id, file, old, new string
	}{
		{"K9", "web/js/core/constants-git-changes.js", "bisect_in_progress:'bisect'", "bisect_running:'bisect'"},
		{"K9", "internal/webserver/domain/git/query/preflight.go", `BlockBisectInProgress = "bisect_in_progress"`, `BlockBisectInProgress = "bisect_in_progress"
	BlockSequencerInProgress = "sequencer_in_progress"`},
		{"K10", "web/js/core/constants-git-actions.js", "const GIT_OP_CHERRY='cherry-pick';", "const GIT_OP_CHERRY='cherry';"},
		{"K10", "internal/webserver/domain/git/query/operation.go", `OpBisect = "bisect"`, `OpBisect = "bisect"
	OpSequencer = "sequencer"`},
		{"K12", "web/js/core/constants-editor.js", "const LSP_WS_CLOSE_START=4002;", "const LSP_WS_CLOSE_START=4012;"},
		{"K12", "internal/webserver/httpapi/handlers_lsp_ws.go", "lspWSCloseEnded = 4003", "lspWSCloseEnded = 4004"},
		{"K13", "web/js/core/constants.js", "const WS_SCHEMA_VERSION=2;", "const WS_SCHEMA_VERSION=3;"},
		{"K13", "internal/shared/workspace/manager.go", "const SchemaVersion = 2", "const SchemaVersion = 3"},
		{"K17", "web/js/core/constants.js", "const SSE_SILENCE_MS=45000;", "const SSE_SILENCE_MS=30000;"},
		{"K17", "internal/webserver/httpapi/commands.go", "const sseHelloEvery = 15 * time.Second", "const sseHelloEvery = 20 * time.Second"},
		// 읽지 못하는 식은 조용히 넘기지 않는다.
		{"K17", "internal/webserver/httpapi/commands.go", "const sseHelloEvery = 15 * time.Second", "const sseHelloEvery = helloBase * 3"},
		// 상수가 사라져도 실패한다.
		{"K13", "web/js/core/constants.js", "const WS_SCHEMA_VERSION=2;", "const WS_SCHEMA_VER=2;"},
	}
	for _, c := range cases {
		t.Run(c.id+" "+filepath.Base(c.file), func(t *testing.T) {
			s := repoSources(t)
			if !strings.Contains(s.Files[c.file], c.old) {
				t.Fatalf("탐침 자리 %q 가 %s 에 없다 — 시험을 고쳐라", c.old, c.file)
			}
			s.Files[c.file] = strings.Replace(s.Files[c.file], c.old, c.new, 1)
			got := Check(s)
			if len(got) == 0 {
				t.Fatalf("%s 를 바꿨는데 게이트가 통과했다", c.id)
			}
			if !strings.Contains(strings.Join(got, "\n"), c.id) {
				t.Fatalf("문구에 %s 가 없다: %v", c.id, got)
			}
		})
	}
}

// K-h 덧붙임: 표시기에 서는 잡 종류마다 ko·en 라벨이 있다.
func TestCheck_ProbesJobKindLabels(t *testing.T) {
	s := repoSources(t)
	s.IndicatorKinds = append(s.IndicatorKinds, "squash-merge")
	got := strings.Join(Check(s), "\n")
	for _, want := range []string{"ko: git.job_kind.squash_merge", "en: git.job_kind.squash_merge"} {
		if !strings.Contains(got, want) {
			t.Fatalf("%q 가 없다: %s", want, got)
		}
	}
}

func TestGoConsts(t *testing.T) {
	src := `package x
import "time"
const (
	A = "a"
	B = 42
	C = 15 * time.Second
	D = 250 * time.Millisecond
	E = time.Minute
	F = other + 1
)`
	vals, bad := GoConsts(src)
	want := map[string]string{"A": "a", "B": "42", "C": "15000", "D": "250", "E": "60000"}
	for k, v := range want {
		if vals[k] != v {
			t.Errorf("%s = %q, want %q", k, vals[k], v)
		}
	}
	if _, ok := bad["F"]; !ok {
		t.Errorf("읽지 못하는 식 F 가 bad 에 없다: %v", bad)
	}
}

func TestJSConstsAndKeys(t *testing.T) {
	src := "const A='x';\nconst B=4001;\n  const C=\"y\"; // c\nconst OBJ={a_b:'1',\n  // 주석: z:'no'\n  'c-d':'2', e:'3'};\n"
	got := JSConsts(src)
	if got["A"] != "x" || got["B"] != "4001" || got["C"] != "y" {
		t.Fatalf("JSConsts = %v", got)
	}
	keys, ok := JSObjectKeys(src, "OBJ")
	if !ok || strings.Join(keys, ",") != "a_b,c-d,e" {
		t.Fatalf("JSObjectKeys = %v %v", keys, ok)
	}
	if _, ok := JSObjectKeys(src, "NOPE"); ok {
		t.Fatal("없는 객체를 찾았다")
	}
}
