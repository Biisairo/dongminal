// Package decidx 는 SRS 에 흩어진 **결정**을 색인한다 (M5 `G8-1`, ADR-lite).
//
// 이 저장소는 결정을 SRS 안에 적어 왔다. 그것은 옳다 — 결정은 그것을 낳은 요구
// 옆에 있어야 뜻이 통한다. 문제는 **찾는 길**이었다: "우리가 왜 이렇게 했더라"
// 를 물으면 136개 문서를 뒤져야 했고, 그래서 같은 결정이 두 번 논의됐다.
//
// **옮기지 않는다.** 원문은 SRS 에 그대로 두고 색인만 만든다 — 옮기면 근거가
// 요구에서 떨어지고, 그때 결정은 맥락 없는 문장이 된다.
//
// 생성물인 이유는 `errors.md` 와 같다 (D-ERR-3): 손으로 적은 색인은 조용히 낡고,
// 낡은 색인은 없는 것보다 나쁘다 — 있다고 믿게 만든다.
package decidx

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// Entry 는 결정 하나다.
type Entry struct {
	ID     string
	Title  string
	Why    string
	Source string // SRS 파일 이름
	Status string
}

var (
	// 표 행: `| **D-CFG-1** | 제목 | 근거 |` — 이 저장소가 가장 많이 쓰는 형태.
	rowRe = regexp.MustCompile(`^\|\s*\*{0,2}(D-[A-Z0-9]+(?:-[0-9]+)?)\*{0,2}\s*\|(.*)$`)
	// 굵은 머리: `**D-CAF-1: 제목**` 또는 `**D-CAF-1** 제목`
	headRe = regexp.MustCompile(`^\*\*(D-[A-Z0-9]+(?:-[0-9]+)?)[:：]?\*{0,2}\s*(.*?)\*{0,2}\s*$`)
	// 취소선으로 철회 표기한 것 — 이 저장소의 관행이다.
	struckRe = regexp.MustCompile(`~~\s*\*{0,2}(D-[A-Z0-9]+(?:-[0-9]+)?)`)
)

// Collect 는 dir 아래 SRS 전부에서 결정을 모은다.
func Collect(dir string) ([]Entry, error) {
	paths, err := filepath.Glob(filepath.Join(dir, "*_SRS.md"))
	if err != nil {
		return nil, err
	}
	sort.Strings(paths)

	seen := map[string]bool{}
	var out []Entry
	for _, p := range paths {
		data, err := os.ReadFile(p)
		if err != nil {
			return nil, err
		}
		name := filepath.Base(p)
		text := string(data)
		struck := map[string]bool{}
		for _, m := range struckRe.FindAllStringSubmatch(text, -1) {
			struck[m[1]] = true
		}
		for _, line := range strings.Split(text, "\n") {
			e, ok := parseLine(line)
			if !ok {
				continue
			}
			e.Source = name
			// **같은 ID 가 여러 문서에 있다.** 접두사 없는 `D-1` 이 특히 그렇다 —
			// 문서마다 1번부터 세기 때문이다. 색인에서는 출처로 갈라 준다.
			key := name + "/" + e.ID
			if seen[key] {
				continue
			}
			seen[key] = true
			if struck[e.ID] {
				e.Status = "철회"
			}
			out = append(out, e)
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Source != out[j].Source {
			return out[i].Source < out[j].Source
		}
		return idLess(out[i].ID, out[j].ID)
	})
	return out, nil
}

// parseLine 은 한 줄에서 결정을 읽는다.
func parseLine(line string) (Entry, bool) {
	t := strings.TrimSpace(line)
	// 표의 구분선·헤더는 건너뛴다.
	if strings.HasPrefix(t, "|---") || strings.HasPrefix(t, "| ---") {
		return Entry{}, false
	}
	if m := rowRe.FindStringSubmatch(t); m != nil {
		cells := splitCells(m[2])
		e := Entry{ID: m[1], Status: "채택"}
		if len(cells) > 0 {
			e.Title = cells[0]
		}
		if len(cells) > 1 {
			e.Why = cells[1]
		}
		if e.Title == "" {
			return Entry{}, false
		}
		return e, true
	}
	if m := headRe.FindStringSubmatch(t); m != nil {
		title := strings.TrimSpace(strings.TrimSuffix(m[2], "**"))
		if title == "" {
			return Entry{}, false
		}
		// 자유 서술형 결정은 여러 줄로 이어진다. 색인은 첫 줄만 들므로,
		// **잘렸다는 사실이 보이게** 한다 — 문장이 중간에서 끝난 것처럼 읽히면
		// 독자는 그것이 결정의 전부라고 믿는다.
		if !endsSentence(title) {
			title += "…"
		}
		return Entry{ID: m[1], Title: title, Status: "채택"}, true
	}
	return Entry{}, false
}

// endsSentence 는 줄이 문장으로 끝났는지 본다.
func endsSentence(s string) bool {
	if s == "" {
		return true
	}
	r := []rune(s)
	switch r[len(r)-1] {
	case '.', '!', '?', ')', ']', '»', '」', '”', ':':
		return true
	}
	// 한국어 종결 어미. 완벽하지 않아도 되는 판정이다 — 틀리면 말줄임표가
	// 하나 더 붙거나 덜 붙을 뿐이다.
	return strings.HasSuffix(s, "다") || strings.HasSuffix(s, "음") || strings.HasSuffix(s, "함")
}

func splitCells(rest string) []string {
	rest = strings.TrimSuffix(strings.TrimSpace(rest), "|")
	var out []string
	for _, c := range strings.Split(rest, "|") {
		out = append(out, strings.TrimSpace(c))
	}
	return out
}

// idLess 는 `D-X-2` 가 `D-X-10` 보다 앞서게 한다. 문자열 비교면 뒤집힌다.
func idLess(a, b string) bool {
	pa, na := splitID(a)
	pb, nb := splitID(b)
	if pa != pb {
		return pa < pb
	}
	return na < nb
}

func splitID(s string) (string, int) {
	i := strings.LastIndex(s, "-")
	if i < 0 {
		return s, 0
	}
	n, err := strconv.Atoi(s[i+1:])
	if err != nil {
		return s, 0
	}
	return s[:i], n
}

// Render 는 색인 문서를 만든다.
func Render(entries []Entry) string {
	var b strings.Builder
	b.WriteString(`<!-- 이 파일은 생성물입니다. 직접 고치지 마세요.
     원천: docs/internal/*_SRS.md 의 결정 항목
     생성: dongminal 저장소에서 ` + "`go run ./scripts/gen-decisions`" + `
     검사: scripts/check-decisions.sh (CI) -->

# 결정 색인 (ADR-lite)

이 저장소는 결정을 **그것을 낳은 요구 옆에** 적습니다 — SRS 안입니다. 옳은
자리이지만 찾는 길이 없었습니다: "우리가 왜 이렇게 했더라" 를 물으면 문서
백여 개를 뒤져야 했고, 그래서 같은 결정이 두 번 논의됐습니다.

이 문서가 그 길입니다. **원문을 옮기지 않습니다** — 근거가 요구에서 떨어지면
결정은 맥락 없는 문장이 되기 때문입니다. 여기 있는 것은 제목과 링크뿐이고,
읽을 것은 저쪽입니다.

## 상태

| 값 | 뜻 |
|---|---|
| 채택 | 지금 코드가 이것을 따릅니다 |
| 철회 | 뒤집혔습니다. 원문에 취소선과 대체 항목이 적혀 있습니다 |

`)
	var cur string
	for _, e := range entries {
		if e.Source != cur {
			cur = e.Source
			fmt.Fprintf(&b, "\n## [`%s`](./%s)\n\n| ID | 결정 | 근거 | 상태 |\n|---|---|---|---|\n",
				strings.TrimSuffix(cur, ".md"), cur)
		}
		fmt.Fprintf(&b, "| `%s` | %s | %s | %s |\n",
			e.ID, cell(e.Title), cell(e.Why), e.Status)
	}
	fmt.Fprintf(&b, "\n---\n\n결정 **%d건** · 문서 **%d개**.\n", len(entries), countSources(entries))
	return b.String()
}

func countSources(entries []Entry) int {
	m := map[string]bool{}
	for _, e := range entries {
		m[e.Source] = true
	}
	return len(m)
}

// cell 은 표 칸에 들어갈 수 없는 글자를 피한다. 파이프가 칸을 쪼갠다.
func cell(s string) string {
	s = strings.ReplaceAll(s, "|", `\|`)
	s = strings.ReplaceAll(s, "\n", " ")
	// 너무 길면 색인이 아니라 사본이 된다. 읽을 것은 원문이다.
	const max = 140
	if len([]rune(s)) > max {
		s = string([]rune(s)[:max]) + "…"
	}
	return s
}
