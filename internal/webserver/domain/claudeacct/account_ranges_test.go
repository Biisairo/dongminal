package claudeacct

import (
	"errors"
	"reflect"
	"sort"
	"strings"
	"testing"
)

// REFACTOR3_FE_FIX_SRS TC-FFX-15 (FX-7): 계정 행 칸의 범위는 `AccountRanges` 하나가 원천이다.
// `Patch.Validate` 가 그 표로 판정하고, 값과 오류 문구는 종전과 같다.
func TestAccountRanges_SourceOfValidate(t *testing.T) {
	var keys []string
	for k := range AccountRanges {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	if want := []string{"alias", "priority", "threshold"}; !reflect.DeepEqual(keys, want) {
		t.Fatalf("keys = %v, want %v", keys, want)
	}
	want := map[string]AutoRange{"alias": {0, 24}, "threshold": {50, 100}, "priority": {0, 1000}}
	if !reflect.DeepEqual(AccountRanges, want) {
		t.Fatalf("AccountRanges = %v, want %v — 값은 바꾸지 않는다", AccountRanges, want)
	}

	patch := func(k string, v float64) Patch {
		switch k {
		case "alias":
			s := strings.Repeat("가", int(v))
			return Patch{Alias: &s}
		case "threshold":
			return Patch{Threshold: &v}
		default:
			n := int(v)
			return Patch{Priority: &n}
		}
	}
	for _, k := range keys {
		r := AccountRanges[k]
		for _, v := range []float64{r.Min, r.Max} {
			if err := patch(k, v).Validate(); err != nil {
				t.Errorf("%s=%v 는 범위 안이다: %v", k, v, err)
			}
		}
		out := []float64{r.Max + 1}
		if k != "alias" {
			out = append(out, r.Min-1)
		}
		for _, v := range out {
			if err := patch(k, v).Validate(); !errors.Is(err, ErrInvalid) {
				t.Errorf("%s=%v 는 범위 밖이다: %v", k, v, err)
			}
		}
	}

	for k, msg := range map[string]string{
		"alias":     "값이 범위를 벗어났습니다: 별칭은 24자 이하입니다",
		"threshold": "값이 범위를 벗어났습니다: 문턱값은 50~100.0 입니다",
		"priority":  "값이 범위를 벗어났습니다: 우선순위는 0~1000 입니다",
	} {
		if err := patch(k, AccountRanges[k].Max+1).Validate(); err == nil || err.Error() != msg {
			t.Errorf("%s 오류 = %v, want %q", k, err, msg)
		}
	}
}
