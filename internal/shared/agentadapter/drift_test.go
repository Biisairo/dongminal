//go:build agentdrift

package agentadapter

import (
	"bufio"
	"bytes"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"
)

// 계약 드리프트 대조 잡 (M8_UNIFIED_SRS D-U-5 · §9.2 R-a · V-1 의 "드리프트", P4 결정).
//
// CI 에는 없다 — 실제 바이너리와 자격증명이 없다. 로컬에서 **단계 착수마다 · 바이너리
// 판이 오를 때** 돈다:
//
//	go test -tags agentdrift -run TestDrift -v ./internal/shared/agentadapter/
//
// 무모델 프레임만 잰다: 어댑터의 Launch·Handshake 로 실제 바이너리를 띄우고, 세션 신원
// (`session`)과 모델 목록(`status.models`)이 **어댑터의 Decode 로** 읽히는지, 핸드셰이크
// 동안 모르는 프레임(`Decode → false`)이 없는지, stdin EOF 로 끝나는지를 본다. 턴 의존
// 프레임은 자격증명이 있어야 하므로 여기 없다 (P0 의 사용자 결정 — 자격증명은 묻지 않는다).
// 바이너리가 PATH 에 없으면 그 어댑터는 건너뛴다 (`DONGMINAL_AGENT_BIN_DIR` 을 먼저 본다).

// driftSessionAtHandshake 는 핸드셰이크만으로 세션 신원이 오는가다 (실측 2026-09-13):
// claude 는 `system:init` 을 **첫 프롬프트 뒤**에 낸다 — 핸드셰이크에는 없다 (P4 발견,
// M8_PROGRESS §2-28). 이 표가 바뀌면 그 어댑터의 계약이 움직인 것이다.
var driftSessionAtHandshake = map[string]bool{"claude": false, "codex": true, "omp": true}

func TestDrift(t *testing.T) {
	for _, id := range IDs() {
		ad, _ := Get(id)
		if ad.Proto == nil {
			continue
		}
		t.Run(id, func(t *testing.T) { driftOne(t, ad, driftSessionAtHandshake[id]) })
	}
}

func driftOne(t *testing.T, ad Adapter, wantSession bool) {
	bin := ""
	if dir := os.Getenv("DONGMINAL_AGENT_BIN_DIR"); dir != "" {
		if st, err := os.Stat(dir + "/" + ad.DetectCmd); err == nil && !st.IsDir() {
			bin = dir + "/" + ad.DetectCmd
		}
	}
	if bin == "" {
		p, err := exec.LookPath(ad.DetectCmd)
		if err != nil {
			t.Skipf("%s: 실행 파일이 없다 — 건너뛴다", ad.DetectCmd)
		}
		bin = p
	}
	cwd := t.TempDir()
	opts := LaunchOpts{Bin: bin, Cwd: cwd}
	argv := ad.Proto.Launch(opts)
	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.Dir = cwd
	cmd.Stderr = os.Stderr
	stdin, _ := cmd.StdinPipe()
	stdout, _ := cmd.StdoutPipe()
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	st := NewProtoState()
	if ad.Proto.Handshake != nil {
		for _, fr := range ad.Proto.Handshake(opts, st) {
			stdin.Write(append(fr, '\n'))
		}
	}
	lines := make(chan []byte, 256)
	go func() {
		sc := bufio.NewScanner(stdout)
		sc.Buffer(make([]byte, 0, 64*1024), 8*1024*1024)
		for sc.Scan() {
			lines <- append([]byte(nil), sc.Bytes()...)
		}
		close(lines)
	}()
	var sawSession, sawModels bool
	var unknown []string
	deadline := time.After(20 * time.Second)
loop:
	for !((sawSession || !wantSession) && sawModels) {
		select {
		case line, ok := <-lines:
			if !ok {
				break loop
			}
			evs, ok := ad.Proto.Decode(line, st)
			if !ok {
				unknown = append(unknown, string(bytes.TrimSpace(line)))
				continue
			}
			for _, e := range evs {
				if e.Kind == EvSession && e.SessionID != "" {
					sawSession = true
				}
				// 모델 목록은 status 또는 session(claude 의 initialize 응답 — D-C-16)에 실린다.
				if e.Status != nil && len(e.Status.Models) > 0 {
					sawModels = true
				}
				if e.Kind == EvError {
					t.Logf("%s: error 이벤트 — %s", ad.ID, e.Text)
				}
			}
		case <-deadline:
			break loop
		}
	}
	// 종료는 stdin EOF 다 (U-7).
	start := time.Now()
	stdin.Close()
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case <-done:
		t.Logf("%s: stdin EOF → 종료 %.2fs", ad.ID, time.Since(start).Seconds())
	case <-time.After(10 * time.Second):
		cmd.Process.Kill()
		t.Errorf("%s: stdin EOF 뒤 10초 안에 끝나지 않았다", ad.ID)
	}
	if wantSession && !sawSession {
		t.Errorf("%s: 세션 신원(session)이 오지 않았다 — 핸드셰이크의 계약이 움직였다", ad.ID)
	}
	if !sawModels {
		t.Errorf("%s: 모델 목록(status.models)이 오지 않았다", ad.ID)
	}
	if len(unknown) > 0 {
		t.Errorf("%s: 핸드셰이크 동안 모르는 프레임 %d개 (첫 것): %s", ad.ID, len(unknown), truncateLine(unknown[0]))
	}
}

func truncateLine(s string) string {
	if len(s) > 300 {
		return s[:300] + "…"
	}
	return strings.TrimSpace(s)
}
