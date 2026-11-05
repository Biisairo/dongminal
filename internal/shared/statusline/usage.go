// Package statusline 은 Claude Code statusLine 입력의 허용 목록이다
// (ISSUE_AGENT_TREE_SRS FR-SLP-2·2a · REFACTOR PROD2 §6).
//
// 목록은 이 파일의 타입 **한 벌**이다. `dmctl statusline` 은 입력에서 이 타입을 채워 보내고,
// 서버는 같은 타입으로 받는다. 그래서 한쪽에만 필드를 더할 수 없다.
//
// 필드마다 태그가 둘이다: `json` 은 내보내는 이름, `sl` 은 statusLine 입력의 이름(점으로
// 이은 경로)이다. 끝 필드는 포인터다 — "관측이 없다" 와 "0 이다" 를 가른다.
package statusline

import (
	"encoding/json"
	"reflect"
	"regexp"
	"strings"
)

type Model struct {
	ID          *string `json:"id,omitempty" sl:"id"`
	DisplayName *string `json:"displayName,omitempty" sl:"display_name"`
}

type Cost struct {
	TotalCostUsd       *float64 `json:"totalCostUsd,omitempty" sl:"total_cost_usd"`
	TotalDurationMs    *float64 `json:"totalDurationMs,omitempty" sl:"total_duration_ms"`
	TotalApiDurationMs *float64 `json:"totalApiDurationMs,omitempty" sl:"total_api_duration_ms"`
	TotalLinesAdded    *float64 `json:"totalLinesAdded,omitempty" sl:"total_lines_added"`
	TotalLinesRemoved  *float64 `json:"totalLinesRemoved,omitempty" sl:"total_lines_removed"`
}

type CurrentUsage struct {
	InputTokens              *float64 `json:"inputTokens,omitempty" sl:"input_tokens"`
	OutputTokens             *float64 `json:"outputTokens,omitempty" sl:"output_tokens"`
	CacheCreationInputTokens *float64 `json:"cacheCreationInputTokens,omitempty" sl:"cache_creation_input_tokens"`
	CacheReadInputTokens     *float64 `json:"cacheReadInputTokens,omitempty" sl:"cache_read_input_tokens"`
}

type ContextWindow struct {
	TotalInputTokens  *float64      `json:"totalInputTokens,omitempty" sl:"total_input_tokens"`
	TotalOutputTokens *float64      `json:"totalOutputTokens,omitempty" sl:"total_output_tokens"`
	WindowTokens      *float64      `json:"windowTokens,omitempty" sl:"context_window_size"`
	UsedPct           *float64      `json:"usedPct,omitempty" sl:"used_percentage"`
	RemainingPct      *float64      `json:"remainingPct,omitempty" sl:"remaining_percentage"`
	CurrentUsage      *CurrentUsage `json:"currentUsage,omitempty" sl:"current_usage"`
}

type RateWindow struct {
	UsedPct  *float64 `json:"usedPct,omitempty" sl:"used_percentage"`
	ResetsAt *float64 `json:"resetsAt,omitempty" sl:"resets_at"`
}

// Usage 는 statusLine 입력에서 내보내도 되는 값 전부다. 경로·본문(`transcript_path`·`cwd`·
// `workspace.*`)은 여기 없으므로 나가지 않는다 (FR-SLP-2a).
type Usage struct {
	SessionID     *string               `json:"sessionId,omitempty" sl:"session_id"`
	Version       *string               `json:"version,omitempty" sl:"version"`
	Model         *Model                `json:"model,omitempty" sl:"model"`
	Effort        *string               `json:"effort,omitempty" sl:"effort.level"`
	Thinking      *bool                 `json:"thinking,omitempty" sl:"thinking.enabled"`
	FastMode      *bool                 `json:"fastMode,omitempty" sl:"fast_mode"`
	OutputStyle   *string               `json:"outputStyle,omitempty" sl:"output_style.name"`
	Exceeds200k   *bool                 `json:"exceeds200k,omitempty" sl:"exceeds_200k_tokens"`
	Cost          *Cost                 `json:"cost,omitempty" sl:"cost"`
	ContextWindow *ContextWindow        `json:"contextWindow,omitempty" sl:"context_window"`
	RateLimits    map[string]RateWindow `json:"rateLimits,omitempty" sl:"rate_limits"`
}

// 한도 창의 이름은 판마다 늘 수 있다(`five_hour`·`seven_day`…). 이름 모양만 거른다.
var rateName = regexp.MustCompile(`^[a-z0-9_]{1,32}$`)

// FromInput 은 statusLine 입력에서 허용 목록의 값만 꺼낸다. 값이 null·없음·다른 타입이면 그
// 필드를 싣지 않는다. 실을 값이 하나도 없거나 입력이 객체가 아니면 nil 이다.
func FromInput(raw []byte) *Usage {
	var in map[string]any
	if json.Unmarshal(raw, &in) != nil {
		return nil
	}
	var u Usage
	if !fill(reflect.ValueOf(&u).Elem(), in) {
		return nil
	}
	return &u
}

// fill 은 dst(구조체)의 필드를 sl 태그의 경로로 src 에서 채운다. 하나라도 채웠으면 참이다.
func fill(dst reflect.Value, src map[string]any) bool {
	filled := false
	for i := 0; i < dst.NumField(); i++ {
		tag := dst.Type().Field(i).Tag.Get("sl")
		v, ok := lookup(src, tag)
		if tag == "" || !ok {
			continue
		}
		if fillField(dst.Field(i), v) {
			filled = true
		}
	}
	return filled
}

func fillField(f reflect.Value, v any) bool {
	switch f.Kind() {
	case reflect.Map:
		m, ok := v.(map[string]any)
		if !ok {
			return false
		}
		out := reflect.MakeMap(f.Type())
		for name, w := range m {
			wm, ok := w.(map[string]any)
			if !ok || !rateName.MatchString(name) {
				continue
			}
			ev := reflect.New(f.Type().Elem()).Elem()
			if fill(ev, wm) {
				out.SetMapIndex(reflect.ValueOf(camel(name)), ev)
			}
		}
		if out.Len() == 0 {
			return false
		}
		f.Set(out)
		return true
	case reflect.Pointer:
		elem := f.Type().Elem()
		if elem.Kind() == reflect.Struct {
			m, ok := v.(map[string]any)
			if !ok {
				return false
			}
			p := reflect.New(elem)
			if !fill(p.Elem(), m) {
				return false
			}
			f.Set(p)
			return true
		}
		rv := reflect.ValueOf(v)
		if !rv.IsValid() || rv.Type() != elem {
			return false
		}
		p := reflect.New(elem)
		p.Elem().Set(rv)
		f.Set(p)
		return true
	}
	return false
}

func lookup(m map[string]any, path string) (any, bool) {
	var cur any = m
	for k := range strings.SplitSeq(path, ".") {
		mm, ok := cur.(map[string]any)
		if !ok {
			return nil, false
		}
		cur, ok = mm[k]
		if !ok {
			return nil, false
		}
	}
	return cur, cur != nil
}

func camel(s string) string {
	parts := strings.Split(s, "_")
	for i := 1; i < len(parts); i++ {
		if parts[i] != "" {
			parts[i] = strings.ToUpper(parts[i][:1]) + parts[i][1:]
		}
	}
	return strings.Join(parts, "")
}
