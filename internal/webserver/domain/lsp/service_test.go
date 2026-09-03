package lsp

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"
)

func testService(t *testing.T, onPath map[string]string,
	exec func(context.Context, string, []string, []string, string) ([]byte, error)) (*Service, string) {
	t.Helper()
	dir := t.TempDir()
	look := func(name string) (string, error) {
		if p, ok := onPath[name]; ok {
			return p, nil
		}
		return "", errors.New("not found")
	}
	return &Service{
		Dir:      dir,
		LookPath: look,
		Exec:     exec,
	}, dir
}

// TC-LSP-20 (FR-LSP-5·46 / V-LSP-3): 상태는 서술자마다 한 줄이며 어디서 찾았는지를
// 싣는다. 설정창이 그릴 것이 이 목록이다.
func TestService_StatusCoversEveryDescriptor(t *testing.T) {
	svc, _ := testService(t, map[string]string{"gopls": "/usr/bin/gopls", "go": "/usr/bin/go"}, nil)

	got := svc.Status(nil)
	if len(got) != len(Descriptors()) {
		t.Fatalf("서술자 수와 상태 줄 수가 다르다: %d vs %d", len(got), len(Descriptors()))
	}
	var gopls *Status
	for i := range got {
		if got[i].ID == "gopls" {
			gopls = &got[i]
		}
	}
	if gopls == nil {
		t.Fatal("gopls 줄이 없다")
	}
	if !gopls.Found || gopls.Origin != OriginPath {
		t.Fatalf("PATH 의 gopls 를 그렇게 보고하지 않았다: %+v", *gopls)
	}
	if !gopls.CanInstall {
		t.Fatalf("go 가 있는데 설치 가능이 아니다: %+v", *gopls)
	}
}

// TC-LSP-21 (FR-LSP-4·4b): 요청이 실은 절대경로가 탐색의 첫째다.
func TestService_StatusHonorsOverrides(t *testing.T) {
	svc, dir := testService(t, map[string]string{"gopls": "/usr/bin/gopls"}, nil)
	g, _ := DescriptorForExt(".go")
	mine := putManaged(t, dir, g) // 그냥 실행 가능한 아무 파일

	got := svc.Status(map[string]string{"gopls": mine})
	for _, st := range got {
		if st.ID != "gopls" {
			continue
		}
		if st.Origin != OriginConfig || st.Exe != mine {
			t.Fatalf("요청이 실은 경로가 이기지 않았다: %+v", st)
		}
		return
	}
	t.Fatal("gopls 줄이 없다")
}

// TC-LSP-22 (FR-LSP-48 / V-LSP-3b): 설치 중에는 두 번째 요청이 거절되고, 그 사실이
// 상태에 실린다.
//
// 판정을 서버가 하는 근거는 화면의 비활성으로는 **다른 탭·다른 기기**에서 누른
// 두 번째 설치를 막지 못한다는 것이다.
func TestService_InstallIsSingleFlight(t *testing.T) {
	release := make(chan struct{})
	var calls int
	var mu sync.Mutex
	svc, _ := testService(t, map[string]string{"go": "/usr/bin/go"},
		func(ctx context.Context, _ string, _, _ []string, _ string) ([]byte, error) {
			mu.Lock()
			calls++
			mu.Unlock()
			<-release
			return nil, nil
		})

	started := make(chan struct{})
	done := make(chan InstallOutcome, 1)
	go func() {
		close(started)
		done <- svc.Install(context.Background(), "gopls")
	}()
	<-started

	// 첫 설치가 실제로 들어가기를 기다린다.
	deadline := time.Now().Add(2 * time.Second)
	for {
		mu.Lock()
		in := calls
		mu.Unlock()
		if in > 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("첫 설치가 시작되지 않았다")
		}
		time.Sleep(5 * time.Millisecond)
	}

	// 상태가 "설치 중" 을 알린다.
	for _, st := range svc.Status(nil) {
		if st.ID == "gopls" && !st.Installing {
			t.Fatalf("설치 중인데 상태가 알리지 않았다: %+v", st)
		}
	}
	// 두 번째는 거절된다 — 명령이 다시 돌지 않는다.
	second := svc.Install(context.Background(), "gopls")
	if second.OK {
		t.Fatal("설치 중인데 두 번째 설치가 성공했다고 했다")
	}
	if second.Reason == "" {
		t.Fatal("거절에 사유가 없다")
	}

	close(release)
	<-done

	mu.Lock()
	defer mu.Unlock()
	if calls != 1 {
		t.Fatalf("설치 명령이 %d 번 돌았다 — 한 번이어야 한다", calls)
	}
	// 끝난 뒤에는 더 이상 설치 중이 아니다.
	for _, st := range svc.Status(nil) {
		if st.ID == "gopls" && st.Installing {
			t.Fatalf("끝났는데 설치 중으로 남았다: %+v", st)
		}
	}
}

// TC-LSP-23 (FR-LSP-1): 모르는 서술자 id 는 거절된다 — 사유와 함께.
func TestService_InstallUnknownID(t *testing.T) {
	svc, _ := testService(t, map[string]string{"go": "/usr/bin/go"}, nil)
	got := svc.Install(context.Background(), "no-such-server")
	if got.OK {
		t.Fatal("모르는 id 로 설치가 성공했다고 했다")
	}
	if got.Reason == "" {
		t.Fatal("사유가 없다")
	}
}

// TC-LSP-24 (FR-LSP-44): 상태에 확장자가 실린다 — 화면이 "이 파일의 서버가
// 있는가" 를 판정할 근거다. 화면이 그 표를 따로 적으면 서술자와 어긋난다.
func TestService_StatusCarriesExts(t *testing.T) {
	svc, _ := testService(t, nil, nil)
	for _, st := range svc.Status(nil) {
		if len(st.Exts) == 0 {
			t.Fatalf("%s 에 확장자가 없다", st.ID)
		}
	}
	// .go 가 어느 줄에도 없으면 화면은 Go 파일의 제안을 띄울 수 없다.
	found := false
	for _, st := range svc.Status(nil) {
		for _, e := range st.Exts {
			if e == ".go" {
				found = true
			}
		}
	}
	if !found {
		t.Fatal(".go 를 덮는 줄이 없다")
	}
}
