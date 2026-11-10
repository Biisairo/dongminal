package statusline

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

// PROD2 §6 (R-SLU-2·3·6) — 허용 목록 한 벌.

// 2026-11-05 실측 입력(Claude Code 2.1.318)에 사용률·한도를 채우고 모르는 필드를 더한 표본.
// 허용 목록의 끝 필드를 하나도 빠짐없이 채운다 (R-SLU-6).
const sample = `{"session_id":"c009","transcript_path":"/Users/x/.claude/projects/p/c009.jsonl","cwd":"PROJ",
"effort":{"level":"medium"},"model":{"id":"claude-opus-5-5","display_name":"Opus 5.5"},
"workspace":{"current_dir":"PROJ","project_dir":"PROJ","added_dirs":[]},"version":"2.1.318",
"output_style":{"name":"default"},
"cost":{"total_cost_usd":0.5,"total_duration_ms":1019,"total_api_duration_ms":10,"total_lines_added":3,"total_lines_removed":1},
"context_window":{"total_input_tokens":100,"total_output_tokens":20,"context_window_size":1000000,
"current_usage":{"input_tokens":6,"output_tokens":8,"cache_creation_input_tokens":62146,"cache_read_input_tokens":0},
"used_percentage":6,"remaining_percentage":94},
"rate_limits":{"five_hour":{"used_percentage":12.5,"resets_at":1793860000},"Bad-Name":{"used_percentage":1}},
"exceeds_200k_tokens":false,"fast_mode":false,"thinking":{"enabled":true},"secret_new_field":"leak?"}`

func TestFromInput_FillsEveryLeaf(t *testing.T) {
	u := FromInput([]byte(sample))
	if u == nil {
		t.Fatal("nil")
	}
	var walk func(v reflect.Value, path string)
	walk = func(v reflect.Value, path string) {
		for i := 0; i < v.NumField(); i++ {
			f, fv := v.Type().Field(i), v.Field(i)
			p := path + "." + f.Name
			if f.Tag.Get("sl") == "" {
				t.Errorf("%s 에 sl 태그가 없다 — 입력에서 채울 길이 없다", p)
				continue
			}
			if fv.Kind() == reflect.Map {
				if fv.Len() == 0 {
					t.Errorf("%s 가 비었다", p)
				}
				continue
			}
			if fv.IsNil() {
				t.Errorf("%s 가 채워지지 않았다", p)
				continue
			}
			if fv.Elem().Kind() == reflect.Struct {
				walk(fv.Elem(), p)
			}
		}
	}
	walk(reflect.ValueOf(*u), "Usage")
	if u.RateLimits["five_hour"].ResetsAt == nil {
		t.Errorf("rateLimits=%+v", u.RateLimits)
	}
}

func TestFromInput_WireShape(t *testing.T) {
	blob, _ := json.Marshal(FromInput([]byte(sample)))
	s := string(blob)
	for _, banned := range []string{"transcript", "/Users/x", "PROJ", "workspace", "secret_new_field", "leak?", "Bad-Name", "badName", "fiveHour"} {
		if strings.Contains(s, banned) {
			t.Errorf("허용 목록 밖의 값 %q 이 나갔다: %s", banned, s)
		}
	}
	for _, want := range []string{`"contextWindow":{`, `"windowTokens":1000000`, `"cacheCreationInputTokens":62146`,
		`"rateLimits":{"five_hour":{"usedPct":12.5,"resetsAt":1793860000}}`, `"model":{"id":"claude-opus-5-5","displayName":"Opus 5.5"}`,
		`"effort":"medium"`, `"thinking":true`, `"exceeds200k":false`, `"totalCostUsd":0.5`} {
		if !strings.Contains(s, want) {
			t.Errorf("%s 가 없다: %s", want, s)
		}
	}
}

func TestFromInput_NullMissingAndWrongTypeDropped(t *testing.T) {
	raw := `{"session_id":7,"version":"v","context_window":{"context_window_size":"big","current_usage":null,"used_percentage":null},
"rate_limits":{"five_hour":{"used_percentage":null}}}`
	u := FromInput([]byte(raw))
	if u == nil || u.Version == nil || *u.Version != "v" {
		t.Fatalf("u=%+v", u)
	}
	if u.SessionID != nil {
		t.Errorf("숫자인 session_id 가 실렸다")
	}
	if u.ContextWindow != nil {
		t.Errorf("채울 값이 없는 contextWindow 가 실렸다: %+v", u.ContextWindow)
	}
	if len(u.RateLimits) != 0 {
		t.Errorf("빈 한도 창이 실렸다: %+v", u.RateLimits)
	}
}

func TestFromInput_NothingOrBroken(t *testing.T) {
	for _, raw := range []string{`{}`, `{"cwd":"/x"}`, `not json`, `[]`} {
		if u := FromInput([]byte(raw)); u != nil {
			t.Errorf("%s → %+v, nil 이어야 한다", raw, u)
		}
	}
}
