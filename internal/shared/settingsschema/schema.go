// Package settingsschema 는 브라우저 설정 블롭의 서술자 표를 읽는다
// (CONFIG_MANAGEMENT_SRS 묶음 S·C).
//
// **표는 여기 없다.** 원천은 `web/js/core/settings-schema.js` 이고 이 패키지는
// 그 **같은 바이트**를 JSON 으로 읽을 뿐이다 (FR-CFG-10). 값을 Go 에 다시 적으면
// 두 벌이 되고, 두 벌이 되면 한쪽만 고쳐진다 — 이 문서가 없애려는 실패가 그것이다.
//
// 생성기가 아니라 **형태 제약**인 이유는 D-CFG-2 다. 생성기는 원천을 Go 로 옮기고
// JS 를 산출물로 만든다 — 게이트 밖에서 JS 를 고친 사람이 조용히 되돌려진다.
package settingsschema

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"sort"

	"dongminal/web"
)

// schemaPath 는 원천 파일의 embed 안 경로다.
const schemaPath = "js/core/settings-schema.js"

// 형태 계약 (FR-CFG-2): 파일 어딘가에 `const SETTINGS_SCHEMA = [ ... ];` 가 있고
// 그 대괄호 안이 순수 JSON 이다.
var (
	schemaOpen  = []byte("const SETTINGS_SCHEMA = [")
	schemaClose = []byte("\n];")
)

// Spec 은 블롭 키 하나의 서술자다. 필드 이름은 JS 쪽 표의 키와 같다.
type Spec struct {
	Key   string `json:"key"`
	Type  string `json:"type"`
	Def   any    `json:"def"`
	Min   *int   `json:"min,omitempty"`
	Max   *int   `json:"max,omitempty"`
	Off   bool   `json:"off,omitempty"`
	Where string `json:"where"`
}

// Problem 은 값 하나가 서술자를 벗어난 사실이다.
type Problem struct {
	Key    string `json:"key"`
	Reason string `json:"reason"`
	Got    any    `json:"got"`
}

func (p Problem) String() string { return fmt.Sprintf("%s: %s (값 %v)", p.Key, p.Reason, p.Got) }

// raw 는 원천 파일의 바이트다.
func raw() ([]byte, error) {
	f, err := web.FS().Open(schemaPath)
	if err != nil {
		return nil, fmt.Errorf("서술자 표를 열지 못했습니다 (%s): %w", schemaPath, err)
	}
	defer f.Close()
	var buf bytes.Buffer
	if _, err := buf.ReadFrom(f); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// extract 는 형태 계약에 따라 JSON 배열 부분만 잘라낸다.
func extract(src []byte) ([]byte, error) {
	i := bytes.Index(src, schemaOpen)
	if i < 0 {
		return nil, errors.New("`const SETTINGS_SCHEMA = [` 를 찾지 못했습니다")
	}
	start := i + len(schemaOpen) - 1 // '[' 를 포함한다
	j := bytes.Index(src[start:], schemaClose)
	if j < 0 {
		return nil, errors.New("표의 끝(`\\n];`)을 찾지 못했습니다")
	}
	return src[start : start+j+2], nil // ']' 까지
}

// Load 는 원천 표를 읽어 서술자를 돌려준다.
func Load() ([]Spec, error) {
	src, err := raw()
	if err != nil {
		return nil, err
	}
	body, err := extract(src)
	if err != nil {
		return nil, err
	}
	var specs []Spec
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&specs); err != nil {
		return nil, fmt.Errorf("서술자 표가 순수 JSON 이 아닙니다 (FR-CFG-2): %w", err)
	}
	return specs, nil
}

// CheckShape 는 형태 계약만 확인한다 — 검사와 게이트가 부른다.
func CheckShape() error {
	specs, err := Load()
	if err != nil {
		return err
	}
	if len(specs) == 0 {
		return errors.New("서술자 표가 비었습니다")
	}
	seen := map[string]bool{}
	for _, s := range specs {
		if s.Key == "" {
			return errors.New("key 가 빈 서술자가 있습니다")
		}
		if seen[s.Key] {
			return fmt.Errorf("키가 두 번 나옵니다: %s", s.Key)
		}
		seen[s.Key] = true
		switch s.Type {
		case "string", "bool", "int", "object", "array", "any":
		default:
			return fmt.Errorf("%s: 알 수 없는 type %q", s.Key, s.Type)
		}
		if s.Where == "" {
			return fmt.Errorf("%s: where 가 비었습니다", s.Key)
		}
	}
	return nil
}

// ByKey 는 키로 찾을 수 있게 묶는다.
func ByKey(specs []Spec) map[string]Spec {
	m := make(map[string]Spec, len(specs))
	for _, s := range specs {
		m[s.Key] = s
	}
	return m
}

// Keys 는 정렬된 키 목록이다. 문서 대조와 `config show` 가 쓴다.
func Keys(specs []Spec) []string {
	out := make([]string, 0, len(specs))
	for _, s := range specs {
		out = append(out, s.Key)
	}
	sort.Strings(out)
	return out
}

// Validate 는 블롭을 서술자에 대조한다 (FR-CFG-8·9).
//
// **첫 오류에서 멈추지 않는다** — 고치고 다시 돌리는 왕복을 키 수만큼 시키지
// 않는다. 알 수 없는 키는 두 번째 반환값(경고)으로 갈라 나온다: 실패가 아니다
// (D-CFG-4). 판이 앞선 브라우저가 쓴 키가 빨갛게 뜨면 사용자가 멀쩡한 설정을 지운다.
func Validate(specs []Spec, blob []byte) (probs []Problem, unknown []string, err error) {
	var m map[string]any
	if err := json.Unmarshal(blob, &m); err != nil {
		return nil, nil, fmt.Errorf("JSON 이 아닙니다: %w", err)
	}
	by := ByKey(specs)
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		spec, ok := by[k]
		if !ok {
			unknown = append(unknown, k)
			continue
		}
		if p := check(spec, m[k]); p != nil {
			probs = append(probs, *p)
		}
	}
	return probs, unknown, nil
}

// check 는 값 하나를 서술자에 댄다. nil 이면 통과.
func check(s Spec, v any) *Problem {
	// null 은 "정한 적 없음" 이다 — 표의 기본값이 null 인 키(customTheme)가 있고,
	// 그 밖에서도 지우는 뜻으로 쓰인다. 범위를 묻지 않는다.
	if v == nil {
		return nil
	}
	switch s.Type {
	case "any":
		return nil
	case "bool":
		if _, ok := v.(bool); !ok {
			return &Problem{s.Key, "bool 이어야 합니다", v}
		}
	case "string":
		if _, ok := v.(string); !ok {
			return &Problem{s.Key, "string 이어야 합니다", v}
		}
	case "array":
		if _, ok := v.([]any); !ok {
			return &Problem{s.Key, "array 여야 합니다", v}
		}
	case "object":
		if _, ok := v.(map[string]any); !ok {
			return &Problem{s.Key, "object 여야 합니다", v}
		}
	case "int":
		f, ok := v.(float64)
		if !ok {
			return &Problem{s.Key, "정수여야 합니다", v}
		}
		n := int(f)
		if float64(n) != f {
			return &Problem{s.Key, "정수여야 합니다", v}
		}
		// FR-PIS-9: `0` 이 "그 계층을 걸지 않는다" 를 뜻하는 키만 0 을 통과시킨다.
		if n == 0 && s.Off {
			return nil
		}
		if s.Min != nil && n < *s.Min {
			return &Problem{s.Key, fmt.Sprintf("최솟값 %d 보다 작습니다", *s.Min), v}
		}
		if s.Max != nil && n > *s.Max {
			return &Problem{s.Key, fmt.Sprintf("최댓값 %d 보다 큽니다", *s.Max), v}
		}
	}
	return nil
}
