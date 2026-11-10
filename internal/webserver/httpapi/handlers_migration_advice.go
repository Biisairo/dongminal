package httpapi

import (
	"encoding/json"
	"net/http"
	"strings"
	"sync"

	"dongminal/internal/shared/settingsschema"
	"dongminal/internal/shared/toolipc"
)

// ISSUE_TREE_OPS_SRS 묶음 M — 맥락 기준 migration 의 설정과 일반 훅의 판정.

// migrationConf 는 설정 넷이다 (FR-ITM-1). 일반 훅과 issue-tree 는 서로 영향을 주지
// 않는다 (FR-ITM-2).
type migrationConf struct {
	HookOn  bool
	HookPct int
	TreeOn  bool
	TreePct int
}

const (
	migrationHookKey    = "migrationHook"
	migrationHookPctKey = "migrationHookCtxPct"
	issueTreeOnKey      = "issueTreeMigration"
	issueTreePctKey     = "issueTreeCtxPct"
)

// migrationSpecs 는 서술자 표의 넷이다. 기본값·범위를 여기 적지 않는다 — 표가 단일
// 원천이다 (FR-CFG-10, `scrollSpeedSpec` 과 같은 까닭).
var migrationSpecs = sync.OnceValue(func() map[string]settingsschema.Spec {
	specs, err := settingsschema.Load()
	if err != nil {
		return map[string]settingsschema.Spec{}
	}
	return settingsschema.ByKey(specs)
})

// parseMigrationConf 는 blob 에서 넷을 읽는다. 비었거나 타입·범위 밖이면 표의 기본값이다
// (FR-ITM-4). 표를 읽지 못하면 일반 훅은 끔, issue-tree 는 켬, 기준은 50 이다.
func parseMigrationConf(blob []byte) migrationConf {
	var m map[string]any
	if json.Unmarshal(blob, &m) != nil {
		m = nil
	}
	specs := migrationSpecs()
	return migrationConf{
		HookOn:  settingBool(m, specs[migrationHookKey], migrationHookFallback),
		HookPct: settingInt(m, specs[migrationHookPctKey]),
		TreeOn:  settingBool(m, specs[issueTreeOnKey], issueTreeOnFallback),
		TreePct: settingInt(m, specs[issueTreePctKey]),
	}
}

const (
	migrationHookFallback = false
	issueTreeOnFallback   = true
	migrationPctFallback  = issueTreeCtxDefault
)

func settingBool(m map[string]any, spec settingsschema.Spec, fallback bool) bool {
	def, ok := spec.Def.(bool)
	if !ok {
		def = fallback
	}
	if v, ok := m[spec.Key].(bool); ok && spec.Key != "" {
		return v
	}
	return def
}

func settingInt(m map[string]any, spec settingsschema.Spec) int {
	n := migrationPctFallback
	if def, ok := spec.Def.(float64); ok {
		n = int(def)
	}
	if v, ok := m[spec.Key].(float64); ok && spec.Key != "" {
		if i := int(v); float64(i) == v && (spec.Min == nil || i >= *spec.Min) && (spec.Max == nil || i <= *spec.Max) {
			return i
		}
	}
	return n
}

// migrationConf 는 지금 설정이다. 설정 저장소가 없으면 기본값이다.
func (s *Server) migrationConf() migrationConf {
	if s.Settings == nil {
		return parseMigrationConf(nil)
	}
	return s.Settings.Migration()
}

// 판정 (FR-ITM-11).
const (
	adviceSkip    = "skip"
	adviceUnknown = "unknown"
	adviceAdvise  = "advise"
	adviceMust    = "must"
	adviceOK      = "ok"
)

// 맥락 판단의 두 값 (FR-ITM-16·23, D-ITO-15). 판단은 기준의 4/5(80%) 에서 시작하고,
// 상한은 기준과 무관하게 판단 없이 넘기는 자리다. 비율을 정수 둘로 두는 것은
// `70*0.8` 같은 부동소수 오차가 시작점 비교를 흔들지 않게 하려는 것이다.
const (
	migrationJudgeNum = 4
	migrationJudgeDen = 5
	migrationCapPct   = 85
)

// apiMigrationAdvice implements GET /api/tools/migration-advice?id=<toolId> (FR-ITM-10·11).
func (s *Server) apiMigrationAdvice(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimSpace(r.URL.Query().Get("id"))
	conf := s.migrationConf()
	out := map[string]any{"ctxPct": conf.HookPct, "judgePct": judgePct(conf.HookPct), "capPct": migrationCapPct}
	out["verdict"] = s.migrationVerdict(id, conf, out)
	writeJSON(w, out)
}

func (s *Server) migrationVerdict(id string, conf migrationConf, out map[string]any) string {
	if s.Runs != nil {
		if m, ok := s.Runs.MemberByTool(id); ok && m.Assign != nil {
			return adviceSkip // 트리 노드는 자기 절차를 따른다 (D-ITO-5)
		}
	}
	if !conf.HookOn {
		return adviceSkip
	}
	ctx, _ := s.toolUsageView(id)
	if ctx == nil || ctx.UsedPct == nil {
		// FR-ITM-13: 모르는 사실은 도구마다 한 번만 알린다.
		if _, told := s.migrationUnknownTold.LoadOrStore(id, true); told {
			return adviceOK
		}
		s.putRecord(toolipc.RecordMigrationTold, id, true)
		return adviceUnknown
	}
	out["usedPct"] = *ctx.UsedPct
	switch {
	case *ctx.UsedPct >= migrationCapPct:
		return adviceMust
	case *ctx.UsedPct >= judgePct(conf.HookPct):
		return adviceAdvise
	}
	return adviceOK
}

// judgePct 는 기준 pct 의 판단 시작점이다 (FR-ITM-23).
func judgePct(pct int) float64 {
	return float64(pct*migrationJudgeNum) / migrationJudgeDen
}
