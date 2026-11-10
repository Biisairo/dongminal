package httpapi

import (
	"fmt"
	"net/http"
	"testing"

	"dongminal/internal/webserver/domain/run"
)

// ISSUE_TREE_OPS_SRS 묶음 M — 맥락 설정과 일반 훅의 판정 (TC-ITM-1·2).

func TestMigrationSettings_DefaultsAndClamp(t *testing.T) {
	cases := []struct {
		blob string
		want migrationConf
	}{
		{``, migrationConf{HookOn: false, HookPct: 50, TreeOn: true, TreePct: 50}},
		{`{"migrationHook":true,"migrationHookCtxPct":70}`, migrationConf{HookOn: true, HookPct: 70, TreeOn: true, TreePct: 50}},
		{`{"issueTreeMigration":false,"issueTreeCtxPct":30}`, migrationConf{HookOn: false, HookPct: 50, TreeOn: false, TreePct: 30}},
		{`{"migrationHookCtxPct":0,"issueTreeCtxPct":101}`, migrationConf{HookOn: false, HookPct: 50, TreeOn: true, TreePct: 50}},
		{`{"migrationHookCtxPct":"x","migrationHook":"y"}`, migrationConf{HookOn: false, HookPct: 50, TreeOn: true, TreePct: 50}},
		{`not json`, migrationConf{HookOn: false, HookPct: 50, TreeOn: true, TreePct: 50}},
	}
	for _, c := range cases {
		if got := parseMigrationConf([]byte(c.blob)); got != c.want {
			t.Errorf("%q: got %+v want %+v", c.blob, got, c.want)
		}
	}
}

func TestMigrationAdvice_Verdicts(t *testing.T) {
	f := treeSucceedServer(t)
	settings := &fakeSettingsStore{}
	f.s.Settings = settings
	report := func(id string, pct int) {
		t.Helper()
		f.who.toolID = id
		if code, out := postRun(t, f.s, "/api/tools/usage", fmt.Sprintf(`{"usage":{"contextWindow":{"usedPct":%d}}}`, pct)); code != http.StatusOK {
			t.Fatalf("usage code=%d %v", code, out)
		}
	}
	report("tool-b", 57)

	ask := func(id string) map[string]any {
		t.Helper()
		code, out := getRun(t, f.s, "/api/tools/migration-advice?id="+id)
		if code != http.StatusOK {
			t.Fatalf("code=%d %v", code, out)
		}
		return out
	}
	// 기본은 끔이다 — 맥락은 모으지만 알리지 않는다.
	if out := ask("tool-b"); out["verdict"] != "skip" {
		t.Fatalf("기본 끔=%v", out)
	}
	settings.blob = []byte(`{"migrationHook":true}`)
	// 일반 세션(tool-b 는 트리 아닌 Run 의 멤버다) — 57% ≥ 50% 이면 advise.
	if out := ask("tool-b"); out["verdict"] != "advise" || out["usedPct"] != 57.0 || out["ctxPct"] != float64(50) {
		t.Fatalf("advise=%v", out)
	}
	if out := ask("tool-b"); out["judgePct"] != float64(40) || out["capPct"] != float64(85) {
		t.Fatalf("판단 시작점·상한=%v", out)
	}
	// FR-ITM-23: 기준 아래라도 판단 시작점(기준 × 0.8) 이상이면 advise 다.
	settings.blob = []byte(`{"migrationHook":true,"migrationHookCtxPct":60}`)
	if out := ask("tool-b"); out["verdict"] != "advise" || out["judgePct"] != float64(48) {
		t.Fatalf("시작점 이상·기준 아래=%v", out)
	}
	settings.blob = []byte(`{"migrationHook":true,"migrationHookCtxPct":75}`)
	if out := ask("tool-b"); out["verdict"] != "ok" {
		t.Fatalf("시작점 아래=%v", out)
	}
	settings.blob = []byte(`{"migrationHook":true}`)
	report("tool-b", 40)
	if out := ask("tool-b"); out["verdict"] != "advise" {
		t.Fatalf("시작점 그 자리=%v", out)
	}
	report("tool-b", 39)
	if out := ask("tool-b"); out["verdict"] != "ok" {
		t.Fatalf("시작점 바로 아래=%v", out)
	}
	// FR-ITM-16: 상한 85% 는 기준과 무관하다 — 기준이 상한보다 높아도 must 다.
	report("tool-b", 85)
	if out := ask("tool-b"); out["verdict"] != "must" {
		t.Fatalf("상한=%v", out)
	}
	settings.blob = []byte(`{"migrationHook":true,"migrationHookCtxPct":95}`)
	if out := ask("tool-b"); out["verdict"] != "must" {
		t.Fatalf("기준이 상한보다 높을 때=%v", out)
	}
	report("tool-b", 57)
	settings.blob = []byte(`{"migrationHook":false}`)
	if out := ask("tool-b"); out["verdict"] != "skip" {
		t.Fatalf("끔=%v", out)
	}
	settings.blob = []byte(`{"migrationHook":true}`)
	// 트리 멤버는 issue-tree 설정과 절차를 따른다 — 일반 훅은 건너뛴다 (FR-ITM-11①·15).
	report("tool-n", 90)
	if out := ask("tool-n"); out["verdict"] != "skip" {
		t.Fatalf("트리 멤버=%v", out)
	}
	// 모르면 unknown — 도구마다 한 번만 (FR-ITM-13).
	if out := ask("tool-z"); out["verdict"] != "unknown" {
		t.Fatalf("첫 unknown=%v", out)
	}
	if out := ask("tool-z"); out["verdict"] != "ok" {
		t.Fatalf("두 번째 unknown 은 조용해야 한다: %v", out)
	}
}

func TestTreePreamble_CtxFromSettings(t *testing.T) {
	f := treeSucceedServer(t)
	settings := &fakeSettingsStore{}
	f.s.Settings = settings
	rec, _ := f.store.Get(f.node.RunID)
	if tc := f.s.treeContext(rec, f.node); tc.CtxPct != 50 {
		t.Fatalf("기본=%d", tc.CtxPct)
	}
	settings.blob = []byte(`{"issueTreeCtxPct":35}`)
	if tc := f.s.treeContext(rec, f.node); tc.CtxPct != 35 {
		t.Fatalf("설정=%d", tc.CtxPct)
	}
	n := f.node
	n.Assign = &run.Assignment{Issue: "o/r#33", CtxPct: 44}
	if tc := f.s.treeContext(rec, n); tc.CtxPct != 44 {
		t.Fatalf("--ctx 가 이긴다=%d", tc.CtxPct)
	}
	settings.blob = []byte(`{"issueTreeMigration":false}`)
	if tc := f.s.treeContext(rec, n); tc.CtxPct != 0 {
		t.Fatalf("끔=%d", tc.CtxPct)
	}
}
