package lsp

import (
	"bufio"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
)

// endless 는 끝없이 같은 바이트를 준다 — 줄바꿈이 오지 않는 헤더다.
type endless byte

func (e endless) Read(p []byte) (int, error) {
	for i := range p {
		p[i] = byte(e)
	}
	return len(p), nil
}

// TC-ATF-29 (FR-ATF-29 / AT-LSP-1): 헤더 한 줄에 상한이 있다. 줄바꿈 없이 흘러오는
// 헤더가 메모리를 잡지 못하고 오류로 끝난다(호출자가 연결을 닫는다).
func TestReadFrame_HeaderLineCap(t *testing.T) {
	_, err := readFrame(bufio.NewReader(endless('a')))
	if !errors.Is(err, ErrHeaderTooLarge) {
		t.Fatalf("err = %v, want ErrHeaderTooLarge", err)
	}
}

// TC-ATF-29 (FR-ATF-29): 헤더 총량에도 상한이 있다 — 짧은 줄이 끝없이 와도 끝난다.
func TestReadFrame_HeaderTotalCap(t *testing.T) {
	raw := strings.Repeat("X-Pad: 1\r\n", maxHeaderBytes) + "Content-Length: 2\r\n\r\n{}"
	_, err := readFrame(bufio.NewReader(strings.NewReader(raw)))
	if !errors.Is(err, ErrHeaderTooLarge) {
		t.Fatalf("err = %v, want ErrHeaderTooLarge", err)
	}
}

// TC-ATF-30 (FR-ATF-30 / AT-LSP-2): 동시 PUT 뒤에도 디스크의 경로표와 메모리의 표가 같다.
// 저장이 잠금 밖이면 A 저장 → B 저장 → B 갱신 → A 갱신 순서로 둘이 갈린다.
func TestSetPaths_ConcurrentPutPersistsSameAsMemory(t *testing.T) {
	svc := svcWith(t, nil, nil)
	file := filepath.Join(t.TempDir(), "lsp-paths.json")
	if err := svc.LoadPaths(file); err != nil {
		t.Fatal(err)
	}
	base := t.TempDir()
	for round := range concurrentPutRounds {
		var wg sync.WaitGroup
		for i := range concurrentPuts {
			wg.Add(1)
			go func() {
				defer wg.Done()
				p := filepath.Join(base, "gopls-"+strconv.Itoa(round)+"-"+strconv.Itoa(i))
				if _, err := svc.SetPaths(map[string]string{"gopls/gopls": p}); err != nil {
					t.Error(err)
				}
			}()
		}
		wg.Wait()
		raw, err := os.ReadFile(file)
		if err != nil {
			t.Fatal(err)
		}
		var onDisk pathsFileBody
		if err := json.Unmarshal(raw, &onDisk); err != nil {
			t.Fatal(err)
		}
		if mem := svc.Paths()["gopls/gopls"]; onDisk.Paths["gopls/gopls"] != mem {
			t.Fatalf("round %d: 디스크 %q ≠ 메모리 %q", round, onDisk.Paths["gopls/gopls"], mem)
		}
	}
}

const (
	concurrentPutRounds = 30
	concurrentPuts      = 8
)

// TC-ATF-29 (FR-ATF-29): 상한 안의 헤더는 그대로 읽는다.
func TestReadFrame_HeaderAtLineCap(t *testing.T) {
	pad := "X-Pad: " + strings.Repeat("a", maxHeaderLine-len("X-Pad: \r\n"))
	raw := pad + "\r\nContent-Length: 2\r\n\r\n{}"
	got, err := readFrame(bufio.NewReader(strings.NewReader(raw)))
	if err != nil || string(got) != "{}" {
		t.Fatalf("readFrame = %q %v", got, err)
	}
}

// TC-ATF-71 (FR-ATF-71 / AT-EXT-13): 파일에서 읽은 경로표의 상대경로는 무시한다
// (SetPaths 와 같은 규칙). 절대경로 값은 그대로 남는다.
func TestLoadPaths_IgnoresNonAbsolute(t *testing.T) {
	abs := filepath.Join(t.TempDir(), "my-gopls")
	file := filepath.Join(t.TempDir(), "lsp-paths.json")
	data, err := json.Marshal(pathsFileBody{Paths: map[string]string{
		"gopls/gopls":                           abs,
		"typescript/typescript-language-server": "rel/tsls",
	}})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, data, 0o644); err != nil {
		t.Fatal(err)
	}
	svc := svcWith(t, nil, nil)
	if err := svc.LoadPaths(file); err != nil {
		t.Fatal(err)
	}
	got := svc.Paths()
	if len(got) != 1 || got["gopls/gopls"] != abs {
		t.Fatalf("Paths = %v, want 절대경로 하나만", got)
	}
}

// TC-ATF-73 (FR-ATF-73 / AT-LSP-7): PUT 의 모르는 키(지금 없는 팩)는 오류 없이 버린다.
// 아는 키는 저장되고, 버린 키는 메모리에도 파일에도 남지 않는다.
func TestSetPaths_DropsUnknownKeys(t *testing.T) {
	svc := svcWith(t, nil, nil)
	file := filepath.Join(t.TempDir(), "lsp-paths.json")
	if err := svc.LoadPaths(file); err != nil {
		t.Fatal(err)
	}
	abs := filepath.Join(t.TempDir(), "my-gopls")
	got, err := svc.SetPaths(map[string]string{"gopls/gopls": abs, "gone/gone": "/x"})
	if err != nil {
		t.Fatalf("SetPaths = %v", err)
	}
	if len(got) != 1 || got["gopls/gopls"] != abs {
		t.Fatalf("Paths = %v, want 아는 키 하나만", got)
	}
	raw, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	var onDisk pathsFileBody
	if err := json.Unmarshal(raw, &onDisk); err != nil {
		t.Fatal(err)
	}
	if _, ok := onDisk.Paths["gone/gone"]; ok || onDisk.Paths["gopls/gopls"] != abs {
		t.Fatalf("파일 = %s", raw)
	}
}
