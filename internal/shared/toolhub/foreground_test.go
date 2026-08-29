package toolhub

import (
	"fmt"
	"strconv"
	"sync"
	"testing"
	"time"
)

// TestDerivedName은 파생 이름 규칙을 고정한다 (FR-TAN-10/11/13/14).
func TestDerivedName(t *testing.T) {
	cases := []struct{ in, want string }{
		{"vim", "vim"},
		{"claude", "claude"},
		{"node", "node"},
		// macOS ps -o comm= 은 실행 경로를 낸다 — 경로는 이름이 아니다.
		{"/usr/bin/vim", "vim"},
		{"  claude  ", "claude"},
		// 셸은 전경 프로그램이 아니다 (FR-TAN-11).
		{"sh", ""}, {"bash", ""}, {"zsh", ""}, {"fish", ""}, {"dash", ""},
		{"/bin/zsh", ""},
		// 로그인 셸의 '-' 접두.
		{"-zsh", ""}, {"-bash", ""},
		{"-someprog", "someprog"},
		// 16자로 자른다 (FR-TAN-13, V-TAN-11).
		{"abcdefghijklmnopqrst", "abcdefghijklmnop"},
		{"abcdefghijklmnop", "abcdefghijklmnop"},
		// 알아낼 수 없으면 이름 없음. 추측하지 않는다 (FR-TAN-5).
		{"", ""}, {"   ", ""}, {"/", ""}, {"-", ""},
	}
	for _, c := range cases {
		if got := derivedName(c.in); got != c.want {
			t.Errorf("derivedName(%q)=%q want %q", c.in, got, c.want)
		}
	}
}

// TestDerivedNameNoWrapperStripping은 래퍼를 벗기지 않는다는 규칙을 고정한다
// (FR-TAN-14). 셸 훅의 claude 함수는 `command claude` 로 실제 바이너리를 띄우며,
// 실측(V-TAN-20)에서도 전경 이름은 claude 였다 — 예외를 둘 이유가 없다.
func TestDerivedNameNoWrapperStripping(t *testing.T) {
	for _, name := range []string{"claude", "dmctl", "codex"} {
		if got := derivedName(name); got != name {
			t.Errorf("derivedName(%q)=%q — 래퍼를 벗기거나 매핑하면 안 된다", name, got)
		}
	}
}

// fakeFGProbe는 fgProbe를 결정론적 구현으로 갈아끼우고, 호출 기록을 돌려준다.
func fakeFGProbe(t *testing.T, fn func([]fgRequest) map[string]string) *[][]fgRequest {
	t.Helper()
	orig := fgProbe
	t.Cleanup(func() { fgProbe = orig })
	var mu sync.Mutex
	calls := &[][]fgRequest{}
	fgProbe = func(reqs []fgRequest) map[string]string {
		mu.Lock()
		*calls = append(*calls, reqs)
		mu.Unlock()
		return fn(reqs)
	}
	return calls
}

func adoptDetached(m *ToolManager, ids ...string) {
	for _, id := range ids {
		m.Adopt(NewDetachedTool(id, nil))
	}
}

// TestForegroundCacheHonorsInterval은 조회 주기를 고정한다 (FR-TAN-8, C-3).
// 주기 안에 몇 번을 물어도 조회는 한 번이다.
func TestForegroundCacheHonorsInterval(t *testing.T) {
	pm := NewToolManager(t.TempDir(), nil)
	t.Cleanup(pm.WaitSaves)
	adoptDetached(pm, "a", "b")
	calls := fakeFGProbe(t, func([]fgRequest) map[string]string {
		return map[string]string{"a": "vim"}
	})

	t0 := time.Now()
	for i := 0; i < 5; i++ {
		pm.refreshForeground(t0.Add(time.Duration(i) * 100 * time.Millisecond))
	}
	if len(*calls) != 1 {
		t.Fatalf("주기 안에서 조회가 %d회 — 1회여야 한다", len(*calls))
	}
	pm.refreshForeground(t0.Add(fgRefreshInterval))
	if len(*calls) != 2 {
		t.Fatalf("주기 경과 후 조회가 %d회 — 2회여야 한다", len(*calls))
	}
	if got := pm.ForegroundNames(); got["a"] != "vim" {
		t.Fatalf("ForegroundNames=%v want a=vim", got)
	}
	if _, ok := pm.ForegroundNames()["b"]; ok {
		t.Fatalf("전경 프로그램이 없는 도구는 결과에 담기지 않아야 한다")
	}
}

// TestForegroundNotifyOnlyOnChange는 값이 바뀌었을 때만 알린다는 것을 고정한다
// (FR-TAN-9). 같은 값을 반복 전송하지 않는다.
func TestForegroundNotifyOnlyOnChange(t *testing.T) {
	pm := NewToolManager(t.TempDir(), nil)
	t.Cleanup(pm.WaitSaves)
	adoptDetached(pm, "a")

	name := "vim"
	fakeFGProbe(t, func([]fgRequest) map[string]string {
		if name == "" {
			return nil
		}
		return map[string]string{"a": name}
	})

	var mu sync.Mutex
	var got [][2]string
	pm.SetForegroundNotifier(func(id, n string) {
		mu.Lock()
		got = append(got, [2]string{id, n})
		mu.Unlock()
	})

	t0 := time.Now()
	tick := func(i int) { pm.refreshForeground(t0.Add(time.Duration(i) * fgRefreshInterval)) }
	tick(0) // "" → vim
	tick(1) // vim → vim (알림 없음)
	tick(2) // vim → vim (알림 없음)
	name = "node"
	tick(3) // vim → node
	name = ""
	tick(4) // node → "" (프로그램 종료 — FR-TAN-12 의 서버측 근거)
	tick(5) // "" → "" (알림 없음)

	want := [][2]string{{"a", "vim"}, {"a", "node"}, {"a", ""}}
	mu.Lock()
	defer mu.Unlock()
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("알림=%v want %v", got, want)
	}
}

// TestForegroundBatchesEveryTool은 조회가 도구 수와 무관하게 한 번임을 고정한다
// (NFR-CNV-1, R4, V-TAN-18). macOS 폴백이 도구마다 ps 를 띄우면 여기서 깨진다.
func TestForegroundBatchesEveryTool(t *testing.T) {
	pm := NewToolManager(t.TempDir(), nil)
	t.Cleanup(pm.WaitSaves)
	const n = 100
	for i := 0; i < n; i++ {
		adoptDetached(pm, "t"+strconv.Itoa(i))
	}
	calls := fakeFGProbe(t, func(reqs []fgRequest) map[string]string {
		out := make(map[string]string, len(reqs))
		for _, r := range reqs {
			out[r.ID] = "vim"
		}
		return out
	})

	start := time.Now()
	pm.refreshForeground(start)
	elapsed := time.Since(start)

	if len(*calls) != 1 {
		t.Fatalf("도구 %d개에 조회 %d회 — 1회여야 한다", n, len(*calls))
	}
	if got := len((*calls)[0]); got != n {
		t.Fatalf("한 번의 조회가 도구 %d개만 받았다 — %d개여야 한다", got, n)
	}
	if elapsed >= fgRefreshInterval {
		t.Fatalf("도구 %d개 조회에 %v — 폴링 주기(%v) 안에 끝나야 한다", n, elapsed, fgRefreshInterval)
	}
	if got := pm.ForegroundNames(); len(got) != n {
		t.Fatalf("이름 %d개 — %d개여야 한다", len(got), n)
	}
}

// TestForegroundProbeFailureIsSilent는 조회 실패를 이름 없음으로 다루는 것을
// 고정한다 (FR-TAN-5, V-TAN-17). 예외도, 추측된 이름도 나오지 않는다.
func TestForegroundProbeFailureIsSilent(t *testing.T) {
	pm := NewToolManager(t.TempDir(), nil)
	t.Cleanup(pm.WaitSaves)
	adoptDetached(pm, "a")
	fakeFGProbe(t, func([]fgRequest) map[string]string { return nil })

	pm.refreshForeground(time.Now())
	if got := pm.ForegroundNames(); len(got) != 0 {
		t.Fatalf("조회 실패인데 이름이 나왔다: %v", got)
	}
	for _, m := range pm.List() {
		if m["fgName"] != "" {
			t.Fatalf("fgName=%v — 조회 실패는 빈 문자열이어야 한다", m["fgName"])
		}
	}
}

// TestForegroundListCarriesName은 이름이 도구 목록에 실려 나가는 것을 고정한다
// (FR-TAN-7, SRS §4.2). 데몬은 이 목록을 그대로 IPC 로 보낸다.
func TestForegroundListCarriesName(t *testing.T) {
	pm := NewToolManager(t.TempDir(), nil)
	t.Cleanup(pm.WaitSaves)
	adoptDetached(pm, "a", "b")
	fakeFGProbe(t, func([]fgRequest) map[string]string {
		return map[string]string{"a": "vim"}
	})

	seen := map[string]interface{}{}
	for _, m := range pm.List() {
		seen[m["id"].(string)] = m["fgName"]
	}
	if seen["a"] != "vim" {
		t.Fatalf("a.fgName=%v want vim", seen["a"])
	}
	if seen["b"] != "" {
		t.Fatalf("b.fgName=%v want \"\"", seen["b"])
	}
}

// TestForegroundCachePrunesDeadTools는 사라진 도구의 캐시가 남지 않는 것을
// 고정한다. 도구 id 는 재사용되지 않지만, 캐시가 무한히 자라면 안 된다.
func TestForegroundCachePrunesDeadTools(t *testing.T) {
	pm := NewToolManager(t.TempDir(), nil)
	t.Cleanup(pm.WaitSaves)
	tool, err := pm.Create(t.TempDir(), 80, 24)
	if err != nil {
		t.Skipf("PTY 를 띄울 수 없는 환경: %v", err)
	}
	fakeFGProbe(t, func(reqs []fgRequest) map[string]string {
		out := map[string]string{}
		for _, r := range reqs {
			out[r.ID] = "vim"
		}
		return out
	})

	pm.refreshForeground(time.Now())
	if _, ok := pm.ForegroundNames()[tool.ID]; !ok {
		t.Fatalf("살아 있는 도구의 이름이 없다")
	}
	pm.Delete(tool.ID)
	pm.refreshForeground(time.Now())

	pm.fgMu.Lock()
	n := len(pm.fgCache)
	pm.fgMu.Unlock()
	if n != 0 {
		t.Fatalf("삭제된 도구의 캐시가 %d건 남았다", n)
	}
}

// TestForegroundNoNotifyOnInitialEmpty는 첫 조회가 빈 결과일 때 알리지 않는
// 것을 고정한다 (FR-TAN-9). 프롬프트에서 대기 중인 도구가 열릴 때마다 빈
// 이름을 방송하면 같은 값을 반복 전송하는 것과 같다.
func TestForegroundNoNotifyOnInitialEmpty(t *testing.T) {
	pm := NewToolManager(t.TempDir(), nil)
	t.Cleanup(pm.WaitSaves)
	adoptDetached(pm, "a")
	fakeFGProbe(t, func([]fgRequest) map[string]string { return nil })

	var n int
	pm.SetForegroundNotifier(func(string, string) { n++ })
	pm.refreshForeground(time.Now())
	if n != 0 {
		t.Fatalf("첫 조회가 빈 결과인데 알림이 %d회 나갔다", n)
	}
}
