package claudeacct

// 라인과 묶는 창 (FR-CAC-71, cswap `lines.py`).

// labeledWindow 는 판단에 넣을 창과 그 창이 5시간 창인지다.
type labeledWindow struct {
	Window
	name string
	five bool
}

func (u *Usage) labeled(models map[string]bool) []labeledWindow {
	var out []labeledWindow
	if u.FiveHour != nil {
		out = append(out, labeledWindow{Window: *u.FiveHour, name: "five_hour", five: true})
	}
	if u.SevenDay != nil {
		out = append(out, labeledWindow{Window: *u.SevenDay, name: "seven_day"})
	}
	for _, s := range u.Scoped {
		if models == nil || models[s.Name] {
			out = append(out, labeledWindow{Window: s.Window, name: s.Name})
		}
	}
	return out
}

// lineHeadroom 은 창 하나의 라인 헤드룸이다. 0%→100, 라인→100-scale, 100%→0 의 구간 선형이다.
func lineHeadroom(pct, line, scale float64) float64 {
	if line == scale {
		return 100 - pct
	}
	if line >= 100 && pct >= 100 {
		return 0
	}
	if pct <= line {
		return (100 - scale) + scale*(line-pct)/line
	}
	return (100 - scale) * (100 - pct) / (100 - line)
}

// binding 은 계정을 붙잡는 창이다.
type binding struct {
	Name         string
	Pct          float64
	Line         float64
	ResetsAt     int64
	LineHeadroom float64
	Over         bool
}

// bindingOf 는 라인을 넘은 창을 먼저, 그다음 라인 헤드룸이 가장 작은 창을 고른다.
// weekly 가 nil 이면 모든 창이 threshold 를 라인으로 쓴다. 창이 없으면 false.
func bindingOf(u *Usage, models map[string]bool, threshold float64, weekly *float64, scale float64) (binding, bool) {
	var best binding
	found := false
	for _, w := range u.labeled(models) {
		line := threshold
		if weekly != nil && !w.five {
			line = *weekly
		}
		b := binding{Name: w.name, Pct: w.Pct, Line: line, ResetsAt: w.ResetsAt, LineHeadroom: lineHeadroom(w.Pct, line, scale), Over: w.Pct >= line}
		if !found || (b.Over && !best.Over) || (b.Over == best.Over && b.LineHeadroom < best.LineHeadroom) {
			best, found = b, true
		}
	}
	return best, found
}
