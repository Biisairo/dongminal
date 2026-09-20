package decidx

import (
	"os"
	"path/filepath"
	"testing"
)

// DOC_SYNC_SRS 묶음 D-A — 색인이 **이 저장소가 쓰는 형식**을 읽는다
// (FR-DSY-10~14 · TC-DSY-1~3).
//
// 착수 시 색인은 표 행과 **줄머리 굵은 글씨**만 읽었다. 이 저장소의 SRS 49개가
// 결정을 목록(`- **D-X …**`)으로 적고 있었고, 그래서 게이트가 초록인 채로
// **323건**을 놓쳤다 (609 → 932). 그 수가 D-DSY-1 을 정했다.

func writeSRS(t *testing.T, dir, name, body string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func ids(es []Entry) []string {
	out := make([]string, 0, len(es))
	for _, e := range es {
		out = append(out, e.ID)
	}
	return out
}

func has(es []Entry, id string) *Entry {
	for i := range es {
		if es[i].ID == id {
			return &es[i]
		}
	}
	return nil
}

// TC-DSY-1: 목록 형식의 결정이 색인에 든다.
func TestCollect_ReadsListForm(t *testing.T) {
	dir := t.TempDir()
	writeSRS(t, dir, "A_SRS.md", `# A

## 4. 결정

- **D-AAA-1 첫 결정이다.** 근거가 이어진다.
- **D-AAA-2 둘째 결정이다.**
`)
	got, err := Collect(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 {
		t.Fatalf("결정 %v — 둘이어야 한다", ids(got))
	}
	if e := has(got, "D-AAA-1"); e == nil || e.Title != "첫 결정이다." {
		t.Fatalf("D-AAA-1 = %+v", e)
	}
}

// TC-DSY-3: 불릿 셋을 다 받는다. 하나만 받으면 다음 문서가 다른 것을 쓰고 같은 일이 난다.
func TestCollect_AcceptsEveryBullet(t *testing.T) {
	dir := t.TempDir()
	writeSRS(t, dir, "B_SRS.md", `# B

- **D-BBB-1 대시.**
* **D-BBB-2 별표.**
+ **D-BBB-3 더하기.**
`)
	got, err := Collect(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 3 {
		t.Fatalf("결정 %v — 셋이어야 한다", ids(got))
	}
}

// TC-DSY-3: `D-<대문자>-<숫자>` 가 아닌 것은 잡지 않는다. 넓힌 패턴이 산문을
// 줍기 시작하면 색인이 **믿을 수 없는 것**이 된다.
func TestCollect_IgnoresNonDecisions(t *testing.T) {
	dir := t.TempDir()
	writeSRS(t, dir, "C_SRS.md", `# C

- **D-Day 는 결정이 아니다.**
- **DECIDE-1 도 아니다.**
- **참고** 굵은 글씨일 뿐이다.
- **D-CCC-1 이것만 결정이다.**
`)
	got, err := Collect(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].ID != "D-CCC-1" {
		t.Fatalf("결정 %v — D-CCC-1 하나여야 한다", ids(got))
	}
}

// TC-DSY-2: 표 행·취소선의 답이 **그대로다.** 이 변경은 못 읽던 것을 읽게 할 뿐이고,
// 읽던 것의 답을 바꾸지 않는다 (FR-DSY-13).
func TestCollect_TableAndStruckUnchanged(t *testing.T) {
	dir := t.TempDir()
	writeSRS(t, dir, "D_SRS.md", `# D

| ID | 결정 | 근거 |
|---|---|---|
| **D-DDD-1** | 표 행의 결정 | 그 근거 |
| ~~**D-DDD-2**~~ | 철회된 결정 | 그 근거 |
| **D-DDD-3** | 철회된 결정의 원문 | 그 근거 |

~~**D-DDD-3**~~ 는 철회했다.
`)
	got, err := Collect(dir)
	if err != nil {
		t.Fatal(err)
	}
	one := has(got, "D-DDD-1")
	if one == nil || one.Title != "표 행의 결정" || one.Why != "그 근거" || one.Status != "채택" {
		t.Fatalf("D-DDD-1 = %+v", one)
	}
	// **취소선만 있는 행은 애초에 항목이 아니다** — `rowRe` 가 `~~` 를 받지 않는다.
	// 그 행은 "철회했다" 는 기록이고, 철회 표시는 **다른 자리에서 항목으로 잡힌
	// 결정**에 붙는다. 그 계약이 그대로인지를 아래가 잠근다.
	if has(got, "D-DDD-2") != nil {
		t.Fatalf("취소선만 있는 행이 항목이 됐다: %v", ids(got))
	}
	three := has(got, "D-DDD-3")
	if three == nil || three.Status != "철회" {
		t.Fatalf("D-DDD-3 = %+v — 취소선 판정이 달라졌다", three)
	}
}

// 목록 형식은 여러 줄로 이어진다. 색인은 첫 줄만 들므로 **잘렸다는 사실이 보여야**
// 한다 — 문장이 중간에서 끝난 것처럼 읽히면 독자는 그것이 결정의 전부라고 믿는다.
func TestCollect_MarksTruncatedListTitle(t *testing.T) {
	dir := t.TempDir()
	writeSRS(t, dir, "E_SRS.md", `# E

- **D-EEE-1 이 결정은 다음 줄로 이어지고
  여기서 끝난다.**
`)
	got, err := Collect(dir)
	if err != nil {
		t.Fatal(err)
	}
	e := has(got, "D-EEE-1")
	if e == nil {
		t.Fatalf("결정 %v", ids(got))
	}
	if len(e.Title) == 0 || e.Title[len(e.Title)-3:] != "…" {
		t.Fatalf("Title = %q — 잘린 것이 보이지 않는다", e.Title)
	}
}
