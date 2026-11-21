package httpapi

import (
	"reflect"
	"testing"

	"dongminal/internal/webserver/hub"
)

// REFACTOR3_GO_STRUCT_SRS FR-RGS-1: 명령 처리기에서 뗀 판정 함수.

func TestSSESubPlanFor(t *testing.T) {
	cases := []struct {
		name     string
		cid      string
		presence bool
		want     sseSubPlan
	}{
		{"신원 없는 방송 구독", "", false, sseSubPlan{update: true}},
		{"신원 있는 방송 구독", "c1", false, sseSubPlan{focus: true, gitWatch: true, fsWatch: true, update: true}},
		{"신원 없는 칸 구독", "", true, sseSubPlan{}},
		{"신원 있는 칸 구독은 파일 감시·업데이트를 쥐지 않는다", "c1", true, sseSubPlan{focus: true, gitWatch: true}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := sseSubPlanFor(c.cid, c.presence); got != c.want {
				t.Fatalf("got %+v, want %+v", got, c.want)
			}
		})
	}
}

func TestCommandLocField(t *testing.T) {
	cases := []struct {
		name, orig, final, want string
	}{
		{"없음", "", "", ""},
		{"좌표 그대로", "W1.P1.T1", "W1.P1.T1", " location=W1.P1.T1"},
		{"uuid 를 좌표로", "u-1", "W1.P1.T1", " location=W1.P1.T1 uuid=u-1"},
		{"좌표를 모르면 비운다", "u-1", "", ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := commandLocField(c.orig, c.final); got != c.want {
				t.Fatalf("got %q, want %q", got, c.want)
			}
		})
	}
}

func TestPutCommandResult(t *testing.T) {
	pos := &hub.CmdPosition{}
	cases := []struct {
		name     string
		res      hub.CmdResult
		n        int
		timedOut bool
		want     map[string]interface{}
	}{
		{
			name: "빈 선택 필드는 싣지 않는다",
			n:    2,
			want: map[string]interface{}{
				"delivered": 2, "newWindows": []string(nil), "newPanes": []string(nil),
				"newTabs": []hub.TabRef(nil), "timedOut": false,
			},
		},
		{
			name:     "선택 필드가 있으면 싣는다",
			res:      hub.CmdResult{NewGroups: []string{"g"}, Position: pos, Error: "e"},
			n:        1,
			timedOut: true,
			want: map[string]interface{}{
				"delivered": 1, "newWindows": []string(nil), "newPanes": []string(nil),
				"newTabs": []hub.TabRef(nil), "timedOut": true,
				"newGroups": []string{"g"}, "position": pos, "error": "e",
			},
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := map[string]interface{}{}
			putCommandResult(got, c.res, c.n, c.timedOut)
			if !reflect.DeepEqual(got, c.want) {
				t.Fatalf("got %#v, want %#v", got, c.want)
			}
		})
	}
}
