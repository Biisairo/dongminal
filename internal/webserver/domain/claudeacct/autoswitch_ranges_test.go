package claudeacct

import (
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"sort"
	"strings"
	"testing"
)

// REFACTOR3_FE_REST1_SRS TC-FR1-7 (FC-11): 자동 전환 숫자 칸의 범위는 `AutoRanges` 하나가 원천이다.
// `Validate` 가 그 표로 판정하고, 응답(`AutoView.ranges`)이 그 표를 싣는다.
func TestAutoRanges_SourceOfValidate(t *testing.T) {
	want := []string{"cooldownSeconds", "hysteresisPct", "intervalSeconds", "threshold", "unhealthyTicks", "weeklyThreshold"}
	var keys []string
	for k := range AutoRanges {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	if !reflect.DeepEqual(keys, want) {
		t.Fatalf("keys = %v, want %v", keys, want)
	}
	// 키는 AutoSettings 의 JSON 이름이다.
	raw, _ := json.Marshal(DefaultAutoSettings())
	for _, k := range keys {
		if !strings.Contains(string(raw), `"`+k+`"`) && k != "weeklyThreshold" {
			t.Errorf("%s 는 AutoSettings 의 JSON 이름이 아니다", k)
		}
	}
	x := newAutoEnv(t)
	for _, k := range keys {
		r := AutoRanges[k]
		for _, v := range []float64{r.Min, r.Max} {
			if _, err := x.auto.Put([]byte(fmt.Sprintf(`{%q:%v}`, k, v))); err != nil {
				t.Errorf("%s=%v 는 범위 안이다: %v", k, v, err)
			}
		}
		for _, v := range []float64{r.Min - 1, r.Max + 1} {
			if _, err := x.auto.Put([]byte(fmt.Sprintf(`{%q:%v}`, k, v))); !errors.Is(err, ErrInvalid) {
				t.Errorf("%s=%v 는 범위 밖이다: %v", k, v, err)
			}
		}
	}
	v := x.auto.View()
	if !reflect.DeepEqual(v.Ranges, AutoRanges) {
		t.Fatalf("View().Ranges = %v", v.Ranges)
	}
	out, _ := json.Marshal(v)
	if !strings.Contains(string(out), `"ranges":{`) || !strings.Contains(string(out), `"intervalSeconds":{"min":15,"max":3600}`) {
		t.Fatalf("응답에 ranges 가 없다: %s", out)
	}
}
