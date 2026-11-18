package privhelper

import (
	"crypto/ed25519"
	"encoding/base32"
	"encoding/json"
	"errors"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"dongminal/internal/shared/humancmd"
	"dongminal/internal/shared/platform"
)

// TC-PCH-8: RFC 6238 부록 B 의 SHA1 시험 값. 비밀은 "12345678901234567890" 이다.
func TestTOTPRFC6238(t *testing.T) {
	secret := []byte("12345678901234567890")
	cases := []struct {
		unix int64
		want string
	}{
		{59, "94287082"},
		{1111111109, "07081804"},
		{1111111111, "14050471"},
		{1234567890, "89005924"},
		{2000000000, "69279037"},
		{20000000000, "65353130"},
	}
	for _, c := range cases {
		step := stepOf(time.Unix(c.unix, 0))
		if got := hotp(secret, uint64(step), 8); got != c.want {
			t.Errorf("T=%d: 8자리 %s, 기대 %s", c.unix, got, c.want)
		}
		if got := hotp(secret, uint64(step), digits); got != c.want[2:] {
			t.Errorf("T=%d: 6자리 %s, 기대 %s", c.unix, got, c.want[2:])
		}
	}
}

type clock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *clock) now() time.Time { c.mu.Lock(); defer c.mu.Unlock(); return c.t }
func (c *clock) add(d time.Duration) {
	c.mu.Lock()
	c.t = c.t.Add(d)
	c.mu.Unlock()
}

func testSecret(t *testing.T) (Secret, []string) {
	t.Helper()
	s, codes, err := newSecret(os.Getuid())
	if err != nil {
		t.Fatal(err)
	}
	return s, codes
}

func codeAt(t *testing.T, s Secret, at time.Time) string {
	t.Helper()
	raw, err := base32.StdEncoding.WithPadding(base32.NoPadding).DecodeString(s.TOTP)
	if err != nil {
		t.Fatal(err)
	}
	return hotp(raw, uint64(stepOf(at)), digits)
}

func newTestGuard(t *testing.T) (*guard, Secret, []string, *clock) {
	t.Helper()
	s, codes := testSecret(t)
	c := &clock{t: time.Unix(1_800_000_000, 0)}
	g, err := newGuard(&s, c.now, func(Secret) error { return nil })
	if err != nil {
		t.Fatal(err)
	}
	return g, s, codes, c
}

func codeOf(err error) string {
	var he *humancmd.Error
	if errors.As(err, &he) {
		return he.Code
	}
	return ""
}

// TC-PCH-7(도우미): 코드 없음·틀림·재사용은 거절, 맞으면 받는다. 앞뒤 한 칸을 받는다.
func TestGuardCodes(t *testing.T) {
	g, s, _, c := newTestGuard(t)
	if codeOf(g.check("")) != humancmd.CodeBadCode {
		t.Fatal("빈 코드를 받았다")
	}
	good := codeAt(t, s, c.now())
	wrong := "000000"
	if wrong == good {
		wrong = "111111"
	}
	if codeOf(g.check(wrong)) != humancmd.CodeBadCode {
		t.Fatal("틀린 코드를 받았다")
	}
	if err := g.check(good); err != nil {
		t.Fatalf("맞는 코드를 거절했다: %v", err)
	}
	if codeOf(g.check(good)) != humancmd.CodeBadCode {
		t.Fatal("같은 코드를 두 번 받았다")
	}
	// 앞 칸의 코드는 이미 쓴 칸보다 앞이므로 받지 않는다.
	if codeOf(g.check(codeAt(t, s, c.now().Add(-30*time.Second)))) != humancmd.CodeBadCode {
		t.Fatal("쓴 칸보다 앞의 코드를 받았다")
	}
	// 다음 칸(시계가 30초 느린 휴대폰과 반대 — 휴대폰이 앞섬)은 받는다.
	if err := g.check(codeAt(t, s, c.now().Add(30*time.Second))); err != nil {
		t.Fatalf("다음 칸 코드를 거절했다: %v", err)
	}
	// 두 칸 뒤는 받지 않는다.
	c.add(10 * time.Minute)
	if codeOf(g.check(codeAt(t, s, c.now().Add(60*time.Second)))) != humancmd.CodeBadCode {
		t.Fatal("두 칸 뒤의 코드를 받았다")
	}
	// 앞 칸(휴대폰이 늦음)은 받는다.
	if err := g.check(codeAt(t, s, c.now().Add(-30*time.Second))); err != nil {
		t.Fatalf("앞 칸 코드를 거절했다: %v", err)
	}
}

// TC-PCH-7(도우미): 5번 틀리면 5분 잠근다. 잠긴 동안 맞는 코드도 거절한다. 풀리면 0 부터 센다.
func TestGuardLock(t *testing.T) {
	g, s, _, c := newTestGuard(t)
	for i := range 4 {
		if codeOf(g.check("abc")) != humancmd.CodeBadCode {
			t.Fatalf("%d번째 틀림이 bad_code 가 아니다", i+1)
		}
	}
	err := g.check("abc")
	var he *humancmd.Error
	if !errors.As(err, &he) || he.Code != humancmd.CodeLocked || he.Until != c.now().Add(5*time.Minute).UnixMilli() {
		t.Fatalf("5번째 틀림 = %v, 잠금과 풀리는 시각을 기대", err)
	}
	c.add(4 * time.Minute)
	if codeOf(g.check(codeAt(t, s, c.now()))) != humancmd.CodeLocked {
		t.Fatal("잠긴 동안 맞는 코드를 받았다")
	}
	if g.lockedUntil().IsZero() {
		t.Fatal("잠금 시각이 비었다")
	}
	c.add(61 * time.Second)
	if !g.lockedUntil().IsZero() {
		t.Fatal("5분 뒤에도 잠겨 있다")
	}
	// 풀린 뒤 네 번 틀려도 잠기지 않는다.
	for range 4 {
		if codeOf(g.check("abc")) != humancmd.CodeBadCode {
			t.Fatal("풀린 뒤 횟수가 이어졌다")
		}
	}
	if err := g.check(codeAt(t, s, c.now())); err != nil {
		t.Fatalf("맞는 코드를 거절했다: %v", err)
	}
}

// 복구 코드는 TOTP 대신 한 번만 쓴다. 쓴 것은 비밀 파일에 남긴다.
func TestGuardRecovery(t *testing.T) {
	s, codes := testSecret(t)
	c := &clock{t: time.Unix(1_800_000_000, 0)}
	var saved Secret
	g, err := newGuard(&s, c.now, func(x Secret) error { saved = x; return nil })
	if err != nil {
		t.Fatal(err)
	}
	if len(codes) != recoveryCount {
		t.Fatalf("복구 코드 %d개, 기대 %d", len(codes), recoveryCount)
	}
	if err := g.check(strings.ToUpper(codes[0])); err != nil {
		t.Fatalf("복구 코드를 거절했다: %v", err)
	}
	if len(saved.Used) != 1 {
		t.Fatalf("쓴 복구 코드가 저장되지 않았다: %+v", saved.Used)
	}
	if codeOf(g.check(codes[0])) != humancmd.CodeBadCode {
		t.Fatal("복구 코드를 두 번 받았다")
	}
	for _, h := range s.Recovery {
		if strings.Contains(h, codes[1]) {
			t.Fatal("복구 코드가 해시 없이 저장되었다")
		}
	}
}

func shortDir(t *testing.T) string {
	t.Helper()
	d, err := os.MkdirTemp("", "ph")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(d) })
	return d
}

func startServer(t *testing.T, uid func(net.Conn) (int, error)) (humancmd.Client, Secret, *clock) {
	t.Helper()
	s, _ := testSecret(t)
	c := &clock{t: time.Unix(1_800_000_000, 0)}
	srv, err := NewServer(&s, c.now, func(Secret) error { return nil })
	if err != nil {
		t.Fatal(err)
	}
	if uid != nil {
		srv.peerUID = uid
	} else {
		srv.peerUID = func(net.Conn) (int, error) { return s.UID, nil }
	}
	path := filepath.Join(shortDir(t), "h.sock")
	ln, err := platform.Current().IPC.Listen(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	go srv.Serve(ln)
	return humancmd.Client{Path: path, Timeout: 2 * time.Second}, s, c
}

func killReq() humancmd.Request {
	return humancmd.Request{Node: strings.Repeat("a", 64), Op: humancmd.OpKill, Rooms: []string{"r1", "r2", "r3"}}
}

// TC-PCH-7(도우미): 소켓의 info·sign. 서명은 묶음 전체를 덮는다.
func TestServerSign(t *testing.T) {
	cl, s, c := startServer(t, nil)
	info, err := cl.Info()
	if err != nil {
		t.Fatal(err)
	}
	seed, _ := decodeKey(s.Key)
	if info.Key != humancmd.PublicKey(ed25519.NewKeyFromSeed(seed)) {
		t.Fatal("info 의 키가 비밀 파일의 키가 아니다")
	}
	if _, err := cl.Sign("", killReq()); codeOf(err) != humancmd.CodeBadCode {
		t.Fatalf("코드 없는 서명 = %v", err)
	}
	signed, err := cl.Sign(codeAt(t, s, c.now()), killReq())
	if err != nil {
		t.Fatal(err)
	}
	b, err := humancmd.Open(signed)
	if err != nil {
		t.Fatal(err)
	}
	if b.Key != info.Key || b.Op != humancmd.OpKill || len(b.Rooms) != 3 || b.At != c.now().UnixMilli() || b.ID == "" {
		t.Fatalf("본문 = %+v", b)
	}
	// 대상 하나를 바꾸면 서명이 맞지 않는다.
	var m map[string]any
	_ = json.Unmarshal(signed.B, &m)
	m["rooms"] = []string{"r1", "r2", "zz"}
	signed.B, _ = json.Marshal(m)
	if _, err := humancmd.Open(signed); err == nil {
		t.Fatal("바꾼 본문의 서명이 맞았다")
	}
}

func TestServerRejects(t *testing.T) {
	cl, s, c := startServer(t, nil)
	bad := humancmd.Request{Node: strings.Repeat("a", 64), Op: humancmd.OpKill, Rooms: []string{"r1"}, Kicks: []humancmd.Kick{{Room: "r1", Participant: "p"}}}
	if _, err := cl.Sign(codeAt(t, s, c.now()), bad); codeOf(err) != humancmd.CodeBadRequest {
		t.Fatalf("종류가 섞인 묶음 = %v", err)
	}
	many := humancmd.Request{Node: strings.Repeat("a", 64), Op: humancmd.OpKill}
	for range humancmd.MaxTargets + 1 {
		many.Rooms = append(many.Rooms, "r")
	}
	if _, err := cl.Sign(codeAt(t, s, c.now()), many); codeOf(err) != humancmd.CodeBadRequest {
		t.Fatalf("65개 묶음 = %v", err)
	}
	// 모양이 틀린 묶음은 코드를 쓰지 않는다 — 같은 코드로 바른 묶음에 서명한다.
	if _, err := cl.Sign(codeAt(t, s, c.now()), killReq()); err != nil {
		t.Fatalf("바른 묶음 = %v", err)
	}
}

// 설치한 사용자가 아니면 끊는다.
func TestServerOtherUID(t *testing.T) {
	cl, _, _ := startServer(t, func(net.Conn) (int, error) { return 424242, nil })
	if _, err := cl.Info(); codeOf(err) != humancmd.CodeNoHelper {
		t.Fatalf("다른 uid 의 info = %v", err)
	}
}

func TestSecretFile(t *testing.T) {
	s, _ := testSecret(t)
	path := filepath.Join(shortDir(t), "d", "secret.json")
	if err := saveSecret(path, s); err != nil {
		t.Fatal(err)
	}
	fi, err := os.Stat(path)
	if err != nil || runtime.GOOS != "windows" && fi.Mode().Perm() != 0o600 {
		t.Fatalf("비밀 파일 모드 = %v, %v", fi.Mode(), err)
	}
	di, _ := os.Stat(filepath.Dir(path))
	if runtime.GOOS != "windows" && di.Mode().Perm() != 0o700 {
		t.Fatalf("비밀 폴더 모드 = %v", di.Mode())
	}
	got, err := loadSecret(path)
	if err != nil || got.TOTP != s.TOTP || got.Key != s.Key || got.UID != s.UID {
		t.Fatalf("다시 읽은 비밀 = %+v, %v", got, err)
	}
}

func TestPlist(t *testing.T) {
	p := plist("/Library/PrivilegedHelperTools/com.dongminal.helper")
	for _, want := range []string{"<string>com.dongminal.helper</string>", "<string>otp</string>", "<string>run</string>", "<key>KeepAlive</key>", "<key>RunAtLoad</key>"} {
		if !strings.Contains(p, want) {
			t.Errorf("plist 에 %q 가 없다", want)
		}
	}
}

func TestFormatSecret(t *testing.T) {
	if got := groupBy4("ABCDEFGHIJ"); got != "ABCD EFGH IJ" {
		t.Fatalf("groupBy4 = %q", got)
	}
}

// 사용법은 OTP 를 어디에 쓰는지까지 말한다 — 이름만 보고는 무엇인지 알 수 없었다.
func TestUsageExplainsOTP(t *testing.T) {
	for _, want := range []string{"dongminal otp", "6자리", "강제 삭제", "강퇴", "복구 코드", "5번", "5분"} {
		if !strings.Contains(Usage, want) {
			t.Errorf("사용법에 %q 가 없다:\n%s", want, Usage)
		}
	}
}
